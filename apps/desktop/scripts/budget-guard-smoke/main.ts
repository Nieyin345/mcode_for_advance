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
import { budgetViolations, parseFallbackModels, parseTurnBudget } from "@main/lib/turnPolicy.js";

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
// 一个合法一个非法:合法的那个要活下来 —— 不能因为一个坏字段把整份预算扔掉。
const mixed = parseTurnBudget(JSON.stringify({ enabled: true, maxTurns: 4, maxUsd: "很多" }));
eq("混合输入里合法字段存活", (mixed as { maxTurns?: number } | undefined)?.maxTurns, 4);
eq("混合输入里非法字段被丢", (mixed as { maxUsd?: number } | undefined)?.maxUsd, undefined);

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

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
