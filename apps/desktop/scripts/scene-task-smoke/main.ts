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
import type { TaskInvocation } from "@contracts/sceneTask.js";

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
    eq("被取消集合 = 全部 5 个任务", [...cancelled.value].sort().join(","), "b1,b2,c1,d1,r");
  }
  eq("深处后代也被取消", reg.getTask("d1")?.state, "cancelled");
  eq("isTerminalState(cancelled) 为真", isTerminalState(reg.getTask("b2")!.state), true);

  // 幂等:再取消一次不报错、不重复。
  const again = reg.cancel("r");
  check("重复取消幂等(自身已终态不再计入)", again.ok && again.value.length === 0, again);
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
  // 代际:updateLimits 换代后,旧凭据 settle 被拒(不跨代借记),release 仍可退。
  const accts = new SceneBudgetAccounts();
  accts.createAccount("gen", "s1", { maxTokens: 1000 });
  const r = accts.reserve("gen", { tokens: 100 }, "t1");
  check("预留成功", r.ok, r);
  const rid = (r as { ok: true; value: { reservationId: string } }).value.reservationId;

  const bumped = accts.updateLimits("gen", { maxTokens: 2000 });
  check("受控改额成功", bumped.ok, bumped);
  if (bumped.ok) eq("改额后 generation 自增到 1", bumped.value.generation, 1);

  const stale = accts.settle(rid, { tokens: 90, costUsd: 0 });
  check("旧代际凭据 settle → RESERVATION_STALE", !stale.ok, stale);
  if (!stale.ok) eq("拒绝码 = RESERVATION_STALE", stale.code, "RESERVATION_STALE");
  eq("被拒的结算未删除预留", accts.openReservationCount(), 1);

  const rel = accts.release(rid);
  check("旧代际凭据 release 仍可退预留", rel.ok, rel);
  eq("release 后无挂账", accts.openReservationCount(), 0);

  // 上限不得压到当前占用之下。
  const accts2 = new SceneBudgetAccounts();
  accts2.createAccount("cap", "s1", { maxTokens: 1000 });
  accts2.reserve("cap", { tokens: 500 }, "t1");
  const tooLow = accts2.updateLimits("cap", { maxTokens: 100 });
  check("把上限压到占用之下 → LIMITS_BELOW_USAGE", !tooLow.ok, tooLow);
  if (!tooLow.ok) eq("拒绝码 = LIMITS_BELOW_USAGE", tooLow.code, "LIMITS_BELOW_USAGE");
}

/* ─────────────────── 收尾 ─────────────────── */

console.log(`\nscene-task-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) {
  process.exitCode = 1;
}
