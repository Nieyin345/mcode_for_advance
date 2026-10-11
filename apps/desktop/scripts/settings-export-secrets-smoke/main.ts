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

console.log(`\nsettings-export-secrets-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
