/**
 * T96 探针：**迁移后的 `mcode-*` 节点，在真 Node-RED 5.0.8 里真的会被执行吗？**
 * 以及 **`mcode-agent` 真的会调到 Host 端口吗？**
 *
 * ## 为什么这套和 `node-red-e2e-smoke` 不同
 *
 * `node-red-e2e-smoke` 的 Gate C（2026-10-19）断言的是「含 mcode-* 的整组 flow
 * **不启动**」（missing-types 全局闸）。T42（2026-10-21）装上受管节点包之后，
 * 那条断言被改成了「HTTP-in 探针必须 200」（`★【T42】`），也就是「整组能启动」。
 *
 * **但它仍然只证明「启动了」**：
 *   - 它部署的是 `http in → function → http response`，**不是 `mcode-agent`**；
 *   - 那个 200 是一个**纯原生节点**给的，跟 `mcode-agent` 是否被实例化无关；
 *   - 全套里没有任何一处断言「`mcode-*` 节点的 execute 真跑了、真调到了 Host」。
 *
 * 本套补这一格：**部署一条 inject → mcode-agent 的流，看 Host 端口有没有被调用。**
 * Host 端口用注入的记账桩（`NodePackHostServices`），所以「调用」是**可观测的事实**，
 * 不是从日志猜的。
 *
 * ## 判据怎么分层
 *
 *   L1 引擎起得来（生产 launchSpec + 生产 EngineRuntime）
 *   L2 节点类型注册了（`mcode-agent` 在 palette 里，不是 unknown）
 *   L3 flow 真的启动（同部署里的原生 HTTP-in 应答 200 —— 这是 L3 的正控）
 *   L4 **`mcode-agent` 的 execute 真的跑了 → Host 端口被调用**（本题的核心）
 *   L5 结果回灌（下游原生节点收到了 payload）
 *
 * L3 的 HTTP-in 是**对照**：它证明「引擎在跑」，从而让 L4 的「Host 没被调用」
 * 可以归因到节点本身，而不是引擎没起来。
 *
 * Run: set -euo pipefail; source scripts/lib/esbuild-path.sh; bash scripts/t96-probe/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import {
  EngineRuntime,
  defaultEngineRuntimePorts,
  type EngineChildProcess,
  type EngineRuntimePorts,
  type EngineSpawnSpec,
} from "@main/workflowEngines/runtimeSupervisor.js";
import {
  ProductionWorkflowEngineRegistry,
  OwnedNodeRedRuntime,
} from "@main/workflowEngines/registry.js";
import { createInMemoryExecutorOwnership } from "@main/workflowEngines/executorOwnership.js";
import { ensureNodePack, MCODE_NODE_PACK_DIR } from "@main/workflowEngines/nodePackManifest.js";
import { NODE_RED_ENGINE_ID } from "@main/orchestration/nodeRedExecutor.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function evidence(label: string, value: unknown): void {
  console.log(`  [evidence] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor<T>(
  fn: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number, intervalMs = 150,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v as T; } catch { /* keep waiting */ }
    await sleep(intervalMs);
  }
  return null;
}
function tcpConnect(port: number, timeoutMs: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (v: boolean): void => { if (settled) return; settled = true; socket.destroy(); resolve(v); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}
async function fetchOn(port: number, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
}

/* ══════════ 0. 安装树（共享 106MB，与 e2e 同一布局） ══════════ */
const APP = process.cwd();
const NR_ROOT = process.env.MCODE_NR_E2E_ROOT ?? join(APP, ".tmp", "nr-e2e");
const SHARED_ENGINE_DIR = join(NR_ROOT, "workflow-engines", NODE_RED_ENGINE_ID);
const SHARED_NODE_MODULES = join(SHARED_ENGINE_DIR, "node_modules");
const NODE_RED_PKG = join(SHARED_NODE_MODULES, "node-red", "package.json");

if (!existsSync(NODE_RED_PKG)) {
  console.log("SKIP: 未安装 node-red —— T96 真引擎节点执行整套跳过（不是失败）。");
  console.log(`  期望位置: ${NODE_RED_PKG}`);
  process.exit(0);
}
const installedVersion = (JSON.parse(readFileSync(NODE_RED_PKG, "utf8")) as { version?: string }).version ?? "?";
console.log(`t96-probe: node-red@${installedVersion} @ ${SHARED_ENGINE_DIR}`);

const PRIVATE_DATA_ROOT = process.env.MCODE_SMOKE_DATA_ROOT ?? "";
const PRIVATE_ENGINE_DIR = PRIVATE_DATA_ROOT === ""
  ? "" : join(PRIVATE_DATA_ROOT, "workflow-engines", NODE_RED_ENGINE_ID);
if (PRIVATE_ENGINE_DIR !== "") {
  mkdirSync(PRIVATE_ENGINE_DIR, { recursive: true });
  const linkPath = join(PRIVATE_ENGINE_DIR, "node_modules");
  if (!existsSync(linkPath)) {
    try { symlinkSync(SHARED_NODE_MODULES, linkPath, "junction"); }
    catch { cpSync(SHARED_NODE_MODULES, linkPath, { recursive: true }); }
  }
}
const INSTALLED = PRIVATE_ENGINE_DIR === "" ? SHARED_ENGINE_DIR : PRIVATE_ENGINE_DIR;

/* ══════════ 1. 节点包落盘（引擎启动的前置，失败 → registry 拒绝启动） ══════════ */
console.log("\n1. 节点包（`ensureNodePack`，失败则 launchSpec 返回 null）");
const pack = ensureNodePack(INSTALLED, NODE_RED_ENGINE_ID);
check("★ ensureNodePack 成功", pack.ok === true, pack);
const packDir = join(INSTALLED, MCODE_NODE_PACK_DIR);
const packFiles = existsSync(packDir) ? readdirSync(packDir) : [];
const jsFiles = packFiles.filter((f) => f.endsWith(".js"));
evidence("节点包 .js", jsFiles);
check("★ 6 个节点类型各有一个 .js（Node-RED 按 nodesDir 自动加载）", jsFiles.length === 6, jsFiles);
check("mcode-agent.js 在其中", jsFiles.includes("mcode-agent.js"));
check("共享 runtime 在（子进程侧的 IPC 客户端）", packFiles.includes("mcode-runtime.cjs"));

/* ══════════ 2. 起真引擎（生产 launchSpec + 生产 EngineRuntime） ══════════ */
console.log("\n2. 真引擎启动");

/** 记账式 Host 桩：`mcode-agent` 的 execute 走到这里就是**可观测的事实**。 */
interface HostCall { operation: string; payload: Record<string, unknown>; }
const hostCalls: HostCall[] = [];
const hostServices = {
  execute: async (operation: string, payload: Record<string, unknown>): Promise<unknown> => {
    hostCalls.push({ operation, payload });
    return { text: `t96-host-saw:${operation}`, artifacts: [], runId: "t96-run" };
  },
  subscribe: (): (() => void) => () => undefined,
};

function recordingPorts(): EngineRuntimePorts & { specs: EngineSpawnSpec[]; children: EngineChildProcess[] } {
  const specs: EngineSpawnSpec[] = [];
  const children: EngineChildProcess[] = [];
  return {
    specs, children,
    spawn: (spec) => { specs.push(spec); const c = defaultEngineRuntimePorts.spawn(spec); children.push(c); return c; },
    allocatePort: defaultEngineRuntimePorts.allocatePort,
    probe: defaultEngineRuntimePorts.probe,
    now: defaultEngineRuntimePorts.now,
    sleep: defaultEngineRuntimePorts.sleep,
  };
}

const productionRegistry = new ProductionWorkflowEngineRegistry();
const engineDir = productionRegistry.dataDirOf(NODE_RED_ENGINE_ID);
writeFileSync(join(engineDir, "engine-trust.json"), JSON.stringify({ trusted: true }), "utf8");
const launch = productionRegistry.launchSpec(NODE_RED_ENGINE_ID);
check("★ 生产 launchSpec 非空（节点包校验通过）", launch !== null, launch === null ? "null（见上方 registry 日志）" : "ok");

if (launch === null) {
  console.log(`\nt96-probe: ${pass}/${pass + fail} 通过（launchSpec 为 null，引擎没起）`);
  process.exit(1);
}
evidence("launch command", { command: launch.command, args: launch.args, dataDir: launch.dataDir });

const ports = recordingPorts();
const runtime = new OwnedNodeRedRuntime(
  NODE_RED_ENGINE_ID, ports, createInMemoryExecutorOwnership(),
  hostServices,            // ← Host 端口：记账桩
  async () => undefined,   // 库镜像：本探针不关心
);
let child: EngineChildProcess | undefined;
const userDir = mkdtempSync(join(INSTALLED, "t96-user-"));
try {
  const status = await runtime.start({
    engineId: NODE_RED_ENGINE_ID,
    dataDir: launch.dataDir,
    command: launch.command,
    args: launch.args,
    ...(launch.env !== undefined ? { env: launch.env } : {}),
    ...(launch.probeIdentity !== undefined ? { probeIdentity: launch.probeIdentity } : {}),
    readyTimeoutMs: 25_000,
  });
  child = ports.children[0];
  evidence("engine status", status);
  check("★ L1 真引擎经生产路径就绪", status.state === "running" && status.port !== null, status);
  const port = status.port ?? 0;
  check("引擎端口真的在监听", port > 0 && (await tcpConnect(port, 2_000)), { port });

  const token = launch.env?.MCODE_ENGINE_ADMIN_TOKEN ?? "";
  const auth = { authorization: `Bearer ${token}` };

  /* ══════════ 3. 节点类型注册了吗（L2） ══════════ */
  console.log("\n3. L2 — 引擎认不认 mcode-* 类型");
  // Node-RED 的 /nodes 列出已注册的节点类型。不需要凭据的部分是 /settings 里的
  // paletteCategories，但完整清单要走 Admin API。
  const nodesList = await fetchOn(port, "/nodes", { headers: { ...auth, accept: "application/json", "Node-RED-API-Version": "v2" } }, 15_000);
  let registered: string[] = [];
  let loadErrors: unknown[] = [];
  try {
    const parsed = JSON.parse(nodesList.text) as Array<{ types?: string[]; err?: string }>;
    registered = [...new Set(parsed.flatMap((n) => n.types ?? []))];
    loadErrors = parsed.filter((n) => n.types === undefined || n.err !== undefined)
      .filter((n) => n.err !== undefined).map((n) => n.err);
  } catch { /* 下面断言会红 */ }
  evidence("/nodes status", nodesList.status);
  evidence("已注册的 mcode-* 类型", registered.filter((t) => t.startsWith("mcode-")));
  check("★ L2 mcode-agent 已注册（不是 unknown type）", registered.includes("mcode-agent"), registered.slice(0, 40));
  check("★ L2 六个 mcode-* 全部已注册且无加载错误",
    ["mcode-agent", "mcode-conversation", "mcode-branch", "mcode-trigger", "mcode-module-capability", "mcode-node-red-call"]
      .every((t) => registered.includes(t)) && loadErrors.length === 0,
    { mcodeTypes: registered.filter((t) => t.startsWith("mcode-")), loadErrors });

  /* ══════════ 4. 部署 inject → mcode-agent ══════════ */
  console.log("\n4. L3/L4/L5 — 部署 flow 并观察 Host 是否被调到");
  // 三个入口：
  //   tabP + http in /gatec-t96-probe  → 对照：证明引擎在跑（L3 正控）
  //   tabA + inject(once) → mcode-agent → debug  → 题目主体
  // inject 的 once:true 让它在部署后**立刻发一次**（不用等 repeat）。
  const probeFlow = [
    // —— 对照：纯原生 ——
    { id: "tabP", type: "tab", label: "probe-native", disabled: false, info: "", env: [] },
    { id: "inP", type: "http in", z: "tabP", url: "/t96-native", method: "get", upload: false, swaggerDoc: "", x: 100, y: 100, wires: [["outP"]] },
    { id: "outP", type: "http response", z: "tabP", x: 300, y: 100, wires: [] },
    // —— 主体：inject → mcode-agent → debug ——
    { id: "tabA", type: "tab", label: "probe-mcode-agent", disabled: false, info: "", env: [] },
    {
      id: "injA", type: "inject", z: "tabA", name: "fire", repeat: "", once: true, onceDelay: 0.5,
      props: [{ p: "payload" }], payload: "t96-input", payloadType: "str",
      topic: "", x: 100, y: 200, wires: [["agentA"]],
    },
    {
      id: "agentA", type: "mcode-agent", z: "tabA", name: "agent",
      instruction: "T96 探针：把 payload 原样返回",
      capability: "read",
      "x-mcode": { nodeId: "probe-node-1", nativeId: "agentA", nativeType: "mcode-agent",
        params: { instruction: "T96 探针：把 payload 原样返回", capability: "read" } },
      x: 300, y: 200, wires: [["dbgA"]],
    },
    { id: "dbgA", type: "debug", z: "tabA", name: "after-agent", active: true, complete: "payload", targetType: "msg", x: 500, y: 200, wires: [] },
  ];

  const deploy = await fetchOn(port, "/flows", {
    method: "POST",
    headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...auth },
    body: JSON.stringify({ flows: probeFlow }),
  }, 20_000);
  evidence("deploy", { status: deploy.status, body: deploy.text.slice(0, 400) });
  check("部署成功（200）", deploy.status === 200, deploy);

  // L3 对照：纯原生 HTTP-in 必须应答
  const nativeProbe = await waitFor(async () => {
    const r = await fetchOn(port, "/api/t96-native", {}, 3_000);
    return { status: r.status, text: r.text.slice(0, 200) };
  }, 12_000);
  evidence("L3 原生 HTTP-in 实际响应", nativeProbe);
  check("★ L3 对照：纯原生 HTTP-in 应答 200（引擎 runtime 真的在跑）", nativeProbe?.status === 200,
    nativeProbe ?? "12s 内根本没有响应 —— 引擎没跑，L4 的阴性结果不可归因到节点");

  // L4：等了足够长（inject once 0.5s + RPC）
  const hostHit = await waitFor(() => hostCalls.length > 0, 15_000);
  evidence("Host 收到的调用", hostCalls.map((c) => ({ op: c.operation, nodeId: c.payload["nodeId"], instruction: c.payload["instruction"] })));
  check("★ L4 mcode-agent 真的执行并调到了 Host 端口（operation = agent.run）",
    hostHit !== null && hostCalls.some((c) => c.operation === "agent.run"), hostCalls);
  check("★ L4 调用带着正确的 nodeId（x-mcode.nodeId 被尊重）",
    hostCalls.some((c) => c.operation === "agent.run" && c.payload["nodeId"] === "probe-node-1"),
    hostCalls.map((c) => c.payload["nodeId"]));

  // L5：结果回灌 —— 用 GET /flows 看不到运行时 msg；改看 debug 节点的运行时输出。
  // Node-RED 的 debug 只有在打开了「运行时调试」通道时才可读；这里改用**更硬**的判据：
  // 让 mcode-agent 的下游是 **http response**，由外部 HTTP 请求驱动整条链。
  console.log("\n5. L5 — 结果回灌（mcode-agent 的返回值到下游）");
  const flowWithResponse = [
    { id: "tabR", type: "tab", label: "probe-回灌", disabled: false, info: "", env: [] },
    { id: "inR", type: "http in", z: "tabR", url: "/t96-agent", method: "get", upload: false, swaggerDoc: "", x: 100, y: 100, wires: [["agentR"]] },
    {
      id: "agentR", type: "mcode-agent", z: "tabR", name: "agent",
      instruction: "回灌探针", capability: "read",
      "x-mcode": { nodeId: "probe-node-2", nativeId: "agentR", nativeType: "mcode-agent",
        params: { instruction: "回灌探针", capability: "read" } },
      x: 300, y: 100, wires: [["fnR"]],
    },
    {
      id: "fnR", type: "function", z: "tabR", name: "pack", outputs: 1, x: 500, y: 100, wires: [["outR"]],
      func: "msg.headers={'content-type':'application/json'}; msg.payload={got: msg.payload, nodeId: (msg.mcode||{}).nodeId}; return msg;",
    },
    { id: "outR", type: "http response", z: "tabR", x: 700, y: 100, wires: [] },
  ];
  const deploy2 = await fetchOn(port, "/flows", {
    method: "POST",
    headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...auth },
    body: JSON.stringify({ flows: flowWithResponse }),
  }, 20_000);
  check("回灌流部署成功", deploy2.status === 200, deploy2);
  const agentResponse = await waitFor(async () => {
    const r = await fetchOn(port, "/api/t96-agent", {}, 5_000);
    return { status: r.status, text: r.text.slice(0, 400) };
  }, 20_000);
  evidence("agent 回灌响应", agentResponse);
  check("★ L5 mcode-agent 下游收到了回灌（HTTP 200）", agentResponse?.status === 200,
    agentResponse ?? "20s 内根本没有响应 —— 节点可能没执行完或没把 msg 送下去");
  let echoed: { got?: { text?: string }; nodeId?: string } | null = null;
  try {
    const raw: unknown = agentResponse === null ? null : JSON.parse(agentResponse.text);
    echoed = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as { got?: { text?: string }; nodeId?: string } : null;
  } catch { /* 下面断言会红 */ }
  check("★ L5 回灌的 payload 是 Host 返回的 text（不是原输入）",
    echoed?.got?.text === "t96-host-saw:agent.run", echoed);
  check("★ L5 下游看到 msg.mcode.nodeId", echoed?.nodeId === "probe-node-2", echoed);
} finally {
  try { child?.kill("SIGKILL"); } catch { /* already dead */ }
  try { await runtime.stop(500); } catch { /* 已停 */ }
  try { rmSync(userDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

console.log(`\nt96-probe: ${pass}/${pass + fail} 通过${fail === 0 ? "" : `（${fail} FAIL）`}`);
if (fail > 0) process.exitCode = 1;
