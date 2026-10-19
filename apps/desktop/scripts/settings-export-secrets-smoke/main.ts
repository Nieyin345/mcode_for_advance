/**
 * settings-export-secrets-smoke — 「导出设置」**绝不带密钥**这条承诺的回归网。
 *
 * ## 盯的是什么
 *
 * `settingsTransfer.ts` 的文件头逐字写着:「**绝不导出的**:密钥类:API Key、令牌、
 * 密码、cookie、公网 MCP 密钥、手机配对设备、隧道 token」。它靠两把筛子实现:键名
 * 正则(`SECRET_KEY_RE`)+ 精确/前缀排除表。而**第三条路漏了**:
 *
 * 自定义模型的密钥存在设置表的 `customModelKeys` 键里(见 `main/lib/secretStore.ts`),
 * 值是 `id → base64(密文)`,**在 `safeStorage` 不可用的机器上是明文 base64**
 * (`encrypt()` 的降级路径就在那儿,只打一句 warn)。这个键名既不含 `key`/`token`/
 * `secret` 里的任何一个词(它是 `customModel**Keys**`,正则匹配的是
 * `api[-_.]?key|apikey|...` —— `Keys` 不在表内),也不在精确/前缀排除表里。于是
 * **导出设置会把全部自定义模型密钥写进那个 JSON 文件** —— 而用户导出它正是为了
 * 分享/搬机器。
 *
 * 判据立在「导出文档里有没有它」,不是立在"正则怎么写"—— 所以撤掉排除项时必红。
 *
 * ## 它怎么跑
 *
 * `settingsTransfer.ts` 不 import electron(文件头写了),esbuild 打包后直接 node 跑。
 *
 * Run: scripts/settings-export-secrets-smoke/run.sh
 */
import {
  buildSettingsExport,
  isTransferableSettingKey,
  scrubSecrets,
} from "@main/settings/settingsTransfer.js";
import { isSecretSettingKey } from "@main/lib/secretKeys.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** 一批**真实存在**的、含密钥或密钥本体的设置键。 */
const SECRET_KEYS = [
  // 自定义模型密钥本体(密文或降级后的明文 base64)。
  "customModelKeys",
  // Pi / Codex 的密钥本体(同样是 safeStorage 密文,与 customModelKeys 同一个形状)。
  "piProviderKeys",
  "codexProviderKeys",
  // 其它已知的密钥/凭据类键,一并钉住。
  "browser.cookieVault",
  "browser.cookieVault.enc",
  "browser.persistLogin",
  "mobile.login",
  "relay.vpsConfig",
  "onlyoffice.config",
];

// The explicit secret-key list covers names like onlyoffice.config that do
// not contain words such as "token" or "password". Unlike the regex fallback,
// Set.has is case-sensitive. A case variant must not escape the export filter.
const CASED_SECRET_KEYS = [
  "RELAY.VPSCONFIG", "ONLYOFFICE.CONFIG",
  "PUBLICMCP.PROJECTLINKS", "MCP.MANAGEMENT",
  "MOBILE.PAIREDDEVICES",
];
for (const k of CASED_SECRET_KEYS) {
  check(`★ 显式凭据设置的大小写变体必须仍被识别: ${k}`, isSecretSettingKey(k));
  check(`★ 显式凭据设置的大小写变体不能进入导出: ${k}`, !isTransferableSettingKey(k));
}
{
  const input: Record<string, string> = { "ui.locale": "zh" };
  for (const k of CASED_SECRET_KEYS) input[k] = "SENTINEL-SHOULD-NOT-EXPORT";
  const { doc } = buildSettingsExport(input, { appVersion: "0.0.0" });
  check("★ 带大小写混排的密钥设置真实导出结果无泄漏",
    CASED_SECRET_KEYS.every((k) => !(k in doc.settings)), doc.settings);
  check("★ 普通界面语言依然允许导出", doc.settings["ui.locale"] === "zh");
}

// Local OS trust and runtime state are also non-transferable. The explicit
// security-grant and local-state prefix tables were case-sensitive, while
// exported setting keys may include aliases originating from a plugin.
const CASED_LOCAL_TRUST = [
  "MCP.PROJECTTRUST", "AGENTSSH.KNOWNHOSTS",
  "AGENTSSH.FUTUREGRANT", "MCP.TRUST.FUTURE",
  "SECURITYGRANT.PROJECTS", "MOBILE.PORT",
  "AUTOMATION.LASTMINUTE", "RELAY.HOSTNAME",
];
for (const k of CASED_LOCAL_TRUST) {
  check(`★ 不同大小写的信任/本机状态绝不允许迁移: ${k}`, !isTransferableSettingKey(k));
}
{
  const all: Record<string, string> = { "ui.locale": "en" };
  for (const k of CASED_LOCAL_TRUST) all[k] = "LOCAL-TRUST-SENTINEL";
  const { doc } = buildSettingsExport(all, { appVersion: "0.0.0" });
  check("★ 混合大小写的信任/本机状态不能真实进入导出 JSON",
    CASED_LOCAL_TRUST.every((k) => !(k in doc.settings)), doc.settings);
  check("★ 安全过滤后普通 ui.locale 仍可迁移", doc.settings["ui.locale"] === "en");
}

console.log("导出设置:密钥类设置键一律不导出");
for (const key of SECRET_KEYS) {
  check(`★ ${key} 不可导出`, !isTransferableSettingKey(key), { key });
}

// ── 【MC-031 / MC-052】安全授信键 —— 不是密钥,但同样**绝不可迁移** ──
//
// 这些存的是"用户在本机明确批准过的信任决定"(SSH 主机指纹、项目 MCP 信任)。键名不含
// 任何密钥词,所以两道密钥筛子都拦不住 —— 但它们随设置备份**导入**的后果是:一份被
// 诱导导入的"设置备份"能预先写好用户对某台服务器 / 某个仓库的信任。独立复核实测过
// `mcp.projectTrust` 与 `agentSsh.knownHosts` 都曾 transferable=true。
console.log("\n导出设置:安全授信键不导出(不只是密钥)");
{
  const TRUST_KEYS = [
    "mcp.projectTrust",      // 项目 MCP 信任指纹(某仓库 .mcp.json 命令的批准)
    "agentSsh.knownHosts",   // SSH agent 的 known-hosts 指纹表
    // ⚠️ **将来新增的授信键**也必须被挡 —— 判据是**类别**(前缀/清单),不是逐个硬编码。
    // 这里用一个"还没人加过"的键验证:`mcp.trust.future` 命中 `mcp.trust` 前缀、
    // `agentSsh.futureGrant` 命中 `agentSsh.` 前缀 —— 都应被拒,无需再改这份清单。
    "mcp.trust.future",
    "agentSsh.futureGrant",
    "securityGrant.projects",
  ];
  for (const key of TRUST_KEYS) {
    check(`★ ${key} 不可导出(安全授信)`, !isTransferableSettingKey(key), { key });
  }
  // 反向控制:正常的可迁移偏好**照常**过 —— 别把判据写成一刀切。
  check("正控:外观偏好仍可迁移", isTransferableSettingKey("ui.appearance.theme"), true);
  check("正控:通用偏好仍可迁移", isTransferableSettingKey("ui.locale"), true);
  // 端到端:夹带授信键的导出文档里不得出现它们。
  const all: Record<string, string | null> = {};
  for (const k of TRUST_KEYS) all[k] = "SHOULD-NOT-LEAK";
  all["ui.locale"] = "zh";
  const { doc } = buildSettingsExport(all, { appVersion: "0.0.0" });
  const trustLeaked = TRUST_KEYS.filter((k) => k in doc.settings);
  check("★ 导出文档里没有任何安全授信键", trustLeaked.length === 0, { trustLeaked });
  check("正控:同一份文档里普通偏好照常导出", doc.settings["ui.locale"] === "zh");
}

// 端到端:整张表过一遍 buildSettingsExport,导出文档的 settings 里不得出现任何一个。
{
  const all: Record<string, string | null> = {};
  for (const k of SECRET_KEYS) all[k] = "SHOULD-NOT-LEAK";
  // 加一条**该导出**的偏好键作正控 —— 证明这套筛子不是"把什么都排掉"。
  all["ui.locale"] = "zh";
  const { doc } = buildSettingsExport(all, { appVersion: "0.0.0" });
  const leaked = SECRET_KEYS.filter((k) => k in doc.settings);
  check("★ 导出文档里没有任何密钥设置键", leaked.length === 0, { leaked });
  check("正控:普通偏好键照常导出", doc.settings["ui.locale"] === "zh", doc.settings);
  check("正控:另一条普通键也不受影响", isTransferableSettingKey("ui.accentColor"), true);
}

// ── 会话派生内容:不是密钥,但同样不能进那个"拿去分享"的 JSON ──
//
// 文件头承诺的还有"绝不导出…按项目 id 存的东西(换台电脑对不上)"。记忆助手的
// `memory.assistant.job.<id>` 值里带着 `result` —— AI 从用户对话里整理出的交接材料。
// 键名不含任何密钥词,两道密钥筛子都拦不住,只能按前缀排。
console.log("\n导出设置:会话派生的记忆助手状态不导出");
{
  const LOCAL_STATE_KEYS = [
    "memory.assistant.job.7f3a-uuid",
    "memory.assistant.source.sess-abc",
    "memory.assistant.target.sess-def",
    // 代理挂账:值里带着模型问出去的那句 question + 机器本地会话 id。
    "agentMail.pendingAsks",
  ];
  const all: Record<string, string | null> = {};
  for (const k of LOCAL_STATE_KEYS) {
    all[k] = JSON.stringify({ result: "用户对话的 AI 摘要,不该出现在分享文件里" });
  }
  all["ui.locale"] = "zh"; // 正控
  const { doc } = buildSettingsExport(all, { appVersion: "0.0.0" });
  const leaked = LOCAL_STATE_KEYS.filter((k) => k in doc.settings);
  check("★ 记忆助手的运行时状态键不导出", leaked.length === 0, { leaked });
  check("正控:普通偏好键仍导出", doc.settings["ui.locale"] === "zh", doc.settings);
}

// ── 值里的密钥字段:深度清洗不能只认恰好等于 `apiKey` 的那种名 ──
//
// `customModels` 是**公开元数据**(该导出),但它的 `customHeaders` 里放的常常就是网关
// 的鉴权头 —— 而用户管它叫 `x-api-key` / `x-auth-token` / `Authorization` 都属常见。
// 若清洗只认 `^api[-_]?key$` 这种"整名恰好相等",这些前缀/后缀命名的头就原样导出去。
console.log("\n值清洗:常见鉴权头名一律打码");
{
  const [clean, n] = scrubSecrets({
    id: "c1",
    name: "gateway",
    customHeaders: {
      "x-api-key": "sk-live-REAL",
      "x-auth-token": "tok-REAL",
      Authorization: "Bearer REAL",
      "api-key": "sk-REAL",
      "X-Api-Key": "sk-REAL2",
      "x-tenant": "acme", // 正控:非密钥头必须留下
    },
  }) as [Record<string, unknown>, number, boolean];
  const headers = clean.customHeaders as Record<string, string> | undefined;
  check("★ x-api-key 被清洗", !("x-api-key" in (headers ?? {})), headers);
  check("★ x-auth-token 被清洗", !("x-auth-token" in (headers ?? {})), headers);
  check("★ Authorization 被清洗", !("Authorization" in (headers ?? {})), headers);
  check("★ X-Api-Key(带前缀大写)被清洗", !("X-Api-Key" in (headers ?? {})), headers);
  check("正控:非密钥头 x-tenant 保留", headers?.["x-tenant"] === "acme", headers);
  check("清洗计数 ≥ 5", n >= 5, { n });

  // ⚠️ **反向控制:不能把"恰好含 token 字样"的非密钥字段一起删掉。** 放宽正则最
  // 容易踩的就是这个 —— `runtime.turnBudget` 的值里就有 `maxTotalTokens`,用量快照里
  // 有 `totalTokens` / `cacheReadTokens`。被误删的字段是**真的会跟着导出**的偏好,悄悄
  // 少一项比多清洗一处更难查。判据:这些名字必须**原样留下**。
  const [, keepN] = scrubSecrets({
    maxTotalTokens: 200000,
    maxTurns: 30,
    maxUsd: 5,
    totalTokens: 100,
    cacheReadTokens: 50,
    turnProcessedTokens: 10,
    outputTokens: 20,
    tokenBudget: 200000,
    shortKeys: ["a"],
  }) as [unknown, number, boolean];
  check("★ 含 token 字样但非密钥的字段不被误删", keepN === 0, { keepN });
}

// ── MC-024:嵌套超过 20 层时**不得原样保留**,必须 fail-closed ──
//
// 从前的 `depth > 20 → return [value, 0]` 把没洗过的整棵子树原样留下 —— 只要把密钥塞进
// 一个 21+ 层深的 `{a:{a:{…}}}` 里,`SECRET_FIELD_RE` 就永远够不到那个叶节点,导出文件
// 里带着明文密钥走出去。判据立在"深层叶密钥绝不出现" + "整条设置被丢弃"上。
console.log("\n深层嵌套:超过上限 fail-closed,绝不原样保留(MC-024)");
{
  // 把 apiKey 埋在 30 层深的叶子里。
  let leaf: Record<string, unknown> = { apiKey: "sk-DEEP-REAL" };
  for (let i = 0; i < 30; i++) leaf = { nested: leaf };
  const [clean, , overflow] = scrubSecrets(leaf) as [unknown, number, boolean];
  check("★ 超深嵌套被判 overflow(清洗不干净)", overflow === true, { overflow });
  check("★ 超深嵌套的清洗结果里不含原样叶密钥", JSON.stringify(clean ?? null).indexOf("sk-DEEP-REAL") === -1, { clean });
  // 导出文档里也绝不能出现这条带深层密钥的整块配置。
  const { doc } = buildSettingsExport({ "customUi.blocks": JSON.stringify(leaf) }, { appVersion: "0.0.0" });
  check("★ 超深嵌套的整条设置被丢弃(不写进导出文档)", !("customUi.blocks" in doc.settings), doc.settings);
  check("★ 丢弃的整条不出现在导出文本里", JSON.stringify(doc).indexOf("sk-DEEP-REAL") === -1);

  // 正控:20 层以内、结构正常的偏好照常导出(证明 fail-closed 没有把普通嵌套一起误杀)。
  const shallow = { a: { b: { c: { theme: "dark" } } } };
  const [cleanShallow, , overflowShallow] = scrubSecrets(shallow) as [unknown, number, boolean];
  check("正控:普通浅嵌套不被判 overflow", overflowShallow === false, { overflowShallow });
  check(
    "正控:普通浅嵌套的内容照常保留",
    (cleanShallow as { a: { b: { c: { theme: string } } } }).a.b.c.theme === "dark",
    cleanShallow,
  );
  const { doc: docShallow } = buildSettingsExport({ "ui.layout": JSON.stringify(shallow) }, { appVersion: "0.0.0" });
  check("正控:普通嵌套偏好照常导出", "ui.layout" in docShallow.settings, docShallow.settings);
}

// ── MC-024:导出侧超大配置不吃满内存 / 不卡死;节点预算耗尽也 fail-closed ──
console.log("\n大配置:节点预算耗尽即 fail-closed,不逐节点爆炸(MC-024)");
{
  // 一个 > 20 万节点的数组 —— 清洗在预算处停下并判 overflow,而不是把整棵走完。
  const big = { rows: Array.from({ length: 250_000 }, (_, i) => ({ i })) };
  const t0 = Date.now();
  const [, , overflow] = scrubSecrets(big) as [unknown, number, boolean];
  const ms = Date.now() - t0;
  check("★ 节点数超预算判 overflow", overflow === true, { overflow });
  check("★ 清洗在预算内快速停下(没有把 25 万节点全走完)", ms < 3000, { ms });
  // 未超预算的中等数组正常清洗、不判 overflow。
  const medium = { rows: Array.from({ length: 1000 }, (_, i) => ({ i })) };
  const [, , overflowMed] = scrubSecrets(medium) as [unknown, number, boolean];
  check("正控:中等数组不判 overflow", overflowMed === false, { overflowMed });
}

// ── 【MC-024 字节预算】字节预算必须按 **UTF-8 字节**计量,不是 UTF-16 码元 ──
//
// `scrubSecrets` 的默认预算是 `nodes/bytes` 两个数,`bytes` 由 `SCRUB_MAX_BYTES` 兜底 ——
// 名字、注释与选它做 DoS 防线("防御极端大对象拖死 / 卡死主进程")都按**字节**说。从前
// 它减的是 `value.length`(UTF-16 码元):一个汉字 `length` 是 1 却占 3 个 UTF-8 字节,
// 一段中文/emoji 配置的真实体积可达"字面长度"的两三倍都不触发溢出 —— 字节红线对多字节
// 内容形同虚设(与 MC-033 的收件箱字节封顶同一类缺陷)。
console.log("\n字节预算:按 UTF-8 字节计量,多字节内容不虚报为未超");
{
  // 「日本語日本語」= 6 个 UTF-16 码元,却是 18 个 UTF-8 字节。预算给 10 字节:按真实
  // 字节数(18 > 10)处理完它后预算应已耗尽,令下一个节点判 overflow;按 `String.length`
  // (6)则会虚留 4 字节、放行 —— 判据立在"多字节内容真的按字节记账"上。
  const cfg = { a: "日本語日本語", b: { c: 1 } };
  const [, , overflowMb] = scrubSecrets(cfg, 0, { nodes: 100, bytes: 10 }) as [unknown, number, boolean];
  check("★ 多字节字符串按 UTF-8 字节计预算(超预算判 overflow)", overflowMb === true, { overflowMb });
  // 正控:结构相同、纯 ASCII(a~z 与 UTF-8 字节数一致)在 10 字节预算内不判 overflow。
  const ascii = { a: "abcdef", b: { c: 1 } };
  const [, , overflowAscii] = scrubSecrets(ascii, 0, { nodes: 100, bytes: 10 }) as [unknown, number, boolean];
  check("正控:同字面长度的 ASCII 内容在预算内不判 overflow", overflowAscii === false, { overflowAscii });
}

console.log("\n【MC-004】密钥键判据唯一一份:三条路(导出 / agent 读设置 / 局域网桥)同源");
{
  // 从前这三处各写一遍、而且**已经漂开**:`appControl/tools.ts` 的孪生正则认
  // `cookieVault` 而 `settingsTransfer.ts` 这条认 `paireddevices` / `passwordlogin`,
  // 手机侧是硬编码两键集合。现在全部从 `@main/lib/secretKeys` 取同一份判据。
  // 这里钉的是**判据本身**的行为(判据立在"这个键被不被当密钥"上,不是"谁 import 了谁")。
  // 三条路各自在漂移里**漏过**的那个键,现在都要被同一份判据认出来。
  const DRIFT_KEYS = [
    "browser.cookieVault",     // 从前 tools.ts 认、settingsTransfer 不认
    "browser.cookieVault.enc", // `.enc` 尾缀(settingsTransfer 认、tools 不认)
    "mobile.pairedDevices",    // 从前手机侧硬编码、settingsTransfer 正则认、tools 不认
    "mobile.passwordLogin",    // 同上
    // 结构性形状:全小写/全大写也不该骗过判据。
    "providerkeys",
    "PROVIDERTOKENS",
    // 显式名单层。
    "relay.vpsConfig",
    "onlyoffice.config",
    "publicMcp.projectLinks",
    "mcp.management",
  ];
  const missed = DRIFT_KEYS.filter((k) => !isSecretSettingKey(k));
  check("★ MC-004:漂移里漏过的键,共享判据全部认出来", missed.length === 0, missed);
  // 导出侧用它当第一道闸 —— 每个漂移键都不可导出。
  const leaked = DRIFT_KEYS.filter((k) => isTransferableSettingKey(k));
  check("★ MC-004:这些键经导出侧也不可迁移", leaked.length === 0, leaked);
  // 正控:公开元数据 `customModels` 仍可导出(它由 scrubSecrets 深度清洗,不是密钥本体)。
  // 判据立在"元数据照常搬走"上 —— 若有人把它塞进共享密钥名单,这条会红。
  check("★ MC-004 正控:customModels(公开元数据)仍可导出", isTransferableSettingKey("customModels") === true);
  check("正控:普通偏好仍可导出", isTransferableSettingKey("ui.locale") === true);
  // 正控:不是密钥的键**不**被共享判据误伤 —— 否则手机壳读不到自己的偏好。
  const NOT_SECRET = ["ui.locale", "ui.appearance.theme", "workflow.maxParallel", "ui.voiceEngine"];
  const overblocked = NOT_SECRET.filter((k) => isSecretSettingKey(k));
  check("正控:普通偏好键不被误判成密钥", overblocked.length === 0, overblocked);
}

console.log("\n【MC-026 复核】真实敏感键清单:从生产定义处取,不用手写样例");
{
  // 判据立在三件事上:
  //  1. 用**生产代码里的定义**(contracts 导出的键常量 / 密钥清单模块)构造夹具,
  //     而不是在测试里手打一串"看起来像密钥"的字符串 —— 手写的样例会在键改名时
  //     悄悄变成测一个不存在的键;
  //  2. 每个真实敏感键都**不可导出**,且**不出现在导出文档里**;
  //  3. 正控:同一份文档里普通偏好照常导出(证明不是一刀切)。
  //
  // ⚠️ 有些键的定义模块会拉进原生依赖(`agentRemoteSsh.ts` → ssh2 → cpu-features),
  // 纯模块 smoke 打包不了;那几条改用**源码锚定**:读定义文件断言字面量确实在那里,
  // 再把真值喂给判据。锚定失败(键改了名)= 红,而不是静默测空气。

  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const contracts = await import("@contracts/ipc");
  const mobile = await import("@contracts/mobile");
  const relay = await import("@contracts/relay");
  const { SECRET_SETTING_KEYS } = await import("@main/lib/secretKeys.js");

  // ── ① 从定义处取的敏感键(contracts / 共享密钥清单) ──
  const REAL_SENSITIVE = [
    contracts.BROWSER_COOKIE_VAULT_SETTING_KEY,
    contracts.BROWSER_COOKIE_VAULT_ENC_SETTING_KEY,
    contracts.MCP_MANAGEMENT_SETTING_KEY,
    contracts.MCP_PROJECT_TRUST_SETTING_KEY,
    contracts.ONLYOFFICE_CONFIG_SETTING_KEY,
    relay.RELAY_CONFIG_SETTING_KEY,
    contracts.PUBLIC_MCP_SECRET_SETTING_KEY,
    contracts.PUBLIC_MCP_PROJECT_LINKS_SETTING_KEY,
    contracts.PUBLIC_MCP_TUNNEL_TOKEN_SETTING_KEY,
    mobile.MOBILE_PAIRED_DEVICES_SETTING_KEY,
    mobile.MOBILE_LOGIN_SETTING_KEY,
    mobile.MOBILE_TUNNEL_TOKEN_SETTING_KEY,
    ...SECRET_SETTING_KEYS,
  ];
  const mustNotExport = REAL_SENSITIVE;
  const leakedReal = mustNotExport.filter((k) => isTransferableSettingKey(k));
  check("★ 生产定义处的敏感键全部不可导出", leakedReal.length === 0, { leakedReal });

  // 每个都必须被**导出侧的迁移判据**挡下(密钥本体走共享的 `isSecretSettingKey`,
  // 安全授信走 `isTransferableSettingKey` 里的授信族判据 —— 两条闸,同一出口)。
  // 不要求每个都进 `isSecretSettingKey`:授信键不是密钥,但它们同样**绝不可导出**。
  const notRecognized = mustNotExport.filter((k) => !isSecretSettingKey(k) && isTransferableSettingKey(k));
  check("★ 每个真实敏感键都被某一条闸挡下(密钥判据或授信判据)", notRecognized.length === 0, { notRecognized });

  // ── ② 源码锚定:定义模块不能 import 的那几条 ──
  const anchor = (file: string, key: string): boolean =>
    readFileSync(join(process.cwd(), file), "utf8").includes(`"${key}"`);
  const ANCHORED: Array<[string, string]> = [
    ["src/main/mcp/agentRemoteSsh.ts", "agentSsh.knownHosts"],
    ["src/main/mcp/agentRemoteSsh.ts", "agentSsh.hostTrustGrants"],
    ["src/main/providers/bridge/extensionBridge.ts", "web.bridgeToken"],
    ["src/main/lib/secretStore.ts", "customModelKeys"],
    ["src/main/lib/piModelsStore.ts", "piProviderKeys"],
    ["src/main/lib/codexModelsStore.ts", "codexProviderKeys"],
    ["src/main/lib/secretStore.ts", "customModels"], // 公开元数据(正控)
  ];
  for (const [file, key] of ANCHORED) {
    check(`锚定:${key} 确实定义在 ${file}`, anchor(file, key));
  }
  const anchoredSensitive = ANCHORED.map(([, k]) => k).filter((k) => k !== "customModels");
  const anchoredLeak = anchoredSensitive.filter((k) => isTransferableSettingKey(k));
  check("★ 源码锚定的敏感键全部不可导出", anchoredLeak.length === 0, { anchoredLeak });
  check("正控:customModels(公开元数据)仍可导出", isTransferableSettingKey("customModels") === true);

  // ── ③ 端到端:整张表喂进去,真实敏感键一条都不得出现在导出文档里 ──
  const all: Record<string, string | null> = { "ui.locale": "zh", "ui.appearance.theme": "dark" };
  for (const k of [...mustNotExport, ...anchoredSensitive]) all[k] = "SHOULD-NOT-LEAK";
  const { doc } = buildSettingsExport(all, { appVersion: "0.0.0" });
  const endToEndLeak = [...mustNotExport, ...anchoredSensitive].filter((k) => k in doc.settings);
  check("★ 导出文档里没有任何真实敏感键", endToEndLeak.length === 0, { endToEndLeak });
  check("正控:同一份文档里普通偏好照常导出", doc.settings["ui.locale"] === "zh" && doc.settings["ui.appearance.theme"] === "dark");
}

console.log("\n【MC-026 复核】未知/未来偏好键:导入侧不静默丢,往返保全");
{
  // 台账要求"未知键被保全或明确拒绝,不是静默丢"。当前设计是**保全**:
  // 名字合法、不命中密钥/授信/本机状态判据的键(例如未来版本新增的一条偏好)导入时
  // 照常 upsert,再次导出时原样带回去 —— 新旧版本之间往返不丢数据。
  // 这里钉住这个方向:它若哪天被改成"悄悄丢掉",这条会红。
  const { parseSettingsImport } = await import("@main/settings/settingsTransfer.js");
  const futureKey = "futureFeature.newPreference";
  const parsed = parseSettingsImport(JSON.stringify({
    format: "mcode-settings", version: 1, exportedAt: "",
    settings: { [futureKey]: "v2-value", "ui.locale": "en" },
  }));
  check("未知偏好键被接受(不是静默丢)", parsed.ok === true && parsed.entries.some(([k]) => k === futureKey), parsed);
  if (parsed.ok) {
    const { doc } = buildSettingsExport(Object.fromEntries(parsed.entries), { appVersion: "0.0.0" });
    check("★ 未知偏好键导入后再导出仍在(往返不丢)", doc.settings[futureKey] === "v2-value", doc.settings);
    check("正控:同批普通偏好也在", doc.settings["ui.locale"] === "en");
  }
  // 反面:名字像未来键、但命中密钥/授信判据的 —— 必须明确进 skipped,不是接受。
  const badParsed = parseSettingsImport(JSON.stringify({
    format: "mcode-settings", version: 1, exportedAt: "",
    settings: { "futureFeature.bridgeToken": "leak", "ui.locale": "en" },
  }));
  check(
    "★ 像未来键的敏感键被明确拒绝并计入 skipped(不是静默接受也不是静默丢)",
    badParsed.ok === true && badParsed.skipped.includes("futureFeature.bridgeToken") && !badParsed.entries.some(([k]) => k === "futureFeature.bridgeToken"),
    badParsed,
  );
}

console.log(`\nsettings-export-secrets-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
