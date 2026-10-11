import { ExecutionEngine, type ExecutionContext, type NodeExecutor } from "../../src/main/orchestration/executionEngine.js";
import type { NodeOutcome } from "@contracts/nodeType";

const checks: string[] = [];
const ok = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  checks.push(message);
};

const context = (kind: string): ExecutionContext => ({
  node: { id: "n1", type: "test.node", title: "Test", params: {}, position: { x: 0, y: 0 } },
  manifest: {
    id: "test.node",
    manifestVersion: 1,
    name: "Test",
    runner: { kind: kind as never },
    capability: "read",
    params: [],
  },
  input: {
    prompt: "hello",
    data: { userInput: "hello", upstreamText: "", upstreamOutputs: {}, upstreamArtifacts: [] },
    skills: [],
    mcpServerNames: [],
    pluginNames: [],
    returnMode: "none",
    signal: new AbortController().signal,
  },
  cwd: ".",
  metadata: { runId: "run_test", sessionId: "session_test", nodeId: "n1" },
});

const engine = new ExecutionEngine();
const executor: NodeExecutor = {
  kind: "test",
  async execute(ctx): Promise<NodeOutcome> {
    ok(ctx.metadata.runId === "run_test", "passes stable run metadata");
    ok(ctx.input.data.userInput === "hello", "passes structured data context");
    return { status: "success", summary: "done" };
  },
};

engine.register(executor);
ok(engine.has("test"), "registry exposes registered executor");
const result = await engine.execute(context("test"));
ok(result.status === "success" && result.summary === "done", "executes registered executor");
ok(result.execution?.executorKind === "test", "records executor kind");
ok((result.execution?.durationMs ?? -1) >= 0, "records execution duration");

let duplicateRejected = false;
try {
  engine.register(executor);
} catch {
  duplicateRejected = true;
}
ok(duplicateRejected, "rejects duplicate executor registration");

const missing = await engine.execute(context("missing"));
ok(missing.status === "failed", "unknown executor fails deterministically");
ok(missing.error === "没有能执行这种节点的执行器:missing", "unknown executor reports its kind (in Chinese, like its sibling node errors)");
ok(missing.execution?.executorKind === "missing", "unknown executor still records metadata");

// —— 兜底执行器:setDefault 之后,注册表没有的 kind 落到它 ——
// 这是"默认怎么跑"(模型轮)进入同一条分派边界的凭据:分派链不需要 kind 分支。
const fallbackEngine = new ExecutionEngine();
const fallbackCalls: string[] = [];
fallbackEngine.setDefault({
  async execute(ctx): Promise<NodeOutcome> {
    fallbackCalls.push(ctx.manifest.runner.kind);
    return { status: "success", summary: `fallback:${ctx.manifest.runner.kind}` };
  },
});
const fell = await fallbackEngine.execute(context("prompt"));
ok(fell.status === "success" && fell.summary === "fallback:prompt", "fallback takes unregistered kinds");
ok(fallbackCalls[0] === "prompt", "fallback receives the requested kind");
ok(fell.execution?.executorKind === "prompt", "fallback still records metadata");
fallbackEngine.register({
  kind: "test",
  async execute(): Promise<NodeOutcome> {
    return { status: "success", summary: "exact" };
  },
});
const exact = await fallbackEngine.execute(context("test"));
ok(exact.summary === "exact", "registered kind wins over fallback");

// —— 内置 code / command 执行器:未配置时那句失败原因必须是中文 ——
// 它画在**失败节点卡片**上(见 runner.ts 的 workflow.node.result),而编排里其它节点错误
// 一律中文。这两处从前写着英文 "Code/Command node is missing execution config",同一件事
// 在 `codeRunner`/`commandRunner` 里却是中文 —— 一处中一处英。
{
  const { CodeExecutor } = await import("../../src/main/orchestration/codeExecutor.js");
  const { CommandExecutor } = await import("../../src/main/orchestration/commandExecutor.js");
  const codeCtx = context("code");
  (codeCtx.input as { code?: unknown }).code = undefined;
  const codeOut = await new CodeExecutor().execute(codeCtx);
  ok(codeOut.status === "failed" && /没有填写/.test(codeOut.error ?? ""), "code 节点未配置 -> 中文失败原因");

  const cmdCtx = context("command");
  (cmdCtx.input as { command?: unknown }).command = undefined;
  const cmdOut = await new CommandExecutor().execute(cmdCtx);
  ok(cmdOut.status === "failed" && /没有填/.test(cmdOut.error ?? ""), "command 节点未配置 -> 中文失败原因");
}

// —— 【MC-075】settle 钩子报错不得翻转已成功的执行 / 不得逃出 ——
// 从前 start/execute/settle 共用一个 try:settle(成功) 一抛就落进 catch,再拿**失败**结果
// 调一次 settle,把已提交(副作用已落)的节点反向标成 failed;settle 若再抛,异常还逃出引擎。
{
  const settleEngine = new ExecutionEngine();
  let commitCount = 0;
  const settleCalls: string[] = [];
  settleEngine.register({
    kind: "test",
    async execute(): Promise<NodeOutcome> {
      commitCount += 1; // 业务已提交(副作用落定)
      return { status: "success", summary: "done" };
    },
    async settle(_ctx, outcome): Promise<void> {
      settleCalls.push(outcome.status);
      // 第一次(成功结果)抛,第二次(若被错误地当失败收尾)不抛 —— 复现"翻转"路径。
      if (outcome.status === "success" && settleCalls.length === 1) throw new Error("notify failure");
    },
  });
  let settled: NodeOutcome | undefined;
  let escaped: unknown;
  try {
    settled = await settleEngine.execute(context("test"));
  } catch (err) {
    escaped = err;
  }
  ok(escaped === undefined, "★ settle 抛错不逃出执行引擎(返回 NodeOutcome)");
  ok(settled?.status === "success", `★ settle 抛错不得把已成功的执行翻转成失败(实际 ${settled?.status})`);
  ok(commitCount === 1, "★ 业务只提交一次");
  ok(settleCalls.length === 1 && settleCalls[0] === "success", `★ settle 只被调用一次且带**真实**结果(实际 ${JSON.stringify(settleCalls)})`);
  ok(/收尾钩子报错/.test(settled?.summary ?? ""), "★ settle 的错作为告警进 summary(用户可见)");

  // settle 始终抛错:业务成功仍报成功,引擎不抛。
  const alwaysEngine = new ExecutionEngine();
  alwaysEngine.register({
    kind: "test",
    async execute(): Promise<NodeOutcome> {
      return { status: "success", summary: "done" };
    },
    async settle(): Promise<void> {
      throw new Error("notify offline");
    },
  });
  let alwaysOut: NodeOutcome | undefined;
  let alwaysEscaped: unknown;
  try {
    alwaysOut = await alwaysEngine.execute(context("test"));
  } catch (err) {
    alwaysEscaped = err;
  }
  ok(alwaysEscaped === undefined, "★ settle 始终抛错也不逃出引擎");
  ok(alwaysOut?.status === "success", "★ settle 始终抛错,业务成功仍是 success");

  // 业务本身失败(start/execute 抛):settle 收到**失败**结果,且 settle 再抛也不逃出。
  const failEngine = new ExecutionEngine();
  const failSettle: string[] = [];
  failEngine.register({
    kind: "test",
    async execute(): Promise<NodeOutcome> {
      throw new Error("boom");
    },
    async settle(_ctx, outcome): Promise<void> {
      failSettle.push(outcome.status);
      throw new Error("cleanup failed");
    },
  });
  let failOut: NodeOutcome | undefined;
  let failEscaped: unknown;
  try {
    failOut = await failEngine.execute(context("test"));
  } catch (err) {
    failEscaped = err;
  }
  ok(failEscaped === undefined, "★ execute 抛错 + settle 抛错都不逃出引擎");
  ok(failOut?.status === "failed" && /boom/.test(failOut.error ?? ""), "★ 业务失败的根因保留");
  ok(failSettle.length === 1 && failSettle[0] === "failed", `★ 失败路径 settle 也只调一次且带失败结果(实际 ${JSON.stringify(failSettle)})`);
}

console.log(`PASS: ${checks.length} checks`);