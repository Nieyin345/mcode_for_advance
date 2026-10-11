/**
 * MAINT M28 · runner 续跑/重试的启动竞态与启动失败可见性。
 *
 * 检查对象(`orchestration/runner.ts`):
 *  1. `resolveWorkflowRetry` / `resolveWorkflowChoice`(→ `resumeRun`)在**同一对话已有启动在预检中**
 *     (`pendingStarts`,`runs` 尚未登记)时,不得返回 `ok:true` —— 那次 `startWorkflowRun` 会被
 *     `hasActiveRun` 挡掉、什么都不跑,用户却看到"已重试"。
 *  2. 重试/续跑触发的 `startWorkflowRun` 若在预检阶段抛错(引擎不可用),不得成为 unhandledRejection,
 *     且不得留下 `hasActiveRun` 僵死。
 *
 * 数据根是临时目录;夹具、替身复用 node-session-smoke(只读)。Run: scripts/maint-m28-smoke/run.sh
 */
import "../node-session-smoke/stubs/prelude.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
});

const { initDb } = await import("@main/store/db.js");
const { ProjectRepo, SessionRepo, WorkflowRepo, WorkflowRunRepo } = await import("@main/store/repositories.js");
const runner = await import("@main/orchestration/runner.js");
const { saveRun } = await import("@main/orchestration/runStore.js");
const { workflowRevision } = await import("@main/orchestration/workflowTrust.js");
const { getWorkflow } = await import("@main/orchestration/library.js");
const rt = await import("../node-session-smoke/stubs/runtimeManager.js");
const health = await import("./stubs/providerRegistry.js");
const { nodeSessionDoc, parentSession, project, WORKFLOW_ID, PARENT } = await import("../node-session-smoke/fixtures.js");

await initDb();
WorkflowRepo.save(nodeSessionDoc());
ProjectRepo.create(project());
SessionRepo.create(parentSession(PARENT));

async function waitFor(label: string, cond: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = rt.realNowMs() + timeoutMs;
  while (rt.realNowMs() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  check(`等到了:${label}`, false, { waitedMs: timeoutMs });
  return false;
}
const tick = () => new Promise((r) => setTimeout(r, 30));

const revision = workflowRevision(getWorkflow(WORKFLOW_ID)!);
function persistRetryable(runId: string): void {
  saveRun({
    runId, sessionId: PARENT, workflowId: WORKFLOW_ID, status: "failed",
    snapshot: {
      prompt: "重试夹具", cwd: process.cwd(), attempts: [], workflowRevision: revision, inFlightNodeIds: [],
      state: { record: [], rounds: [], picks: [], outcomes: [["agentA", { status: "failed", summary: "可重试" }]], awaiting: [] },
    },
  });
}

console.log("maint-m28-smoke —— 续跑/重试启动竞态与启动失败可见性\n");

/* 1. 预检挂起期间的第二次重试 */
// Catalog lookup now precedes replay authorization: cancellation covers that
// new async boundary too, before any health probe or actual node execution.
{
  const runId = "run_m28_catalog_cancel";
  persistRetryable(runId);
  const pending = runner.resolveWorkflowRetry({ sessionId: PARENT, runId, nodeId: "agentA" });
  eq("catalog lookup reserves the session immediately", runner.hasActiveRun(PARENT), true);
  runner.cancelWorkflowRun(PARENT);
  eq("stop during catalog lookup rejects the continuation", (await pending).ok, false);
  eq("cancelled catalog lookup never marks the old run running", WorkflowRunRepo.get(runId)?.status, "failed");
  eq("cancelled catalog reservation is released", runner.hasActiveRun(PARENT), false);
}

{
  const runId = "run_m28_pending";
  persistRetryable(runId);
  let release!: () => void;
  health.holdNextHealth(new Promise<void>((r) => { release = r; }));
  const first = await runner.resolveWorkflowRetry({ sessionId: PARENT, runId, nodeId: "agentA" });
  eq("第一次重试被受理", first.ok, true);
  await tick();
  eq("此时启动在预检中(pendingStarts):hasActiveRun 为真", runner.hasActiveRun(PARENT), true);
  const second = await runner.resolveWorkflowRetry({ sessionId: PARENT, runId, nodeId: "agentA" });
  eq("预检中再点重试:不得返回 ok(实际不会启动第二次)", second.ok, false);
  const choice = await runner.resolveWorkflowChoice({ sessionId: PARENT, runId, nodeId: "agentA", edgeId: "e1" });
  eq("预检中的岔路口续跑同样不得返回 ok", choice.ok, false);
  release();
  await waitFor("第一次重试真正启动", () => WorkflowRunRepo.get(runId)?.status === "running" && runner.hasActiveRun(PARENT));
  runner.cancelWorkflowRun(PARENT);
  await waitFor("运行收尾", () => !runner.hasActiveRun(PARENT));
}

/* 2. 预检失败:不得 unhandledRejection、不得僵死 */
{
  const runId = "run_m28_preflight_fail";
  persistRetryable(runId);
  const before = unhandled.length;
  const eventsBefore = rt.published.length;
  health.failNextHealth(new Error("m28: 引擎预检故意失败"));
  const res = await runner.resolveWorkflowRetry({ sessionId: PARENT, runId, nodeId: "agentA" });
  eq("重试在同步阶段被受理(失败发生在异步预检)", res.ok, true);
  await tick(); await tick();
  await waitFor("启动失败后释放 active run", () => !runner.hasActiveRun(PARENT), 3_000);
  eq("启动失败没有变成 unhandledRejection", unhandled.length - before, 0);
  eq("失败的重试没有把原行改成 running", WorkflowRunRepo.get(runId)?.status, "failed");
  const after = rt.published.slice(eventsBefore) as Array<{ type?: string; message?: string; reason?: string }>;
  check("失败原因作为 error 事件发给会话", after.some((e) => e.type === "error" && (e.message ?? "").includes("预检")), after);
  check("并以 turn.done(error) 收掉这一回合", after.some((e) => e.type === "turn.done" && e.reason === "error"), after);
}

/* 3. MC-028:两个"声称 durable"的关口必须**检查 writeRun 的返回值**。
 *
 * 上下文的两个关口 —— 岔路口等待用户前(`writeRun("running", …, true)`)与整图收口
 * (`writeRun(settled, …, true)`)—— 都在对用户承诺"磁盘上就是这个状态"。存盘失败却
 * 照常摆卡 / 照常广播「流程结束」,就是对着一个磁盘上并不存在的状态讲话:硬杀之后重启
 * 会认回旧快照,改掉一张已答过的卡、或冒出一张过期可续卡。
 *
 * ## 为什么是**源级**断言而不是跑一遍
 *
 * 这两处的失败是"磁盘写不进去"——无头套件里要真造出来得往 `db.persistNowOrThrow` 里塞
 * 故障,而那条注入缝会牵动整套 runner 的存储路径(风险远大于收益)。而这条错误**错了的
 * 样子恰好是"那一个 `if (...)` 不见了"** —— 一个离散的源码事实,真正的行为差异在别处
 * (由本套上面那两条 + automation-smoke 的收尾覆盖)。所以这里钉住那个判据本身:两处
 * `writeRun(..., true)` 都必须被一个 `if (!writeRun(...))` 包着。改回"忽略返回值"即红。 */
{
  // 套件由 run.sh 从 **apps/desktop** 里跑,所以 cwd 相对路径稳;`import.meta.url`
  // 不行 —— 产物被 esbuild 打进临时目录,那个 URL 指向的是 bundle 不是源码。
  const src = readFileSync(resolve(process.cwd(), "src/main/orchestration/runner.ts"), "utf8");
  const durableChecks = src.match(/if\s*\(\s*!\s*writeRun\(/g) ?? [];
  check(
    "★ MC-028:两处 durable 关口都检查了 writeRun 的返回值(岔路口 + 收口)",
    durableChecks.length >= 1 &&
      /const settleSaved = writeRun\(/.test(src) &&
      /if \(!settleSaved\)/.test(src),
    { found: durableChecks.length, settle: /const settleSaved = writeRun\(/.test(src) },
  );
  check(
    "★ MC-028:岔路口存盘失败时不摆卡(发 error 而不是照常 choose)",
    /if\s*\(\s*!\s*writeRun\("running",[\s\S]{0,220}?emitWorkflowEvent\(\{\s*type:\s*"error"/.test(src),
  );
  check(
    "★ MC-028:收口存盘失败时发 error(不让「流程结束」盖过去)",
    /if \(!settleSaved\)[\s\S]{0,260}?emitWorkflowEvent\(\{\s*type:\s*"error"/.test(src),
  );
  check(
    "★ MC-028:收口的 turn.done reason 认存盘失败(settleSaved)为 error,不只认 settled",
    /reason:[\s\S]{0,200}?\|\| !settleSaved[\s\S]{0,80}?"error"/.test(src),
  );
}

/* 4. MC-028:**真跑一遍** —— 收口那一次 durable 写失败时,用户**当场**看到 error,
 * 而不是被骗着看到「流程结束」。
 *
 * §3 钉的是源码判据(那个 `if (...)` 在不在)。台账第 23 轮 / 21.2 明确要求比这更强:
 * 「磁盘 fsync/rename 失败 → UI 是否真实展示失败」的**行为**测试,而不是只看源码形状。
 *
 * 做法:用一个**单节点对话图**(跑完即收口),让收口那次 `WorkflowRunRepo.save` 抛
 * (等价于 durable 写没成 —— saveRun 的 try/catch 会把它收敛成 `return false`,与
 * fsync/rename 故障**同一条失败路径**),然后读真实 runner 广播出去的事件。判据钉在
 * **用户看得见的那两件事**上:一条 error 正文 + `turn.done(reason:"error")`,并且
 * **绝不能**出现 `end_turn`(那就是"谎报成功")。 */
{
  const wfId = "wf_m28_settle_fail";
  const sid = "s_m28_settle_fail";
  const base = nodeSessionDoc();
  WorkflowRepo.save({
    ...base,
    id: wfId,
    nodes: [{ id: "entry", type: "mcode.conversation", title: "问一句", params: { instruction: "跑一下" }, position: { x: 0, y: 0 } }],
    edges: [],
  });
  SessionRepo.create({ ...parentSession(sid), workflowId: wfId });

  const repo = WorkflowRunRepo as unknown as { save: typeof WorkflowRunRepo.save };
  const originalRunSave = repo.save;
  let settleAttempts = 0;
  // 只让**终态**那一次写失败(开跑那次 running 照常落,否则图根本起不来)。
  repo.save = (row) => {
    if (row.status === "success" || row.status === "failed" || row.status === "cancelled") {
      settleAttempts += 1;
      throw new Error("injected durable settle failure");
    }
    return originalRunSave(row);
  };

  rt.holdConversationTurns(true);
  rt.resetPublished();
  const offset = rt.sentPrompts.length;
  const safety = setTimeout(() => runner.cancelWorkflowRun(sid), 6_000);
  try {
    const done = runner.startWorkflowRun({ session: SessionRepo.get(sid)!, prompt: "跑一下", cwd: process.cwd() });
    await waitFor("对话节点被派发", () => rt.sentPrompts.length >= offset + 1);
    rt.finishTurn(sid);
    await done;
  } finally {
    clearTimeout(safety);
    repo.save = originalRunSave;
    rt.holdConversationTurns(false);
    rt.finishTurn(sid);
  }

  eq("收口那次 durable 写确实被击中(不是空过)", settleAttempts, 1);
  const after = rt.published as Array<{ type?: string; message?: string; reason?: string }>;
  check(
    "★ 收口存盘失败:用户当场看到一条 error(说清“没能保存到磁盘”)",
    after.some((e) => e.type === "error" && (e.message ?? "").includes("没能保存")),
    after.filter((e) => e.type === "error" || e.type === "turn.done"),
  );
  check(
    "★ 且以 turn.done(error) 收口 —— 不是被蒙成「流程结束」",
    after.some((e) => e.type === "turn.done" && e.reason === "error"),
    after.filter((e) => e.type === "turn.done"),
  );
  check(
    "★ 绝不出现 end_turn(存盘失败不得谎报成功收尾)",
    !after.some((e) => e.type === "turn.done" && e.reason === "end_turn"),
    after.filter((e) => e.type === "turn.done"),
  );
  eq("收口失败后没有僵死的 active run", runner.hasActiveRun(sid), false);
}

console.log(`\n${checks - failures}/${checks} passed; ${failures} failed`);
process.exit(failures ? 1 : 0);