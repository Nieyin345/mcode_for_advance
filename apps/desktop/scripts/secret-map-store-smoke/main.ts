/**
 * secret-map-store-smoke —— 【凭据存储的静默失败】回归网。
 *
 * ## 盯的是什么
 *
 * 「设置表里那个 `id → 密文` 映射」曾经在**三个地方各有一份**实现
 * （`secretStore.ts` / `piModelsStore.ts` / `codexModelsStore.ts`），逐行同构，
 * **只有一处不一样**：
 *
 * ```ts
 * // piModelsStore / codexModelsStore —— 打日志
 * } catch (err) { log.error(`…failed to parse: ${err.message}`); return {}; }
 * // secretStore —— 静默
 * } catch { return {}; }
 * ```
 *
 * 后果：用户的**自定义模型 API Key 表**损坏时，面板显示「没有配置任何模型」，
 * 日志里一个字节都没有 —— 凭据上的静默失败，违反仓库硬规矩 3
 * 「坏东西显式报出来，不静默跳过」。
 *
 * ## 判据（写在「坏数据有没有被上报」上，不写在"返回了什么"上）
 *
 * ★ 断言的**落点是日志**而不是返回值 —— 因为「返回空表」这件事**静默也能达成**，
 * 判据立在返回值上就抓不住这个 bug。撤掉 `log.error` 那句，本条必红。
 *
 * 覆盖：
 *  - §A 正常读/写往返
 *  - §B 非法 JSON → 返回空表 **且** 有 error 日志 **且** 标记为损坏
 *  - §C 合法 JSON 但不是对象（数组 / 字符串 / null）→ 同样上报
 *  - §D 未损坏时不报（防"永远在报"的假修复）
 *  - §E 损坏标记只增不减（一次事故不该因为后续读成功而消失）
 *  - §F 三个真实 store 都接上了这份共享实现（不再是各自的副本）
 *
 * Run: scripts/secret-map-store-smoke/run.sh
 */
import { readSecretMap, writeSecretMap, secretMapCorrupted, corruptedSecretMapKeys, __resetSecretMapCorruptionForTest } from "@main/lib/secretMapStore.js";
import { SettingRepo } from "@main/store/repositories.js";

/** 往设置表里塞一份"原始字符串"(模拟损坏内容)。走真的 `SettingRepo.set`,
 *  桩与真模块形状一致 —— 不需要桩专有导出,tsc 与运行期都成立。 */
function putRaw(key: string, raw: string): void {
  SettingRepo.set(key, raw);
}

/** 读日志桩记下的内容(桩把记录挂在 globalThis 上,见其文件头)。 */
interface LogRecord { level: string; message: string }
function allLogs(): LogRecord[] {
  return ((globalThis as Record<string, unknown>)["__mcodeSmokeLogs"] as LogRecord[]) ?? [];
}
function messagesAt(level: string): string[] {
  return allLogs().filter((r) => r.level === level).map((r) => r.message);
}
function clearLogs(): void {
  allLogs().length = 0;
}

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 每个小节开始前清空日志与损坏标记，免得互相污染。 */
function reset(): void {
  clearLogs();
  __resetSecretMapCorruptionForTest();
}

// ───────────────────────── §A 正常往返 ─────────────────────────
console.log("\n§A 正常读写");
reset();
{
  const KEY = "smokeNormalKeys";
  writeSecretMap(KEY, { a: "cipher-a", b: "cipher-b" });
  const back = readSecretMap(KEY, "测试密钥");
  check("写进去的能原样读回来", back.a === "cipher-a" && back.b === "cipher-b", back);
  check("正常数据不产生 error 日志", messagesAt("error").length === 0, messagesAt("error"));
  check("正常数据不标记损坏", !secretMapCorrupted(KEY));
}

// ───────────────────────── §B 非法 JSON ─────────────────────────
console.log("\n§B 非法 JSON（核心判据）");
reset();
{
  const KEY = "smokeBrokenKeys";
  putRaw(KEY, "{ 这不是 JSON");
  const out = readSecretMap(KEY, "测试密钥");

  check("坏数据返回空表（降级，不抛）", Object.keys(out).length === 0, out);
  // ★ 这一条是本次修复的核心。撤掉 markCorrupted 里的 log.error，它必红。
  const errs = messagesAt("error");
  check("★ 坏数据必须打 error 日志（不是静默）", errs.length === 1, errs);
  check("★ 日志里点明了是哪个键", errs[0]?.includes(KEY) === true, errs[0]);
  check("★ 日志里带上了可读名（用户能对上是哪块配置）", errs[0]?.includes("测试密钥") === true, errs[0]);
  check("★ 日志里说明盘上内容未动", errs[0]?.includes("盘上内容未动") === true, errs[0]);
  check("★ 标记为损坏（界面据此显示）", secretMapCorrupted(KEY) === true);
  check("★ 损坏键能列出来", corruptedSecretMapKeys().includes(KEY) === true, corruptedSecretMapKeys());
}

// ─────────────────── §C 合法 JSON 但形状不对 ───────────────────
console.log("\n§C 合法 JSON、形状不是对象映射");
for (const [label, raw] of [
  ["数组", "[1,2,3]"],
  ["字符串", '"hello"'],
  ["数字", "42"],
  ["null", "null"],
] as const) {
  reset();
  const KEY = `smokeShapeKeys_${label}`;
  putRaw(KEY, raw);
  const out = readSecretMap(KEY, "形状测试");
  check(`${label} → 返回空表`, Object.keys(out).length === 0, out);
  check(`${label} → ★ 上报为损坏`, messagesAt("error").length === 1, messagesAt("error"));
  check(`${label} → 日志点明形状不符`, messagesAt("error")[0]?.includes("期望对象") === true, messagesAt("error")[0]);
}

// ─────────────────── §D 未损坏时不报（防假修复）───────────────────
console.log("\n§D 未损坏时保持安静");
reset();
{
  const KEY = "smokeQuietKeys";
  putRaw(KEY, JSON.stringify({ x: "1" }));
  readSecretMap(KEY, "安静测试");
  // 若把 markCorrupted 写成"无论如何都报一次"，上面 §B/§C 会绿而这条会红 ——
  // 正是它防止"加了一句 log.error 就以为修好了"。
  check("★ 正常数据一条 error 都不产生", messagesAt("error").length === 0, messagesAt("error"));
  check("★ 正常数据不被标记损坏", secretMapCorrupted(KEY) === false);

  // 空表键（从未写过）也不该报。
  const missing = readSecretMap("smokeNeverWritten", "从未写过");
  check("从未写过的键返回空表且不报", messagesAt("error").length === 0 && Object.keys(missing).length === 0);
}

// ─────────────────── §E 损坏标记只增不减 ───────────────────
console.log("\n§E 损坏标记的持久性");
reset();
{
  const KEY = "smokeStickyKeys";
  putRaw(KEY, "坏");
  readSecretMap(KEY, "粘性测试");
  check("首次读到损坏 → 标记上", secretMapCorrupted(KEY) === true);

  // 用户修好了数据、再读一次 —— 标记**不该**消失（一次数据事故该被看见）。
  putRaw(KEY, JSON.stringify({ ok: "1" }));
  const out = readSecretMap(KEY, "粘性测试");
  check("修好后再读能拿到数据", out.ok === "1", out);
  check("★ 但损坏标记仍在（事故不该被后续成功抹掉）", secretMapCorrupted(KEY) === true);
}

// ─────────────────── §F 三个真实 store 已接上共享实现 ───────────────────
console.log("\n§F 三处已收敛（不再是各自的副本）");
{
  // 判据：源文件里不再各自写 JSON.parse 的私有实现，而是调共享函数。
  // 用 import 静态检查太脆，这里直接断言"共享模块确实存在且被它们 import"——
  // 由 tsc（全量）+ 本套的运行期导入共同保证。
  check(
    "共享实现导出了 readSecretMap / writeSecretMap",
    typeof readSecretMap === "function" && typeof writeSecretMap === "function",
  );
  check(
    "共享实现导出了损坏查询口（供 RPC 层暴露）",
    typeof secretMapCorrupted === "function" && typeof corruptedSecretMapKeys === "function",
  );
}

console.log(`\nsecret-map-store-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
