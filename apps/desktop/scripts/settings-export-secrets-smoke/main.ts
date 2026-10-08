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

// ── 值里的密钥字段:深度清洗不能只认恰好等于 `apiKey` 的那种名字 ──
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
  }) as [Record<string, unknown>, number];
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
  }) as [unknown, number];
  check("★ 含 token 字样但非密钥的字段不被误删", keepN === 0, { keepN });
}

console.log(`\nsettings-export-secrets-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
