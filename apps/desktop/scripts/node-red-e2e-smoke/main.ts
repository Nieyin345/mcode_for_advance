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
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { ProductionWorkflowEngineRegistry, OwnedNodeRedRuntime } from "@main/workflowEngines/registry.js";
import { createInMemoryExecutorOwnership } from "@main/workflowEngines/executorOwnership.js";
import {
  checkEngineRequestUrl,
  defaultNodeRedFetch,
  nodeRedExecutor,
  NODE_RED_ENGINE_ID,
} from "@main/orchestration/nodeRedExecutor.js";
import { isBlockedPort } from "@main/lib/loopbackPort.js";
import { migrateWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";

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
/** 共享安装树：node-red 的 106MB 依赖装在这里（gitignored，可被 MCODE_NR_E2E_ROOT 覆盖）。 */
const SHARED_ENGINE_DIR = join(NR_ROOT, "workflow-engines", NODE_RED_ENGINE_ID);
const SHARED_NODE_MODULES = join(SHARED_ENGINE_DIR, "node_modules");
const NODE_RED_PKG = join(SHARED_NODE_MODULES, "node-red", "package.json");

/**
 * 【并行隔离】数据目录 = 本套**私有**目录，`node_modules` 用 junction 指回共享安装树。
 *
 * 从前 `INSTALLED`（共享安装树本身）同时充当 dataDir：另一份全量跑（或
 * `mcode-node-pack-smoke`）在同目录写/清 `flows.json`、`engine-trust.json`、
 * `.config.runtime.json` 时，本套会看到「刚部署的 flow 没了」「信任标记被改写」，
 * 甚至 Node-RED 自己 flush `.config.runtime.json` 时目录被清 → 未捕获异常退出
 * （实测：并行时 78/80，且 Gate C 20s 就绪超时后 EADDRNOTAVAIL）。与 node-pack
 * 同一模式：可变状态全落私有目录，106MB 依赖共享。
 *
 * junction 不可用 → 回退整树复制（慢、占盘，但绝不回退成共享目录）。
 */
const PRIVATE_DATA_ROOT = process.env.MCODE_SMOKE_DATA_ROOT ?? "";
const PRIVATE_ENGINE_DIR = PRIVATE_DATA_ROOT === "" ? "" : join(PRIVATE_DATA_ROOT, "workflow-engines", NODE_RED_ENGINE_ID);
if (PRIVATE_ENGINE_DIR !== "" && existsSync(SHARED_NODE_MODULES)) {
  mkdirSync(PRIVATE_ENGINE_DIR, { recursive: true });
  const linkPath = join(PRIVATE_ENGINE_DIR, "node_modules");
  if (!existsSync(linkPath)) {
    try {
      symlinkSync(SHARED_NODE_MODULES, linkPath, "junction");
    } catch {
      cpSync(SHARED_NODE_MODULES, linkPath, { recursive: true });
    }
  }
}
const INSTALLED = PRIVATE_ENGINE_DIR === "" ? SHARED_ENGINE_DIR : PRIVATE_ENGINE_DIR;

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
  runtimeA = new OwnedNodeRedRuntime(NODE_RED_ENGINE_ID, portsA, createInMemoryExecutorOwnership());
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
  // T47: Node-RED HTML-escapes slashes in href (`theme&#x2F;css&#x2F;...`).
  // Decode actual HTML attribute values before verifying that the editor loads
  // the stylesheet; a bare CSS endpoint returning 200 does not prove linkage.
  const decodeHtmlAttribute = (s: string): string => s
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_, hex: string | undefined, dec: string | undefined) =>
      String.fromCodePoint(Number.parseInt(hex ?? dec ?? "", hex === undefined ? 10 : 16)))
    .replace(/&amp;/gi, "&");
  const editorStylesheets = [...editor.text.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => decodeHtmlAttribute(tag))
    .filter((tag) => /\brel\s*=\s*["']stylesheet["']/i.test(tag))
    .map((tag) => tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? "")
    .filter(Boolean);
  evidence("production stylesheet hrefs (HTML-decoded)", editorStylesheets);
  const themePath = editorStylesheets
    .map((href) => new URL(href, "http://localhost/").pathname)
    .find((path) => path === "/theme/css/mcode-theme-auto.css");
  check("★【T47】编辑器 HTML 真实引用宿主注入的主题样式表",
    themePath !== undefined, { stylesheets: editorStylesheets });
  const themeResponse = await fetchOn(portA, themePath ?? "/theme/css/mcode-theme-auto.css");
  check("★【T47】生产 Node-RED 确实托管了浅/深两套 CSS 变量",
    themeResponse.status === 200
      && themeResponse.text.includes("--red-ui-primary-background: #fcfcfb")
      && themeResponse.text.includes("@media (prefers-color-scheme: dark)")
      && themeResponse.text.includes("--red-ui-primary-background: #151515"),
    { status: themeResponse.status, bytes: themeResponse.text.length });

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

  // W25: true Node-RED event graph, real upstream 20-inject HTTP endpoint.
  // The function node records ONLY the ticket; never any DOI/form secret.
  // An independent HTTP-in endpoint reads state so "POST 200" alone cannot
  // satisfy this test without actual downstream node execution.
  const manualFlow = [
    ...echoFlow(),
    {
      id: "manual-in", type: "inject", z: "flow1", name: "Explicit manual W25",
      once: false, onceDelay: 0, repeat: "", crontab: "",
      props: [{ p: "payload" }], payload: "", payloadType: "str",
      x: 110, y: 340, wires: [["manual-record"]],
    },
    {
      id: "manual-record", type: "function", z: "flow1", name: "Record actual injection",
      func: "flow.set('w25-ticket', (msg.mcode || {}).triggerTicket || null);"
        + "flow.set('w25-received', (flow.get('w25-received') || 0)+1);return null;",
      outputs: 1, noerr: 0, initialize: "", finalize: "", libs: [],
      x: 280, y: 340, wires: [[]],
    },
    { id: "manual-check-in", type: "http in", z: "flow1", name: "Observable result",
      url: "/manual-state", method: "get", wires: [["manual-check-fn"]] },
    {
      id: "manual-check-fn", type: "function", z: "flow1", name: "Read executed context",
      func: "msg.payload={received:flow.get('w25-received')||0,ticket:flow.get('w25-ticket')||null};"
        + "msg.headers={'content-type':'application/json'};return msg;",
      outputs: 1, noerr: 0, initialize: "", finalize: "", libs: [],
      wires: [["manual-check-out"]],
    },
    { id: "manual-check-out", type: "http response", z: "flow1", wires: [] },
  ];
  const manualDeploy = await fetchOn(portA, "/flows", {
    method: "POST",
    headers: {
      ...authHeaders,
      "content-type": "application/json",
      "Node-RED-Deployment-Type": "full",
      "Node-RED-API-Version": "v2",
    },
    body: JSON.stringify({ flows: manualFlow }),
  }, 15_000);
  check("W25 真 Node-RED 受控部署手动 Inject+下游函数+结果观察端口",
    manualDeploy.status === 200, { status: manualDeploy.status, body: manualDeploy.text.slice(0, 250) });
  const readManual = async (): Promise<{ received: number; ticket: string | null } | null> => {
    const response = await fetchOn(portA, "/api/manual-state");
    if (response.status !== 200) return null;
    try {
      return JSON.parse(response.text) as { received: number; ticket: string | null };
    } catch { return null; }
  };
  const beforeManual = await waitFor(readManual, 10_000);
  check("W25 真引擎部署之后 manual once=false 不自动运行", beforeManual?.received === 0,
    beforeManual);
  const forgedWithoutAuth = await fetchOn(portA, "/inject/manual-in", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  check("W25 未授权调用原生 inject 管理端点被拒（401）",
    forgedWithoutAuth.status === 401, { status: forgedWithoutAuth.status });
  const actualTicket = randomUUID();
  const manualPost = await fetchOn(portA, "/inject/manual-in", {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ __user_inject_props__: [
      { p: "mcode.triggerTicket", v: actualTicket, vt: "str" },
    ] }),
  });
  check("W25 真 Node-RED /inject/:id 收到带单次票据的手动调用",
    manualPost.status === 200, { status: manualPost.status, body: manualPost.text.slice(0, 220) });
  const confirmedManual = await waitFor(async () => {
    const value = await readManual();
    return value?.received === 1 && value.ticket === actualTicket ? value : null;
  }, 10_000);
  check("W25 真下游函数已执行并收到正确嵌套票据，不只是 Inject HTTP 200",
    confirmedManual !== null, { actual: await readManual(), expectedTicket: actualTicket });
  const persistedManual = readFileSync(join(INSTALLED, "flows.json"), "utf8");
  check("W25 原生 Inject 最终图保留 manual once=false（无部署即运行）",
    persistedManual.includes('"manual-in"') && persistedManual.includes('"once":false'));

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
  runtimeA = new OwnedNodeRedRuntime(NODE_RED_ENGINE_ID, portsA2, createInMemoryExecutorOwnership());
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
  runtimeA = new OwnedNodeRedRuntime(NODE_RED_ENGINE_ID, portsA3, createInMemoryExecutorOwnership());
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

  // W25 production-owned Host -> true Node-RED Inject -> condition + switch
  // -> mcode-agent -> real Host IPC. Only the provider implementation is a
  // deterministic stub. The real child, node pack, wires and dispatch remain.
  cleanProductionState();
  const docId = "w25-real-custom-ui";
  const triggerId = "w25-real-trigger";
  const expression = { logic: "and", rules: [
    { ref: "{{trigger.input.doi}}", op: "equal", value: "10.1000/real-native" },
  ] };
  const manualDoc: WorkflowDoc = {
    id: docId, name: "W25 real native manual graph", engine: "node-red",
    builtin: false, updatedAt: 1,
    nodes: [
      { id: triggerId, type: "mcode.trigger", title: "Only on user click",
        params: { triggerKind: "manual" }, position: { x: 0, y: 0 } },
      { id: "w25-real-condition", type: "mcode.condition", title: "DOI matches",
        params: { expression }, position: { x: 150, y: 0 } },
      { id: "w25-real-agent", type: "mcode.agent", title: "Read DOI",
        params: { instruction: "Look up {{trigger.input.doi}}", capability: "read" },
        position: { x: 300, y: 0 } },
    ],
    edges: [
      { id: "w25-edge-1", from: triggerId, to: "w25-real-condition" },
      { id: "w25-edge-2", from: "w25-real-condition", to: "w25-real-agent", label: "true" },
    ],
  } as WorkflowDoc;
  const manualTypes = new Map<string, NodeTypeManifest>();
  for (const type of ["mcode.trigger", "mcode.condition", "mcode.agent"]) {
    const builtin = builtinManifestById(type);
    if (builtin) manualTypes.set(type, builtin);
  }
  const graph = migrateWorkflowDoc(manualDoc, { types: manualTypes });
  check("W25 真实手动流程迁移包含原生 Inject、条件 adapter、Switch 和 Agent",
    graph.report.unmapped.length === 0 &&
      ["inject", "mcode-condition-eval", "switch", "mcode-agent"].every(
        type => graph.flow.nodes.some(node => node.type === type)),
    { missing: graph.report.unmapped });
  const manualGraphNodes = structuredClone(graph.flow.nodes);
  const nativeSwitch = manualGraphNodes.find(n => n.type === "switch");
  const nativeTab = manualGraphNodes.find(n => n.type === "tab");
  if (!nativeSwitch || !nativeTab) throw Error("Migrated W25 condition switch/tab missing");
  // The false branch has a real observable downstream node. Waiting for its
  // settled event proves a mismatch was routed, rather than merely sleeping
  // and hoping an Agent has not executed yet.
  const falseDebugId = "w25-false-debug";
  const originalWires = nativeSwitch["wires"] as string[][] | undefined;
  nativeSwitch["wires"] = [originalWires?.[0] ?? [], [falseDebugId]];
  manualGraphNodes.push({
    id: falseDebugId, type: "debug", z: nativeTab["id"],
    name: "W25 false branch reached", active: true,
    tosidebar: true, complete: "payload", targetType: "msg", wires: [],
  });
  const hostAgentCalls: Array<Record<string, unknown>> = [];
  const manualServices = {
    execute: async (operation: string, payload: Record<string, unknown>) => {
      if (operation !== "agent.run") throw Error("Unexpected W25 Host operation: " + operation);
      hostAgentCalls.push(payload);
      return { text: "Done: " + payload.instruction, artifacts: [], runId: randomUUID() };
    },
    subscribe: () => () => {},
  };
  const manualPorts = recordingPorts();
  const manualMessages: Array<{kind: string; operation?: string; nodeId?: unknown; stage?: unknown; ok?: unknown; error?: unknown; tabId?: unknown; hasTicket?: boolean; ticketSize?: number}> = [];
  const priorSpawn = manualPorts.spawn.bind(manualPorts);
  manualPorts.spawn = (spec) => {
    const child = priorSpawn(spec);
    const originalOnMessage = child.onMessage?.bind(child);
    child.onMessage = (listener) => originalOnMessage?.(message => {
      if (message && typeof message === "object") {
        const m = message as Record<string, unknown>;
        if (String(m["kind"]).startsWith("mcode-")) {
          const reqPayload = m["payload"] && typeof m["payload"] === "object" && !Array.isArray(m["payload"])
            ? m["payload"] as Record<string, unknown> : {};
          manualMessages.push({kind:String(m["kind"]),operation:typeof m["operation"]==="string"?m["operation"]:undefined,
            nodeId:reqPayload["nodeId"] ?? m["nodeId"],stage:m["stage"],ok:m["ok"],error:m["error"],tabId:reqPayload["tabId"],
            hasTicket:typeof reqPayload["triggerTicket"] === "string",
            ticketSize:typeof reqPayload["triggerTicket"] === "string" ? reqPayload["triggerTicket"].length : 0});
        }
      }
      listener(message);
    });
    return child;
  };
  const manualRuntime = new OwnedNodeRedRuntime(
    NODE_RED_ENGINE_ID, manualPorts, createInMemoryExecutorOwnership(),
    manualServices, undefined, id => id === docId ? manualDoc : null,
  );
  runtimeA = manualRuntime;
  const manualLaunch = registry.launchSpec(NODE_RED_ENGINE_ID);
  if (!manualLaunch) throw Error("W25 launchSpec unexpectedly null");
  const manualStatus = await manualRuntime.start({
    engineId: NODE_RED_ENGINE_ID, dataDir: manualLaunch.dataDir,
    command: manualLaunch.command, args: manualLaunch.args,
    ...(manualLaunch.env ? { env: manualLaunch.env } : {}),
    ...(manualLaunch.probeIdentity ? { probeIdentity: manualLaunch.probeIdentity } : {}),
    readyTimeoutMs: 20_000,
  });
  childA = manualPorts.children[0];
  check("W25 真生产 Host 子进程安全启动", manualStatus.state === "running" &&
    typeof manualStatus.port === "number", manualStatus);
  const manualPort = manualStatus.port ?? 0;
  const nativeW25Deploy = await fetchOn(manualPort, "/flows", {
    method: "POST",
    headers: {
      authorization: "Bearer " + (manualLaunch.env?.MCODE_ENGINE_ADMIN_TOKEN ?? ""),
      "content-type": "application/json",
      "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2",
    },
    body: JSON.stringify({ flows: manualGraphNodes }),
  }, 15_000);
  check("W25 真原生带 Host 归属的迁移整图可部署", nativeW25Deploy.status === 200,
    { status: nativeW25Deploy.status, body: nativeW25Deploy.text.slice(0, 250) });
  const ownerReady = await waitFor(() => {
    try { return manualRuntime.nativeManualTarget(docId, triggerId); }
    catch { return null; }
  }, 10_000);
  check("W25 Host 收到真实 Deploy 回执并确认唯一手动 Inject",
    ownerReady !== null, ownerReady ? { nodeId: ownerReady.nodeId, port: ownerReady.port } : null);
  const runResponse = await manualRuntime.runNativeManual(docId, triggerId, {
    kind: "event", event: "library.item.imported", "input.doi": "10.1000/real-native",
  });
  check("W25 真 Host 只发送受控 ticket 到原生 Inject", runResponse.ok, runResponse);
  const ran = await waitFor(() => hostAgentCalls.some(call =>
    call["instruction"] === "Look up 10.1000/real-native"), 10_000);
  check("W25 真 Node-RED 条件→Switch→Host Agent 实际执行且 DOI 插值正确",
    ran === true, { calls: hostAgentCalls.map(call => ({
      nodeId: call["nodeId"], instruction: call["instruction"],
    })), messages: manualMessages.slice(-30), tail: manualPorts.children[0]?.tailOutput().slice(-1300) });
  check("W25 本次真实触发只派发一次 Host Agent",
    hostAgentCalls.length === 1, { executions: hostAgentCalls.length });
  const badRun = await manualRuntime.runNativeManual(docId, triggerId, {
    kind: "event", event: "library.item.imported", "input.doi": "10.1000/mismatch",
  });
  check("W25 不匹配 DOI 仍可成功 Inject，但不能因此判 Agent 成功",
    badRun.ok, badRun);
  const falseSettled = await waitFor(() => manualMessages.some(m =>
    m.kind === "mcode-native-node-stage" && m.nodeId === falseDebugId &&
    m.stage === "settled"), 10_000);
  check("W25 不匹配 DOI 真正走到 false 分支原生节点（不靠固定睡眠）",
    falseSettled === true, manualMessages.filter(m => m.nodeId === falseDebugId));
  check("W25 不匹配 DOI 由真 Switch 截断，不执行 Host Agent",
    falseSettled === true && hostAgentCalls.length === 1, hostAgentCalls.length);
  const stoppedManual = await manualRuntime.stop(2_000);
  check("W25 真引擎 Stop 释放主进程归属", stoppedManual.state === "stopped" &&
    stoppedManual.port === null, stoppedManual);
  childA = undefined;
  runtimeA = null;

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
console.log("\nB. NR3 全链：执行器 → HTTP-in 流 → 返回值回灌（生产 bootstrap，与 A 段同一份启动参数）");

// 【Gate B / P1-4】B 段不再自带 fixture bootstrap：测试若自己写一份引导脚本、自己拼
// env，生产缺了 Electron-as-Node / 宿主身份 / 版本检查也照样绿 —— 这正是 P1-4 的漂移。
// 现在 B 段用的是生产注册表的 launchSpec（入口脚本即生产 P1-5 清单写出的
// bootstrap.cjs，env/身份/命令全由生产生成器给），只有数据目录换成本段临时 userDir。
// 这也复验了 P1-3 的探针：B 段能进 running，靠的是真 Node-RED 的宿主身份握手。

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
  fixtureUserDir = mkdtempSync(join(INSTALLED, "fixture-user-"));

  // 宿主环境里的 canary：env 完全替换时它绝不能出现在引擎进程里。
  process.env.MCODE_E2E_SECRET_CANARY = "must-not-leak";

  // 【P1-4】B 段启动参数 = 生产注册表 launchSpec。生产把文件（bootstrap / 密钥 /
  // 令牌）写在自己的数据目录；本段要在临时 userDir 上跑，所以把生产写出的
  // bootstrap.cjs 复制过去，其余（command/args/env/身份）原样复用。
  const productionRegistryB = new ProductionWorkflowEngineRegistry();
  // 生产 bootstrap 默认 safeMode（未审批的持久化 flow 不执行）。B 段要验执行器链路，
  // 所以先写下宿主可信标记 —— 与 A 段 A10 同一个入口（engine-trust.json），
  // launchSpec 只读它、不提供写 API。
  writeFileSync(join(productionRegistryB.dataDirOf(NODE_RED_ENGINE_ID), "engine-trust.json"), JSON.stringify({ trusted: true }), "utf8");
  const generatedB = productionRegistryB.launchSpec(NODE_RED_ENGINE_ID);
  check("★【P1-4】B 段复用生产 launchSpec（不再自带 fixture bootstrap）", generatedB !== null, generatedB);
  if (generatedB === null) throw new Error("生产 launchSpec 不可用 —— 安装布局与生产注册表不一致");
  check("★【P0-2】B 段启动 env 是可信模式（宿主写下了 engine-trust.json）",
    generatedB.env?.MCODE_ENGINE_TRUSTED === "1", generatedB.env?.MCODE_ENGINE_TRUSTED);
  writeFileSync(
    join(fixtureUserDir, "bootstrap.cjs"),
    readFileSync(join(productionRegistryB.dataDirOf(NODE_RED_ENGINE_ID), "bootstrap.cjs"), "utf8"),
    "utf8",
  );
  const launchB = { ...generatedB, dataDir: fixtureUserDir };

  const portsB = recordingPorts();
  runtimeB = new OwnedNodeRedRuntime(NODE_RED_ENGINE_ID, portsB, createInMemoryExecutorOwnership());
  const statusB = await runtimeB.start({
    engineId: NODE_RED_ENGINE_ID,
    dataDir: launchB.dataDir,
    command: launchB.command,
    args: launchB.args,
    ...(launchB.env !== undefined ? { env: launchB.env } : {}),
    ...(launchB.probeIdentity !== undefined ? { probeIdentity: launchB.probeIdentity } : {}),
  });
  evidence("fixture start status", statusB);
  check("★ 真 node-red 经**生产 EngineRuntime** 起来（真 spawn / listenOnDialablePort / 真 HTTP 探活）",
    statusB.state === "running" && statusB.port !== null, statusB);
  const portB = statusB.port ?? 0;
  childB = portsB.children[0];
  evidence("fixture port", portB);
  evidence("engine log tail", childB?.tailOutput().slice(-800) ?? "(no child)");
  check("★ 端口由生产 listenOnDialablePort 分配（不是 fetch 黑名单端口）", portB > 0 && !isBlockedPort(portB));
  // B 段现在跑的是生产 bootstrap（adminAuth + safeMode）。Admin API 要带宿主令牌；
  // 持久化 flow 默认不执行 —— 所以先写可信标记并在启动前把它读进 launchSpec env。
  const adminTokenB = launchB.env?.MCODE_ENGINE_ADMIN_TOKEN ?? "";
  const authHeadersB = { authorization: `Bearer ${adminTokenB}` };
  check("★【P1-3】B 段启动参数带宿主控制面令牌", /^[0-9a-f]{64}$/.test(adminTokenB), adminTokenB.slice(0, 6));

  // —— B1'. env 边界（此前靠 fixture 的 fixture-ready.json 自报；生产 bootstrap
  // 不写这种文件，改为直接查宿主真正交给 spawn 的 spec —— 那才是"env 完全替换"
  // 的判据；子进程侧的 Windows 会话变量注入不是本段的职责）。 ——
  {
    const specB = portsB.specs[0];
    const specKeys = Object.keys(specB?.env ?? {}).sort();
    const expectedSpec = [
      "HOST", "NODE_RED_CREDENTIAL_SECRET", "MCODE_ENGINE_ADMIN_TOKEN", "MCODE_ENGINE_THEME_CSS", "MCODE_ENGINE_TRUSTED", "NODE_PATH", "PATH", "PORT",
      ...(process.platform === "win32" ? ["SystemRoot"] : []),
    ].sort();
    check("★ env 在 spawn spec 里**完全替换**：宿主白名单 + 引擎凭据/控制面令牌（无宿主密钥）",
      deepEqual(specKeys, expectedSpec), { actual: specKeys, expected: expectedSpec });
    check("★【T19】NODE_PATH 只能是空 npm fallback 或经过版本校验的 vendor 路径",
      specB?.env?.NODE_PATH === "" || Boolean(specB?.env?.NODE_PATH?.includes("node-red")));
    check("★ 宿主自定义变量没有泄漏进 spawn spec（canary 缺席）",
      !specKeys.some((k) => k.toLowerCase() === "mcode_e2e_secret_canary"));
    check("★ spawn spec 不含任何 ANTHROPIC_*/OPENAI_* 宿主密钥",
      !specKeys.some((k) => /^(ANTHROPIC|OPENAI|CLAUDE)_/i.test(k)), specKeys);
    check("★【P1-3】控制面身份随 spec 进了探针（跑绿 running 本身就是握手成功的证据）",
      typeof specB?.env?.MCODE_ENGINE_ADMIN_TOKEN === "string" && (specB.env.MCODE_ENGINE_ADMIN_TOKEN as string).length === 64);
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
      ...authHeadersB,
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

  // —— B3. 真进程 running 的代次由宿主生成（非 Agent 自报、非端口）。
  const runEpoch = runtimeB!.status().instanceEpoch;
  check("★ 真 EngineRuntime running 含非空宿主启动实例代次",
    typeof runEpoch === "string" && runEpoch.length >= 32, { present: !!runEpoch });
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

  // —— B4'. 真进程主动跨权限域对抗（不是仅在纯函数里检查 URL） ——
  const beforeBlocked = await fetchOn(portB, "/flows", {
    method: "GET", headers: { ...authHeadersB, "Node-RED-API-Version": "v2" },
  });
  check("★ 控制面基线流图可被宿主合法读出", beforeBlocked.status === 200);
  const blockedTargets = ["/flows", "/settings", "/api/../flows", "/api/%2e%2e/settings"];
  for (const target of blockedTargets) {
    const bad = await exec.execute(execContext(target, "POST", '{"flows":[]}'));
    check("★ 真引擎运行时：普通执行器拒发管理面路径 " + target,
      bad.status === "failed" && bad.retryable === false && bad.outputs === undefined,
      { status: bad.status, error: bad.error });
  }
  const afterBlocked = await fetchOn(portB, "/flows", {
    method: "GET", headers: { ...authHeadersB, "Node-RED-API-Version": "v2" },
  });
  check("★ 跨权限域被拒后真实 Node-RED 已部署流图字节不变",
    beforeBlocked.status === 200 && afterBlocked.status === 200
    && beforeBlocked.text === afterBlocked.text,
    { before: beforeBlocked.status, after: afterBlocked.status });

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
  check("★ 真 EngineRuntime stop 会废弃本轮代次（端口复用仍不相同）",
    typeof stopped.instanceEpoch === "string" && stopped.instanceEpoch !== runEpoch);
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

/* ══════════ C. Gate C：迁移器产物 → 真 Node-RED 部署/读回 ══════════ */
// 这一段把 `flowMigration.ts` 的**真实产物**（不是手写夹具）部署给真 node-red 5.0.8：
//   - 迁移一张含全部 runner.kind 的 WorkflowDoc → flow；
//   - 经 Admin API（带宿主令牌）部署 → 200 + rev；
//   - GET /flows 读回：每个节点都在、wires 连的是节点 id、`x-mcode` 原样保留；
//   - **未知节点类型（未安装 mcode-* 节点包）的硬事实**：见下面「实测」注释。
//
// ## 实测硬事实（2026-10-19，node-red 5.0.8）
//
// 1. **部署不拒绝未知类型**：POST /flows 回 200 + rev，节点原样落盘、原样读回
//    （编辑器里显示为"未知节点"红框，但节点与连线都在）。
// 2. **但整组 flows 不启动**：`@node-red/runtime/lib/flows/index.js` 的
//    `updateMissingTypes()` 收集到 `missingTypes.length > 0` 后，日志打
//    "Waiting for missing types to be registered:" + 每个类型一行，emit
//    `runtime-state {state:'stop', error:'missing-types', text:'notification.warnings.missing-types'}`，
//    然后 **return** —— 这一份部署里的**所有** flow（包括全由原生节点组成的那条支路）
//    都停在未启动状态。这不是 Mcode 迁移器的 bug，是 Node-RED 的全局闸：只要 flow 里
//    引用了未注册类型，整组不跑。
// 3. **`GET /flows/state` 不可作为判据**：该版本在 missing-types 分支 return 前已把模块
//    级 `state = 'start'`，接口仍回 `{"state":"start"}`（版本怪癖）。本套件因此用
//    **行为**证明"整组不启动"：同一份部署里放一条**全原生节点**（inject → debug）的
//    支路，部署后它的 runtime event 不会来、HTTP-in（若流里有）也不会应答。
//    为了让这条判据稳定可测，C 段额外部署一条**只有原生节点**的探针流，先证明引擎本身
//    能跑，再部署迁移流并证明同一引擎上它不跑。
// 4. **未知节点类型在编辑器里保留为 unknown**（不是丢弃、不是拒绝加载）：`GET /flows`
//    读回的节点 `type` 原样是 `mcode-agent` 等；Node-RED 的 palette 里没有它们。
// 5. 生产 bootstrap 的 logging 级别是 `warn`，上述 info 级 missing-types 日志**不会**
//    出现在 tailOutput 里 —— 所以断言不能依赖日志文本，只能依赖行为 + 读回结构。
//
// 结论（Gate C 必须知道）：**在 mcode-* 节点包真正安装之前，迁移产物可以部署、可以
// 在编辑器里查看/编辑，但整组 flow 不会执行**。迁移器报告里的 `needsHumanDecision`
// 与这条是同一层事实的两面：换内核后"能看"不等于"能跑"。
console.log("\nC. Gate C：迁移器产物 → 真 Node-RED 部署/读回（未知节点硬事实）");
{
  const { migrateWorkflowDoc } = await import("@main/workflowEngines/flowMigration.js");
  const { builtinManifestById } = await import("@main/orchestration/nodeTypes.js");
  // 类型清单用**真内置清单**（不是夹具）：迁移器与生产注册表看到的是同一份 runner.kind。
  const types = new Map<string, NonNullable<ReturnType<typeof builtinManifestById>>>();
  for (const id of [
    "mcode.main", "mcode.agent", "mcode.conversation", "mcode.branch", "mcode.condition",
    "mcode.trigger", "mcode.command", "mcode.code", "mcode.module-capability", "mcode.node-red",
  ]) {
    const manifest = builtinManifestById(id);
    if (manifest !== undefined) types.set(id, manifest);
  }

  /** 7 种 runner.kind 全出现的最小图（与 flow-migration-smoke 的 richDoc 同形，更小）。 */
  const docForMigration = {
    id: "wf_gatec_engine",
    name: "Gate C 真引擎样例",
    builtin: false,
    updatedAt: 1_760_000_000_000,
    nodes: [
      { id: "m_main", type: "mcode.main", title: "主代理", params: { instruction: "拆" }, position: { x: 10, y: 10 } },
      { id: "m_agent", type: "mcode.agent", title: "子 agent", params: { instruction: "查" }, capability: "write", position: { x: 110, y: 10 } },
      { id: "m_conv", type: "mcode.conversation", title: "对话", params: { instruction: "聊\n第二行" }, position: { x: 210, y: 10 } },
      { id: "m_branch", type: "mcode.branch", title: "岔路", params: { decider: "user", note: "分支说明\n第二行", outputVar: "route" }, position: { x: 310, y: 10 } },
      { id: "m_cond", type: "mcode.condition", title: "条件", params: { expression: { logic: "and", rules: [] } }, position: { x: 410, y: 10 } },
      { id: "m_cmd", type: "mcode.command", title: "命令", params: { command: "echo hi", timeoutMs: 1500 }, position: { x: 510, y: 10 } },
      { id: "m_code", type: "mcode.code", title: "代码", params: { code: "return msg;", language: "node", timeoutMs: 5000 }, position: { x: 610, y: 10 } },
      { id: "m_python", type: "mcode.code", title: "Python", params: { code: "print('hi')", language: "python", timeoutMs: 2500, input: "{{m_agent.payload}}" }, position: { x: 660, y: 10 } },
      { id: "m_trigger", type: "mcode.trigger", title: "事件触发", params: { triggerKind: "event", task: "处理事件\n第二行", cron: "" }, position: { x: 710, y: 10 } },
      { id: "m_schedule", type: "mcode.trigger", title: "定时触发", params: { triggerKind: "schedule", cron: "0 9 * * *" }, position: { x: 810, y: 10 } },
      { id: "m_file", type: "mcode.trigger", title: "文件触发", params: { triggerKind: "file", paths: "src/**/*.ts" }, position: { x: 910, y: 10 } },
      { id: "m_module", type: "mcode.module-capability", title: "模块能力", params: { moduleId: "core.files", contributionId: "inspect", path: "report.md" }, position: { x: 1010, y: 10 } },
      { id: "m_node_red", type: "mcode.node-red", title: "HTTP 调用", params: { enginePath: "/api/flows", engineMethod: "PATCH", engineBody: "{\n  \"deploy\": true\n}" }, position: { x: 1110, y: 10 } },
    ],
    edges: [
      { id: "e1", from: "m_main", to: "m_agent" },
      { id: "e2", from: "m_agent", to: "m_conv" },
      { id: "e3", from: "m_conv", to: "m_branch" },
      { id: "e4", from: "m_branch", to: "m_cond", label: "继续", note: "人工选择后继续" },
      { id: "e5", from: "m_branch", to: "m_cmd", label: "停", note: "命令支路" },
      { id: "e6", from: "m_cond", to: "m_code", label: "true" },
      { id: "e7", from: "m_cond", to: "m_trigger", label: "false" },
      { id: "e8", from: "m_main", to: "m_schedule" },
      { id: "e9", from: "m_main", to: "m_file" },
      { id: "e10", from: "m_main", to: "m_module" },
      { id: "e11", from: "m_main", to: "m_node_red" },
    ],
  } as unknown as Parameters<typeof migrateWorkflowDoc>[0];
  const migrated = migrateWorkflowDoc(docForMigration, { types });
  evidence("migration report", {
    mapped: migrated.report.mapped.length,
    unmapped: migrated.report.unmapped.length,
    needsHumanDecision: migrated.report.needsHumanDecision.map((i) => i.merge0Item),
  });
  check("★【Gate C】含 7 种 runner.kind 的文档迁移无「无法映射」", migrated.report.unmapped.length === 0, migrated.report.unmapped);

  // 启动一台真引擎（与 A/B 同一套生产 launchSpec），部署迁移产物。
  const productionRegistryC = new ProductionWorkflowEngineRegistry();
  writeFileSync(join(productionRegistryC.dataDirOf(NODE_RED_ENGINE_ID), "engine-trust.json"), JSON.stringify({ trusted: true }), "utf8");
  const launchC = productionRegistryC.launchSpec(NODE_RED_ENGINE_ID);
  check("★【Gate C】生产 launchSpec 可用", launchC !== null);
  if (launchC !== null) {
    const portsC = recordingPorts();
    const runtimeC = new OwnedNodeRedRuntime(NODE_RED_ENGINE_ID, portsC, createInMemoryExecutorOwnership());
    let childC: EngineChildProcess | undefined;
    const userDirC = mkdtempSync(join(INSTALLED, "gatec-user-"));
    try {
      const statusC = await runtimeC.start({
        engineId: NODE_RED_ENGINE_ID,
        dataDir: launchC.dataDir,
        command: launchC.command,
        args: launchC.args,
        ...(launchC.env !== undefined ? { env: launchC.env } : {}),
        ...(launchC.probeIdentity !== undefined ? { probeIdentity: launchC.probeIdentity } : {}),
        readyTimeoutMs: 20_000,
      });
      childC = portsC.children[0];
      evidence("gate C engine status", statusC);
      check("★【Gate C】真引擎经生产路径就绪", statusC.state === "running" && statusC.port !== null, statusC);
      const portC = statusC.port ?? 0;
      const tokenC = launchC.env?.MCODE_ENGINE_ADMIN_TOKEN ?? "";
      const authC = { authorization: `Bearer ${tokenC}` };

      // C1. 迁移产物部署 → 200 + rev。
      const deployC = await fetchOn(portC, "/flows", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Node-RED-Deployment-Type": "full",
          "Node-RED-API-Version": "v2",
          ...authC,
        },
        body: JSON.stringify({ flows: migrated.flow.nodes }),
      }, 15_000);
      let revC: string | null = null;
      try {
        revC = (JSON.parse(deployC.text) as { rev?: string }).rev ?? null;
      } catch {
        /* 下面断言会红 */
      }
      evidence("gate C deploy", { status: deployC.status, rev: revC });
      check("★【Gate C】迁移产物部署成功（200 + rev）", deployC.status === 200 && typeof revC === "string", deployC);

      // C2. GET /flows 读回：每个迁移节点都在（id/type 原样），tab 也在。
      const readC = await fetchOn(portC, "/flows", { headers: { ...authC, "Node-RED-API-Version": "v2" } }, 10_000);
      let readFlows: Array<Record<string, unknown>> = [];
      try {
        readFlows = (JSON.parse(readC.text) as { flows?: Array<Record<string, unknown>> }).flows ?? [];
      } catch {
        /* 下面断言会红 */
      }
      const migratedIds = migrated.flow.nodes.filter((n) => n.type !== "tab").map((n) => n.id);
      const readById = new Map(readFlows.map((n) => [n.id as string, n]));
      check("★【Gate C】读回里每个迁移节点都在（按 Node-RED id）",
        migratedIds.every((id) => readById.has(id)), { missing: migratedIds.filter((id) => !readById.has(id)) });
      check("★【Gate C】读回里未知节点类型原样保留为 unknown（不丢弃、不改名）",
        readFlows.some((n) => n.type === "mcode-agent") && readFlows.some((n) => n.type === "mcode-branch"),
        [...new Set(readFlows.map((n) => n.type))]);
      check("★【Gate C】读回里 wires 连的是目标节点 id（不是 link id）",
        JSON.stringify(readById.get("n_m_main")?.wires ?? []).includes("n_m_agent"),
        readById.get("n_m_main")?.wires);
      check("★【Gate C】读回里 x-mcode 元数据原样保留（nodeId/params）",
        (readById.get("n_m_main") as { "x-mcode"?: { nodeId?: string; params?: unknown } } | undefined)?.["x-mcode"]?.nodeId === "m_main",
        (readById.get("n_m_main") as Record<string, unknown> | undefined)?.["x-mcode"]);
      const nativeAgent = readById.get("n_m_agent") as Record<string, unknown> | undefined;
      const nativeConversation = readById.get("n_m_conv") as Record<string, unknown> | undefined;
      const nativeBranch = readById.get("n_m_branch") as Record<string, unknown> | undefined;
      const nativeCall = readById.get("n_m_node_red") as Record<string, unknown> | undefined;
      const nativeCommand = readById.get("n_m_cmd") as Record<string, unknown> | undefined;
      const nativeFunction = readById.get("n_m_code") as Record<string, unknown> | undefined;
      const nativePython = readById.get("n_m_python") as Record<string, unknown> | undefined;
      const nativeEvent = readById.get("n_m_trigger") as Record<string, unknown> | undefined;
      check("★【Gate C】真实 Admin API v2 保留自定义节点表单字段与多行文本",
        nativeAgent?.instruction === "查" && nativeAgent?.capability === "write"
        && nativeConversation?.instruction === "聊\n第二行"
        && nativeBranch?.note === "分支说明\n第二行",
        { agent: nativeAgent, conversation: nativeConversation, branch: nativeBranch });
      check("★【Gate C】真实 Admin API v2 保留 PATCH/多行 body 与原生执行器字段",
        nativeCall?.engineMethod === "PATCH"
        && nativeCall?.engineBody === "{\n  \"deploy\": true\n}"
        && nativeCommand?.command === "echo hi" && nativeCommand?.timer === "1.5"
        && Array.isArray(nativeCommand?.wires) && nativeCommand?.wires.length === 3
        && nativeFunction?.func === "return msg;" && nativeFunction?.timeout === 5
        && nativePython?.command === "python -c print('hi')" && nativePython?.timer === "2.5"
        && Array.isArray(nativePython?.wires) && nativePython?.wires.length === 3,
        { call: nativeCall, command: nativeCommand, function: nativeFunction, python: nativePython });
      check("★【Gate C】真实 Admin API v2 保留 inject/watch 原生参数与 edgeMeta 注释",
        readById.get("n_m_schedule")?.["crontab"] === "0 9 * * *"
        && readById.get("n_m_file")?.["files"] === "src/**/*.ts"
        && (nativeBranch?.["x-mcode"] as { edgeMeta?: Array<{label?: string;note?: string}> } | undefined)?.edgeMeta?.some(e => e.label === "继续" && e.note === "人工选择后继续") === true,
        { schedule: readById.get("n_m_schedule"), file: readById.get("n_m_file"), edgeMeta: nativeBranch?.["x-mcode"] });
      check("★【Gate C】code.input 不等价与输出契约差异有显式迁移报告",
        migrated.report.lossy.some(issue => issue.nodeId === "m_python" && issue.message.includes("input JSON"))
        && migrated.report.lossy.some(issue => issue.nodeId === "m_cmd" && issue.message.includes("产出契约"))
        && migrated.report.lossy.some(issue => issue.nodeId === "m_code" && issue.message.includes("产出契约")),
        migrated.report.lossy.filter(issue => issue.nodeId !== undefined && ["m_python","m_cmd","m_code"].includes(issue.nodeId)));
      check("★【Gate C】所有节点挂在 tab 下（z 指向 tab 的 id）",
        [...readById.values()].filter((n) => n.type !== "tab").every((n) => typeof n.z === "string" && readById.has(n.z as string)),
        [...readById.values()].map((n) => ({ id: n.id, z: n.z })));


      check("★【Gate C FULL-2】真实 Node-RED GET 留存原生类型与唯一身份标记",
        [...readById.values()].filter(n => n.type !== "tab").every(n => {
          const meta = n["x-mcode"] as { nativeId?: string; nativeType?: string } | undefined;
          return meta?.nativeId === n.id && meta?.nativeType === n.type;
        }),
        [...readById.values()].filter(n => n.type !== "tab").map(n => ({
          id: n.id, type: n.type, native: (n["x-mcode"] as Record<string, unknown> | undefined)?.nativeId,
          mappedType: (n["x-mcode"] as Record<string, unknown> | undefined)?.nativeType,
        })));
      const orphanedAgent = structuredClone(nativeAgent);
      if (orphanedAgent) {
        orphanedAgent.id = "new-native-id-after-original-deletion";
        orphanedAgent.wires = [[]];
      }
      const { flowToWorkflowDoc: readEditorFlow } = await import("@main/workflowEngines/flowMigration.js");
      const orphanedRestored = orphanedAgent
        ? readEditorFlow({ id: "orphaned", label: "Orphaned Copy", nodes: [orphanedAgent as typeof migrated.flow.nodes[number]] })
        : null;
      check("★【Gate C FULL-2】原厂 GET 真正写权限节点复制后删除原件不能继承旧授权",
        orphanedRestored !== null && orphanedRestored.nodes.length === 1
        && orphanedRestored.nodes[0].id !== "m_agent"
        && orphanedRestored.nodes[0].capability === "read"
        && orphanedRestored.nodes[0].id.startsWith("mcode_copy_"),
        orphanedRestored?.nodes);
      const typeChangedCommand = structuredClone(nativeCommand);
      if (typeChangedCommand) typeChangedCommand.type = "function";
      let staleNativeTypeRejected = false;
      try {
        if (typeChangedCommand) {
          readEditorFlow({ id: "typeChanged", label: "Type changed", nodes: [
            typeChangedCommand as typeof migrated.flow.nodes[number],
          ] });
        }
      } catch (err) { staleNativeTypeRejected = /native.*type|不一致/i.test((err as Error).message); }
      check("★【Gate C FULL-2】原厂 GET 后节点原生类型替换时拒绝继承旧命令执行协议",
        staleNativeTypeRejected);

      // C2b. Real API-v2 editor save, not an in-memory change to the adapter:
      // read native fields -> edit them -> POST with rev -> GET persisted fields
      // -> reconstruct Mcode doc. Stale x-mcode.params must not win the edits.
      const editedNative = structuredClone(readFlows);
      const byNativeId = new Map(editedNative.map((n) => [String(n.id), n]));
      const editNative = (id: string, patch: Record<string, unknown>): void => {
        const node = byNativeId.get("n_" + id);
        if (node) Object.assign(node, patch);
      };
      editNative("m_agent", { instruction: "原生改写指令", capability: "read", outputVar: "editedOutput" });
      editNative("m_conv", { instruction: "新对话指令\\n第二行" });
      editNative("m_branch", { decider: "model", note: "", outputVar: "newRoute" });
      editNative("m_cmd", { command: "echo edited", timer: "3" });
      editNative("m_code", { func: "return {...msg,payload:42};", timeout: 1.25 });
      editNative("m_python", { command: "python -c print('edited')", timer: "4" });
      editNative("m_trigger", { task: "新事件任务" });
      editNative("m_schedule", { crontab: "0 10 * * *" });
      editNative("m_file", { files: "tests/**/*.ts" });
      editNative("m_module", { path: "" });
      editNative("m_node_red", { engineMethod: "GET", engineBody: "" });
      // Simulate a copied/stale plugin sidecar persisting through the actual
      // upstream API. Native editor capability and wires remain authoritative.
      const nativeAgentForSave = byNativeId.get("n_m_agent");
      const rawAgentMeta = nativeAgentForSave?.["x-mcode"] as Record<string, unknown> | undefined;
      if (rawAgentMeta) {
        rawAgentMeta.params = { ...(rawAgentMeta.params as Record<string, unknown>), capability: "write" };
        rawAgentMeta.unknown = {
          id: "forged-node", type: "forged.type", capability: "write",
          params: { instruction: "poisoned", capability: "write" },
          position: { x: 999, y: 999 }, approvedUnknown: "retained",
        };
      }
      const tabNative = editedNative.find((n) => n.type === "tab");
      const rawTabMeta = tabNative?.["x-mcode"] as Record<string, unknown> | undefined;
      if (rawTabMeta) {
        rawTabMeta.unknown = { id: "forged-flow", builtin: true, nodes: [], edges: [], safeExtra: "retained" };
      }
      const editedDeploy = await fetchOn(portC, "/flows", {
        method: "POST",
        headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...authC },
        body: JSON.stringify({ rev: revC, flows: editedNative }),
      }, 15_000);
      let editedRevision: string | null = null;
      try { editedRevision = (JSON.parse(editedDeploy.text) as {rev?:string}).rev ?? null; } catch { /* explicit check below */ }
      check("★【Gate C FULL-2】真引擎带 revision 部署原生字段变更成功", editedDeploy.status === 200 && typeof editedRevision === "string", {
        status: editedDeploy.status, rev: editedRevision, body: editedDeploy.text.slice(0, 300),
      });
      const editedRead = await fetchOn(portC, "/flows", {
        headers: { ...authC, "Node-RED-API-Version": "v2" },
      }, 10_000);
      let persistedNative: Array<Record<string, unknown>> = [];
      try { persistedNative = (JSON.parse(editedRead.text) as {flows?:Array<Record<string,unknown>>}).flows ?? []; }
      catch { /* explicit assertion */ }
      const persistedById = new Map(persistedNative.map((n) => [n.id as string, n]));
      check("★【Gate C FULL-2】真实 Node-RED GET 回来的编辑器属性已持久改变（包括清空）",
        editedRead.status === 200 && persistedById.get("n_m_agent")?.instruction === "原生改写指令"
        && persistedById.get("n_m_branch")?.note === ""
        && persistedById.get("n_m_code")?.timeout === 1.25
        && persistedById.get("n_m_module")?.path === ""
        && persistedById.get("n_m_node_red")?.engineBody === "",
        { status: editedRead.status, agent: persistedById.get("n_m_agent"), branch: persistedById.get("n_m_branch") });
      const { flowToWorkflowDoc } = await import("@main/workflowEngines/flowMigration.js");
      const restoredAfterNativeEdit = flowToWorkflowDoc({
        ...migrated.flow,
        nodes: persistedNative as unknown as typeof migrated.flow.nodes,
        links: undefined,
        "x-mcode": undefined, // the actual native API has no top-level Mcode metadata
      });
      const mcodeParam = (id: string, key: string): unknown =>
        restoredAfterNativeEdit.nodes.find((n) => n.id === id)?.params[key];
      check("★【Gate C FULL-2】真编辑 Mcode agent/branch/trigger/module/HTTP 字段逆映射成功",
        mcodeParam("m_agent", "instruction") === "原生改写指令"
        && restoredAfterNativeEdit.nodes.find((n) => n.id === "m_agent")?.capability === "read"
        && mcodeParam("m_agent", "outputVar") === "editedOutput"
        && mcodeParam("m_conv", "instruction") === "新对话指令\\n第二行"
        && mcodeParam("m_branch", "decider") === "model"
        && mcodeParam("m_branch", "note") === ""
        && mcodeParam("m_trigger", "task") === "新事件任务"
        && mcodeParam("m_module", "path") === ""
        && mcodeParam("m_node_red", "engineMethod") === "GET"
        && mcodeParam("m_node_red", "engineBody") === "");
      check("★【Gate C FULL-2】原厂 API 持久化后，旧参数写权限不得复活",
        mcodeParam("m_agent", "capability") === "read"
        && restoredAfterNativeEdit.nodes.find((n) => n.id === "m_agent")?.capability === "read");
      check("★【Gate C FULL-2】原厂 API 保留的恶意未知扩展字段不得覆盖正式节点/文档身份",
        restoredAfterNativeEdit.id === "wf_gatec_engine"
        && restoredAfterNativeEdit.builtin === false
        && restoredAfterNativeEdit.nodes.some((n) => n.id === "m_agent" && n.type === "mcode.agent")
        && !restoredAfterNativeEdit.nodes.some((n) => n.id === "forged-node")
        && (restoredAfterNativeEdit as unknown as Record<string, unknown>).safeExtra === "retained"
        && (restoredAfterNativeEdit.nodes.find((n) => n.id === "m_agent") as unknown as Record<string,unknown> | undefined)?.approvedUnknown === "retained");
      check("★【Gate C FULL-2】真原生 exec/function/inject/watch 编辑同步并按秒毫秒转换",
        mcodeParam("m_cmd", "command") === "echo edited"
        && mcodeParam("m_cmd", "timeoutMs") === 3000
        && mcodeParam("m_code", "code") === "return {...msg,payload:42};"
        && mcodeParam("m_code", "timeoutMs") === 1250
        && mcodeParam("m_python", "code") === "print('edited')"
        && mcodeParam("m_python", "timeoutMs") === 4000
        && mcodeParam("m_schedule", "cron") === "0 10 * * *"
        && mcodeParam("m_file", "paths") === "tests/**/*.ts");
      check("★【Gate C FULL-2】无法原生表达的 code.input 与不变的连线备注仍保留",
        mcodeParam("m_python", "input") === "{{m_agent.payload}}"
        && restoredAfterNativeEdit.edges.some((e) => e.id === "e4" && e.label === "继续" && e.note === "人工选择后继续"));
      const staleNativeDeploy = await fetchOn(portC, "/flows", {
        method: "POST",
        headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...authC },
        body: JSON.stringify({ rev: revC, flows: editedNative }),
      }, 15_000);
      check("★【Gate C FULL-2】旧 revision 不得覆盖真 Node-RED 新版本（409）", staleNativeDeploy.status === 409,
        {status: staleNativeDeploy.status, body: staleNativeDeploy.text.slice(0, 200)});

      // C3. 未知节点硬事实：整组 flows 不启动。用行为证明 —— 同一台引擎上，
      //     一条**全原生节点**的注入流能跑；而迁移流里混入未知类型后，同一份部署的
      //     原生支路也不跑（Node-RED 的 missing-types 全局闸）。
      //     做法：部署第一条纯原生流（inject 每 100ms → debug），读回 /flows 的状态
      //     无法可靠判断（见文件头 #3），所以用**第二条部署**覆盖它，观察 runtime event。
      const nativeFlow = [
        { id: "tabN", type: "tab", label: "native", disabled: false, info: "", env: [] },
        { id: "injN", type: "inject", z: "tabN", name: "tick", props: [{ p: "payload" }], repeat: "0.2", once: false, x: 100, y: 100, wires: [["dbgN"]] },
        { id: "dbgN", type: "debug", z: "tabN", name: "dbg", active: true, complete: "payload", targetType: "msg", x: 200, y: 100, wires: [] },
      ];
      const deployNative = await fetchOn(portC, "/flows", {
        method: "POST",
        headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...authC },
        body: JSON.stringify({ flows: nativeFlow }),
      }, 15_000);
      check("★【Gate C】纯原生节点流部署成功（引擎本身可跑，作为对照）", deployNative.status === 200, deployNative);

      // 对照组：纯原生流的 HTTP-in 能应答（证明引擎的 runtime 确实在跑）。
      const nativeHttpIn = [
        { id: "tabH", type: "tab", label: "http", disabled: false, info: "", env: [] },
        { id: "inH", type: "http in", z: "tabH", url: "/gatec-native", method: "get", upload: false, swaggerDoc: "", x: 100, y: 100, wires: [["outH"]] },
        { id: "outH", type: "http response", z: "tabH", x: 300, y: 100, wires: [] },
      ];
      const deployNativeHttp = await fetchOn(portC, "/flows", {
        method: "POST",
        headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...authC },
        body: JSON.stringify({ flows: nativeHttpIn }),
      }, 15_000);
      check("★【Gate C】原生 HTTP-in 流部署成功", deployNativeHttp.status === 200, deployNativeHttp);
      const nativeAlive = await waitFor(async () => {
        const res = await fetchOn(portC, "/api/gatec-native", {}, 2_000);
        return res.status === 200 ? res : null;
      }, 8_000);
      check("★【Gate C】对照：纯原生流真的在跑（HTTP-in 200）", nativeAlive !== null);

      // 现在换成迁移流（含未知 mcode-* 类型）：同一台引擎、同一条部署路径。
      const deployMigrated = await fetchOn(portC, "/flows", {
        method: "POST",
        headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...authC },
        body: JSON.stringify({ flows: migrated.flow.nodes }),
      }, 15_000);
      check("★【Gate C】迁移流部署本身仍成功（200，未知类型不是部署错误）", deployMigrated.status === 200, deployMigrated);
      // 在迁移流里加一条原生 HTTP-in：若 runtime 启动，它必须应答 200；实测是 404
      // （整组不启动，HTTP-in 未注册）。这不是"路由没挂"——同一路径在上一份纯原生成
      // 部署里是 200。
      const migratedWithNativeProbe = migrateWorkflowDoc({
        ...docForMigration,
        nodes: [
          ...(docForMigration.nodes as unknown[]),
          { id: "m_http", type: "mcode.agent", title: "占位", params: {}, position: { x: 810, y: 10 } },
        ],
      } as typeof docForMigration, { types });
      const nativeProbeNodes = [
        ...migratedWithNativeProbe.flow.nodes,
        { id: "tabP", type: "tab", label: "probe", disabled: false, info: "", env: [] },
        { id: "inP", type: "http in", z: "tabP", url: "/gatec-blocked", method: "get", upload: false, swaggerDoc: "", x: 100, y: 500, wires: [["outP"]] },
        { id: "outP", type: "http response", z: "tabP", x: 300, y: 500, wires: [] },
      ];
      const deployProbe = await fetchOn(portC, "/flows", {
        method: "POST",
        headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...authC },
        body: JSON.stringify({ flows: nativeProbeNodes }),
      }, 15_000);
      check("★【Gate C】迁移流 + 原生 HTTP-in 探针一起部署（200）", deployProbe.status === 200, deployProbe);
      // 给 runtime 一点时间：若它会启动，HTTP-in 会立刻注册。
      await sleep(2_000);
      const blocked = await fetchOn(portC, "/api/gatec-blocked", {}, 3_000);
      evidence("migrated-flow HTTP-in status", { status: blocked.status });
      // T42 closes the former Gate C missing-node gap. With the managed Mcode
      // pack installed, this probe MUST run; retaining a 404 assertion would
      // punish the intended fix instead of guarding a regression.
      check("★【T42】内置节点包安装后原 Gate C 缺失类型阻断解除（HTTP-in 200）",
        blocked.status === 200, blocked);

      // C4. 把迁移流单独再部署一次：未知节点仍在读回里（不因"不启动"而被清掉/丢弃）。
      const redeploy = await fetchOn(portC, "/flows", {
        method: "POST",
        headers: { "content-type": "application/json", "Node-RED-Deployment-Type": "full", "Node-RED-API-Version": "v2", ...authC },
        body: JSON.stringify({ flows: migrated.flow.nodes }),
      }, 15_000);
      const reRead = await fetchOn(portC, "/flows", { headers: { ...authC, "Node-RED-API-Version": "v2" } }, 10_000);
      let reFlows: Array<Record<string, unknown>> = [];
      try {
        reFlows = (JSON.parse(reRead.text) as { flows?: Array<Record<string, unknown>> }).flows ?? [];
      } catch {
        /* 下面断言会红 */
      }
      check("★【Gate C】不启动的迁移流仍可读回全部节点（未知类型不被清掉）",
        redeploy.status === 200 && migratedIds.every((id) => reFlows.some((n) => n.id === id)),
        { redeploy: redeploy.status, read: reFlows.length });
      check("★【Gate C】未知类型在读回里仍是原始 type（编辑器保留为 unknown，不丢、不改名）",
        reFlows.filter((n) => n.type === "mcode-agent").length >= 1
        && reFlows.filter((n) => n.type === "mcode-branch").length === 1,
        [...new Set(reFlows.map((n) => n.type))]);
    } finally {
      killQuietly(childC);
      await settleWithin(runtimeC.stop(500), 8_000);
      try {
        rmSync(userDirC, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }
}

console.log(`\nnode-red-e2e-smoke: ${total - failures}/${total} 通过${failures === 0 ? "" : `（${failures} FAIL）`}`);
if (failures > 0) process.exitCode = 1;
