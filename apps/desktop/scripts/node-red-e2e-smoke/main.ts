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
 * ## 两条路径，各管一件事（⚠️ 记一条真缺陷）
 *
 * **A. 生产 bootstrap（`workflowEngines/registry.ts` 写出的那份）—— 已知缺陷的绊线。**
 * 实测：它 `http.createServer()` 时**没有给请求处理器**，也从未
 * `app.use(RED.httpAdmin)` / `app.use(httpNodeRoot, RED.httpNode)`；`RED.init(server)`
 * 只初始化运行时、不往 server 上挂请求路由。结果：
 *   - 端口在监听（TCP connect 成功），但任何 HTTP 请求（就绪探测 `GET /`、编辑器页、
 *     HTTP-in）都**得不到任何响应**；
 *   - 生产就绪探测 `defaultProbe` 的 `fetch` **自身没有超时**，而
 *     `EngineRuntime.startInner` 是 `await probe(...)` 之后才检查 deadline ——
 *     探测被挂住时**就绪超时（30s）形同虚设**（实测 25s 内 start() 不返回）。
 * 本套把这两条当作**绊线**断言：一旦 registry.ts 修成官方挂载形状，这里会红，
 * 提醒把路径 B 换成生产 bootstrap。按任务要求，本套**不修改**那三个生产文件。
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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
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

/** 有界原始 HTTP GET：response 是否真的回来了（超时/拒绝都算 false）。 */
function rawHttpGet(port: number, path: string, timeoutMs: number): Promise<{ responded: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { responded: boolean; status?: number; error?: string }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => done({ responded: true, status: res.statusCode }));
      res.on("error", (err) => done({ responded: false, error: err.message }));
    });
    req.on("timeout", () => {
      req.destroy();
      done({ responded: false, error: `timeout after ${timeoutMs}ms` });
    });
    req.on("error", (err) => done({ responded: false, error: err.message }));
    req.end();
  });
}

async function fetchOn(port: number, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
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

/* ══════════ A. 生产 bootstrap：记录真缺陷（绊线） ══════════ */
console.log("\nA. 生产注册表 bootstrap（registry.ts 写出的引导脚本）");
let runtimeA: EngineRuntime | null = null;
let childA: EngineChildProcess | undefined;
try {
  const registry = new ProductionWorkflowEngineRegistry();
  // registry.launchSpec 会按生产路径把 bootstrap.cjs 写进
  // <dataRoot>/workflow-engines/node-red/（本套里 dataRoot 就是 .tmp/nr-e2e）。
  const launch = registry.launchSpec(NODE_RED_ENGINE_ID);
  check("★ 生产注册表认出已安装的 node-red 并给出启动参数", launch !== null);
  if (launch === null) throw new Error("launchSpec 返回 null —— 安装布局与生产注册表不一致");

  const bootstrapPath = join(INSTALLED, "bootstrap.cjs");
  const bootstrapText = existsSync(bootstrapPath) ? readFileSync(bootstrapPath, "utf8") : "";
  evidence("production bootstrap", bootstrapPath);
  evidence("production bootstrap sha256", createHash("sha256").update(bootstrapText).digest("hex"));
  evidence("production bootstrap 形状", bootstrapText.includes("RED.init(server") && !bootstrapText.includes("app.use(")
    ? "listen() 先于 RED.init，且没有 express 挂载（app.use）——请求路由从未接到 server 上"
    : "与预期不同（可能已被修复，见下方绊线）");
  check("生产 bootstrap 先 listen 再 RED.init（缺陷形状的来源）", bootstrapText.includes("server.listen(port, \"127.0.0.1\"") && bootstrapText.includes("RED.init(server"));

  const secretPath = join(INSTALLED, ".engine-secret");
  const secret = existsSync(secretPath) ? readFileSync(secretPath, "utf8").trim() : "";
  evidence(".engine-secret", `${secretPath} (${secret.length} 字符)`);
  check("★ 宿主生成了凭据密钥（32 字节 hex）并放在 dataDir 的 .engine-secret", /^[0-9a-f]{64}$/.test(secret));
  check("★ 启动 env 里的凭据密钥与 .engine-secret 一致（不进日志/flows）", launch.env?.NODE_RED_CREDENTIAL_SECRET === secret);
  check("★ 启动命令是宿主自己的 node + 引导脚本（不是 node-red CLI）", launch.command === process.execPath && launch.args.length > 0);

  const portsA = recordingPorts();
  runtimeA = new EngineRuntime(NODE_RED_ENGINE_ID, portsA);
  // 就绪超时故意给 8s：如果 deadline 被遵守，start() 应在 ~8s 内以 failed 返回。
  const startPromiseA = runtimeA.start({
    engineId: NODE_RED_ENGINE_ID,
    dataDir: launch.dataDir,
    command: launch.command,
    args: launch.args,
    ...(launch.env !== undefined ? { env: launch.env } : {}),
    readyTimeoutMs: 8_000,
  });
  const raceA = settleWithin(startPromiseA, 25_000);

  const portA = await waitFor(() => (portsA.allocated.length > 0 ? portsA.allocated[0] : null), 15_000);
  check("★ 生产路径经 listenOnDialablePort 分到了回环端口", typeof portA === "number" && portA > 0);
  evidence("production port", portA);

  childA = portsA.children[0];
  const listeningA = portA !== null ? await waitFor(async () => ((await tcpConnect(portA, 800)) ? true : null), 25_000) : null;
  check("★ 生产 bootstrap 的端口**在监听**（TCP connect 成功）", listeningA === true);

  const getA = portA !== null ? await rawHttpGet(portA, "/", 3_000) : { responded: false, error: "no port" };
  evidence("production GET /", getA);
  check("★【已知缺陷】端口在听但 HTTP 不应答（GET / 超时无响应）", listeningA === true && getA.responded === false);

  const raceResultA = await raceA;
  evidence("production start() 结果", raceResultA.settled ? raceResultA.value : "25s 内没有 settle（探测 fetch 被挂住）");
  // 绊线：registry.ts 修好后这里会红 —— 那是提醒把路径 B 换成生产 bootstrap，而不是本套坏了。
  check("★【已知缺陷·绊线】readyTimeoutMs=8s 不生效：start() 25s 内没有返回（defaultProbe 的 fetch 无自身超时）",
    raceResultA.settled === false);

  // 收掉子进程，让被挂住的探测失败、start() 真正落定。
  killQuietly(childA);
  const settledA = await settleWithin(startPromiseA, 15_000);
  evidence("kill 后 start() 落定", settledA.settled ? settledA.value : "仍未返回");
  check("★ 子进程被杀后 start() 最终以 failed 落定且原因是就绪超时",
    settledA.settled && settledA.value.state === "failed" && /没有就绪/.test(settledA.value.reason ?? ""),
    settledA.settled ? settledA.value : null);
} catch (err) {
  check(`A 段未抛异常（${err instanceof Error ? err.message : String(err)}）`, false);
} finally {
  killQuietly(childA);
  if (runtimeA !== null) await settleWithin(runtimeA.stop(500), 8_000);
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
  const flow = [
    { id: "flow1", type: "tab", label: "nr-e2e" },
    { id: "in1", type: "http in", z: "flow1", url: "/echo", method: "post", upload: false, swaggerDoc: "", x: 100, y: 100, wires: [["fn1"]] },
    {
      id: "fn1", type: "function", z: "flow1", name: "echo", outputs: 1, x: 250, y: 100, wires: [["out1"]],
      func: "msg.headers={'content-type':'application/json'};"
        + "msg.payload={echo: msg.payload, via:'node-red', nonce:(msg.req.headers['x-nr-e2e-nonce']||null)};"
        + "return msg;",
    },
    { id: "out1", type: "http response", z: "flow1", x: 400, y: 100, wires: [] },
  ];
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
