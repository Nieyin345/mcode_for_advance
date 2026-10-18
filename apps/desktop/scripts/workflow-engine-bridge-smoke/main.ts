/**
 * 【ARC-006 WF-INT · 桥 1】**Node-RED 触发执行器**的无头回归网。
 *
 * 钉四件事：
 *  1. **只发回环同端口**：远程 host、别的端口、非 http(s) 一律拒绝；
 *  2. 引擎没 running → 失败且**不可重试**（用户要去启动引擎，重跑无意义）；
 *  3. 2xx → success + 结构化 outputs；4xx → failed 不可重试；5xx → failed 可重试；
 *  4. 取消 → cancelled；响应超上限 → 截断并如实标注。
 *
 * Run: bash scripts/workflow-engine-bridge-smoke/run.sh
 */
import { checkEngineRequestUrl, nodeRedExecutor, NODE_RED_PATH_PARAM, NODE_RED_METHOD_PARAM, NODE_RED_BODY_PARAM, type NodeRedFetchRequest } from "@main/orchestration/nodeRedExecutor.js";
import type { EngineRuntimeStatus } from "@main/workflowEngines/runtimeSupervisor.js";

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
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const PORT = 3527;
const running: EngineRuntimeStatus = { engineId: "node-red", state: "running", port: PORT, reason: null };
const stopped: EngineRuntimeStatus = { engineId: "node-red", state: "stopped", port: null, reason: null };

/* ══════════ 1. URL 围栏 ══════════ */
{
  eq("回环同端口通过（绝对地址）", checkEngineRequestUrl(`http://127.0.0.1:${PORT}/api/flow`, PORT).ok, true);
  eq("相对路径按引擎根解析", checkEngineRequestUrl("/api/flow", PORT).ok, true);
  eq("localhost 同端口通过", checkEngineRequestUrl(`http://localhost:${PORT}/x`, PORT).ok, true);
  eq("[::1] 同端口通过", checkEngineRequestUrl(`http://[::1]:${PORT}/x`, PORT).ok, true);

  const remote = checkEngineRequestUrl("https://example.com/api", PORT);
  check("★ 远程 host 被拒且点名", remote.ok === false && remote.reason.includes("example.com"), remote);
  const wrongPort = checkEngineRequestUrl(`http://127.0.0.1:9999/x`, PORT);
  check("★ 别的端口被拒", wrongPort.ok === false && wrongPort.reason.includes("9999"), wrongPort);
  const proto = checkEngineRequestUrl("ftp://127.0.0.1/x", PORT);
  check("★ 非 http(s) 被拒", proto.ok === false, proto);
}

/* ══════════ 2. 执行器行为 ══════════ */
function ctx(params: Record<string, unknown>, signal?: AbortSignal) {
  return {
    node: { params },
    input: { signal: signal ?? new AbortController().signal },
  } as unknown as Parameters<ReturnType<typeof nodeRedExecutor>["execute"]>[0];
}
const spec = { [NODE_RED_PATH_PARAM]: "/api/flow", [NODE_RED_METHOD_PARAM]: "POST", [NODE_RED_BODY_PARAM]: '{"a":1}' };

{
  // 引擎未运行 → 不可重试
  const exec = nodeRedExecutor({
    engine: { status: () => stopped },
    fetch: async () => {
      throw new Error("不该发请求");
    },
  });
  const out = await exec.execute(ctx(spec));
  eq("★ 引擎未运行 → failed", out.status, "failed");
  eq("★ 且不可重试（提示用户去启动）", out.retryable, false);
  check("原因说清要启动引擎", (out.error ?? "").includes("启动"), out.error);
}

{
  // 2xx → success
  const seen: NodeRedFetchRequest[] = [];
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    fetch: async (req) => {
      seen.push(req);
      return { status: 200, text: '{"ok":true}', truncated: false };
    },
  });
  const out = await exec.execute(ctx(spec));
  eq("★ 2xx → success", out.status, "success");
  eq("outputs 带状态与解析后的 body", out.outputs, { status: 200, body: { ok: true }, truncated: false });
  eq("请求发到回环同端口", seen[0]?.url, `http://127.0.0.1:${PORT}/api/flow`);
  eq("方法原样", seen[0]?.method, "POST");
}

{
  // 4xx → failed 不可重试；5xx → 可重试
  const mk = (status: number) =>
    nodeRedExecutor({
      engine: { status: () => running },
      fetch: async () => ({ status, text: "err", truncated: false }),
    });
  const bad = await mk(400).execute(ctx(spec));
  eq("★ 4xx → failed", bad.status, "failed");
  eq("★ 4xx 不可重试", bad.retryable, false);
  const server = await mk(503).execute(ctx(spec));
  eq("★ 5xx → failed", server.status, "failed");
  eq("★ 5xx 可重试（引擎内部瞬时故障）", server.retryable, true);
}

{
  // 取消 → cancelled
  const controller = new AbortController();
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    fetch: async (req) => {
      controller.abort();
      throw new Error("aborted");
    },
  });
  const out = await exec.execute(ctx(spec, controller.signal));
  eq("★ 取消 → cancelled", out.status, "cancelled");
}

{
  // 截断标注
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    fetch: async () => ({ status: 200, text: "x".repeat(10), truncated: true }),
  });
  const out = await exec.execute(ctx(spec));
  eq("★ 截断照常成功但标注", out.outputs?.truncated, true);
  check("summary 明说已截断", (out.summary ?? "").includes("截断"), out.summary);
}

{
  // 节点缺参数 → 明确失败
  const exec = nodeRedExecutor({ engine: { status: () => running }, fetch: async () => ({ status: 200, text: "", truncated: false }) });
  const out = await exec.execute(ctx({}));
  eq("★ 缺参数 → failed", out.status, "failed");
  check("原因点名缺什么", (out.error ?? "").includes("enginePath"), out.error);
}

console.log(`\nworkflow-engine-bridge-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
