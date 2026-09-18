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
ok(missing.error === "No executor registered: missing", "unknown executor reports its kind");
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

console.log(`PASS: ${checks.length} checks`);
