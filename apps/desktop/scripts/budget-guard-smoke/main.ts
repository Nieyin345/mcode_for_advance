/**
 * Headless smoke for the turn-policy pipeline (main/lib/turnPolicy.ts).
 *
 * S3 轮预算和 S4 失败回退链的入口都是设置表里的一段 JSON,而且它们坏掉的
 * 方式特别危险:**坏配置不能弄瘫回合**。这里钉死三类边界:
 *
 * 1. parseTurnBudget —— 关/坏 JSON/空上限/负数/零/非数值,全部安全降级;
 * 2. parseFallbackModels —— 坏 JSON/非数组/混合元素/首尾空白,全部安全降级;
 * 3. budgetViolations —— 三判的"恰好到达即停"语义(enforceBudget 在发
 *    turn.notice + interrupt 之前跑的就是它;emit/interrupt 副作用要活的
 *    RuntimeManager,靠手测)。
 *
 * Run: scripts/budget-guard-smoke/run.sh
 */
import { budgetViolations, parseFallbackModels, parseTurnBudget, parseTurnBudgetDetailed, lastGoodTurnBudgetKey } from "@main/lib/turnPolicy.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ────────────────────── 1. 轮预算解析 ────────────────────── */

console.log("\nparseTurnBudget(设置 JSON → 预算,坏输入全降级)");

eq("没有存值 → 无预算", parseTurnBudget(null), undefined);
eq("空串 → 无预算", parseTurnBudget(""), undefined);
eq("坏 JSON → 无预算(不抛)", parseTurnBudget("{ 这不是 JSON"), undefined);
eq("顶层是数组 → 无预算", parseTurnBudget("[]"), undefined);
eq("顶层是数字 → 无预算", parseTurnBudget("42"), undefined);
eq("null 字面量 → 无预算", parseTurnBudget("null"), undefined);

eq("开关关着 → 无预算", parseTurnBudget(JSON.stringify({ enabled: false, maxTurns: 3 })), undefined);
eq("开关缺着 → 无预算", parseTurnBudget(JSON.stringify({ maxTurns: 3 })), undefined);
eq("开了但一个上限都没有 → 无预算", parseTurnBudget(JSON.stringify({ enabled: true })), undefined);

const full = parseTurnBudget(JSON.stringify({ enabled: true, maxTurns: 5, maxUsd: 0.5, maxTotalTokens: 120000 }));
check("三上限齐全 → 全收", full !== undefined, full);
eq("maxTurns", (full as { maxTurns?: number } | undefined)?.maxTurns, 5);
eq("maxUsd", (full as { maxUsd?: number } | undefined)?.maxUsd, 0.5);
eq("maxTotalTokens", (full as { maxTotalTokens?: number } | undefined)?.maxTotalTokens, 120000);

// 小数轮数要取整(界面输入不拦 2.5,但预算只能按整轮算)。
eq(
  "小数轮数向下取整",
  (parseTurnBudget(JSON.stringify({ enabled: true, maxTurns: 2.9 })) as { maxTurns?: number } | undefined)?.maxTurns,
  2,
);
eq(
  "小数 token 同样取整",
  (parseTurnBudget(JSON.stringify({ enabled: true, maxTotalTokens: 99.9 })) as { maxTotalTokens?: number } | undefined)
    ?.maxTotalTokens,
  99,
);
// 花费是小数语义,不取整 —— 0.05 美元的上限是合法的。
eq(
  "花费不取整",
  (parseTurnBudget(JSON.stringify({ enabled: true, maxUsd: 0.05 })) as { maxUsd?: number } | undefined)?.maxUsd,
  0.05,
);

eq("零上限 → 当作没设", parseTurnBudget(JSON.stringify({ enabled: true, maxTurns: 0 })), undefined);
eq("负上限 → 当作没设", parseTurnBudget(JSON.stringify({ enabled: true, maxUsd: -1 })), undefined);
eq(
  "NaN/Infinity → 当作没设",
  parseTurnBudget(JSON.stringify({ enabled: true, maxTurns: "3", maxUsd: null })),
  undefined,
);
// 【第 38 章】一个合法一个非法**不再**"合法的那个活下来" —— 用户启用预算却有一项格式不合法,
// 说明配置坏了,整体判 INVALID(有合法 maxTurns 也**不挑着用**、不悄悄放宽),由上层拒绝/提示重设。
const mixedDetailed = parseTurnBudgetDetailed(JSON.stringify({ enabled: true, maxTurns: 4, maxUsd: "很多" }));
eq("★ 一个合法一个非法 → 整体 INVALID(不挑好的用)", mixedDetailed.status, "INVALID");
eq("★ 且不产出任何预算(不悄悄放宽)", mixedDetailed.budget, undefined);
// 兼容视图:旧 parseTurnBudget 也不返回"只剩合法项"的预算。
eq("★ 旧视图同样不返回半套预算", parseTurnBudget(JSON.stringify({ enabled: true, maxTurns: 4, maxUsd: "很多" })), undefined);

/* ────────────────────── 2. 回退链解析 ────────────────────── */

console.log("\nparseFallbackModels(设置 JSON → 模型链,坏输入全降级)");

eq("没有存值 → 空链", parseFallbackModels(null).length, 0);
eq("空串 → 空链", parseFallbackModels("").length, 0);
eq("坏 JSON → 空链(不抛)", parseFallbackModels("[").length, 0);
eq("非数组 → 空链", parseFallbackModels('{"model":"x"}').length, 0);
eq("对象字面量 → 空链", parseFallbackModels("42").length, 0);

const chain = parseFallbackModels(JSON.stringify(["a", "b"]));
eq("合法链原样", chain.join(","), "a,b");
check(
  "首尾空白去掉、空项过滤",
  parseFallbackModels(JSON.stringify([" a ", "", "   ", "b", 42, null])).join(",") === "a,b",
  parseFallbackModels(JSON.stringify([" a ", "", "   ", "b", 42, null])),
);
check(
  "全非法 → 空链",
  parseFallbackModels(JSON.stringify([1, null, true])).length === 0,
);

/* ────────────────────── 3. 预算三判 ────────────────────── */

console.log("\nbudgetViolations(enforceBudget 发 notice 前的三判)");

// 语义:**恰好到达即停** —— 预算是"最多允许",不是"超过才管"。
eq("全部未超 → 空", budgetViolations({ maxTurns: 3, maxUsd: 1, maxTotalTokens: 1000 }, 2, 0.9, 999).length, 0);
eq("恰好到达轮数 → 触发", budgetViolations({ maxTurns: 3 }, 3, 0, 0).length, 1);
eq("恰好到达花费 → 触发", budgetViolations({ maxUsd: 1 }, 0, 1, 0).length, 1);
eq("恰好到达 token → 触发", budgetViolations({ maxTotalTokens: 1000 }, 0, 0, 1000).length, 1);
eq("差一点 → 不触发", budgetViolations({ maxTurns: 3, maxUsd: 1, maxTotalTokens: 1000 }, 3 - 1, 0.99, 1000 - 1).length, 0);

const multi = budgetViolations({ maxTurns: 2, maxUsd: 0.5, maxTotalTokens: 100 }, 5, 2, 500);
eq("三上限同时爆 → 三条理由", multi.length, 3);
check("理由带具体数字(卡片正文要能看懂是哪项爆了)", multi[0].includes("5/2"), multi);

// 没设的上限永远不触发 —— 这是"部分预算"(只限花费不限轮数)能成立的前提。
eq("只设花费时轮数再大也不管", budgetViolations({ maxUsd: 1 }, 99, 0.1, 999999).length, 0);
eq("空预算对象 → 永不触发", budgetViolations({}, 99, 99, 99).length, 0);

/* ───────────── 【MC-083】坏配置**不得**悄悄退化成"不限制" ───────────── */

console.log("\nparseTurnBudgetDetailed(三态 + last-good 恢复,坏配置不静默失效)");

{
  const KEY = "runtime.turnBudget";
  const lg = lastGoodTurnBudgetKey(KEY);
  eq("last-good 键是主键派生", lg, "runtime.turnBudget.last-good");

  // 从没设过 → MISSING(合法不限制)。
  const missing = parseTurnBudgetDetailed(null);
  eq("没设过 → MISSING(合法不限制)", missing.status, "MISSING");
  eq("MISSING 无预算", missing.budget, undefined);

  // 坏 JSON → INVALID(**不是**"用户主动关"),无备份时 budget undefined 但状态是 INVALID。
  const bad = parseTurnBudgetDetailed("{ 这不是 JSON", null);
  eq("★ 坏 JSON → INVALID(不是静默无限制)", bad.status, "INVALID");
  eq("★ INVALID 无备份时 recovered=false", bad.recovered, false);
  check("★ INVALID 带可读原因", typeof bad.error === "string" && bad.error.length > 0, bad.error);

  // 用户**明确关闭** → DISABLED(合法不限制,与损坏不同)。
  eq("明确关闭 → DISABLED(合法不限制)", parseTurnBudgetDetailed(JSON.stringify({ enabled: false, maxTurns: 3 })).status, "DISABLED");

  // 合法 → VALID。
  eq("合法配置 → VALID", parseTurnBudgetDetailed(JSON.stringify({ enabled: true, maxUsd: 1 })).status, "VALID");

  // 坏主键 + 有 last-good 备份 → INVALID 但**恢复**出最后确认有效的预算。
  const lastGood = JSON.stringify({ enabled: true, maxUsd: 0.5, maxTurns: 4 });
  const recovered = parseTurnBudgetDetailed("{ 坏了", lastGood);
  eq("★ 坏主键 + 有 last-good → INVALID 且 recovered=true", recovered.recovered, true);
  eq("★ 恢复出的是最后确认有效的预算(不静默变无限)", recovered.budget?.maxUsd, 0.5);
  eq("★ 恢复的 maxTurns 也在", recovered.budget?.maxTurns, 4);

  // last-good 备份本身是"明确关闭" → 恢复成合法的无预算(不复活旧限制)。
  const recDisabled = parseTurnBudgetDetailed("{ 坏了", JSON.stringify({ enabled: false }));
  eq("★ last-good 是明确关闭 → 恢复成合法无预算", recDisabled.budget, undefined);
  eq("★ 且 recovered=true(备份是有效的关闭)", recDisabled.recovered, true);

  // 【第 38 章】`enabled:true` 却没有任何有效上限 → **INVALID**(不是 VALID),不得静默变无限额。
  const noLimit = parseTurnBudgetDetailed(JSON.stringify({ enabled: true }));
  eq("★ enabled:true 但无任何上限 → INVALID(不静默变无限)", noLimit.status, "INVALID");
  eq("★ 且 budget 是 undefined、recovered=false(无备份)", noLimit.budget, undefined);
  eq("★ recovered 为 false", noLimit.recovered, false);

  // 【第 43 章 §43.3】`enabled` 是**显式非布尔值**(字符串 "off" / null / 数字 1)→ INVALID,
  // **不是** MISSING(不能把"显式类型损坏"当成"用户没配置",否则消费端对 MISSING 不拒绝 → 丢额度)。
  for (const badEnabled of ["off", null, 1, 0, {}] as const) {
    const r = parseTurnBudgetDetailed(JSON.stringify({ enabled: badEnabled, maxUsd: 1 }));
    eq(`★ enabled=${JSON.stringify(badEnabled)} 显式非布尔 → INVALID(不当成未配置)`, r.status, "INVALID");
  }
  // 对照:真正**缺** enabled 键 → MISSING(合法);enabled:false → DISABLED(合法)。
  eq("★ 缺 enabled 键 → MISSING(合法)", parseTurnBudgetDetailed(JSON.stringify({ maxUsd: 1 })).status, "MISSING");
  eq("★ enabled:false → DISABLED(合法不限制)", parseTurnBudgetDetailed(JSON.stringify({ enabled: false, maxUsd: 1 })).status, "DISABLED");

  // 【第 38 章】字段格式不合法(非数/负数/小数)→ INVALID,不能悄悄丢掉最后一个限制。
  const badField = parseTurnBudgetDetailed(JSON.stringify({ enabled: true, maxUsd: "not-number", maxTurns: 0.2, maxTotalTokens: -8 }));
  eq("★ 上限字段全不合法(enabled:true)→ INVALID(不静默放宽)", badField.status, "INVALID");

  // 【第 38 章】last-good 备份本身 `enabled:true` 无有效上限 → **不算可恢复**(否则拒绝闸失效)。
  const badRecovery = parseTurnBudgetDetailed("{ 坏了", JSON.stringify({ enabled: true, maxUsd: "not-number" }));
  eq("★ 坏主键 + 无效的 last-good(enabled:true 无有效上限)→ recovered=false", badRecovery.recovered, false);
  eq("★ 且 budget 仍是 undefined(不假装恢复出限额)", badRecovery.budget, undefined);

  // 小数非法输入:0.2 轮不能经 floor 变成 0(0 不是合法预算)。
  const frac = parseTurnBudgetDetailed(JSON.stringify({ enabled: true, maxTurns: 0.2, maxTotalTokens: 0.9 }));
  eq("★ 0.2 轮不产生 0 预算(非法输入被挡)", frac.budget, undefined);
  eq("○ 且 0.2 这类非法字段使配置判为 INVALID(不静默丢字段)", frac.status, "INVALID");

  // 正控:只要有一项有效上限,其余非法字段仍使整体 INVALID(不挑好的用、悄悄放宽)。
  const mixed = parseTurnBudgetDetailed(JSON.stringify({ enabled: true, maxUsd: 1, maxTurns: 0.2 }));
  eq("★ 有合法 maxUsd 但 maxTurns 非法 → 整体 INVALID(不挑好的用)", mixed.status, "INVALID");
}

// 消费端接线:RuntimeManager 必须据 status 决定"拒绝自动执行",而不是把 INVALID 当合法不限制。
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/main/claude/RuntimeManager.ts"), "utf8");
  check("★ RuntimeManager 用带状态解析(parseTurnBudgetDetailed),不是无状态 parseTurnBudget", /parseTurnBudgetDetailed\(/.test(src) && !/rt\.budget = parseTurnBudget\(/.test(src), null);
  // 断言 INVALID 分支**可达**(不是被 `false &&` 之类短路掉)—— 且体内真的 throw。
  check("★ RuntimeManager 对 INVALID 拒绝本轮执行(不静默变无限制)", /(^|[^&\w])if \(budgetRead\.status === "INVALID" && !budgetRead\.recovered\)[\s\S]{0,260}throw new Error/.test(src), null);
  check("★ RuntimeManager 读 last-good 备份键", /lastGoodTurnBudgetKey\(/.test(src), null);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);