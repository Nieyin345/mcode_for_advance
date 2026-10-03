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

console.log(`\n${checks - failures}/${checks} passed; ${failures} failed`);
process.exit(failures ? 1 : 0);
