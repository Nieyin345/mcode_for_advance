/**
 * 设置导入 / 导出(R39)。
 *
 * 导出的是 settings 表里「跟着人走的偏好」—— 外观、快捷键、手势、自定义 UI、通知、
 * 标题生成、提交信息模板、工作流并发……换一台电脑导进去就是熟悉的样子。
 *
 * **绝不导出的**:
 *  - 密钥类:API Key、令牌、密码、cookie、公网 MCP 密钥、手机配对设备、隧道 token。
 *    按 key 名拦,再对 JSON 值做一遍深度清洗(值里嵌着 `apiKey` / `env.OPENAI_API_KEY`
 *    这类字段的整条删掉)。模型供应商配置(含 Key)根本不在这张表里,也不会带上。
 *    ⚠️ 嵌套清洗**超过上限时 fail-closed**:整条设置丢弃(在 `skipped` 里计数),
 *    绝不退回"原样保留"—— 否则深层叶节点里的密钥会绕过 `SECRET_FIELD_RE` 走出去
 *    (MC-024)。
 *  - 本机状态:数据目录、上次打开的会话 / 文件、浏览历史、按项目 id 存的东西(换台电脑
 *    项目 id 对不上)、资料库内部结构、更新状态、自动化运行链路。
 *
 * 导入时同一套规则再过一遍(文件可能是手改的),只写允许的键;写之前先把当前设置
 * 备份一份到 `<userData>/settings-backups/`,导坏了能找回来。
 *
 * 这个文件不碰 Electron,方便单测;对话框和写盘在 `ipc/settingsTransfer.ts`。
 */

import { CUSTOM_UI_SETTING_KEY } from "@contracts/customUi";
import { isWorkflowExecutionTrustSettingKey } from "@contracts/ipc";
import { validateCustomUiWrite } from "@main/customUi/configValidation.js";
// 【MC-004】密钥键判据(通用词 + 结构形状 + 显式名单)收进了 `@main/lib/secretKeys`
// 的**唯一一份** `isSecretSettingKey` —— 从前这里(`SECRET_KEY_RE` / `SECRET_STORE_KEY_RE`)
// 与 `appControl/tools.ts`、`mobile/MobileHttpServer.ts` 各写一遍,而且已经漂开
// (本文件认 `paireddevices` / `passwordlogin`,那边的孪生正则认 `cookieVault`,手机侧
// 是硬编码键集合)。现在三处共享同一份判据,新增密钥键加在 `secretKeys.ts` 一处即可。
//
// ⚠️ 本文件**只**用它挡住"真密钥";`customModels`(公开元数据)不在这份判据里,它能照常
// 导出 —— 导出的 `customHeaders` 由下面的 `scrubSecrets` 深度清洗(见 `EXCLUDED_KEYS`
// 里那条注释)。这与 agent 读设置那侧**故意不同**:那边没有深度清洗,所以额外挡住它。
import { isSecretSettingKey } from "@main/lib/secretKeys.js";

export const SETTINGS_EXPORT_FORMAT = "mcode-settings";
export const SETTINGS_EXPORT_VERSION = 1;

/** **安全授信**键 —— 这些存的是"用户在本机明确批准过的信任决定"(SSH 主机指纹、
 *  项目 MCP 信任、设备信任)。它们**绝不是"跟着人走的偏好"**,一律不可导入导出。
 *
 *  【MC-031 / MC-052 —— 独立复核实测反例后加】从前这里只有一批零散的"排除式"条目,
 *  逐个往 {@link EXCLUDED_KEYS} 里加是**追着漏**的写法:`mcp.projectTrust`(项目 MCP
 *  信任指纹)与 `agentSsh.knownHosts`(SSH 主机指纹)都不在密钥正则里,于是能随设置
 *  备份**导入** —— 一份被诱导导入的"设置备份"就能把用户对某台服务器 / 某个仓库的
 *  信任**预先写好**(配合一份配套的 `.mcp.json` 或一次网络层冒充即可利用)。
 *
 *  所以这里把"安全授信"单列成一类,而**不是**再往 `EXCLUDED_KEYS` 里加一条:
 *
 *   - **形状判据** {@link SECURITY_GRANT_PREFIXES} 覆盖已知的授信键前缀;
 *   - **显式清单** {@link SECURITY_GRANT_KEYS} 兜住形状不一、或将来新增的零散授信键。
 *
 *  ⚠️ **新增授信键必须同步加到这里** —— 台账反复点名的一个要求是"新增安全设置不可
 *  被无差别导入"。如果你的授信键恰好落在某个前缀下(如 `agentSsh.` / `mcp.trust`)
 *  就不必单列;否则加进 {@link SECURITY_GRANT_KEYS}。 */
const SECURITY_GRANT_KEYS = new Set<string>([
  // 项目级 MCP 信任指纹(用户对某个仓库的 .mcp.json 命令的批准)。
  "mcp.projectTrust",
  // SSH agent 的 known-hosts 指纹表(用户核对过的远端服务器身份)。
  "agentSsh.knownHosts",
]);

/** 安全授信键的**前缀**(一族授信状态)。命中的一律不可迁移。 */
const SECURITY_GRANT_PREFIXES = [
  "agentSsh.",     // SSH agent 的 known-hosts 等
  "mcp.trust",     // 项目 MCP 信任相关
  "trust.",        // 通用信任族
  "securityGrant.",
];

/** 精确排除的键(本机路径 / 运行状态 / 含密钥的整块配置)。
 *  【MC-004】头两条(`customModelKeys` / `mcp.management`)现在的**主判据**已在共享的
 *  `isSecretSettingKey`(见文件头)里 —— `isTransferableSettingKey` 会先问它。这里保留
 *  同名条目是**防御性冗余**(判据万一被改宽,这两条仍在),不是唯一防线。 */
const EXCLUDED_KEYS = new Set<string>([
  // ⚠️ **自定义模型的密钥本体。** 值在 `safeStorage` 不可用的机器上是**明文 base64**
  // (见 `main/lib/secretStore.ts` 的 `encrypt()` 降级路径),可逆。少这一条,导出设置就
  // 把全部网关密钥写进那个 JSON 文件,而用户导出它正是为了分享 / 搬机器 —— 与文件头
  // 「绝不导出密钥」那句直接相悖。
  // (`customModels` 那一条是**公开元数据**、不含密钥,该照常导出,不要一起排掉。)
  "customModelKeys",
  // ⚠️ **MCP 服务器配置里的凭据。** 每个 server 的 `env`(stdio,常放 `GITHUB_TOKEN`
  // 之类)与 `headers`(http/sse,常放 `Authorization`)是原样保存的 —— 导出设置即是分享,
  // 带着这些键就等于把 API key 写进那个 JSON 文件。共享判据已按显式名单认它。
  "mcp.management",
  "app.dataRoot",
  "browser.dataDir",
  "browser.screenshotDir",
  "browser.addressHistory",
  "browser.persistLogin",
  "ui.voiceModelDir",
  "ui.voiceDownloadedModels",
  "ui.voiceMicPermission",
  "worktree.root",
  "worktree.names",
  "update.state",
  "ui.lastProjectId",
  "ui.lastSessionId",
  "ui.ideOpenFiles",
  "ui.ideActiveFile",
  "ui.ideExpandedDirs",
  "ui.gitCollapsedRepos",
  "ui.customCommandsByProject",
  "ui.projectGroups",
  "project.colors",
  "relay.vpsConfig",
  // O5 批二（2026-10-24）：OnlyOffice 功能已删，但用户盘上可能还存着这条设置
  // （值是含 JWT 密钥的 JSON）。删掉这一条不会让旧值消失，只会让导出把旧密钥
  // 写进分享出去的文件 —— 保留排除，清理旧值是另一件事（见 O5 §四之3）。
  "onlyoffice.config",
  "mobile.enabled",
  "mobile.port",
  "mobile.tunnel.autostart",
  "mobile.tunnel.hostname",
  "mobile.tunnel.mode",
  "publicMcp.enabled",
  "publicMcp.fixedPort",
  "publicMcp.projectId",
  "publicMcp.sessionId",
  "publicMcp.projectLinks",
  "publicMcp.agentDelegate",
  "publicMcp.delegateSessionId",
  "publicMcp.delegateSessions",
  "publicMcp.mobileHostname",
  "publicMcp.tunnelHostname",
  "publicMcp.tunnelMode",
]);

/** 按前缀排除(一族状态键)。 */
const EXCLUDED_PREFIXES = [
  // 【MC-026 复核·技能预设/市场】技能预设(`.skill-presets.json`)、导入包
  // (`.bundles.json`)、技能市场(`skill-markets/markets.json`)都**不在 settings 表**
  // (`defaultSkillsRoot()` 下是文件;技能市场记录也是文件),所以设置导入/导出天然
  // 够不到它们 —— 它们的坏档保全由 `ipc/skills.ts` 的三态读 + 写侧拒写负责
  // (MC-053 同族,另一条车道)。`library.` 前缀排的是资料库**表内**状态,与此无关。
  "library.",
  "automation.eventChain.",
  "automation.state.",
  // ── 【MC-026 复核】自动化的**执行状态**,不是偏好 ──────────────────────────
  // 这些键整族都是"这台机器上执行器自己的账",导入它们不是搬偏好,而是**种执行事实**:
  //  - `automation.lastMinute` / `automation.selfTriggerCount.` / `automation.selfTriggerAt.`
  //    是跨重启的去重与自触发额度。导入一份被诱导的"设置备份"就能把某条定时触发器
  //    这一分钟/这一窗口写成"已经跑过",让它**该响而不响**(或反过来抬高自触发额度);
  //  - `automation.triggerClaims` 是"领取→执行"的 durable 账本。种一条 `CLAIMED`
  //    进去,下次重启 `recoverIncompleteClaims` 会把它报成"上一次运行结果不确定" ——
  //    凭空制造一次从未发生的运行,并可能让真正该跑的那次被判为重复;
  //  - `automation.missedSweptTo` / `automation.droppedUndelivered` 是"错过结算到哪"
  //    与"丢了几条还没交付"的游标,跨机器搬运只会让界面报出别的机器的账。
  // 判据落在**执行账本 vs 显示偏好**上:`automation.watch.templates`(用户保存的守望
  // 命令)仍是偏好,照常可迁移 —— 别把 automation. 一刀切。
  "automation.lastMinute",
  "automation.missedSweptTo",
  "automation.triggerClaims",
  "automation.droppedUndelivered",
  "automation.pendingBatches",
  "automation.selfTriggerCount.",
  "automation.selfTriggerAt.",
  // ── 【MC-026 复核】出厂内容的**本机记账**,不是偏好 ─────────────────────────
  // `workflow.seededShipped` 记"哪些出厂工作流已经播过" —— 它是产品承诺「删了就是
  // 删了」的唯一事实(MC-053)。导入一份清空/篡改的名单,已删除的出厂工作流会在下次
  // 读取时被**重新播回**;`workflow.shippedRevisions` 同理是"这一行跟到了哪版出厂内容"
  // 的本机基线,跨机器搬运会让"出厂版有更新"的判定全错。两者都不该离开这台机器。
  "workflow.seededShipped",
  "workflow.shippedRevisions",
  "mobile.",
  "publicMcp.",
  "relay.",
  "browser.cookieVault",
  "session.lastModel.",
  "migration.",
  "internal.",
  // ⚠️ **记忆助手的运行时状态。** `memory.assistant.job.<id>` 的值里带着 `result`
  // —— AI 从**用户对话**里整理出来的交接材料/摘要。键名不含任何密钥词(所以两道密钥
  // 筛子都拦不住它),但导出设置的文件正是用户拿去**分享 / 搬机器**的那个 JSON ——
  // 把自己对话的正文总结写进去与文件头「绝不导出…按项目 id 存的东西」那句相悖。
  // 同族的 `.source.<sessionId>` / `.target.<sessionId>` 也按会话 id 存,换台机器全是
  // 悬空 id,没有任何搬运价值。
  "memory.assistant.",
  // ⚠️ **代理挂账(未答提问)。** 值里带着模型问出去的那句 `question`、发起方名字,以及
  // **机器本地的会话 id**(fromSessionId / toSessionId)—— 换台机器全是悬空 id。与
  // `memory.assistant.*` 同一类:不是密钥,但同样不该进那个"拿去分享"的 JSON。
  "agentMail.",
];

// The setting table has string keys from IPC/imports/extensions. Grant and
// local-state exclusions are security categories, not case-sensitive UI names:
// a differently-cased spelling must never be treated as transferable.
const FOLDED_GRANT_KEYS = new Set([...SECURITY_GRANT_KEYS].map((k) => k.toLowerCase()));
const FOLDED_GRANT_PREFIXES = SECURITY_GRANT_PREFIXES.map((p) => p.toLowerCase());
const FOLDED_EXCLUDED_KEYS = new Set([...EXCLUDED_KEYS].map((k) => k.toLowerCase()));
const FOLDED_EXCLUDED_PREFIXES = EXCLUDED_PREFIXES.map((p) => p.toLowerCase());

export function isTransferableSettingKey(key: string): boolean {
  if (!key || key.length > 200) return false;
  const folded = key.toLowerCase();
  // 【MC-004】密钥键判据走共享的那一份(通用词 + 结构形状 + 显式名单),见文件头。
  if (isSecretSettingKey(key)) return false;
  // 【MC-031 / MC-052】安全授信一律不可迁移 —— 别让大小写变体绕过。
  if (FOLDED_GRANT_KEYS.has(folded)) return false;
  if (FOLDED_GRANT_PREFIXES.some((p) => folded.startsWith(p))) return false;
  // 【ARC-006 创建≠执行授权】**工作流执行信任事实**同属"安全授信":审批记录
  // (`workflow.review.v1.<id>`)是"这条自动化 / 外来工作流能不能无人值守执行"的唯一
  // 事实;「恢复默认」快照(`workflow.pinnedDefaults`)是**不过审直接落库**的完整文档
  // —— 它的信任前提正是"只由 pinWorkflowDefault 写入、而钉之前已过审"。导出档是用户
  // 拿去分享 / 搬机器的 —— 让它跟着走,导入一份"设置备份"就等于替用户预先批准了某条
  // 外来自动化(或种下一份未经当前审批、恢复后即可执行的文档)。判据走 `@contracts/ipc`
  // 的共享谓词,与通用 `setting.set` 的拒绝是同一份(别在这里另写 `startsWith`/整键比较)。
  // 注意前缀只到 `review.v1.`:`workflow.nodePrefs.<id>`(显示偏好)仍要可迁移。
  if (isWorkflowExecutionTrustSettingKey(key) || isWorkflowExecutionTrustSettingKey(folded)) return false;
  if (FOLDED_EXCLUDED_KEYS.has(folded)) return false;
  return !FOLDED_EXCLUDED_PREFIXES.some((p) => folded.startsWith(p));
}

/** 深度去掉值里像密钥的字段。
 *
 *  ⚠️ **匹配的是"词",不是"子串"。** 判据落在段的边界上(`^` / `$` / `-` / `_` / `.`),
 *  所以:
 *    - `x-api-key`、`X-Api-Key`、`x-auth-token`(常见的网关鉴权头名)、`authToken`、
 *      `access_token` 都命中 —— 命中即删;
 *    - 而 `maxTotalTokens`、`tokenBudget`、`cacheReadTokens` 这类**恰好含**
 *      token 字样、却不是密钥的字段**不**命中。
 *
 *  从前的写法是"整名等于密钥词,或以下划线+大写结尾"(`^api[-_]?key$` /
 *  `(_API_KEY|_TOKEN|…)$`),`x-api-key` 这两种都不落在里面 —— 于是 `customModels`
 *  那份**该导出**的公开元数据里,用户配在 `customHeaders` 上的网关密钥原样跟着走。
 *  (清洗"删多了"只丢一个字段,是安全的一侧;"漏删"是把真令牌写进一个专门拿去分享的
 *  文件。两者不对等,所以这里宁可偏严。) */
const SECRET_FIELD_RE =
  /(^|[-_.])(api[-_.]?keys?|apikeys?|access[-_.]?tokens?|refresh[-_.]?tokens?|auth(orization)?[-_.]?tokens?|tokens?|secrets?|client[-_.]?secrets?|passw(or)?ds?|passwd|authorization|credentials?|cookies?|private[-_.]?keys?)([-_.]|$)/i;

/** 递归清洗的上限。**超过就 fail-closed**:不再往下走,而是把整条设置标成"清洗不干净"
 *  交给调用方丢弃 —— 绝不能像从前那样把没洗过的子树原样留下(那正是密钥从深处漏出的口子)。 */
const SCRUB_MAX_DEPTH = 20;
/** 单条设置值最多清洗多少个节点 / 多长字符串 —— 防御"极端大对象拖死 / 卡死主进程"。 */
const SCRUB_MAX_NODES = 200_000;
const SCRUB_MAX_BYTES = 8_000_000;

/** 深度去掉值里像密钥的字段。返回 `[清洗后的值, 删了几处, 是否溢出]`。
 *
 *  ⚠️ **第三个返回值 `overflow` 是 MC-024 补的那个洞。** 从前 `depth > 20` 时直接
 *  `return [value, 0]` —— 把没洗过的整棵子树原样留下。于是只要有人把密钥塞进一个
 *  21 层深的 `{a:{a:{…}}}` 里,`SECRET_FIELD_RE` 就永远够不到那个叶节点,导出文件里
 *  带着明文密钥走出去 —— 而文件头那句"绝不导出密钥"照旧写着。改用 fail-closed 之后,
 *  深度/节点/字节任一超限都置 `overflow = true`,调用方据此**整条丢弃**,不留原样。
 *  (清洗"删多了"只丢一个字段,是安全的一侧;"漏删"是把真令牌写进一个专门拿去分享
 *  的文件。两者不对等,所以这里宁可偏严,同 {@link SECRET_FIELD_RE} 那条。) */
export function scrubSecrets(
  value: unknown,
  depth = 0,
  budget: { nodes: number; bytes: number } = { nodes: SCRUB_MAX_NODES, bytes: SCRUB_MAX_BYTES },
): [unknown, number, boolean] {
  // 深度超限,或节点/字节预算耗尽 —— **fail-closed**:告诉调用方这条清洗不干净,
  // 由它整条丢弃。绝不把没洗过的子树原样返回(那会把深层密钥放出去)。
  if (depth > SCRUB_MAX_DEPTH || budget.nodes <= 0 || budget.bytes <= 0) return [undefined, 0, true];
  if (value === null || typeof value !== "object") {
    budget.nodes -= 1;
    // 【MC-024 字节预算】`budget.bytes` 的额度是 `SCRUB_MAX_BYTES`(**字节**),它作 DoS
    // 防线("防御极端大对象拖死 / 卡死主进程")靠的就是字节数。从前这里减 `value.length`
    // —— UTF-16 **码元**数:一个汉字 `length` 是 1 却占 3 个 UTF-8 字节,一段中文/emoji
    // 配置真实体积轻松到"字面长度"的两三倍都不触发溢出,字节红线对多字节内容形同虚设
    // (与 MC-033「字符长度不等同字节大小」同一类)。改按 **UTF-8 字节**记账。
    if (typeof value === "string") budget.bytes -= Buffer.byteLength(value, "utf8");
    return [value, 0, false];
  }
  budget.nodes -= 1;
  if (Array.isArray(value)) {
    let n = 0;
    let overflow = false;
    const out: unknown[] = [];
    for (const item of value) {
      const [c, k, o] = scrubSecrets(item, depth + 1, budget);
      n += k;
      if (o) overflow = true;
      out.push(c);
    }
    return [out, n, overflow];
  }
  let n = 0;
  let overflow = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_RE.test(k)) {
      n += 1;
      continue;
    }
    const [c, m, o] = scrubSecrets(v, depth + 1, budget);
    n += m;
    if (o) overflow = true;
    out[k] = c;
  }
  return [out, n, overflow];
}

/** 值是 JSON 就清洗后再序列化;不是 JSON 原样返回。
 *
 *  `rejected = true` 表示**清洗不干净**(递归/预算超限)—— 调用方必须**整条丢弃**,
 *  不许回落到"原样导出 / 原样导入"。 */
function scrubValue(raw: string): { value: string; scrubbed: number; rejected: boolean } {
  const t = raw.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return { value: raw, scrubbed: 0, rejected: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { value: raw, scrubbed: 0, rejected: false };
  }
  const [clean, n, overflow] = scrubSecrets(parsed);
  if (overflow) return { value: "", scrubbed: n, rejected: true };
  return n > 0 ? { value: JSON.stringify(clean), scrubbed: n, rejected: false } : { value: raw, scrubbed: 0, rejected: false };
}

/**
 * 【MC-029】算出「把这份导出档**恢复**成当前设置」要**删掉**哪些键。
 *
 * 普通导入是 **upsert(只合并)**:写进档里有的键,**不动**表里其它键。于是"导入前只有 A、
 * 导入新增 B,再拿只含 A 的备份导回来"— B 仍然留着 —— 所谓"导坏了用备份导回来"并没有
 * 真正回到导入前的状态。要让"完整恢复"成立,就得**删掉备份里没有的键**,但只能删**允许
 * 迁移范围内的键**:敏感/本机设置(密钥、本机路径、授信)不在导出档里,也就绝不能被"恢复"
 * 当成"备份里没有"而误删 —— 那会把用户本机的密钥、SSH 授信一起清掉。
 *
 * 判据 =「当前表里的键 ∩ 可迁移集合」减去「备份档里的键」。返回要删的键(已按可迁移过滤)。
 * 只在库里有值(`currentKeysWithValues`)的键会被列出 —— 值为 null 的空键没什么可删。
 */
export function restoreKeysToDelete(
  currentKeysWithValues: readonly string[],
  exportedKeys: ReadonlySet<string>,
): string[] {
  return currentKeysWithValues
    .filter((k) => isTransferableSettingKey(k) && !exportedKeys.has(k))
    .sort();
}

export interface SettingsExportDoc {
  format: typeof SETTINGS_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  appVersion?: string;
  settings: Record<string, string>;
}

export function buildSettingsExport(
  all: Record<string, string | null>,
  meta: { appVersion?: string; now?: Date } = {},
): { doc: SettingsExportDoc; count: number; skipped: number; scrubbed: number } {
  const settings: Record<string, string> = {};
  let skipped = 0;
  let scrubbed = 0;
  for (const key of Object.keys(all).sort()) {
    const raw = all[key];
    if (raw === null || raw === undefined) continue;
    if (!isTransferableSettingKey(key)) {
      skipped += 1;
      continue;
    }
    const r = scrubValue(raw);
    // 清洗不干净(嵌套/体积超限)= **fail-closed 丢弃整条**。绝不能让它以原样进导出文件
    // —— 那正是密钥从深层漏出的口子(MC-024)。宁可丢掉一条带不走的偏好,也不留下一条
    // 可能含密钥的整块配置。
    if (r.rejected) {
      skipped += 1;
      continue;
    }
    scrubbed += r.scrubbed;
    settings[key] = r.value;
  }
  return {
    doc: {
      format: SETTINGS_EXPORT_FORMAT,
      version: SETTINGS_EXPORT_VERSION,
      exportedAt: (meta.now ?? new Date()).toISOString(),
      ...(meta.appVersion ? { appVersion: meta.appVersion } : {}),
      settings,
    },
    count: Object.keys(settings).length,
    skipped,
    scrubbed,
  };
}

/**
 * 别人给的设置文件里,自定义 UI 的「运行终端命令」项一律改回「运行前确认」—— 否则导入一份
 * 设置就等于多了几个点一下就静默跑命令的按钮。「自定义面板」同理:去掉联网、回到确认(R41)。只动 `action.type === "shell"` 的 `confirm`,
 * 其余原样;解析不了就原样返回(读配置那一侧本来就会 coerce / 丢弃坏数据)。
 */
export function forceShellConfirm(raw: string): string {
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!cfg || typeof cfg !== "object") return raw;
  const items = (cfg as { items?: unknown }).items;
  if (!Array.isArray(items)) return raw;
  let changed = false;
  for (const it of items) {
    const action = it && typeof it === "object" ? (it as { action?: unknown }).action : undefined;
    if (action && typeof action === "object" && (action as { type?: unknown }).type === "shell" && "confirm" in action) {
      delete (action as { confirm?: unknown }).confirm;
      changed = true;
    }
    // R41 自定义面板:别人给的面板一律「不联网 + 有副作用的操作每次确认」—— 否则导入一份
    // 设置就多了一个能静默跑自动化 / 写文件、还能把读到的东西发出去的面板。
    if (action && typeof action === "object" && (action as { type?: unknown }).type === "panel") {
      for (const k of ["confirm", "network"] as const) {
        if (k in action) {
          delete (action as { confirm?: unknown; network?: unknown })[k];
          changed = true;
        }
      }
    }
  }
  return changed ? JSON.stringify(cfg) : raw;
}

export type ParsedSettingsImport =
  | { ok: true; entries: Array<[string, string]>; skipped: string[] }
  | { ok: false; error: string };

/** 解析 + 校验导入文件。只返回允许写的键;被挡下的键名放在 skipped 里给界面看。 */
export function parseSettingsImport(text: string): ParsedSettingsImport {
  let obj: unknown;
  try {
    obj = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err) {
    return { ok: false, error: `不是有效的 JSON:${(err as Error).message}` };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "文件内容不是 Mcode 设置导出文件" };
  const o = obj as Partial<SettingsExportDoc>;
  if (o.format !== SETTINGS_EXPORT_FORMAT) return { ok: false, error: "文件内容不是 Mcode 设置导出文件(缺少 format 标记)" };
  // 【MC-026 复核】版本闸 fail-closed 且**说清是哪种不对**:
  //  - 缺席 / 不是数字:不是本格式的有效文件(旧实现把它和"比当前新"混成一句假话);
  //  - 非正整数(`0` / `-1` / `1.5` / `NaN`):没有任何已发布版本产生过这种值,拒;
  //  - 比当前新:让用户先升级(绝不能按当前语义硬套未来文件);
  //  - **比当前旧**:当前只有 v1,没有旧版本需要换算;将来升到 v2 时,这里必须显式
  //    写一条迁移,而不是让旧语义文件悄悄套进新版本(读到 v2 的代码之前,旧文件一律拒)。
  if (typeof o.version !== "number") {
    return { ok: false, error: "导出文件缺少版本号(version),无法确认它的格式" };
  }
  if (!Number.isInteger(o.version) || o.version < 1) {
    return { ok: false, error: `导出文件版本号无效(${String(o.version)}),这不是 Mcode 产生的设置文件` };
  }
  if (o.version > SETTINGS_EXPORT_VERSION) {
    return { ok: false, error: `导出文件版本(${String(o.version)})比当前 Mcode 支持的新,请先升级 Mcode` };
  }
  if (o.version < SETTINGS_EXPORT_VERSION) {
    // 当前 `SETTINGS_EXPORT_VERSION` 仍是 1,走不到这里;这是给"将来升版本"留的
    // fail-closed 闸:没有显式迁移就不许把旧文件按新语义导入。
    return { ok: false, error: `导出文件版本(${String(o.version)})比当前 Mcode 支持的旧,暂不支持自动降级导入` };
  }
  if (!o.settings || typeof o.settings !== "object" || Array.isArray(o.settings)) {
    return { ok: false, error: "文件里没有 settings 字段" };
  }
  const entries: Array<[string, string]> = [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(o.settings as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length > 2_000_000 || !isTransferableSettingKey(k)) {
      skipped.push(k);
      continue;
    }
    const scrubbed = scrubValue(v);
    // 导入侧与导出侧同一道 fail-closed:清洗不干净(嵌套/体积超限)就**整条拒绝**,
    // 绝不写进库(文件可能是手改的,正是 MC-024 说的那条口子的另一个入口)。
    if (scrubbed.rejected) {
      skipped.push(k);
      continue;
    }
    const clean = scrubbed.value;
    if (k === CUSTOM_UI_SETTING_KEY) {
      // 导入是 customUi.config.v1 的**第二个写者**,必须过 `setting.set` 那道同一份校验
      // (`validateCustomUiWrite`:重复 id / 非法动作组合 / 动态 shell 模板)—— 否则同一份
      // 非法配置手工写当场被拒、从文件导进来却照收,两个写者就此漂移(硬规矩 2)。
      // 挡下的整条键进 skipped 交给界面,不因此让整次导入失败(同"被挡下的键名"那条语义)。
      const forced = forceShellConfirm(clean);
      try {
        validateCustomUiWrite(forced);
      } catch {
        skipped.push(k);
        continue;
      }
      entries.push([k, forced]);
      continue;
    }
    entries.push([k, clean]);
  }
  if (entries.length > 5000) return { ok: false, error: "设置项数量异常(超过 5000 条)" };
  return { ok: true, entries, skipped };
}
