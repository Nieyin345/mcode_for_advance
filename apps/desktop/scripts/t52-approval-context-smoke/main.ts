/**
 * 【T52】审批卡必须说出「在改哪一条设置」。
 *
 * ## 病灶
 *
 * `app_api_call` 调 `setting.set` 时，卡上的摘要行取的是 `input` 的第一个值 ——
 * 那是 `method`（`"setting.set"`），于是整张卡只写「setting.set」。
 * 而 `setting.set` 能写设置表里的**任何一条**：快捷键、手势、已配对手机、
 * 各引擎的 API 密钥、插件投递策略。
 *
 * **审批卡上写的东西，必须覆盖它实际能改的范围。** 否则用户点「允许」时，
 * 授权范围远大于他看到的。
 *
 * ## 断言打在哪
 *
 * `toolSummary()` 是摘要行的**唯一来源**（四个调用点共用）。这里直接调它，
 * 喂真实的 `app_api_call` 参数形状 —— 不经过 React，不需要 Electron。
 */
import { toolSummary } from "@renderer/components/chat/activityShared.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 假翻译函数：只把 key 与参数拼出来，验的是「有没有把 key 传进来」。 */
const t = ((key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})` : key) as never;

console.log("\nT52 · 审批卡摘要必须包含设置键名");

/* ── 1. 核心：setting.set 的摘要要点名键名 ── */
{
  const input = { method: "setting.set", input: { key: "ui.shortcuts", value: {} } };
  const s = toolSummary("app_api_call", input, t);
  check("★ setting.set 的摘要带上键名", s.includes("ui.shortcuts"), { summary: s });
  check("★ 摘要不再只是方法名", s !== "setting.set", { summary: s });
  check("★ 用的是 i18n key（不是硬编码中文）", s.startsWith("chatStream.tool.settingWrite"), { summary: s });
}

/* ── 2. 敏感键同样点名 —— 卡上不能因为「敏感」反而更含糊 ── */
for (const key of ["customModelKeys", "relay.vpsConfig", "mobile.pairedDevices", "engine.claude.apiKey"]) {
  const s = toolSummary("app_api_call", { method: "setting.set", input: { key, value: "x" } }, t);
  check(`★ 敏感键 ${key} 也要出现在摘要里`, s.includes(key), { summary: s });
}

/* ── 3. 读设置同样要说明读的是什么 ── */
{
  const s = toolSummary("app_api_call", { method: "setting.get", input: { key: "ui.gestures" } }, t);
  check("★ setting.get 的摘要带上键名", s.includes("ui.gestures"), { summary: s });
}

/* ── 4. 不传 t 时不能崩，退回方法名（四个调用点里可能有人忘了传） ── */
{
  const s = toolSummary("app_api_call", { method: "setting.set", input: { key: "ui.shortcuts" } });
  eq("不传 t 时退回方法名（不崩、不硬编码中文）", s, "setting.set");
}

/* ── 5. 负控：缺 key / key 不是字符串 / 其它方法，都不能编出键名 ── */
{
  eq("input 缺 key 时退回方法名", toolSummary("app_api_call", { method: "setting.set", input: {} }, t), "setting.set");
  eq("key 不是字符串时退回方法名", toolSummary("app_api_call", { method: "setting.set", input: { key: 42 } }, t), "setting.set");
  eq("其它方法仍只显示方法名", toolSummary("app_api_call", { method: "project.create", input: { name: "x" } }, t), "project.create");
}

/* ── 6. 不能影响其它工具的摘要（回归） ── */
{
  eq("Bash 摘要仍是命令", toolSummary("Bash", { command: "ls -la" }, t), "ls -la");
  eq("Read 摘要仍是路径", toolSummary("Read", { file_path: "/tmp/a.txt" }, t), "/tmp/a.txt");
}

/* ── 7. 【写侧拦截】密钥本体不能经 `setting.set` 覆盖 ──
 *
 * 实测（2026-10-23）：改之前 `setting.set` 拿着 `{key:"engine.claude.apiKey"}`
 * 一路放行 —— 读不到但**能覆盖**。对凭据来说覆盖比读取更危险：读到要带走才致命，
 * 覆盖一次就能把用户正在用的引擎换成任意地址。
 */
{
  const { settingKeyRefusal: secretSettingRefusal } = await import("@main/appControl/settingWriteGuard.js");
  const SECRET_KEYS = ["engine.claude.apiKey", "customModelKeys", "codexProviderKeys", "piProviderKeys", "mobile.pairedDevices", "relay.vpsConfig", "onlyoffice.config"];
  for (const key of SECRET_KEYS) {
    const r = secretSettingRefusal("setting.set", { key, value: "attacker" });
    check(`★ setting.set 不能覆盖密钥键 ${key}`, r !== null && String(r).includes(key), { refusal: r });
  }
  for (const key of ["ui.titleGenEnabled", "app.dataRoot", "theme"]) {
    eq(`普通键 ${key} 仍可写`, secretSettingRefusal("setting.set", { key, value: "x" }), null);
  }
  check("★ 读侧拦截仍在（setting.get）", secretSettingRefusal("setting.get", { key: "engine.claude.apiKey" }) !== null);
  check("★ 读侧拦截仍在（setting.getMany）", secretSettingRefusal("setting.getMany", { keys: ["customModelKeys"] }) !== null);
  eq("其它方法不受影响", secretSettingRefusal("project.create", { key: "engine.claude.apiKey" }), null);
}


console.log(`\nt52-approval-context-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
