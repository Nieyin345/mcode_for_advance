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
import { checkEngineRequestUrl, defaultNodeRedFetch, nodeRedExecutor, NODE_RED_PATH_PARAM, NODE_RED_METHOD_PARAM, NODE_RED_BODY_PARAM, type NodeRedFetchRequest } from "@main/orchestration/nodeRedExecutor.js";
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
  eq("localhost 同端口通过", checkEngineRequestUrl(`http://localhost:${PORT}/api/x`, PORT).ok, true);
  eq("[::1] 同端口通过", checkEngineRequestUrl(`http://[::1]:${PORT}/api/x`, PORT).ok, true);

  const remote = checkEngineRequestUrl("https://example.com/api", PORT);
  check("★ 远程 host 被拒且点名", remote.ok === false && remote.reason.includes("example.com"), remote);
  const wrongPort = checkEngineRequestUrl(`http://127.0.0.1:9999/x`, PORT);
  check("★ 别的端口被拒", wrongPort.ok === false && wrongPort.reason.includes("9999"), wrongPort);
  const proto = checkEngineRequestUrl("ftp://127.0.0.1/x", PORT);
  check("★ 非 http(s) 被拒", proto.ok === false, proto);

  // 生产 registry 的 Node-RED 把 Admin API 放 /，HTTP-in 数据面放 /api。
  const adminPaths = ["/settings", "/flows", "/nodes", "/", "/api",
    "/api/../flows", "/api/%2e%2e/settings", `//127.0.0.1:${PORT}/settings`];
  for (const path of adminPaths) {
    const request = checkEngineRequestUrl(path, PORT);
    check("★ HTTP-in 执行器拒绝管理面/非数据面 URL: " + path, !request.ok, request);
  }
  check("★ 数据面 /api/hello 仍可请求", checkEngineRequestUrl("/api/hello", PORT).ok);
  check("★ 数据面查询参数保持", checkEngineRequestUrl("/api/hello?q=1", PORT).ok);
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
  let calls = 0;
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    fetch: async () => { calls++; return { status: 200, text: "{}", truncated: false }; },
  });
  const denied = await exec.execute(ctx({ enginePath: "/flows", engineMethod: "POST" }));
  eq("★ 管理 API 的节点执行请求 fail-closed", denied.status, "failed");
  eq("★ 拒绝管理 API 的节点不能发送 HTTP 请求", calls, 0);
}

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

{
  // 【调度器的变量展开】宿主 builder 塑好的 `input.engineRequest` 优先于
  // `node.params` 的存盘原值 —— 否则 `engineBody` 里写的 `{{上游.字段}}` 永远
  // 发不到引擎（解算只发生在递进 buildInput 的那份参数上）。
  const seen: NodeRedFetchRequest[] = [];
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    fetch: async (req) => {
      seen.push(req);
      return { status: 200, text: "{}", truncated: false };
    },
  });
  const context = ctx({ [NODE_RED_PATH_PARAM]: "/stale", [NODE_RED_BODY_PARAM]: "存盘原值" });
  (context.input as { engineRequest?: unknown }).engineRequest =
    { path: "/api/flow", method: "POST", body: '{"q":"已替换"}' };
  const out = await exec.execute(context);
  eq("★ builder 产物优先时照常成功", out.status, "success");
  eq("★ 请求路径取 input.engineRequest 而非 node.params", seen[0]?.url, `http://127.0.0.1:${PORT}/api/flow`);
  eq("★ 请求体取解算后的值", seen[0]?.body, '{"q":"已替换"}');
}

/* ══════════ 3. 已取消任务与 URL 用户凭据围栏（ARC-006） ══════════ */
{
  const controller = new AbortController();
  controller.abort();
  let fetches = 0;
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    fetch: async () => {
      fetches++;
      return { status: 200, text: '{"unexpected":"side-effect"}', truncated: false };
    },
  });
  const out = await exec.execute(ctx(spec, controller.signal));
  eq("★ 调用前已取消的工作流必须直接 cancelled", out.status, "cancelled");
  eq("★ 调用前已取消不能向引擎发送任何 HTTP 请求", fetches, 0);
  const userinfo = checkEngineRequestUrl(`http://attacker:secret@127.0.0.1:${PORT}/api/flow`, PORT);
  check("★ 回环地址带 URL userinfo 凭据时拒绝", !userinfo.ok, userinfo);
  const fragmented = checkEngineRequestUrl(`http://127.0.0.1:${PORT}/api/flow#invisible`, PORT);
  check("★ 有不可发送的 URL fragment 时拒绝以免操作目标歧义", !fragmented.ok, fragmented);
}
{
  // 自定义 fetch/HTTP 代理不一定尊重 AbortSignal；晚到 200 不得冲掉取消态。
  const controller = new AbortController();
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    fetch: async () => {
      controller.abort();
      return { status: 200, text: '{"late":"ok"}', truncated: false };
    },
  });
  const result = await exec.execute(ctx(spec, controller.signal));
  eq("★ 在途任务取消后即使 fetch 错误返回 200 也必须保持 cancelled", result.status, "cancelled");
  check("★ 取消结果不携带伪成功输出", result.outputs === undefined, result.outputs);
}

{
  // 真实默认 fetch 自身有限额，但注入的桥 fetch 未必遵守；executor 的
  // maxResponseBytes 配置必须保护传给 Agent 输出的最终字节数。
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    maxResponseBytes: 4,
    fetch: async () => ({ status: 200, text: "hello from ignored limit", truncated: false }),
  });
  const out = await exec.execute(ctx(spec));
  eq("★ executor 端再次执行响应大小上限", out.outputs?.body, "hell");
  eq("★ 自定义 fetch 忽略响应上限时最终输出如实标记截断", out.outputs?.truncated, true);
  check("★ 截断状态在摘要里可见", (out.summary ?? "").includes("截断"), out.summary);

  const emoji = nodeRedExecutor({
    engine: { status: () => running }, maxResponseBytes: 1,
    fetch: async () => ({ status: 200, text: "中文", truncated: false }),
  });
  const clipped = await emoji.execute(ctx(spec));
  eq("★ UTF-8 字节限制不能输出半个中文字符", clipped.outputs?.body, "");
  eq("★ UTF-8 多字节被截断时仍明确标注", clipped.outputs?.truncated, true);

  const invalidLimit = nodeRedExecutor({
    engine: { status: () => running }, maxResponseBytes: 0,
    fetch: async () => { throw new Error("非法配置不得发请求"); },
  });
  const badLimit = await invalidLimit.execute(ctx(spec));
  eq("★ 响应上限为 0 时 fail-closed，不发送请求", badLimit.status, "failed");
}

{
  // 生产 fetch 流式读响应时恰好切到 CJK UTF-8 的首字节；
  // 直接 TextDecoder.decode(截断字节) 会注入替换符 U+FFFD 并污染 Agent 输出。
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("你好", { status: 200 });
    const response = await defaultNodeRedFetch({
      url: `http://127.0.0.1:${PORT}/api/chinese`,
      method: "GET", body: null, headers: {},
      signal: new AbortController().signal,
    }, 4);
    eq("★ 生产流式 fetch 不把 UTF-8 码点切成 U+FFFD", response.text, "你");
    eq("★ 截断中文响应按原始字节界限报告 truncated", response.truncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/* ══════════ 4. 引擎执行时序和节点方法守卫 ══════════ */
{
  let port = PORT;
  let state: EngineRuntimeStatus["state"] = "running";
  const fetched: NodeRedFetchRequest[] = [];
  const exec = nodeRedExecutor({
    engine: { status: () => ({ engineId: "node-red", state, port, reason: null }) },
    fetch: async (req) => {
      fetched.push(req);
      state = "stopped"; port = null as unknown as number;
      return { status: 200, text: '{"stale":true}', truncated: false };
    },
  });
  const outcome = await exec.execute(ctx(spec));
  eq("★ HTTP 回应时引擎已停止，旧 200 不能伪报成功", outcome.status, "failed");
  check("★ 失效响应不得交给后续节点", outcome.outputs === undefined, outcome.outputs);
  check("★ 原请求确实已经发出才能证明晚到失效", fetched.length === 1);
}
{
  let calls = 0;
  const exec = nodeRedExecutor({
    engine: { status: () => running },
    fetch: async () => {
      calls++;
      return { status: 200, text: "{}", truncated: false };
    },
  });
  const custom = await exec.execute(ctx({ enginePath: "/api/flow", engineMethod: "CONNECT" }));
  eq("★ 非画布提供的方法 CONNECT 必须拒绝", custom.status, "failed");
  const newline = await exec.execute(ctx({ enginePath: "/api/flow", engineMethod: "POST\r\nX-Evil: 1" }));
  eq("★ 带控制字符的 HTTP method 必须拒绝", newline.status, "failed");
  check("★ 无效 HTTP 方法必须在 fetch 前阻断", calls === 0, calls);
  const get = await exec.execute(ctx({ enginePath: "/api/flow", engineMethod: "GET" }));
  eq("★ 画布中合法 GET 仍可调用", get.status, "success");
  check("★ 合法 GET 仅发送一次", calls === 1, calls);
}

{
  let state: EngineRuntimeStatus["state"] = "running";
  const exec = nodeRedExecutor({
    engine: { status: () => ({ engineId: "node-red", state, port: state === "running" ? PORT : null, reason: null }) },
    fetch: async () => {
      state = "failed";
      throw new Error("断开的老引擎连接");
    },
  });
  const broken = await exec.execute(ctx(spec));
  eq("★ 引擎崩溃引起的请求拒绝自动重试", broken.retryable, false);
  check("★ 崩溃期间的请求失败指出是引擎生命周期", (broken.error ?? "").includes("引擎"), broken.error);
}

/* ══════════ 5. 同端口 ABA：旧进程结果不得复活成新实例成功 ══════════ */
{
  let epoch = "host-start-A";
  const exec = nodeRedExecutor({
    engine: { status: () => ({ ...running, instanceEpoch: epoch }) },
    fetch: async () => {
      // 旧引擎刚关闭，新的引擎在同端口重新上线；state/port 完全相同。
      epoch = "host-start-B";
      return { status: 200, text: '{"belongsTo":"old-process"}', truncated: false };
    },
  });
  const outcome = await exec.execute(ctx(spec));
  eq("★ 同端口重启后旧 HTTP 200 必须拒绝（instanceEpoch 不同）", outcome.status, "failed");
  check("★ ABA 旧结果不能进入下游 outputs", outcome.outputs === undefined, outcome.outputs);
}
{
  let epoch = "host-start-A";
  const exec = nodeRedExecutor({
    engine: { status: () => ({ ...running, instanceEpoch: epoch }) },
    fetch: async () => {
      epoch = "host-start-B";
      throw Error("old request rejected");
    },
  });
  const outcome = await exec.execute(ctx(spec));
  eq("★ 同端口新实例不能自动重试旧进程抛错", outcome.retryable, false);
}

console.log(`\nworkflow-engine-bridge-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
