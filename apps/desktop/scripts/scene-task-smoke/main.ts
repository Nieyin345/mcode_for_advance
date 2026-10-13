/**
 * Headless smoke for ARC-013 第一片 —— 场景任务谱系 + 场景级预算账户。
 *
 * 被测:`@main/orchestration/sceneTaskRegistry.ts`(`SceneTaskRegistry` +
 * `SceneBudgetAccounts`,纯内存、不碰 DB / electron / RuntimeManager)。
 *
 * ## 这一片在证什么
 *
 * 今天 Agent 能开新会话、能发消息,但没有场景级父子任务与总预算;
 * `RuntimeManager.turnBudget` 每轮 `sendTurn` 归零,只限一轮。这一片把
 * **归属链 + 总账**的纯核心立起来,并钉死它的每一条"越界必须拒绝"。
 *
 * ## 失败矩阵(每条都要求"结构化拒绝",不是静默放行)
 *
 * 1. 谱系记对:子任务的 parentTaskId / depth / sceneId 来自父,generation 随状态迁移自增。
 * 2. 超出 maxFanout → REFUSED(不是继续派生)。
 * 3. 超出 maxDepth → REFUSED。
 * 4. 场景不一致 / 父已终态 / 过截止 → 各自 REFUSED。
 * 5. 预算超预留 → REFUSED;**成本未知 → 保守上限**(不是 0,不是放行)。
 * 6. 取消传播到全部后代(幂等);暂停传播到活跃后代。
 * 7. **两个场景预算独立**:A 超支不影响 B。
 * 8. **伪造防线**:invocation 里塞假的 originAgentId / budgetAccountId,
 *    落成的子任务仍取父真值 —— 模型改不了预算归属。
 *
 * ## RED 例(旧行为会放它过去)
 *
 * 台账原话:"旧的普通 chat 会允许无限 fan-out / 每轮重置预算"。这里用一段
 * **模拟旧模型**的循环(无 fan-out 上限、每轮归零)证明它真的会放无限派生过;
 * 同一场景下 `SceneTaskRegistry` 在第 N 个就拒。这条对比断言是"红例"的锚 ——
 * 它证明被测核心确实比旧模型多拦了一层,而不是摆设。
 *
 * Run: scripts/scene-task-smoke/run.sh
 */
import {
  SceneBudgetAccounts,
  SceneTaskRegistry,
  UNKNOWN_COST_USD_UPPER_BOUND,
  UNKNOWN_TOKENS_UPPER_BOUND,
  isTerminalState,
} from "@main/orchestration/sceneTaskRegistry.js";
import {
  assembleSceneRuntime,
  cancelSceneTask,
  ensureSceneBudgetAccount,
  getSceneRegistry,
  getSceneBudgetAccounts,
  markSceneExternalAction,
  parseSceneBudgetLimits,
  releaseSceneReservation,
  reserveSceneBudget,
  sceneCancelReport,
  setSceneRuntime,
  settleSceneReservation,
} from "@main/orchestration/sceneTaskRuntime.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskInvocation } from "@contracts/sceneTask.js";
import { resolveConfigBinding, staleBindings } from "@contracts/configBinding.js";

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

/** 造一份宿主铸造的 TaskInvocation(测试里手填全部字段)。 */
function inv(over: Partial<TaskInvocation> & { taskId: string; sceneId: string }): TaskInvocation {
  return {
    parentTaskId: null,
    sessionId: null,
    originAgentId: "agent_root",
    providerId: "claude-sdk",
    triggerOrigin: "scene",
    allowedCapabilities: ["fs"],
    budgetAccountId: "acct_default",
    maxFanout: 5,
    maxDepth: 3,
    deadline: null,
    ...over,
  };
}

/* ─────────────────── 1. 谱系记对 ─────────────────── */

console.log("\n谱系:parentTaskId / depth / sceneId / generation");

{
  const reg = new SceneTaskRegistry();
  const root = reg.createRootTask(inv({ taskId: "t_root", sceneId: "s1" }));
  check("根任务建成功", root.ok, root);
  if (root.ok) {
    eq("根 depth=0", root.value.depth, 0);
    eq("根 parentTaskId=null", root.value.parentTaskId, null);
    eq("根初始状态 pending", root.value.state, "pending");
    eq("根 generation 初值 0", root.value.generation, 0);
  }

  const childRes = reg.spawn("t_root", inv({ taskId: "t_b", parentTaskId: "t_root", sceneId: "s1", originAgentId: "FAKE", budgetAccountId: "FAKE_ACCT" }));
  check("子任务派生成功", childRes.ok, childRes);
  if (childRes.ok) {
    eq("子 parentTaskId 指向根", childRes.value.parentTaskId, "t_root");
    eq("子 depth=1", childRes.value.depth, 1);
    eq("子 sceneId 取自父", childRes.value.sceneId, "s1");
    eq("子 maxDepth 已减 1", childRes.value.maxDepth, 2);
  }

  const grand = reg.spawn("t_b", inv({ taskId: "t_c", parentTaskId: "t_b", sceneId: "s1" }));
  if (grand.ok) eq("孙 depth=2", grand.value.depth, 2);
  eq("根的直接子任务只有 t_b", reg.childrenOf("t_root").join(","), "t_b");
  eq("t_b 的直接子任务只有 t_c", reg.childrenOf("t_b").join(","), "t_c");

  const s1 = reg.setState("t_b", "running");
  check("迁移到 running 成功", s1.ok, s1);
  if (s1.ok) eq("generation 自增到 1", s1.value.generation, 1);

  // 突变:从内部偷改 getTask 返回的副本,不能影响内部真值。
  const copy = reg.getTask("t_b")!;
  copy.state = "completed";
  eq("getTask 返回副本,改它不影响内部状态", reg.getTask("t_b")?.state, "running");
}

/* ─────────────────── 2. maxFanout 越界必须拒 ─────────────────── */

console.log("\nmaxFanout:超出即 REFUSED(不静默放行)");

{
  const reg = new SceneTaskRegistry();
  reg.createRootTask(inv({ taskId: "r", sceneId: "s1", maxFanout: 2 }));
  const a = reg.spawn("r", inv({ taskId: "c1", parentTaskId: "r", sceneId: "s1" }));
  const b = reg.spawn("r", inv({ taskId: "c2", parentTaskId: "r", sceneId: "s1" }));
  check("前两个子任务建成功", a.ok && b.ok, { a, b });
  const over = reg.spawn("r", inv({ taskId: "c3", parentTaskId: "r", sceneId: "s1" }));
  check("第 3 个(超 maxFanout=2)被拒", !over.ok, over);
  if (!over.ok) eq("拒绝码 = MAX_FANOUT_EXCEEDED", over.code, "MAX_FANOUT_EXCEEDED");
  eq("活跃子任务数停在 2", reg.activeChildCount("r"), 2);

  // 一个子任务进入终态 → 名额释放,又能派生。
  reg.setState("c1", "completed");
  eq("终态后活跃子任务降到 1", reg.activeChildCount("r"), 1);
  const after = reg.spawn("r", inv({ taskId: "c3b", parentTaskId: "r", sceneId: "s1" }));
  check("终态释放名额后可再派生", after.ok, after);
}

/* ─────────────────── 3. maxDepth 越界必须拒 ─────────────────── */

console.log("\nmaxDepth:超出即 REFUSED");

{
  const reg = new SceneTaskRegistry();
  // maxDepth=2:根(0) → c1(1) → c2(2) 可到,再往下 depth 会到 3,超。
  reg.createRootTask(inv({ taskId: "r", sceneId: "s1", maxDepth: 2, maxFanout: 9 }));
  const c1 = reg.spawn("r", inv({ taskId: "c1", parentTaskId: "r", sceneId: "s1", maxDepth: 9 }));
  const c2 = reg.spawn("c1", inv({ taskId: "c2", parentTaskId: "c1", sceneId: "s1", maxDepth: 9 }));
  check("到 depth=2 仍可建", c1.ok && c2.ok, { c1, c2 });
  const c3 = reg.spawn("c2", inv({ taskId: "c3", parentTaskId: "c2", sceneId: "s1", maxDepth: 9 }));
  check("再深一层(maxDepth 耗尽)被拒", !c3.ok, c3);
  if (!c3.ok) eq("拒绝码 = MAX_DEPTH_EXCEEDED", c3.code, "MAX_DEPTH_EXCEEDED");
}

/* ─────────────────── 4. 其它派生前置条件 ─────────────────── */

console.log("\n其它前置:场景不一致 / 父终态 / 过截止");

{
  const reg = new SceneTaskRegistry(() => 1000);
  reg.createRootTask(inv({ taskId: "r", sceneId: "s1", deadline: 500 }));
  // 父已过截止(now=1000 > deadline=500)。
  const late = reg.spawn("r", inv({ taskId: "c1", parentTaskId: "r", sceneId: "s1" }));
  check("父过截止 → REFUSED", !late.ok, late);
  if (!late.ok) eq("拒绝码 = DEADLINE_PASSED", late.code, "DEADLINE_PASSED");

  const reg2 = new SceneTaskRegistry();
  reg2.createRootTask(inv({ taskId: "r", sceneId: "s1" }));
  const mismatch = reg2.spawn("r", inv({ taskId: "x", parentTaskId: "r", sceneId: "s_OTHER" }));
  check("场景不一致 → REFUSED", !mismatch.ok, mismatch);
  if (!mismatch.ok) eq("拒绝码 = SCENE_MISMATCH", mismatch.code, "SCENE_MISMATCH");

  const reg3 = new SceneTaskRegistry();
  reg3.createRootTask(inv({ taskId: "r", sceneId: "s1" }));
  reg3.setState("r", "cancelled");
  const afterTerminal = reg3.spawn("r", inv({ taskId: "c1", parentTaskId: "r", sceneId: "s1" }));
  check("父已终态 → REFUSED", !afterTerminal.ok, afterTerminal);
  if (!afterTerminal.ok) eq("拒绝码 = PARENT_TERMINAL", afterTerminal.code, "PARENT_TERMINAL");

  const missing = reg3.spawn("nope", inv({ taskId: "c9", parentTaskId: "nope", sceneId: "s1" }));
  check("父不存在 → REFUSED", !missing.ok, missing);
  if (!missing.ok) eq("拒绝码 = PARENT_NOT_FOUND", missing.code, "PARENT_NOT_FOUND");
}

/* ─────────────────── 5. 预算:预留 / 结算 / 未知保守上限 ─────────────────── */

console.log("\n预算账户:预留、超预留拒绝、未知成本走保守上限、结算");

{
  const accts = new SceneBudgetAccounts();
  accts.createAccount("acct_A", "s1", { maxTokens: 1000, maxCostUsd: 2, maxConcurrency: 2 });

  // 预留一单:600 token,$1.2。
  const r1 = accts.reserve("acct_A", { tokens: 600, costUsd: 1.2, concurrency: 1 }, "t1");
  check("首单预留成功", r1.ok, r1);
  if (r1.ok) eq("预留凭据带账户 id", r1.value.accountId, "acct_A");

  // 再预留 600 token → 600+600=1200 > 1000,拒。
  const r2 = accts.reserve("acct_A", { tokens: 600, costUsd: 0.1, concurrency: 1 }, "t2");
  check("token 超上限 → RETURN BUDGET_EXCEEDED", !r2.ok, r2);
  if (!r2.ok) eq("拒绝码 = BUDGET_EXCEEDED", r2.code, "BUDGET_EXCEEDED");

  // 并发超上限:已占用 1,再要 2 → 1+2=3 > 2,拒。
  const r3 = accts.reserve("acct_A", { tokens: 100, costUsd: 0.1, concurrency: 2 }, "t3");
  check("并发超上限 → REFUSED", !r3.ok, r3);

  // 结算预留 1:实际只用了 300 token / $0.5。
  const settle = accts.settle((r1 as { ok: true; value: { reservationId: string } }).value.reservationId, { tokens: 300, costUsd: 0.5 });
  check("结算成功", settle.ok, settle);
  if (settle.ok) {
    eq("committed tokens = 300", settle.value.committedTokens, 300);
    eq("committed cost = 0.5", settle.value.committedCostUsd, 0.5);
    eq("预留已全部退回(0)", settle.value.reservedTokens, 0);
    eq("结算笔数 = 1", settle.value.settledCount, 1);
  }

  // 结算后剩下的额度:再预留 600 token(300+600=900 ≤ 1000)应可。
  const r4 = accts.reserve("acct_A", { tokens: 600, costUsd: 0.1, concurrency: 1 }, "t4");
  check("结算后释放的额度可再用", r4.ok, r4);
}

{
  // 未知成本:预留退化为保守上限,而不是 0。
  const accts = new SceneBudgetAccounts();
  // 上限放在保守上限之下 → "未知"这一单必须被拒(证明它按保守上限占账,不是当 0)。
  accts.createAccount("acct_unknown", "s2", { maxTokens: UNKNOWN_TOKENS_UPPER_BOUND - 1 });
  const unknown = accts.reserve("acct_unknown", {}, "tz");
  check("成本未知 → 按保守上限占账并被拒(不是当 0 放行)", !unknown.ok, unknown);
  if (!unknown.ok) eq("拒绝码 = BUDGET_EXCEEDED", unknown.code, "BUDGET_EXCEEDED");

  // 上限恰好等于保守上限 → 通过,且预留值确实是保守上限。
  const accts2 = new SceneBudgetAccounts();
  accts2.createAccount("acct_unknown2", "s2", { maxTokens: UNKNOWN_TOKENS_UPPER_BOUND, maxCostUsd: UNKNOWN_COST_USD_UPPER_BOUND });
  const exact = accts2.reserve("acct_unknown2", {}, "tz2");
  check("上限=保守上限 → 恰好放行", exact.ok, exact);
  if (exact.ok) {
    eq("预留 token = 保守上限", exact.value.tokens, UNKNOWN_TOKENS_UPPER_BOUND);
    eq("预留花费 = 保守上限", exact.value.costUsd, UNKNOWN_COST_USD_UPPER_BOUND);
  }
}

/* ─────────────────── 6. 取消 / 暂停传播到子任务 ─────────────────── */

console.log("\n取消与暂停:传播到全部后代");

{
  const reg = new SceneTaskRegistry();
  reg.createRootTask(inv({ taskId: "r", sceneId: "s1", maxFanout: 9, maxDepth: 9 }));
  reg.spawn("r", inv({ taskId: "b1", parentTaskId: "r", sceneId: "s1", maxDepth: 9 }));
  reg.spawn("r", inv({ taskId: "b2", parentTaskId: "r", sceneId: "s1", maxDepth: 9 }));
  reg.spawn("b1", inv({ taskId: "c1", parentTaskId: "b1", sceneId: "s1", maxDepth: 9 }));
  reg.spawn("c1", inv({ taskId: "d1", parentTaskId: "c1", sceneId: "s1", maxDepth: 9 }));

  const cancelled = reg.cancel("r");
  check("取消根成功", cancelled.ok, cancelled);
  if (cancelled.ok) {
    eq("确定取消集合 = 全部 5 个任务", [...cancelled.value.cancelled].sort().join(","), "b1,b2,c1,d1,r");
    eq("没有 uncertain(纯本地任务)", cancelled.value.uncertain.join(","), "");
  }
  eq("深处后代也被取消", reg.getTask("d1")?.state, "cancelled");
  eq("isTerminalState(cancelled) 为真", isTerminalState(reg.getTask("b2")!.state), true);

  // 幂等:再取消一次不报错、不重复。
  const again = reg.cancel("r");
  check(
    "重复取消幂等(自身已终态不再计入)",
    again.ok && again.value.cancelled.length === 0 && again.value.uncertain.length === 0,
    again,
  );
}

console.log("\n取消诚实性:握着不可中断外部动作 → uncertain,不谎报 cancelled");
{
  // 【ARC-013 剩余项】一条任务取消了、但它正握着 git push/SSH 这类停不掉的外部动作。
  // 记 cancelled 是假成功(不知道副作用做没做);必须记 uncertain 交人核对。
  const reg = new SceneTaskRegistry();
  reg.createRootTask(inv({ taskId: "r", sceneId: "s1", maxFanout: 9, maxDepth: 9 }));
  reg.spawn("r", inv({ taskId: "b_push", parentTaskId: "r", sceneId: "s1", maxDepth: 9 }));
  reg.spawn("r", inv({ taskId: "b_local", parentTaskId: "r", sceneId: "s1", maxDepth: 9 }));
  reg.setState("b_push", "running");
  reg.setState("b_local", "running");

  // 宿主标记:b_push 正起着一个不可中断的外部动作。默认标记是 false。
  eq("新任务默认 externalActionInFlight = false", reg.getTask("b_push")!.externalActionInFlight, false);
  const marked = reg.markExternalAction("b_push", true);
  check("宿主标记外部动作在途", marked.ok, marked);
  eq("标记后 externalActionInFlight = true", reg.getTask("b_push")!.externalActionInFlight, true);

  const out = reg.cancel("r");
  check("取消根成功", out.ok, out);
  if (out.ok) {
    // 有在途外部动作的那条 → uncertain;其余纯本地的那条 → cancelled。
    eq("握着外部动作的任务落 uncertain", out.value.uncertain.join(","), "b_push");
    eq("其余纯本地任务落 cancelled(含自身 r)", [...out.value.cancelled].sort().join(","), "b_local,r");
  }
  eq("b_push 终态 = uncertain", reg.getTask("b_push")?.state, "uncertain");
  eq("uncertain 也是终态(不再派生/推进)", isTerminalState(reg.getTask("b_push")!.state), true);
  eq("b_local 终态 = cancelled", reg.getTask("b_local")?.state, "cancelled");

  // 终态任务不可再改外部动作标记(结构化拒绝,不静默)。
  const late = reg.markExternalAction("b_local", true);
  check("对终态任务标记外部动作 → REFUSED", !late.ok, late);

  // 重来一次,证明标记能撤回:清掉标记后取消,应落回 cancelled(不是永远 uncertain)。
  const reg2 = new SceneTaskRegistry();
  reg2.createRootTask(inv({ taskId: "r", sceneId: "s1", maxFanout: 9, maxDepth: 9 }));
  reg2.spawn("r", inv({ taskId: "b1", parentTaskId: "r", sceneId: "s1", maxDepth: 9 }));
  reg2.setState("b1", "running");
  reg2.markExternalAction("b1", true);
  reg2.markExternalAction("b1", false); // 外部动作已收尾
  const out2 = reg2.cancel("r");
  if (out2.ok) eq("外部动作收尾后再取消 → cancelled(不残留 uncertain)", out2.value.uncertain.join(","), "");
  eq("b1 落 cancelled", reg2.getTask("b1")?.state, "cancelled");
}

{
  const reg = new SceneTaskRegistry();
  reg.createRootTask(inv({ taskId: "r", sceneId: "s1", maxFanout: 9, maxDepth: 9 }));
  reg.spawn("r", inv({ taskId: "b1", parentTaskId: "r", sceneId: "s1", maxDepth: 9 }));
  reg.spawn("b1", inv({ taskId: "c1", parentTaskId: "b1", sceneId: "s1", maxDepth: 9 }));
  const paused = reg.pause("r");
  check("暂停根成功", paused.ok, paused);
  if (paused.ok) eq("暂停集合 = 全部 3 个活跃任务", [...paused.value].sort().join(","), "b1,c1,r");
  eq("暂停后状态 = paused", reg.getTask("c1")?.state, "paused");
  // 暂停非终态:仍占 fan-out 名额,但 can't 再派生(父非终态仍可派生 —— 语义:暂停不封死派生,只停止推进)。
  check("暂停非终态(仍算活跃子任务)", !isTerminalState(reg.getTask("b1")!.state));
}

/* ─────────────────── 7. 两个场景预算互相独立 ─────────────────── */

console.log("\n场景隔离:A 场景超支不影响 B 场景");

{
  const accts = new SceneBudgetAccounts();
  accts.createAccount("acct_A", "sA", { maxTokens: 100 });
  accts.createAccount("acct_B", "sB", { maxTokens: 100 });

  // 把 A 用满。
  const a1 = accts.reserve("acct_A", { tokens: 100 }, "ta");
  check("A 场景用满 100", a1.ok, a1);
  const a2 = accts.reserve("acct_A", { tokens: 1 }, "ta2");
  check("A 场景再要 1 → 拒", !a2.ok, a2);

  // B 场景额度不受影响。
  const b1 = accts.reserve("acct_B", { tokens: 100 }, "tb");
  check("B 场景同额度仍可整额预留(A 超支不牵连 B)", b1.ok, b1);
  eq("A 账户挂账 100", accts.getAccount("acct_A")?.reservedTokens, 100);
  eq("B 账户挂账 100", accts.getAccount("acct_B")?.reservedTokens, 100);
}

/* ─────────────────── 8. 伪造防线:origin / budgetOwner 取父真值 ─────────────────── */

console.log("\n伪造防线:invocation 里塞假 origin/budgetOwner 会被父真值覆盖");

{
  const reg = new SceneTaskRegistry();
  reg.createRootTask(
    inv({ taskId: "r", sceneId: "s1", originAgentId: "REAL_OWNER", budgetAccountId: "REAL_ACCT", maxDepth: 9 }),
  );
  // 模型侧伪造:invocation 声称自己 origin=ATTACKER、预算账户=ATTACKER_ACCT。
  const forged = reg.spawn(
    "r",
    inv({
      taskId: "c_forged",
      parentTaskId: "r",
      sceneId: "s1",
      originAgentId: "ATTACKER",
      budgetAccountId: "ATTACKER_ACCT",
      maxDepth: 9,
    }),
  );
  check("派生本身成功", forged.ok, forged);
  if (forged.ok) {
    eq("originAgentId 仍是父真值(伪造失败)", forged.value.originAgentId, "REAL_OWNER");
    eq("budgetAccountId 仍是父真值(伪造失败)", forged.value.budgetAccountId, "REAL_ACCT");
  }
}

/* ─────────────────── 9. RED 例:旧模型会放无限 fan-out 过 ─────────────────── */

console.log("\nRED 例:模拟旧模型(无场景预算 / 每轮归零)vs 本核心");

{
  // 「旧模型」:没有 maxFanout 概念,每轮预算归零 —— 台账描述的现状。
  // 这里用一个只计数、不设上限的循环,证明旧行为确实放无限派生过。
  let legacyChildren = 0;
  const LEGACY_ATTEMPTS = 50;
  for (let i = 0; i < LEGACY_ATTEMPTS; i++) legacyChildren += 1; // 旧模型:永远成功

  const reg = new SceneTaskRegistry();
  reg.createRootTask(inv({ taskId: "r", sceneId: "s1", maxFanout: 3, maxDepth: 9 }));
  let allowed = 0;
  let refused = 0;
  for (let i = 0; i < LEGACY_ATTEMPTS; i++) {
    const res = reg.spawn("r", inv({ taskId: `c${i}`, parentTaskId: "r", sceneId: "s1", maxDepth: 9 }));
    if (res.ok) allowed += 1;
    else refused += 1;
  }

  eq("旧模型放行无限派生(50 个全过)", legacyChildren, LEGACY_ATTEMPTS);
  eq("本核心只放行 maxFanout=3 个", allowed, 3);
  eq("其余 47 个全被拒(不是静默放行)", refused, LEGACY_ATTEMPTS - 3);
}

/* ─────────────────── 10. MC-081:能力单调收紧(不能扩大父白名单) ─────────────────── */

console.log("\nMC-081 能力继承:子任务只能是父白名单的子集");

{
  const reg = new SceneTaskRegistry(() => 0);
  reg.createRootTask(
    inv({ taskId: "root", sceneId: "s1", allowedCapabilities: ["read-only"], maxDepth: 9, deadline: null }),
  );

  // 子请求把 read-only **加上** shell-admin —— 放宽,必须拒。
  const esc = reg.spawn(
    "root",
    inv({ taskId: "c_esc", parentTaskId: "root", sceneId: "s1", allowedCapabilities: ["read-only", "shell-admin"], maxDepth: 9 }),
  );
  check("子申请父未授权能力(shell-admin)→ REFUSED", !esc.ok, esc);
  if (!esc.ok) eq("拒绝码 = CAPABILITY_ESCALATION", esc.code, "CAPABILITY_ESCALATION");
  eq("被拒后未落任何子任务", reg.getTask("c_esc"), undefined);

  // 子只收窄(read-only 的子集,甚至空集)→ 通过。
  const subset = reg.spawn(
    "root",
    inv({ taskId: "c_sub", parentTaskId: "root", sceneId: "s1", allowedCapabilities: ["read-only"], maxDepth: 9 }),
  );
  check("子收窄为父白名单子集 → 通过", subset.ok, subset);

  const empty = reg.spawn(
    "root",
    inv({ taskId: "c_empty", parentTaskId: "root", sceneId: "s1", allowedCapabilities: [], maxDepth: 9 }),
  );
  check("子收窄为空集 → 通过", empty.ok, empty);
}

/* ─────────────────── 11. MC-081:deadline 单调收紧 + 祖先链 ─────────────────── */

console.log("\nMC-081 截止时刻:子不得晚于父;祖先过截止即拦");

{
  // 子请求更晚的 deadline → 落成时取 min(父有效, 请求)。
  const reg = new SceneTaskRegistry(() => 0);
  reg.createRootTask(inv({ taskId: "root", sceneId: "s1", deadline: 200, maxDepth: 9, maxFanout: 9 }));
  const child = reg.spawn(
    "root",
    inv({ taskId: "c1", parentTaskId: "root", sceneId: "s1", deadline: 99999, maxDepth: 9 }),
  );
  check("子请求更晚 deadline → 仍可派生", child.ok, child);
  if (child.ok) eq("子有效 deadline 被收紧为父的 200", child.value.deadline, 200);

  // 父有限、子请求 null → **不等于无限**,取父的有限值。
  const child2 = reg.spawn(
    "root",
    inv({ taskId: "c2", parentTaskId: "root", sceneId: "s1", deadline: null, maxDepth: 9 }),
  );
  if (child2.ok) eq("子请求 null ≠ 无限,取父的有限截止 200", child2.value.deadline, 200);

  // 时钟推进过根截止 → 深处的孙任务也不能再派生。
  let clock = 100;
  const reg2 = new SceneTaskRegistry(() => clock);
  reg2.createRootTask(inv({ taskId: "root", sceneId: "s1", deadline: 200, maxDepth: 9, maxFanout: 9 }));
  const g1 = reg2.spawn("root", inv({ taskId: "c1", parentTaskId: "root", sceneId: "s1", deadline: 500, maxDepth: 9 }));
  check("树上先建一层(父未过截止)", g1.ok, g1);
  if (g1.ok) eq("该层 deadline 也收到 200", g1.value.deadline, 200);
  clock = 300; // 越过根截止
  const g2 = reg2.spawn("c1", inv({ taskId: "gc1", parentTaskId: "c1", sceneId: "s1", deadline: 99999, maxDepth: 9 }));
  check("根已过截止 → 孙任务派生被拒(不能靠更晚的子 deadline 绕过)", !g2.ok, g2);
  if (!g2.ok) eq("拒绝码 = DEADLINE_PASSED", g2.code, "DEADLINE_PASSED");
}

/* ─────────────────── 12. MC-081:暂停态父/祖先不得派生 ─────────────────── */

console.log("\nMC-081 生命周期:暂停的父或祖先不得派生新任务");

{
  const reg = new SceneTaskRegistry();
  reg.createRootTask(inv({ taskId: "root", sceneId: "s1", maxDepth: 9, maxFanout: 9 }));
  reg.spawn("root", inv({ taskId: "p", parentTaskId: "root", sceneId: "s1", maxDepth: 9 }));
  reg.pause("p");
  eq("p 已被暂停", reg.getTask("p")?.state, "paused");
  const afterPause = reg.spawn("p", inv({ taskId: "c", parentTaskId: "p", sceneId: "s1", maxDepth: 9 }));
  check("暂停的父不得派生 → REFUSED", !afterPause.ok, afterPause);
  if (!afterPause.ok) eq("拒绝码 = ANCESTOR_INACTIVE", afterPause.code, "ANCESTOR_INACTIVE");

  // 暂停的是**祖先**(非直接父):孙也不得派生。
  const reg2 = new SceneTaskRegistry();
  reg2.createRootTask(inv({ taskId: "root", sceneId: "s1", maxDepth: 9, maxFanout: 9 }));
  reg2.spawn("root", inv({ taskId: "mid", parentTaskId: "root", sceneId: "s1", maxDepth: 9 }));
  reg2.spawn("mid", inv({ taskId: "leaf", parentTaskId: "mid", sceneId: "s1", maxDepth: 9 }));
  reg2.pause("root");
  const deep = reg2.spawn("leaf", inv({ taskId: "gg", parentTaskId: "leaf", sceneId: "s1", maxDepth: 9 }));
  check("暂停的祖先 → 孙任务派生被拒", !deep.ok, deep);
  if (!deep.ok) eq("拒绝码 = ANCESTOR_INACTIVE(祖先)", deep.code, "ANCESTOR_INACTIVE");
}

/* ─────────────────── 13. MC-080:账户身份 + 数值校验 ─────────────────── */

console.log("\nMC-080 预算账户:重复创建拒绝、跨场景冲突、负数额度拒绝、代际结算");

{
  const accts = new SceneBudgetAccounts();
  const created = accts.createAccount("reuse", "scene-A", { maxTokens: 100, maxConcurrency: 1 });
  check("首次建账户成功", created.ok, created);

  const r1 = accts.reserve("reuse", { tokens: 80, concurrency: 1 }, "t1", "scene-A");
  check("首单 80 token 预留成功", r1.ok, r1);
  const r2 = accts.reserve("reuse", { tokens: 80, concurrency: 1 }, "t2", "scene-A");
  check("再要 80 超上限 → 拒(基线)", !r2.ok, r2);

  // 同 id **同场景**再 create → 拒绝,不重置。
  const d1 = accts.createAccount("reuse", "scene-A", { maxTokens: 100, maxConcurrency: 1 });
  check("同 id 同场景重复 create → ACCOUNT_ALREADY_EXISTS(不重置)", !d1.ok, d1);
  if (!d1.ok) eq("拒绝码 = ACCOUNT_ALREADY_EXISTS", d1.code, "ACCOUNT_ALREADY_EXISTS");

  // 同 id **跨场景** create → SCENE_CONFLICT。
  const d2 = accts.createAccount("reuse", "scene-B", { maxTokens: 100, maxConcurrency: 1 });
  check("同 id 跨场景 create → SCENE_CONFLICT", !d2.ok, d2);
  if (!d2.ok) eq("拒绝码 = SCENE_CONFLICT", d2.code, "SCENE_CONFLICT");

  // 关键不变量:重复创建**没有**重置活跃预留。
  eq("账户场景未被改写(仍 scene-A)", accts.getAccount("reuse")?.sceneId, "scene-A");
  eq("活跃预留未被重置", accts.openReservationCount(), 1);
  eq("reservedTokens 仍为 80", accts.getAccount("reuse")?.reservedTokens, 80);
  eq("reservedConcurrency 仍为 1", accts.getAccount("reuse")?.reservedConcurrency, 1);
  const stillRefused = accts.reserve("reuse", { tokens: 80, concurrency: 1 }, "t3", "scene-A");
  check("重复创建后第二单 token80 仍被拒(额度没被击穿)", !stillRefused.ok, stillRefused);

  // 旧凭据结算:归属仍在 scene-A,不跨账;计数不穿负。
  const r1id = (r1 as { ok: true; value: { reservationId: string } }).value.reservationId;
  const settled = accts.settle(r1id, { tokens: 50, costUsd: 0.2 });
  check("旧预留结算到本场景成功", settled.ok, settled);
  if (settled.ok) {
    eq("结算后 reservedTokens=0(不穿负)", settled.value.reservedTokens, 0);
    eq("结算后 reservedConcurrency=0(不穿负)", settled.value.reservedConcurrency, 0);
    eq("committed 记到 scene-A 账户", settled.value.committedTokens, 50);
  }
}

{
  // 负数额度 / NaN / Infinity / 小数并发 —— 一律 INVALID_ESTIMATE,不进计数。
  const accts = new SceneBudgetAccounts();
  accts.createAccount("acct", "s1", { maxTokens: 100, maxCostUsd: 1, maxConcurrency: 2 });

  const neg = accts.reserve("acct", { tokens: -200, costUsd: -1, concurrency: -3 }, "tneg");
  check("负数额度 → REFUSED", !neg.ok, neg);
  if (!neg.ok) eq("拒绝码 = INVALID_ESTIMATE(负)", neg.code, "INVALID_ESTIMATE");

  const nan = accts.reserve("acct", { tokens: NaN, concurrency: 1 }, "tnan");
  check("NaN token → REFUSED", !nan.ok, nan);
  const inf = accts.reserve("acct", { costUsd: Infinity }, "tinf");
  check("Infinity 花费 → REFUSED", !inf.ok, inf);
  const frac = accts.reserve("acct", { concurrency: 1.5 }, "tfrac");
  check("小数并发 → REFUSED", !frac.ok, frac);

  // 以上全被拒 → 账户零占用,超限判定没被负值放大。
  eq("被拒后无任何挂账", accts.openReservationCount(), 0);
  eq("reservedTokens 仍为 0", accts.getAccount("acct")?.reservedTokens, 0);
  eq("reservedConcurrency 仍为 0", accts.getAccount("acct")?.reservedConcurrency, 0);

  // 账户授权场景核对:预留带错 sceneId → SCENE_MISMATCH。
  const wrongScene = accts.reserve("acct", { tokens: 1 }, "tws", "s_OTHER");
  check("预留场景与账户不符 → SCENE_MISMATCH", !wrongScene.ok, wrongScene);
  if (!wrongScene.ok) eq("拒绝码 = SCENE_MISMATCH", wrongScene.code, "SCENE_MISMATCH");

  // 非法上限 → INVALID_LIMITS。
  const badLimits = accts.createAccount("bad", "s1", { maxTokens: -5 });
  check("负数上限 → INVALID_LIMITS", !badLimits.ok, badLimits);
}

{
  // 【MC-080 / 第 40.3 节】**额度配置版本与账户身份代际必须分开**。一次合法的
  // `updateLimits` 只是"用户调整预算上限",**不得**让在途任务已经发生的真实用量无法结算
  // (旧实现 `updateLimits` 自增 `generation`,使旧预留凭据在 settle 时被判 `RESERVATION_STALE`
  //  —— 结果只剩不记用量的 `release` 可行,把已经消费的当 0)。现在改额后旧预留**照常结算**、
  //  新上限对**后续**准入生效。
  const accts = new SceneBudgetAccounts();
  accts.createAccount("gen", "s1", { maxTokens: 1000 });
  const r = accts.reserve("gen", { tokens: 50, costUsd: 2 }, "t1");
  check("预留成功", r.ok, r);
  const rid = (r as { ok: true; value: { reservationId: string } }).value.reservationId;

  const bumped = accts.updateLimits("gen", { maxTokens: 2000 });
  check("受控改额成功", bumped.ok, bumped);
  // 改额**不**自增身份代际(它是额度配置版本,不是账户替换)。
  if (bumped.ok) eq("改额不自增身份代际(generation 保持 0)", bumped.value.generation, 0);

  // ★ 核心判据:改额后旧预留**照样结算真实用量**(不再 RESERVATION_STALE、不丢用量)。
  const settled = accts.settle(rid, { tokens: 20, costUsd: 3 });
  check("★ 改额后旧预留仍可结算(不丢已发生的用量)", settled.ok, settled);
  if (settled.ok) {
    eq("★ 实际用量记进 committed(token)", settled.value.committedTokens, 20);
    eq("★ 实际用量记进 committed(花费)", settled.value.committedCostUsd, 3);
    eq("★ 结算后预留并发/额度已释放", settled.value.reservedTokens, 0);
    eq("★ 结算后无挂账", accts.openReservationCount(), 0);
  }

  // 新上限对**后续**准入生效:改额到 30 后,再预留 40 应被拒(committed 已是 20)。
  accts.updateLimits("gen", { maxTokens: 30 });
  const overAfter = accts.reserve("gen", { tokens: 40 }, "t2");
  check("★ 改额后的新上限对后续预留生效(20 已用 + 40 > 30 → 拒绝)", !overAfter.ok, overAfter);

  // 上限不得压到当前占用之下(占用含 committed)。
  const accts2 = new SceneBudgetAccounts();
  accts2.createAccount("cap", "s1", { maxTokens: 1000 });
  accts2.reserve("cap", { tokens: 500 }, "t1");
  const tooLow = accts2.updateLimits("cap", { maxTokens: 100 });
  check("把上限压到占用之下 → LIMITS_BELOW_USAGE", !tooLow.ok, tooLow);
  if (!tooLow.ok) eq("拒绝码 = LIMITS_BELOW_USAGE", tooLow.code, "LIMITS_BELOW_USAGE");
}

/* ── 【ARC-016】ConfigBinding：锁版 / 实时 的生效版本解析 ──────────────────────
 *
 * 同一档案 id 在普通 chat（PINNED 快照）与工作流 node（LIVE 每轮现读）生效时点不同 ——
 * `resolveConfigBinding` 把「这一轮到底用哪个版本」讲清楚。关键不变量：PINNED 必须给
 * pinnedHash（不许静默退化成 LIVE），源被改过只报 stale、**不改写生效值**。 */
{
  // PINNED:生效值 = 锁定值,且源变了只报 stale。
  const pinned = { assetId: "p1", pinnedHash: "sha256:AAAA", bindingPolicy: "PINNED" as const, effectiveAt: "DEPLOY" as const };
  const r1 = resolveConfigBinding(pinned, "sha256:AAAA");
  eq("PINNED + 源未变 → 生效=锁定值,不 stale", `${r1.effectiveHash}|${r1.stale}`, "sha256:AAAA|false");
  const r2 = resolveConfigBinding(pinned, "sha256:BBBB");
  eq("★ PINNED + 源已变 → 生效仍是锁定值(不改写),stale=true", `${r2.effectiveHash}|${r2.stale}`, "sha256:AAAA|true");
  // LIVE:随源,永远用当前哈希、永不 stale。
  const live = { assetId: "p1", bindingPolicy: "LIVE" as const, effectiveAt: "NEXT_TURN" as const };
  const r3 = resolveConfigBinding(live, "sha256:CCCC");
  eq("LIVE → 生效=当前哈希,不 stale", `${r3.effectiveHash}|${r3.stale}`, "sha256:CCCC|false");
  eq("LIVE + 源消失(null) → 生效 null,不 stale", `${resolveConfigBinding(live, null).effectiveHash}|${resolveConfigBinding(live, null).stale}`, "null|false");
  // 契约错误:PINNED 没给 pinnedHash → 抛(不许静默退化成 LIVE)。
  let threw = false;
  try { resolveConfigBinding({ assetId: "p1", bindingPolicy: "PINNED", effectiveAt: "DEPLOY" }, "sha256:AAAA"); }
  catch { threw = true; }
  check("★ PINNED 缺 pinnedHash → 抛错(不许静默退化成 LIVE)", threw);
  // staleBindings 只挑出落后项。
  eq("staleBindings 只挑落后项", staleBindings([r1, r2, r3]).map((x) => x.assetId).join(","), "p1");
}

/* ─────────────────── 14. ARC-013 步②:取消的 uncertain 接到真实调用端 ───────────────────
 *
 * 上面 §6 钉的是**纯核心**的取消诚实性(registry 自己会落 uncertain)。本段钉的是
 * **调用端**(`sceneTaskRuntime`)—— 那才是「真实取消入口」:它拿 registry 的 CancelOutcome
 * 如实报出来,**绝不把 uncertain 静默吞成「已取消」**。装配点接进启动路径(与 GrantStore
 * 的装配切片同形),全仓此前**没有一处**生产代码消费这个 registry。
 */
console.log("\nARC-013 步②:场景任务运行期入口 —— 装配 + 诚实的取消报告");

{
  // 装配前:读取口已给到一个可用的内存单例(不会 undefined 崩)。
  setSceneRuntime(null);
  const before = getSceneRegistry();
  check("装配前:getSceneRegistry() 已给到一个可用单例(内存版)", before instanceof SceneTaskRegistry, typeof before);

  // 真装配:单例换成装配出来的那一个,装配点可注入时钟(无头可复现)。
  const assembled = assembleSceneRuntime();
  eq("★ 装配后:getSceneRegistry() 拿到的是同一个实例(接线真的接上了)", getSceneRegistry() === assembled, true);

  // 建一条任务并标记它**握着不可中断外部动作**(模拟 git push / SSH 在途)—— 宿主标记口。
  const inv1: TaskInvocation = {
    sceneId: "s_wire", taskId: "t_push", parentTaskId: null, sessionId: "sess_1",
    originAgentId: "host", providerId: "claude-sdk", triggerOrigin: "scene",
    allowedCapabilities: ["fs"], budgetAccountId: "acct_1", maxFanout: 3, maxDepth: 3, deadline: null,
  };
  const created = getSceneRegistry().createRootTask(inv1);
  check("装配后的单例能建根任务", created.ok, created);
  const markedRes = markSceneExternalAction("t_push", true);
  check("宿主经运行期入口标记外部动作在途", markedRes.ok, markedRes);

  // ★ 核心判据:外部动作在途时取消 → 报告**如实**把它记为 uncertain,且**不是**干净的全停。
  const res = cancelSceneTask("t_push");
  check("取消经运行期入口成功返回", res.ok, res);
  if (res.ok) {
    const report = sceneCancelReport(res.value);
    eq("★ 握着外部动作的任务进 uncertain(不谎报 cancelled)", report.uncertain.join(","), "t_push");
    eq("★ 确定停住集合为空(它没被干净停住)", report.cancelled.join(","), "");
    eq("★ 报告不声称干净全停(cleanStop=false)", report.cleanStop, false);
    check("★ 报告把 uncertain 讲出来(不静默吞掉)", /t_push/.test(report.message) && /核对|不确定/.test(report.message), report.message);
  }
  eq("任务终态 = uncertain", getSceneRegistry().getTask("t_push")?.state, "uncertain");

  // 对照:纯本地任务取消 → 干净全停(修复不能把正常路径也报成 uncertain)。
  setSceneRuntime(null);
  const reg2 = assembleSceneRuntime();
  reg2.createRootTask({ ...inv1, taskId: "t_local" });
  const res2 = cancelSceneTask("t_local");
  check("纯本地任务取消成功", res2.ok, res2);
  if (res2.ok) {
    const report2 = sceneCancelReport(res2.value);
    eq("纯本地任务 → cancelled", report2.cancelled.join(","), "t_local");
    eq("纯本地任务 → uncertain 为空", report2.uncertain.join(","), "");
    eq("纯本地任务 → cleanStop=true", report2.cleanStop, true);
  }

  // 取消一个不存在的任务:tid 如实拒绝结构化返回(不静默当成功)。
  const missing = cancelSceneTask("t_nope");
  check("取消不存在的任务 → 结构化拒绝(不静默当成功)", !missing.ok, missing);

  // 复位口:回到全新内存版(用例间隔离)。
  setSceneRuntime(null);
  eq("复位:setSceneRuntime(null) 后是新单例", getSceneRegistry() === assembled, false);
}

/* ─────────────────── 15. 运行期入口不 import electron / 单例唯一 ─────────────────── */
{
  const raw = readFileSync(join(process.cwd(), "src/main/orchestration/sceneTaskRuntime.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("★ 运行期入口不 import electron(无头可 bundle)", !/from\s+"electron/.test(code));
  check(
    "★ 运行期入口不 import 存储层 / RuntimeManager(纯运行期,无副作用)",
    !/from\s+"[^"]*(@main\/store|RuntimeManager|sql\.js)/.test(code),
  );
  const ctorSites = [...code.matchAll(/new SceneTaskRegistry\(/g)].length;
  check("★ new SceneTaskRegistry 只出现在装配/复位默认上", ctorSites === 2, ctorSites);
  // 真实调用端的落点:启动路径装配(index.ts)引用 assembleSceneRuntime。**先剥注释**,
  // 否则一句被注释掉的调用也能骗过正则 —— 那正是「没接线却显示已接线」的假绿。
  const idx = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
  const idxCode = idx.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("★ 启动路径**真的**装配了场景任务运行期入口(真实调用端,不是注释)", /^\s*assembleSceneRuntime\(\);/m.test(idxCode));
}

/* ─────────────────── 16. ARC-013 步③:场景总预算接到真实派发(起前 reserve、收轮 settle) ───────────────────
 *
 * 台账 remaining 点名:「真实 `RuntimeManager.sendTurn` 接线(起子任务前 reserve、收轮后
 * settle)未做」—— 于是 `SceneBudgetAccounts` 只在纯核心里活着,没有一处真实派发受它约束。
 * 本段钉的是**运行期入口**(sceneTaskRuntime)那几个新口,以及**真实调用端**是工作流子任务
 * 派发点(runner.ts 的 runInNodeSession)。派发点本身由 node-live-smoke 驱动真跑;这里钉
 * 它调用的那几个运行期函数,以及 runner.ts 里**真的**接上了 reserve/settle。
 */
console.log("\nARC-013 步③:场景总预算接进真实派发(运行期入口 + 调用端源码断言)");

{
  // 每个用例前清一次:装配 = 一套全新的运行期(注册表与总账一起换)。
  setSceneRuntime(null);

  // ① 设置解析:坏值 / 缺省一律视作「没配」(不是「预算=0」)。
  eq("★ 缺省(空串)→ 没配(null,不是把上限设成 0)", parseSceneBudgetLimits(""), null);
  eq("★ 非 JSON → 没配(null)", parseSceneBudgetLimits("{坏"), null);
  eq("★ 数组形状 → 没配(null)", parseSceneBudgetLimits("[1,2]"), null);
  eq("★ 负数上限 → 没配(null,拒绝坏值)", parseSceneBudgetLimits('{"maxTokens":-1}'), null);
  eq("★ 小数 token → 没配(null)", parseSceneBudgetLimits('{"maxTokens":1.5}'), null);
  eq("★ 空对象 {} → 没配(null,不建一本「不限」的账)", parseSceneBudgetLimits("{}"), null);
  {
    const lim = parseSceneBudgetLimits('{"maxTokens":1000,"maxCostUsd":2.5,"maxConcurrency":3}');
    eq("★ 合法配置 → 三维都解出来", `${lim?.maxTokens}|${lim?.maxCostUsd}|${lim?.maxConcurrency}`, "1000|2.5|3");
  }

  // ② ensureSceneBudgetAccount:首建成,复取**读回同一本账、不清账**。
  const e1 = ensureSceneBudgetAccount("acct_scene", "scene_1", { maxTokens: 1000 });
  check("首建账户成功", e1.ok, e1);
  // 先占一笔,证明复取不重置。
  const r0 = reserveSceneBudget("acct_scene", { tokens: 400 }, "t_keep", "scene_1");
  check("先占一笔 400 token", r0.ok, r0);
  const e2 = ensureSceneBudgetAccount("acct_scene", "scene_1", { maxTokens: 1000 });
  check("★ 同 id 同场景再 ensure → 成功(不报 ACCOUNT_ALREADY_EXISTS)", e2.ok, e2);
  eq("★ 复取读回同一本账(已占 400 没被清零)", getSceneBudgetAccounts().getAccount("acct_scene")?.reservedTokens, 400);
  // 复取后**同一本账**继续约束:committed+reserved 已达 400,再来 700 会超 1000。
  const over = reserveSceneBudget("acct_scene", { tokens: 700 }, "t_over", "scene_1");
  check("★ 复取后超预算仍被拒(约束累积,不是每轮归零)", !over.ok, over);
  if (!over.ok) eq("拒绝码 = BUDGET_EXCEEDED", over.code, "BUDGET_EXCEEDED");

  // ③ 未知成本 → 保守上限占账(不当 0):上限恰等于保守上限时可过,预留值就是保守上限。
  setSceneRuntime(null);
  ensureSceneBudgetAccount("acct_unk", "scene_u", { maxTokens: 1000 });
  const unk = reserveSceneBudget("acct_unk", {}, "t_unk", "scene_u");
  check("★ 成本未知 → 按保守上限占账并被拒(不是当 0 放行)", !unk.ok, unk);

  // ④ settle:按实际用量结算,预留退回、committed 记实。
  setSceneRuntime(null);
  ensureSceneBudgetAccount("acct_s", "scene_s", { maxTokens: 5000, maxCostUsd: 10 });
  const rsv = reserveSceneBudget("acct_s", { tokens: 800, costUsd: 1 }, "t_s", "scene_s");
  check("预留成功", rsv.ok, rsv);
  if (rsv.ok) {
    const st = settleSceneReservation(rsv.value.reservationId, { tokens: 300, costUsd: 0.4 });
    check("结算成功", st.ok, st);
    if (st.ok) {
      eq("★ committed token = 实际 300", st.value.committedTokens, 300);
      eq("★ 预留全退(0)", st.value.reservedTokens, 0);
      eq("结算笔数 = 1", st.value.settledCount, 1);
    }
  }

  // ⑤ release:撤销预留,**不计 committed**(子任务没跑)。
  setSceneRuntime(null);
  ensureSceneBudgetAccount("acct_r", "scene_r", { maxTokens: 5000 });
  const rsv2 = reserveSceneBudget("acct_r", { tokens: 800 }, "t_r", "scene_r");
  if (rsv2.ok) {
    const rel = releaseSceneReservation(rsv2.value.reservationId);
    check("撤销成功", rel.ok, rel);
    if (rel.ok) {
      eq("★ release 后 committed 仍为 0(没跑就不记用量)", rel.value.committedTokens, 0);
      eq("★ release 后预留全退", rel.value.reservedTokens, 0);
      eq("★ release 不增结算笔数", rel.value.settledCount, 0);
    }
  }

  // ⑥ 装配 / 复位都换总账:两个单例同生命周期。
  setSceneRuntime(null);
  const acctA = getSceneBudgetAccounts();
  assembleSceneRuntime();
  eq("★ 装配后总账单例被换新(与注册表同生命周期)", getSceneBudgetAccounts() === acctA, false);
  setSceneRuntime(null);
  eq("★ 复位(null)也换新总账", getSceneBudgetAccounts() === acctA, false);
}

/* ─────────────────── 17. 真实调用端:runner.ts 的子任务派发点真的接上了 reserve/settle ───────────────────
 *
 * 这一段是「不能又是一个没有调用方的纯函数」的判据:派发点(runner.ts 的
 * `runInNodeSession`)必须**真的**挑了 reserve / settle / release / parse。先剥注释 ——
 * 一句被注释掉的调用不许骗过正则(同 §15 那条纪律)。行为本身由 node-live-smoke 驱动
 * 真跑(它真起一次工作流、真走 runInNodeSession);这里钉**接线存在**。
 */
{
  const raw = readFileSync(join(process.cwd(), "src/main/orchestration/runner.ts"), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("★ 派发点真的从设置读场景预算(parseSceneBudgetLimits)", /parseSceneBudgetLimits\(/.test(code));
  check("★ 派发点真的起前预留(reserveSceneBudget)", /reserveSceneBudget\(/.test(code));
  check("★ 派发点真的收轮结算(settleSceneReservation)", /settleSceneReservation\(/.test(code));
  check("★ 派发点真的在用未读到用量时释放预留(releaseSceneReservation,不是当 0 记)", /releaseSceneReservation\(/.test(code));
  check("★ 派发点真的用了设置键(workflow.sceneBudget)", /SCENE_BUDGET_SETTING_KEY/.test(code));
  // 关键:预留必须在 sendTurn **之前**,结算在 finally。用「reserve 出现在 sendTurn 之前」
  // 这一条钉住顺序 —— 若有人把 reserve 挪到回合之后,它就拦不住派发了。
  const reserveAt = code.indexOf("reserveSceneBudget(");
  const sendTurnAt = code.indexOf("runtimeManager.sendTurn(nodeSession");
  check("★ 预留发生在 sendTurn **之前**(起子任务前 reserve)", reserveAt >= 0 && sendTurnAt >= 0 && reserveAt < sendTurnAt, { reserveAt, sendTurnAt });
}

/* ─────────────────── 收尾 ─────────────────── */

console.log(`\nscene-task-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) {
  process.exitCode = 1;
}
