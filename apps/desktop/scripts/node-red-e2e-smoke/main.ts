/**
 * 【ARC-006 NR3】**真引擎端到端**：Mcode 执行器 → Node-RED HTTP-in 流 → 返回值回灌。
 *
 * ## 为什么要有这一套
 *
 * NR3 的验收门是「一张 Mcode 图 → 触发一条 Node-RED 流 → 返回值回灌；失败分类清晰」。
 * 已有的两套无头回归都**没有真引擎**：
 *   - `workflow-engine-runtime-smoke` 用假进程钉状态机；
 *   - `workflow-engine-bridge-smoke` 用假 fetch 钉执行器语义；
 *   - `workflow-engine-electron-smoke` 的引擎是 `fake-engine.cjs`（真进程 + 真 HTTP，
 *     但不是 Node-RED）。
 * 本套用**真的 node-red@5.0.8 进程**把整条链跑通，并记录可复核的证据（版本、端口、
 * 进程日志、HTTP 响应、失败分类原文）。
 *
 * ## 前置：node-red 5.0.8 必须已装（不联网装）
 *
 * 装在 `apps/desktop/.tmp/nr-e2e/workflow-engines/node-red/`（就是生产注册表认的
 * `<dataRoot>/workflow-engines/node-red/` 布局）：
 *
 *   cd apps/desktop/.tmp/nr-e2e/workflow-engines/node-red
 *   # 先放一个最小 package.json（否则 npm 会向上找到 apps/desktop 的 workspace: 协议而失败）
 *   npm install node-red@5.0.8 --no-audit --no-fund
 *
 * **未安装时本套显式 SKIP（带原因）并以 0 退出** —— 全量套件在无网机器上不能红。
 * 安装位置可用 `MCODE_NR_E2E_ROOT` 覆盖（见 run.sh）。
 *
 * ## 两条路径，各管一件事
 *
 * **A. 生产 bootstrap（`workflowEngines/registry.ts` 写出的那份）—— Gate A 验收。**
 * 2026-10-18 专项复审的 P0-1 曾经是：它 `http.createServer()` 时**没有给请求处理器**，
 * 也从未 `app.use(RED.httpAdmin)` / `app.use(RED.httpNode)`，端口在听但编辑器与
 * HTTP-in 都没有响应。现在 A 段验证**修好后的**生产形状（官方 embedding 挂载 +
 * 宿主签发令牌的 `adminAuth` + 默认 `safeMode`）：
 *   - 编辑器 GET / 真的 200 且是 Node-RED 页面；
 *   - 无凭据客户端访问 `/flows`、`/settings`、部署、装节点一律 401；
 *   - 带宿主令牌可以部署，HTTP-in 部署后真的应答；
 *   - 未审批的持久化 flow 重启后**不进入 runtime**（`safeMode`），宿主写下可信标记
 *     `engine-trust.json` 才执行；标记损坏按不可信处理（fail-closed）；
 *   - 第二个**无凭据的本机子进程**（不是本测试进程）尝试改图/部署/装节点 → 全部被拒，
 *     原图与运行行为不变；
 *   - 真子进程 stop 后端口释放。
 *
 * **B. NR3 全链（fixture bootstrap，官方 CLI 同形的挂载方式）**：仍是生产同一套
 * `EngineRuntime` + `defaultEngineRuntimePorts`（真 spawn、`listenOnDialablePort`
 * 分配端口、env 完全替换、真 HTTP 探活），只有引导脚本换成官方挂载形状：
 *   `http.createServer((req,res)=>app(req,res))` +
 *   `app.use("/", RED.httpAdmin)` + `app.use("/api", RED.httpNode)` + 再 listen。
 * 在它上面跑：Admin API 部署流 → 生产 `nodeRedExecutor` + `defaultNodeRedFetch`
 * 发 HTTP-in → 断言回显、URL 围栏、停止/崩溃的失败分类。
 *
 * Run: bash scripts/node-red-e2e-smoke/run.sh
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";
import {
  EngineRuntime,
  defaultEngineRuntimePorts,
  type EngineChildProcess,
  type EngineRuntimePorts,
  type EngineSpawnSpec,
} from "@main/workflowEngines/runtimeSupervisor.js";
import { ProductionWorkflowEngineRegistry } from "@main/workflowEngines/registry.js";
import {
  checkEngineRequestUrl,
  defaultNodeRedFetch,
  nodeRedExecutor,
  NODE_RED_ENGINE_ID,
} from "@main/orchestration/nodeRedExecutor.js";
import { isBlockedPort } from "@main/lib/loopbackPort.js";

/* ══════════ 基础设施 ══════════ */
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
function evidence(label: string, value: unknown): void {
  console.log(`  [evidence] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function appDir(): string {
  const dir = process.cwd();
  if (!existsSync(join(dir, "src/main/workflowEngines/registry.ts"))) {
    throw new Error(`工作目录不是 apps/desktop（${dir}）—— run.sh 应 cd 到包根`);
  }
  return dir;
}
const APP = appDir();
const NR_ROOT = process.env.MCODE_NR_E2E_ROOT ?? join(APP, ".tmp", "nr-e2e");
const INSTALLED = join(NR_ROOT, "workflow-engines", NODE_RED_ENGINE_ID);
const NODE_RED_PKG = join(INSTALLED, "node_modules", "node-red", "package.json");

/** 未安装 → 显式 SKIP（带原因）且 0 退出。全量套件在无网机器上不能红。 */
if (!existsSync(NODE_RED_PKG)) {
  console.log("SKIP: 未安装 node-red —— NR3 真引擎端到端整套跳过（不是失败）。");
  console.log(`  期望位置: ${NODE_RED_PKG}`);
  console.log("  安装方法: cd <上述目录> && printf '{\"name\":\"mcode-nr-e2e-engine\",\"private\":true,\"version\":\"0.0.0\"}' > package.json && npm install node-red@5.0.8 --no-audit --no-fund");
  console.log("  （需要网络；装好后重跑本套件。MCODE_NR_E2E_ROOT 可覆盖安装根。）");
  process.exit(0);
}
const installedVersion = (JSON.parse(readFileSync(NODE_RED_PKG, "utf8")) as { version?: string }).version ?? "?";
console.log(`node-red-e2e-smoke: node-red@${installedVersion} @ ${INSTALLED}`);

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  fn: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch {
      /* 继续等 */
    }
    await sleep(intervalMs);
  }
  return null;
}

/** 与超时赛跑；原 promise 的拒绝也被观察掉，避免迟到 reject 变成 unhandled。 */
async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed = promise.then(
      (value) => ({ settled: true as const, value }),
      (error: unknown) => ({ settled: true as const, value: error as T }),
    );
    return await Promise.race([
      observed,
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** TCP 能不能连上（只判监听，不发请求）。 */
function tcpConnect(port: number, timeoutMs: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

async function fetchOn(port: number, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
}

/** 部署形状：`http in → function 回显 → http response`（A/B 两段共用一个 nonce 机制）。 */
function echoFlow(nonceHeader = "x-nr-e2e-nonce"): unknown[] {
  return [
    { id: "flow1", type: "tab", label: "nr-e2e" },
    { id: "in1", type: "http in", z: "flow1", url: "/echo", method: "post", upload: false, swaggerDoc: "", x: 100, y: 100, wires: [["fn1"]] },
    {
      id: "fn1", type: "function", z: "flow1", name: "echo", outputs: 1, x: 250, y: 100, wires: [["out1"]],
      func: "msg.headers={'content-type':'application/json'};"
        + "msg.payload={echo: msg.payload, via:'node-red', nonce:(msg.req.headers['" + nonceHeader + "']||null)};"
        + "return msg;",
    },
    { id: "out1", type: "http response", z: "flow1", x: 400, y: 100, wires: [] },
  ];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** 记录式生产端口：spawn/allocatePort 都用**生产默认实现**，只多记下 spec/端口/子进程。 */
function recordingPorts(): EngineRuntimePorts & {
  specs: EngineSpawnSpec[];
  allocated: number[];
  children: EngineChildProcess[];
} {
  const specs: EngineSpawnSpec[] = [];
  const allocated: number[] = [];
  const children: EngineChildProcess[] = [];
  return {
    specs,
    allocated,
    children,
    spawn: (spec) => {
      specs.push(spec);
      const child = defaultEngineRuntimePorts.spawn(spec);
      children.push(child);
      return child;
    },
    allocatePort: async () => {
      const port = await defaultEngineRuntimePorts.allocatePort();
      allocated.push(port);
      return port;
    },
    probe: defaultEngineRuntimePorts.probe,
    now: defaultEngineRuntimePorts.now,
    sleep: defaultEngineRuntimePorts.sleep,
  };
}

function killQuietly(child: EngineChildProcess | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!child) return;
  try {
    child.kill(signal);
  } catch {
    /* 已经死了 */
  }
}

/* ══════════ A. 生产 bootstrap：Gate A 验收（真 node-red 5.0.8） ══════════ */
console.log("\nA. 生产注册表 bootstrap（官方挂载 + 宿主令牌认证 + 默认 safeMode）");

/** 生产 dataDir 里由本套造出来的文件；A 段开始/结束都清掉，避免上次运行的状态影响判据。 */
function cleanProductionState(): void {
  for (const name of ["flows.json", ".flows.json.backup", "flows_cred.json", ".config.runtime.json", "engine-trust.json"]) {
    try {
      rmSync(join(INSTALLED, name), { force: true });
    } catch {
      /* 清不掉就让断言去暴露 */
    }
  }
}

/** 第二个**独立进程**的无凭据 HTTP 客户端 —— 不是本进程内的 fetch。
 *  它尝试的部署会注册 `/pwned`（若成功，`/api/pwned` 就会应答）；被拒后必须既
 *  改不动图，也跑不出任何新行为。 */
const UNPRIVILEGED_CLIENT = `// node-red-e2e-smoke：另一个本机进程，没有任何宿主凭据。
const http = require("node:http");
const port = Number(process.argv[2]);
function req(method, path, body) {
  return new Promise((resolve) => {
    // 头与编辑器真实部署一致（缺 Node-RED-API-Version 时上游按旧协议解析，会 400 ——
    // 那样"被拒"就不是认证的功劳，敌意部署根本没被尝试）。
    const r = http.request({ host: "127.0.0.1", port, path, method, headers: body === null ? {} : { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", () => resolve(-1));
    r.end(body === null ? undefined : body);
  });
}
const hostileFlow = [
  { id: "pwnflow", type: "tab", label: "pwn" },
  { id: "pwnin", type: "http in", z: "pwnflow", url: "/pwned", method: "post", wires: [["pwnout"]] },
  { id: "pwnout", type: "http response", z: "pwnflow", wires: [] },
];
(async () => {
  const result = {
    getFlows: await req("GET", "/flows", null),
    getSettings: await req("GET", "/settings", null),
    postFlows: await req("POST", "/flows", JSON.stringify({ flows: hostileFlow })),
    postNodes: await req("POST", "/nodes", "{}"),
  };
  console.log(JSON.stringify(result));
})();
`;

function runUnprivilegedClient(port: number): Record<string, number> | null {
  const dir = mkdtempSync(join(INSTALLED, "unprivileged-"));
  const script = join(dir, "client.cjs");
  try {
    writeFileSync(script, UNPRIVILEGED_CLIENT, "utf8");
    const out = spawnSync(process.execPath, [script, String(port)], { encoding: "utf8", timeout: 20_000 });
    if (out.status !== 0 || typeof out.stdout !== "string") return null;
    return JSON.parse(out.stdout.trim()) as Record<string, number>;
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

let runtimeA: EngineRuntime | null = null;
let childA: EngineChildProcess | undefined;
try {
  cleanProductionState();
  const registry = new ProductionWorkflowEngineRegistry();
  let launch = registry.launchSpec(NODE_RED_ENGINE_ID);
  check("★ 生产注册表认出已安装的 node-red 并给出启动参数", launch !== null);
  if (launch === null) throw new Error("launchSpec 返回 null —— 安装布局与生产注册表不一致");

  // —— A1. 引导脚本形状：官方挂载 + adminAuth + safeMode ——
  const bootstrapPath = join(INSTALLED, "bootstrap.cjs");
  const bootstrapText = existsSync(bootstrapPath) ? readFileSync(bootstrapPath, "utf8") : "";
  evidence("production bootstrap", bootstrapPath);
  evidence("production bootstrap sha256", createHash("sha256").update(bootstrapText).digest("hex"));
  check("★【P0-1】生产 bootstrap 把 RED.httpAdmin 挂到 \"/\"（官方 embedding 形状）",
    bootstrapText.includes("app.use(\"/\", RED.httpAdmin)"));
  check("★【P0-1】生产 bootstrap 把 RED.httpNode 挂到 \"/api\"",
    bootstrapText.includes("app.use(\"/api\", RED.httpNode)"));
  check("★【P0-1】请求处理器接到 server 上（express 作为 request listener）",
    bootstrapText.includes("http.createServer((req, res) => app(req, res))"));
  check("★【P0-2】生产 bootstrap 配置 adminAuth（不是 Node-RED 默认的无认证）",
    bootstrapText.includes("adminAuth:") && bootstrapText.includes("tokens:"));
  check("★【P0-2】生产 bootstrap 默认 safeMode（未审批的持久化 flow 不自动执行）",
    bootstrapText.includes("safeMode,") && bootstrapText.includes("MCODE_ENGINE_TRUSTED"));
  check("★ 生产 bootstrap 的 flowFile 固定（不随 hostname 漂移）", bootstrapText.includes("flowFile: \"flows.json\""));

  // —— A2. 宿主签发的凭据 ——
  const secretPath = join(INSTALLED, ".engine-secret");
  const secret = existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "";
  check("★ 宿主生成了凭据密钥（32 字节 hex）并放在 dataDir 的 .engine-secret", /^[0-9a-f]{64}$/.test(secret));
  check("★ 启动 env 里的凭据密钥与 .engine-secret 一致（不进日志/flows）", launch.env?.NODE_RED_CREDENTIAL_SECRET === secret);
  const tokenPath = join(INSTALLED, ".engine-admin-token");
  const adminToken = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "";
  evidence(".engine-admin-token", `${tokenPath} (${adminToken.length} 字符)`);
  check("★【P0-2】宿主签发了 Admin API 令牌（32 字节 hex，与凭据密钥分开存）",
    /^[0-9a-f]{64}$/.test(adminToken) && adminToken !== secret);
  check("★【P0-2】令牌随 env 注入引擎（MCODE_ENGINE_ADMIN_TOKEN），不在 status/flows 里",
    launch.env?.MCODE_ENGINE_ADMIN_TOKEN === adminToken);
  check("★【P0-2】未写可信标记时 env 是 untrusted（MCODE_ENGINE_TRUSTED=0）",
    launch.env?.MCODE_ENGINE_TRUSTED === "0");
  check("★ 启动命令是宿主自己的 node + 引导脚本（不是 node-red CLI）", launch.command === process.execPath && launch.args.length > 0);

  // 预置一份**未经宿主审批**的持久化 flow：重启后不得自动执行。
  writeFileSync(join(INSTALLED, "flows.json"), JSON.stringify(echoFlow()), "utf8");

  // —— A3. 真启动（生产 EngineRuntime + 生产端口分配 + 真探测） ——
  const portsA = recordingPorts();
  runtimeA = new EngineRuntime(NODE_RED_ENGINE_ID, portsA);
  let statusA = await runtimeA.start({
    engineId: NODE_RED_ENGINE_ID,
    dataDir: launch.dataDir,
    command: launch.command,
    args: launch.args,
    ...(launch.env !== undefined ? { env: launch.env } : {}),
    readyTimeoutMs: 20_000,
  });
  childA = portsA.children[0];
  evidence("production start status", statusA);
  evidence("engine log tail", childA?.tailOutput().slice(-600) ?? "(no child)");
  check("★【P0-1】生产引导路径真的就绪（真 spawn / 生产端口分配 / 真 HTTP 探活）",
    statusA.state === "running" && statusA.port !== null, statusA);
  const portA = statusA.port ?? 0;
  evidence("production port", portA);

  const editor = await fetchOn(portA, "/");
  evidence("production GET /", { status: editor.status, bytes: editor.text.length });
  check("★【P0-1】编辑器 GET / 真响应 200 且是 Node-RED 编辑器页",
    editor.status === 200 && editor.text.includes("red-ui-editor") && editor.text.includes("<title>Node-RED</title>"));

  // —— A4. 无凭据客户端一律被拒（控制面） ——
  const noAuthFlows = await fetchOn(portA, "/flows");
  const noAuthSettings = await fetchOn(portA, "/settings");
  const noAuthDeploy = await fetchOn(portA, "/flows", {
    method: "POST",
    headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2" },
    body: JSON.stringify({ flows: [] }),
  });
  const noAuthNodes = await fetchOn(portA, "/nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  evidence("no-auth Admin API", {
    flows: noAuthFlows.status, settings: noAuthSettings.status, deploy: noAuthDeploy.status, nodes: noAuthNodes.status,
  });
  check("★【P0-2】未带宿主凭据：GET /flows 被拒（401）", noAuthFlows.status === 401);
  check("★【P0-2】未带宿主凭据：GET /settings 被拒（401）", noAuthSettings.status === 401);
  check("★【P0-2】未带宿主凭据：Deploy 被拒（401）", noAuthDeploy.status === 401);
  check("★【P0-2】未带宿主凭据：安装节点被拒（401）", noAuthNodes.status === 401);

  // —— A5. 第二个本机进程（无凭据）同样被拒，且原图/行为不变 ——
  const authHeaders = { authorization: `Bearer ${adminToken}` };
  const flowsBefore = await fetchOn(portA, "/flows", { headers: authHeaders });
  check("★ 带宿主凭据 GET /flows 返回 200（编辑器可读原图）", flowsBefore.status === 200);
  const unprivileged = runUnprivilegedClient(portA);
  evidence("second unprivileged process", unprivileged);
  check("★【P0-2】第二个无凭据本机进程访问 /flows、/settings、部署端点、装节点 → 全部 401",
    unprivileged !== null && unprivileged.getFlows === 401 && unprivileged.getSettings === 401
    && unprivileged.postFlows === 401 && unprivileged.postNodes === 401, unprivileged);
  const flowsAfterUnprivileged = await fetchOn(portA, "/flows", { headers: authHeaders });
  check("★【P0-2】被拒之后原图未变（字节级相同）",
    flowsBefore.status === 200 && flowsAfterUnprivileged.text === flowsBefore.text);
  const pwned = await fetchOn(portA, "/api/pwned", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  evidence("second process hostile deploy effect", { pwned: pwned.status });
  check("★【P0-2】被拒的敌意部署没有产生任何运行行为（/api/pwned 仍是 404）", pwned.status === 404);
  // 敌意 deploy 被拒的**直接**证据：请求状态必须是 401。只看 /api/pwned 404 会被
  // 另一层巧合掩盖 —— 实测：无 adminAuth 时上游没有 http in 节点模块（multipart/multer
  // 上传形状不对时返回 400），部署根本不会发生，404 仍成立。断言要打在拒绝本身。
  check("★【P0-2】第二个无凭据进程的敌意 Deploy 本身被拒（401，不是被上游参数校验挡掉）",
    unprivileged !== null && unprivileged.postFlows === 401
    && unprivileged.getFlows === 401 && unprivileged.getSettings === 401 && unprivileged.postNodes === 401,
    unprivileged);

  // —— A6. 未审批的持久化 flow：safeMode 下不进入 runtime ——
  const safeEcho = await fetchOn(portA, "/api/echo", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x: 1 }),
  });
  evidence("untrusted HTTP-in", { status: safeEcho.status });
  check("★【P0-2】未审批的持久化 flow 不进入 runtime（HTTP-in 404，编辑器仍可见原图）",
    safeEcho.status === 404 && flowsBefore.status === 200);

  // —— A7. 带凭据部署成功；会话内显式 deploy 是用户的动作（会解除 safeMode） ——
  const nonce = `nr-e2e-${randomUUID()}`;
  const deploy = await fetchOn(portA, "/flows", {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
      "Node-RED-Deployment-Type": "full",
      "Node-RED-API-Version": "v2",
    },
    body: JSON.stringify({ flows: echoFlow() }),
  }, 15_000);
  let deployRev: string | null = null;
  try {
    deployRev = (JSON.parse(deploy.text) as { rev?: string }).rev ?? null;
  } catch {
    /* 下面断言会红 */
  }
  evidence("authorized deploy", { status: deploy.status, rev: deployRev });
  check("★【P0-2】带宿主凭据的 Deploy 成功（200 且带 rev）",
    deploy.status === 200 && typeof deployRev === "string");
  const registered = await waitFor(async () => {
    const res = await fetchOn(portA, "/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-nr-e2e-nonce": nonce },
      body: JSON.stringify({ warmup: true }),
    }, 5_000);
    return res.status === 200 ? res : null;
  }, 15_000);
  evidence("HTTP-in after authorized deploy", registered === null ? null : { status: registered.status });
  check("★【P0-1】带凭据部署后 HTTP-in 真的注册并应答（200）", registered !== null);

  // —— A8. stop：端口释放（真子进程） ——
  const stoppedA = await runtimeA.stop(2_000);
  evidence("A stop status", stoppedA);
  check("★ stop 后状态 stopped、端口清空", stoppedA.state === "stopped" && stoppedA.port === null, stoppedA);
  const portClosedA = await waitFor(async () => ((await tcpConnect(portA, 500)) ? null : true), 10_000);
  check("★【真子进程】stop 后端口不再监听（无孤儿监听）", portClosedA === true);
  childA = undefined;

  // —— A9. 重启：未经宿主审批的持久化 flow 不得自动执行 ——
  // ⚠️ Gate A 边界：会话内的显式 Deploy 会解除**本次会话**的 safeMode（Node-RED 上游
  // 语义）；跨重启的可信判定只看宿主标记。所以下面这一步必须发生在「部署过、flows.json
  // 已落盘」之后。
  const persistedFlows = readFileSync(join(INSTALLED, "flows.json"), "utf8");
  check("★ 部署后的 flow 已持久化到 production dataDir 的 flows.json", persistedFlows.includes("\"http in\""));

  launch = registry.launchSpec(NODE_RED_ENGINE_ID);
  check("★ 重启前：宿主仍未写可信标记 → env 仍是 untrusted",
    launch !== null && launch.env?.MCODE_ENGINE_TRUSTED === "0");
  const portsA2 = recordingPorts();
  runtimeA = new EngineRuntime(NODE_RED_ENGINE_ID, portsA2);
  statusA = await runtimeA.start({
    engineId: NODE_RED_ENGINE_ID,
    dataDir: launch!.dataDir,
    command: launch!.command,
    args: launch!.args,
    ...(launch!.env !== undefined ? { env: launch!.env } : {}),
    readyTimeoutMs: 20_000,
  });
  childA = portsA2.children[0];
  const portA2 = statusA.port ?? 0;
  evidence("restart(untrusted) status", statusA);
  check("★ 重启（untrusted）后引擎就绪", statusA.state === "running" && portA2 > 0, statusA);
  const restartEcho = portA2 > 0
    ? await waitFor(async () => {
        const res = await fetchOn(portA2, "/api/echo", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ after: "restart" }),
        }, 3_000);
        // 404 就是我们要的稳定结论；多等一轮确认没有「迟到启动」。
        return res.status === 404 ? res : null;
      }, 8_000)
    : null;
  const restartFlows = portA2 > 0 ? await fetchOn(portA2, "/flows", { headers: authHeaders }) : { status: 0, text: "" };
  evidence("restart(untrusted) HTTP-in", { echo: restartEcho?.status ?? null, flows: restartFlows.status });
  check("★【P0-2】未经审批的持久化 flow 重启后不自动执行（HTTP-in 持续 404，编辑器仍能读到原图）",
    restartEcho !== null && restartFlows.status === 200 && restartFlows.text.includes("\"http in\""));

  const stoppedA2 = await runtimeA.stop(2_000);
  check("★ 第二次 stop 后端口清空", stoppedA2.state === "stopped" && stoppedA2.port === null, stoppedA2);
  childA = undefined;

  // —— A10. 宿主写下可信标记后才自动执行 ——
  writeFileSync(join(INSTALLED, "engine-trust.json"), JSON.stringify({ trusted: true }), "utf8");
  launch = registry.launchSpec(NODE_RED_ENGINE_ID);
  check("★ 宿主写下可信标记后 env 变成 trusted（MCODE_ENGINE_TRUSTED=1）",
    launch !== null && launch.env?.MCODE_ENGINE_TRUSTED === "1");
  const portsA3 = recordingPorts();
  runtimeA = new EngineRuntime(NODE_RED_ENGINE_ID, portsA3);
  statusA = await runtimeA.start({
    engineId: NODE_RED_ENGINE_ID,
    dataDir: launch!.dataDir,
    command: launch!.command,
    args: launch!.args,
    ...(launch!.env !== undefined ? { env: launch!.env } : {}),
    readyTimeoutMs: 20_000,
  });
  childA = portsA3.children[0];
  const portA3 = statusA.port ?? 0;
  evidence("restart(trusted) status", statusA);
  const trustedEcho = portA3 > 0
    ? await waitFor(async () => {
        const res = await fetchOn(portA3, "/api/echo", {
          method: "POST",
          headers: { "content-type": "application/json", "x-nr-e2e-nonce": nonce },
          body: JSON.stringify({ trusted: true }),
        }, 3_000);
        return res.status === 200 ? res : null;
      }, 15_000)
    : null;
  check("★【P0-2】宿主批准（可信标记）后，重启自动执行持久化 flow（HTTP-in 200）", trustedEcho !== null);

  const stoppedA3 = await runtimeA.stop(2_000);
  check("★ 第三次 stop 后端口清空", stoppedA3.state === "stopped" && stoppedA3.port === null, stoppedA3);
  childA = undefined;

  // —— A11. 标记损坏 → fail-closed ——
  writeFileSync(join(INSTALLED, "engine-trust.json"), "not-json{", "utf8");
  const brokenLaunch = registry.launchSpec(NODE_RED_ENGINE_ID);
  check("★【P0-2】可信标记损坏 → 按 untrusted 处理（fail-closed）",
    brokenLaunch !== null && brokenLaunch.env?.MCODE_ENGINE_TRUSTED === "0");
} catch (err) {
  check(`A 段未抛异常（${err instanceof Error ? err.message : String(err)}）`, false);
} finally {
  killQuietly(childA);
  if (runtimeA !== null) await settleWithin(runtimeA.stop(500), 8_000);
  cleanProductionState();
  try {
    const status = runtimeA?.status();
    if (status) evidence("A 段收尾状态", status.state);
  } catch {
    /* 忽略 */
  }
}

/* ══════════ B. NR3 全链：真 Node-RED + 生产 EngineRuntime + 生产执行器 ══════════ */
console.log("\nB. NR3 全链：执行器 → HTTP-in 流 → 返回值回灌（fixture bootstrap，官方 CLI 同形挂载）");

// fixture bootstrap：与 Node-RED 官方 red.js 的挂载方式同形。生产 bootstrap 的缺陷见 A 段。
const FIXTURE_BOOTSTRAP = `// 【node-red-e2e-smoke】官方 CLI 同形的引导脚本：端口与数据目录由宿主给。
const RED = require("node-red");
const express = require("express");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const port = Number(process.argv[2]);
const userDir = process.argv[3];
const app = express();
const server = http.createServer((req, res) => app(req, res));
RED.init(server, {
  httpAdminRoot: "/",
  httpNodeRoot: "/api",
  userDir,
  credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || false,
  logging: { console: { level: "warn" } },
});
app.use("/", RED.httpAdmin);
app.use("/api", RED.httpNode);
RED.start().then(
  () => {
    server.listen(port, "127.0.0.1", () => {
      fs.writeFileSync(path.join(userDir, "fixture-ready.json"), JSON.stringify({
        port,
        address: server.address(),
        hostEnv: process.env.HOST ?? null,
        portEnv: process.env.PORT ?? null,
        envKeys: Object.keys(process.env).sort(),
        nodeRedVersion: RED.version(),
      }));
      console.error("[mcode-engine-fixture] node-red ready on " + port);
    });
  },
  (err) => {
    console.error("[mcode-engine-fixture] node-red start failed: " + (err && err.message));
    process.exit(2);
  },
);
`;

/** 与执行器同形的上下文：优先走 `input.engineRequest`（调度器解算后的形状）。 */
function execContext(path: string, method: string, body: string | null, headers?: Record<string, string>) {
  return {
    node: { params: {} },
    input: {
      signal: new AbortController().signal,
      engineRequest: { path, method, body, ...(headers !== undefined ? { headers } : {}) },
    },
  } as never;
}

let runtimeB: EngineRuntime | null = null;
let childB: EngineChildProcess | undefined;
let fixtureUserDir: string | null = null;
try {
  const fixtureBootstrapPath = join(INSTALLED, "bootstrap-e2e-fixture.cjs");
  writeFileSync(fixtureBootstrapPath, FIXTURE_BOOTSTRAP, "utf8");
  fixtureUserDir = mkdtempSync(join(INSTALLED, "fixture-user-"));

  // 宿主环境里的 canary：env 完全替换时它绝不能出现在引擎进程里。
  process.env.MCODE_E2E_SECRET_CANARY = "must-not-leak";
  const secretB = randomBytes(32).toString("hex");

  const portsB = recordingPorts();
  runtimeB = new EngineRuntime(NODE_RED_ENGINE_ID, portsB);
  const statusB = await runtimeB.start({
    engineId: NODE_RED_ENGINE_ID,
    dataDir: fixtureUserDir,
    command: process.execPath,
    args: (port, userDir) => [fixtureBootstrapPath, String(port), userDir],
    env: { NODE_RED_CREDENTIAL_SECRET: secretB },
  });
  evidence("fixture start status", statusB);
  check("★ 真 node-red 经**生产 EngineRuntime** 起来（真 spawn / listenOnDialablePort / 真 HTTP 探活）",
    statusB.state === "running" && statusB.port !== null, statusB);
  const portB = statusB.port ?? 0;
  childB = portsB.children[0];
  evidence("fixture port", portB);
  evidence("engine log tail", childB?.tailOutput().slice(-800) ?? "(no child)");
  check("★ 端口由生产 listenOnDialablePort 分配（不是 fetch 黑名单端口）", portB > 0 && !isBlockedPort(portB));

  const readyFile = join(fixtureUserDir, "fixture-ready.json");
  const ready = await waitFor(() => (existsSync(readyFile) ? JSON.parse(readFileSync(readyFile, "utf8")) as {
    port: number;
    address: { address?: string; port?: number } | null;
    hostEnv: string | null;
    portEnv: string | null;
    envKeys: string[];
    nodeRedVersion: string;
  } : null), 15_000);
  check("★ 引擎自报已就绪（fixture-ready.json）", ready !== null);
  if (ready !== null) {
    evidence("engine-side address", ready.address);
    evidence("engine-side node-red version", ready.nodeRedVersion);
    evidence("engine-side env keys", ready.envKeys);
    check("★ 引擎只绑 127.0.0.1（server.address().address）", ready.address?.address === "127.0.0.1", ready.address);
    check("★ 引擎侧 PORT/HOST 与宿主分配一致", ready.portEnv === String(portB) && ready.hostEnv === "127.0.0.1",
      { portEnv: ready.portEnv, hostEnv: ready.hostEnv });

    const keysLower = ready.envKeys.map((k) => k.toLowerCase()).sort();
    // `EngineRuntime` 的 spec.env 是**完整替换**（只给 PATH[/SystemRoot]/PORT/HOST/凭据密钥）。
    // 但 Windows 上 CreateProcess 的 lpEnvironment 即便由调用方给，子进程仍会看到
    // 系统级会话变量（HOMEDRIVE/HOMEPATH/LOGONSERVER/TEMP/USERPROFILE/WINDIR 等）——
    // 实测：spec.env 只有 5 个键，引擎进程看到 14 个，多出来的全是系统注入且**不含**
    // 宿主进程里的任意 canary。所以判据分两层：
    //   1) 宿主 spec 里恰好是白名单（直接查 spawn spec，不查子进程环境）；
    //   2) 子进程环境不得出现宿主进程的任意自定义变量（canary 缺席 + 无 ANTHROPIC_*/MCODE_*）。
    const specKeys = Object.keys(portsB.specs[0]?.env ?? {}).sort();
    const expectedSpec = ["HOST", "NODE_RED_CREDENTIAL_SECRET", "PATH", "PORT", ...(process.platform === "win32" ? ["SystemRoot"] : [])].sort();
    check("★ env 在 spawn spec 里**完全替换**：恰好是宿主白名单（PATH[/SystemRoot]/PORT/HOST/凭据密钥）",
      deepEqual(specKeys, expectedSpec), { actual: specKeys, expected: expectedSpec });
    const hostInjected = keysLower.filter((k) => !expectedSpec.map((s) => s.toLowerCase()).includes(k));
    evidence("engine-side 额外（系统注入）变量", hostInjected);
    const hostSecrets = ready.envKeys.filter((k) => /^(ANTHROPIC|OPENAI|DEEPSEEK|MCODE_|CLAUDE_)/i.test(k));
    check("★ 宿主环境变量没有泄漏进引擎进程（canary 缺席，且无 ANTHROPIC_*/OPENAI_*/MCODE_*/CLAUDE_*）",
      !keysLower.includes("mcode_e2e_secret_canary") && hostSecrets.length === 0, hostSecrets);
    check("★ 引擎进程里的额外变量只可能来自 Windows 会话（非宿主进程的密钥/自定义变量）",
      hostInjected.every((k) => ["homedrive", "homepath", "logonserver", "systemdrive", "temp", "userdomain", "username", "userprofile", "windir"].includes(k)),
      hostInjected);
  }

  const exec = nodeRedExecutor({
    engine: { status: () => runtimeB!.status() },
    fetch: (req) => defaultNodeRedFetch(req),
  });

  // —— B1. 部署前：HTTP-in 还没注册 ——
  const beforeDeploy = await fetchOn(portB, "/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ probe: true }),
  });
  evidence("部署前 POST /api/echo", { status: beforeDeploy.status });
  check("★ 部署前 HTTP-in 未注册（404）——证明之后的回显来自部署的流", beforeDeploy.status === 404);

  // —— B2. 经 Admin API 部署流：HTTP-in → function 回显 body/头 → HTTP response ——
  const nonce = `nr-e2e-${randomUUID()}`;
  const flow = echoFlow();
  const deploy = await fetchOn(portB, "/flows", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Node-RED-Deployment-Type": "full",
      "Node-RED-API-Version": "v2",
    },
    body: JSON.stringify({ flows: flow }),
  }, 15_000);
  let deployRev: string | null = null;
  try {
    deployRev = (JSON.parse(deploy.text) as { rev?: string }).rev ?? null;
  } catch {
    /* 下面断言会红 */
  }
  evidence("Admin API deploy", { status: deploy.status, rev: deployRev });
  check("★ Admin API 部署返回 200 且带 rev", deploy.status === 200 && typeof deployRev === "string");

  const registered = await waitFor(async () => {
    const res = await fetchOn(portB, "/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ warmup: true }),
    }, 5_000);
    return res.status === 200 ? true : null;
  }, 15_000);
  check("★ 部署后 HTTP-in 真的注册并应答（200）", registered === true);

  // —— B3. 生产执行器发请求，返回值回灌 ——
  const payload = { hello: "world", n: 42, nested: { ok: true }, marker: nonce };
  const out = await exec.execute(execContext("/api/echo", "POST", JSON.stringify(payload), { "x-nr-e2e-nonce": nonce }));
  evidence("executor success", { status: out.status, summary: out.summary, outputs: out.outputs, error: out.error ?? null });
  check("★ 生产 nodeRedExecutor + defaultNodeRedFetch 经真 HTTP-in 成功", out.status === "success", out);
  check("★ summary 是「Node-RED 200」", out.summary === "Node-RED 200", out.summary);
  check("★ 返回值回灌正确：流里 function 节点回显的 body 与发送的一致",
    deepEqual((out.outputs as { body?: { echo?: unknown } })?.body?.echo, payload), out.outputs);
  check("★ 请求头穿过执行器到达流（nonce 回显一致）",
    (out.outputs as { body?: { nonce?: unknown } })?.body?.nonce === nonce, out.outputs);
  check("★ outputs 里带 HTTP 状态与 truncated 标记",
    (out.outputs as { status?: unknown })?.status === 200 && (out.outputs as { truncated?: unknown })?.truncated === false, out.outputs);

  // —— B4. URL 围栏：只放行本机回环 + 本引擎端口 ——
  const remote = await exec.execute(execContext("https://example.com/steal", "POST", "{}"));
  evidence("fence remote", { status: remote.status, error: remote.error });
  check("★ 远程地址被执行器拒绝（点名本机回环）",
    remote.status === "failed" && remote.retryable === false
    && /本机回环/.test(remote.error ?? "") && /example\.com/.test(remote.error ?? ""), remote);
  const otherPort = portB === 65_535 ? portB - 1 : portB + 1;
  const wrongPort = checkEngineRequestUrl(`http://127.0.0.1:${otherPort}/x`, portB);
  check("★ 别的本地端口也被围栏拒绝", wrongPort.ok === false && wrongPort.reason.includes(String(otherPort)), wrongPort);

  // —— B5. HTTP 错误的分类：404 不可重试 ——
  const missing = await exec.execute(execContext("/api/definitely-not-deployed", "POST", "{}"));
  evidence("HTTP 404 classification", { status: missing.status, retryable: missing.retryable, error: missing.error });
  check("★ 引擎返回 404 → failed 且不可重试（请求本身的问题）",
    missing.status === "failed" && missing.retryable === false && /HTTP 404/.test(missing.error ?? ""), missing);

  // —— B6. 崩溃分类：真进程被杀 → failed，执行器报「启动失败」并带原因 ——
  killQuietly(childB);
  childB = undefined;
  const failedStatus = await waitFor(() => (runtimeB!.status().state === "failed" ? runtimeB!.status() : null), 10_000);
  evidence("crash status", failedStatus);
  check("★ 进程被杀后状态及时进 failed 且点名意外退出",
    failedStatus !== null && /意外退出/.test(failedStatus.reason ?? ""), failedStatus);
  const portClosed = await waitFor(async () => ((await tcpConnect(portB, 500)) ? null : true), 10_000);
  check("★ 崩溃后端口不再监听（无孤儿监听）", portClosed === true);
  const crashedOut = await exec.execute(execContext("/api/echo", "POST", "{}"));
  evidence("failed classification", { status: crashedOut.status, retryable: crashedOut.retryable, error: crashedOut.error });
  check("★ failed 分类：执行器报「工作流引擎启动失败」且不可重试",
    crashedOut.status === "failed" && crashedOut.retryable === false
    && /启动失败/.test(crashedOut.error ?? "") && /意外退出/.test(crashedOut.error ?? ""), crashedOut);

  // —— B7. 停止分类：引擎 stopped → 明确「尚未运行/请先启动」 ——
  const stopped = await runtimeB.stop(1_000);
  evidence("stop status", stopped);
  check("★ stop 后状态 stopped、端口清空", stopped.state === "stopped" && stopped.port === null, stopped);
  const stoppedOut = await exec.execute(execContext("/api/echo", "POST", "{}"));
  evidence("stopped classification", { status: stoppedOut.status, retryable: stoppedOut.retryable, error: stoppedOut.error });
  check("★ stopped 分类：执行器明确说「尚未运行 —— 请先…启动」且不可重试",
    stoppedOut.status === "failed" && stoppedOut.retryable === false
    && /尚未运行/.test(stoppedOut.error ?? "") && /启动/.test(stoppedOut.error ?? ""), stoppedOut);
} catch (err) {
  check(`B 段未抛异常（${err instanceof Error ? err.message : String(err)}）`, false);
} finally {
  killQuietly(childB);
  if (runtimeB !== null) await settleWithin(runtimeB.stop(500), 8_000);
  delete process.env.MCODE_E2E_SECRET_CANARY;
  if (fixtureUserDir !== null) {
    try {
      rmSync(fixtureUserDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

console.log(`\nnode-red-e2e-smoke: ${total - failures}/${total} 通过${failures === 0 ? "" : `（${failures} FAIL）`}`);
if (failures > 0) process.exitCode = 1;
