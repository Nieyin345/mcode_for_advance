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
import { validateCustomUiWrite } from "@main/customUi/configValidation.js";

export const SETTINGS_EXPORT_FORMAT = "mcode-settings";
export const SETTINGS_EXPORT_VERSION = 1;

/** key 名里出现这些片段就当密钥,不导出也不导入。
 *
 *  ⚠️ **词尾的 `s?` 不是可有可无的。** 自定义模型密钥存在 `customModelKeys` 里 ——
 *  复数形式。早先这里只认单数(`api[-_.]?key|apikey|token|...`),`Keys` 一个都没命中,
 *  于是那个键从两道筛子里**同时漏过去**(见 `EXCLUDED_KEYS` 里那一条的注释)。复数不该
 *  让一道按名字设的闸门失效。 */
const SECRET_KEY_RE =
  /(api[-_.]?keys?|apikeys?|tokens?|secrets?|passw(or)?ds?|credentials?|cookies?|authorization|private[-_.]?keys?|paireddevices|passwordlogin|\.enc$)/i;

/** **密钥本体**那批键的**结构性**名字:`<某个东西>+Keys/Tokens/Secrets` 结尾
 *  (驼峰或点分)。加密的凭据 map 全仓都是这个形状 —— `customModelKeys`、
 *  `piProviderKeys`、`codexProviderKeys`、`publicMcp.*Secret`。它们**不在**
 *  {@link SECRET_KEY_RE} 里(那个只认 `apiKey`/`token` 这种通用词),而逐个往
 *  `EXCLUDED_KEYS` 里加是**追着漏**的写法 —— 下一个人再加一个 `xxxKeys` 又会忘。
 *  这里按键名的**形状**一次挡住,和 `.enc` 尾缀是同一类判据。 */
const SECRET_STORE_KEY_RE = /(Keys|Tokens|Secrets|Credentials|Passwords)$/i;

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

/** 精确排除的键(本机路径 / 运行状态 / 含密钥的整块配置)。 */
const EXCLUDED_KEYS = new Set<string>([
  // ⚠️ **自定义模型的密钥本体。** 这个键名**不会**被 `SECRET_KEY_RE` 命中 —— 正则认的是
  // `api[-_.]?key` / `apikey`,而它是 `customModel**Keys**(复数)`,两个词都不在表里。
  // 值在 `safeStorage` 不可用的机器上是**明文 base64**(见 `main/lib/secretStore.ts` 的
  // `encrypt()` 降级路径),可逆。少这一条,导出设置就把全部网关密钥写进那个 JSON 文件,
  // 而用户导出它正是为了分享 / 搬机器 —— 与文件头「绝不导出密钥」那句直接相悖。
  // (`customModels` 那一条是**公开元数据**、不含密钥,该照常导出,不要一起排掉。)
  "customModelKeys",
  // ⚠️ **MCP 服务器配置里的凭据。** 每个 server 的 `env`(stdio,常放 `GITHUB_TOKEN`
  // 之类)与 `headers`(http/sse,常放 `Authorization`)是原样保存的 —— 导出设置即是分享,
  // 带着这些键就等于把 API key 写进那个 JSON 文件。键名 `mcp.management` 不被
  // `SECRET_KEY_RE` 命中,所以必须显式列出(与 `appControl/tools.ts` 的 `SECRET_SETTING_KEYS`
  // 同一条:同一个事实两处都要认,别只在一边拦)。
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
  "library.",
  "automation.eventChain.",
  "automation.state.",
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

export function isTransferableSettingKey(key: string): boolean {
  if (!key || key.length > 200) return false;
  if (SECRET_KEY_RE.test(key)) return false;
  if (SECRET_STORE_KEY_RE.test(key)) return false;
  // 【MC-031 / MC-052】安全授信一律不可迁移 —— 单列一类,不是再往排除表里加一条。
  if (SECURITY_GRANT_KEYS.has(key)) return false;
  if (SECURITY_GRANT_PREFIXES.some((p) => key.startsWith(p))) return false;
  if (EXCLUDED_KEYS.has(key)) return false;
  return !EXCLUDED_PREFIXES.some((p) => key.startsWith(p));
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
  if (typeof o.version !== "number" || o.version > SETTINGS_EXPORT_VERSION) {
    return { ok: false, error: `导出文件版本(${String(o.version)})比当前 Mcode 支持的新,请先升级 Mcode` };
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
