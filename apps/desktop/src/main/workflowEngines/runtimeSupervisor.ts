/**
 * 【ARC-006 WF-INT】**第三方工作流引擎的运行时监管**。
 *
 * ## 它管什么
 *
 * 把「一个外部工作流引擎」（Node-RED 为首个目标，设计上不绑定具体引擎）作为
 * **独立子进程**跑起来，并回答四个问题：
 *
 *   1. 它在跑吗？（`status()`：stopped / starting / running / failed）
 *   2. 它监听哪个端口？（`loopbackPort` 分配，只绑 127.0.0.1）
 *   3. 它活着吗？（HTTP 就绪探测 + 子进程退出检测）
 *   4. 它干净地停了吗？（stop 先 SIGTERM，超时再杀进程树；退出时不留孤儿）
 *
 * ## 为什么是独立进程，不是 require 进来
 *
 * Node-RED 可以 `RED.init(server)` 嵌进主进程 —— 实测可行（见
 * `docs/planning/arc-006-wf-integration.md` 的 NR0）。但**宿主进程不该承担第三方
 * 运行时的崩溃、内存泄漏与事件循环阻塞**：它一崩，Mcode 整个应用跟着崩，而用户
 * 只是画了张流程图。独立进程让崩溃可隔离、可重启，也是 `spawnRun` 的既有取向
 * （扩展执行同样是独立进程）。
 *
 * ## 信任边界（逐条）
 *
 * - **只绑回环**：监听的 host 恒为 `127.0.0.1`；不接受调用方指定 `0.0.0.0`。
 * - **env 完全替换**：不继承宿主的 API key / token（与 `spawnRun` 同一条语义）。
 * - **cwd 与数据目录由宿主给**：引擎自己的 `flows.json` / `creds` 落在
 *   `<dataRoot>/workflow-engines/<id>/`，不碰用户项目。
 * - **地址不外泄**：`status()` 只回端口与就绪态；不把完整命令/凭据放进快照。
 *
 * ## 就绪判据（ARC-006 Gate B / P1-3）
 *
 * 「端口上有个会说话的服务」**不等于**「我们的引擎起来了」：无关的 404 服务、
 * 别人的 200 页面、抢占端口的路人进程都会让 `status > 0` 的旧判据误判 running。
 * 现在的生产探针（{@link defaultProbe}）要求两件事：
 *   1. **宿主签发的控制面身份**：`GET /settings` 不带令牌必须回 401 —— 证明对方
 *      认的是本宿主写进引擎数据目录的 `.engine-admin-token`（与凭据密钥分开）；
 *      没配置身份时**一律不就绪**（fail-closed），绝不把"谁都能访问的 200"当引擎。
 *   2. **真实 Node-RED 语义**：带 `Authorization: Bearer <token>` 后必须 200，
 *      且响应是 Node-RED settings 形状（`version` + `httpNodeRoot` 均为字符串）。
 *
 * 探针自身带 `AbortSignal.timeout`，并由 `startInner` 把它绑定到 `readyTimeoutMs`
 * 的剩余预算（见 `EngineProbeContext.timeoutMs`）—— 探测挂住时，就绪超时**真的**
 * 会生效（此前 fetch 无超时，deadline 形同虚设；真 Node-RED 实测抓到）。
 *
 * ## stop 之后迟到的成功不复活（同批 P1-3）
 *
 * 每次 `start` 领一个单调 `epoch`，`stop()` 立刻作废它。启动循环在每个 `await`
 * 之后复核 epoch：stop 期间迟到的探针成功只返回当前（stopped）状态，不会把实例
 * 改回 running，也不会在超时路径上误杀一个已由 stop 收掉的进程。
 *
 * ## 启动参数生成（ARC-006 Gate B / P1-4）
 *
 * {@link createEngineLaunchSpec} 是**唯一**的启动参数来源：命令、入口脚本、宿主
 * 签发身份（`.engine-secret` / `.engine-admin-token`）、Electron-as-Node 模式、
 * 打包路径解析与最低 Node 版本要求都收在这里。生产注册表与真 Electron 套件都调
 * 它 —— 测试不再自己补 `ELECTRON_RUN_AS_NODE=1` 这类只存在于测试里的配置。
 *
 * ## 可测性
 *
 * 进程与就绪探测都是注入的（`ports.spawn` / `ports.probe`），所以无头套件可以：
 *   - 用假进程验状态机（starting → running → stopped / failed）；
 *   - 用真 HTTP 服务验探活在真端口上的行为。
 * 生产默认实现不 import electron（打包路径用惰性 require / 可注入的 getAppPath），
 * 可在纯 node 里加载。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { log } from "@main/lib/logger.js";

export type EngineRuntimeState = "stopped" | "starting" | "running" | "failed";

export interface EngineRuntimeStatus {
  state: EngineRuntimeState;
  /** 监听端口（未启动时为 null）。只在本机回环上。 */
  port: number | null;
  /** 失败原因（人话）；非 failed 时为 null。 */
  reason: string | null;
  /** 引擎 id（调用方给的稳定标识，比如 "node-red"）。 */
  engineId: string;
  /** 宿主生成的不可自报启动代次：同端口重启也必须变更。
   * 仅在主进程内部流动，IPC toStatusView 会主动剥离此内部标识。
   * 旧注入测试/适配器可不提供，但真实 EngineRuntime 一律提供。 */
  instanceEpoch?: string;
  /** Only the Host-verified Node-RED deploy receipt can mark this runtime as deployed. */
  deploymentState?: "not-deployed" | "deployed" | "unknown";
}

export interface EngineSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  /** **完整替换**的环境变量（调用方负责合并需要的那几个）。 */
  env: NodeJS.ProcessEnv;
}

/**
 * 探针上下文 —— 引擎身份与本次探测的时间预算。
 *
 * `identity.adminToken` 是宿主签发、同时写进引擎数据目录 `.engine-admin-token`
 * 与子进程 env 的控制面令牌。没有它，生产探针无法区分「我们的引擎」和「端口上
 * 的任意一个 HTTP 服务」，因此按 fail-closed 处理（见 {@link defaultProbe}）。
 * `timeoutMs` 是**本次探测**可用的时间（已按 `readyTimeoutMs` 的剩余 deadline
 * 收窄）—— 探针必须用它构造自己的 `AbortSignal.timeout`，否则挂住的探测会让
 * 就绪超时失效。
 */
export interface EngineProbeContext {
  identity?: { adminToken: string };
  timeoutMs?: number;
}

/** 生产探针单次请求的超时上限（同时受 readyTimeoutMs 剩余预算约束）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * 实际执行就绪探测的函数。`EngineRuntimePorts.probe` 是它的**绑定形态**：
 *
 *   - 旧签字 `probe(port, signal)` 仍被接受（套件/历史调用），但那样的探针没有
 *     宿主身份与超时预算，只能由调用方自己保证；
 *   - 新签字 `probe(port, signal, context)` 额外拿到身份与剩余时间。
 *
 * 生产注册表用 `boundProbe` 把身份绑在端口实现里，不留"忘了传上下文"的口子。
 */
export type EngineProbe = (
  port: number,
  signal: AbortSignal,
  context?: EngineProbeContext,
) => Promise<boolean>;

/** 最小子进程面 —— 只为可注入。 */
export interface EngineChildProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  /** 进程退出时回调（正常/异常都算）。 */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (err: Error) => void): void;
  /** Structured private IPC (Node/Electron child only). Optional for headless fake children. */
  onMessage?(listener: (message: unknown) => void): void;
  sendMessage?(message: unknown): boolean;
  /** 最近若干行输出（诊断用；宿主不解析它）。 */
  tailOutput(): string;
}

export interface EngineRuntimePorts {
  /** 起一个进程。 */
  spawn(spec: EngineSpawnSpec): EngineChildProcess;
  /** 就绪探测：返回 true = 引擎已经在监听、且**确实是本宿主的引擎**。 */
  probe: EngineProbe;
  /** 分配一个可拨通的回环端口（默认用 `loopbackPort`）。 */
  allocatePort(): Promise<number>;
  /** 当前时间（毫秒）。 */
  now(): number;
  /** 等待（测试可加速）。 */
  sleep(ms: number): Promise<void>;
}

export interface EngineStartOptions {
  engineId: string;
  /** 引擎自己的数据目录（已由宿主创建）。 */
  dataDir: string;
  /** 起进程的命令与参数；宿主负责把 `{port}` 换成实际端口。 */
  command: string;
  args: (port: number, dataDir: string) => string[];
  /** 额外环境变量（会在宿主白名单基础上合并）。 */
  env?: NodeJS.ProcessEnv;
  /** 宿主签发的控制面身份（探针据此确认「这是我们自己的引擎」）。 */
  probeIdentity?: { adminToken: string };
  /** 就绪探测的总超时。 */
  readyTimeoutMs?: number;
  /** Private parent/child protocol; installed before readiness probing. */
  onMessage?: (message: unknown, respond: (response: unknown) => void) => void;
  /** stop 时等 SIGTERM 的宽限；超时再强杀。 */
  stopGraceMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;

/** 生产默认端口分配：`listen(0)` 重抽直到不是 fetch 黑名单端口。 */
async function defaultAllocatePort(): Promise<number> {
  const { listenOnDialablePort } = await import("@main/lib/loopbackPort.js");
  // `listenOnDialablePort(server)` **返回 Promise<number>**（不是 err-first 回调）——
  // 早先这里把可选的 `onBind(port, attempt)` 误当 `(err, port)` 解构，生产路径每次
  // start 都会以「分配端口失败：<端口号>」进 failed。真 Electron U1 抓到的。
  //
  // 这里只需要端口号：起一个空 http server、拿到一个可拨通的端口、立刻关掉，
  // 把绑定让给引擎自己。竞态窗口极小（同一进程内随即复用）。
  const { createServer } = await import("node:http");
  const server = createServer();
  try {
    const port = await listenOnDialablePort(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  } catch (err) {
    try {
      server.close();
    } catch {
      /* 没起来 */
    }
    throw err;
  }
}

/**
 * 生产默认就绪探测：**宿主身份 + 真实 Node-RED 语义**（见文件头「就绪判据」）。
 *
 * 判据（全部满足才算就绪）：
 *   1. 上下文里有宿主签发的 `adminToken`；没有 → false（fail-closed，绝不把匿名
 *      200 当引擎）；
 *   2. `GET /settings` **不带令牌**必须回 401 —— 说明对方有控制面认证，且认的是
 *      我们写进数据目录的那一个令牌（别人的 200 / 无关 404 都过不了这一关）；
 *   3. 带 `Authorization: Bearer <token>` 再取 `/settings`，必须 200，且是
 *      Node-RED settings 形状：JSON 对象、`version` 与 `httpNodeRoot` 都是字符串
 *      （`runtime.settings.version` 由 Node-RED 5.x 在 `runtime.init` 时按包版本
 *      写入；`httpNodeRoot` 是 settings 固定字段）。
 *
 * 超时：每次请求都用 `AbortSignal.any([调用方 signal, AbortSignal.timeout(...)])`，
 * 预算取 `context.timeoutMs`（`startInner` 按 deadline 剩余时间收窄）与单次上限
 * 的较小值。探测挂住时 abort 会真的打断请求 —— 就绪超时因此生效。
 */
async function defaultProbe(
  port: number,
  signal: AbortSignal,
  context: EngineProbeContext = {},
): Promise<boolean> {
  const adminToken = context.identity?.adminToken ?? "";
  if (adminToken === "") return false; // 没有宿主身份 → 无法证明是我们的引擎
  const budget = Math.max(
    1,
    Math.min(context.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS),
  );
  const url = `http://127.0.0.1:${port}/settings`;
  const fetchOnce = async (headers: Record<string, string>): Promise<Response> =>
    fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(budget)]),
    });
  try {
    // 1) 无令牌：必须被拒（401）。200/404/重定向都说明不是"带宿主认证的 Node-RED"。
    const anonymous = await fetchOnce({});
    if (anonymous.status !== 401) return false;
    // 2) 带令牌：200 + Node-RED settings 形状。
    const authorized = await fetchOnce({ authorization: `Bearer ${adminToken}` });
    if (authorized.status !== 200) return false;
    const body = (await authorized.json()) as unknown;
    if (typeof body !== "object" || body === null) return false;
    const settings = body as { version?: unknown; httpNodeRoot?: unknown };
    return typeof settings.version === "string" && typeof settings.httpNodeRoot === "string";
  } catch {
    return false;
  }
}

/**
 * 把身份绑定进探针端口 —— 生产注册表用这条路径，`probe(port, signal)` 的旧签字
 * 仍然成立，但身份不会因为调用方忘了传上下文而丢失。
 */
export function bindProbeIdentity(
  probe: EngineProbe,
  identity: { adminToken: string },
): EngineProbe {
  return (port, signal, context) => probe(port, signal, { ...context, identity });
}

/** 把 child_process 包成可注入的最小面。 */
function wrapChild(child: ChildProcess, limit = 8000): EngineChildProcess {
  let tail = "";
  const append = (chunk: Buffer | string): void => {
    tail += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (tail.length > limit) tail = tail.slice(-limit);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return {
    get pid() {
      return child.pid;
    },
    kill(signal) {
      return child.kill(signal);
    },
    onExit(listener) {
      child.once("exit", (code, sig) => listener(code, sig));
    },
    onError(listener) {
      child.once("error", listener);
    },
    onMessage(listener) {
      child.on("message", listener);
    },
    sendMessage(message) {
      if (!child.connected) return false;
      return child.send(message as Parameters<typeof child.send>[0]);
    },
    tailOutput() {
      return tail;
    },
  };
}

/** 一个引擎实例的运行时。同一 engineId 同时只允许一个实例。 */
export class EngineRuntime {
  private state: EngineRuntimeState = "stopped";
  private port: number | null = null;
  private reason: string | null = null;
  private child: EngineChildProcess | null = null;
  private starting: Promise<EngineRuntimeStatus> | null = null;
  private stopping = false;

  /** A failed launch can still have a live child awaiting OS exit. */
  protected hasLiveChild(): boolean { return this.child !== null; }
  /** 启动世代：每次 start +1，stop 也 +1（作废在途启动）。见文件头「迟到的成功」。 */
  private epoch = 0;
  // 单次 EngineRuntime 对象的唯一随机前缀；多个 runtime 对象各自从
  // epoch=0 计数，只有随机前缀才能防止跨对象/同端口重启 ABA。
  // 不进入子进程环境变量或用户可见 IPC，绝非 auth token。
  private readonly instanceSeed = randomBytes(16).toString("hex");
  private readonly engineId: string;
  private readonly ports: EngineRuntimePorts;
  private readonly terminalListeners = new Set<() => void>();

  /** Includes asynchronous child crash, startup failure and normal stop. */
  onTerminated(listener: () => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  private notifyTerminated(): void {
    for (const listener of this.terminalListeners) {
      try { listener(); }
      catch (err) { log.warn(`[workflow-engine:${this.engineId}] 终止监听失败：${err instanceof Error ? err.message : String(err)}`); }
    }
  }

  constructor(engineId: string, ports: EngineRuntimePorts) {
    this.engineId = engineId;
    this.ports = ports;
  }

  status(): EngineRuntimeStatus {
    return {
      state: this.state, port: this.port, reason: this.reason, engineId: this.engineId,
      instanceEpoch: `${this.instanceSeed}:${this.epoch}`,
    };
  }

  /** 启动（幂等：已在跑/正在起时返回当前状态）。 */
  async start(options: EngineStartOptions): Promise<EngineRuntimeStatus> {
    if (this.stopping) throw new Error("引擎尚在停止过程中，不允许并行启动");
    if (this.state === "running") return this.status();
    if (this.starting !== null) return this.starting;
    const epoch = ++this.epoch;
    this.starting = this.startInner(options, epoch).finally(() => {
      // 只有这一世代还当前时才清 —— stop 之后新 start 的 promise 不能被旧 finally 抹掉。
      if (this.epoch === epoch) this.starting = null;
    });
    return this.starting;
  }

  private async startInner(options: EngineStartOptions, epoch: number): Promise<EngineRuntimeStatus> {
    this.state = "starting";
    this.reason = null;
    let port: number;
    try {
      port = await this.ports.allocatePort();
    } catch (err) {
      if (this.epoch !== epoch) return this.status();
      return this.fail(`分配端口失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.epoch !== epoch) return this.status(); // stop 在分配端口期间发生
    this.port = port;
    // 探针身份 = 注进引擎的那个控制面令牌（`.engine-admin-token` 的内容）。它的
    // 单一事实来源就是 env：注册表读文件、写 env，探针按同一个值去握手。
    const probeIdentity = options.probeIdentity
      ?? (typeof options.env?.MCODE_ENGINE_ADMIN_TOKEN === "string" && options.env.MCODE_ENGINE_ADMIN_TOKEN !== ""
        ? { adminToken: options.env.MCODE_ENGINE_ADMIN_TOKEN }
        : undefined);
    const spec: EngineSpawnSpec = {
      command: options.command,
      args: options.args(port, options.dataDir),
      cwd: options.dataDir,
      // **完整替换**：只给引擎自己的东西，不继承宿主的密钥。
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {}),
        ...(options.env ?? {}),
        PORT: String(port),
        HOST: "127.0.0.1",
      },
    };
    let child: EngineChildProcess;
    try {
      child = this.ports.spawn(spec);
    } catch (err) {
      if (this.epoch !== epoch) return this.status();
      return this.fail(`启动引擎进程失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.epoch !== epoch) {
      // stop 抢在 spawn 之前发生：别把这个进程留成孤儿。
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经死了 */
      }
      return this.status();
    }
    this.child = child;
    if (options.onMessage !== undefined) {
      child.onMessage?.((message) => {
        if (this.child !== child) return;
        options.onMessage?.(message, (response) => {
          if (this.child !== child) return;
          child.sendMessage?.(response);
        });
      });
    }
    let exited = false;
    child.onExit((code, signal) => {
      exited = true;
      if (this.child !== child) return; // 旧实例的迟到事件
      this.child = null;
      this.port = null;
      if (this.stopping) return; // stop() waits for this confirmed exit itself.
      if (this.state === "running" || this.state === "starting") {
        this.state = "failed";
        this.reason = `引擎进程意外退出（code=${code ?? "?"} signal=${signal ?? "-"}）`;
        log.warn(`[workflow-engine:${this.engineId}] ${this.reason}\n${child.tailOutput().slice(-1500)}`);
      }
      // Also release a claim after an earlier timeout / failed kill once
      // the OS finally confirms the child is gone.
      this.notifyTerminated();
    });
    child.onError((err) => {
      if (this.child !== child) return;
      // SIGKILL is only a request; keep ownership until OS exit is confirmed.
      try { child.kill("SIGKILL"); } catch { /* owner is still held */ }
      this.fail(`引擎进程错误：${err.message}`);
    });

    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const deadline = this.ports.now() + readyTimeoutMs;
    while (this.ports.now() < deadline) {
      if (exited) return this.status();
      // 剩余预算传给探针：探针据此构造自己的 AbortSignal.timeout。没有这一条，
      // 挂住的探测会让就绪超时形同虚设（真 Node-RED 实测：30s deadline 25s 未返回）。
      const remaining = Math.max(1, deadline - this.ports.now());
      const controller = new AbortController();
      const ok = await this.ports
        .probe(port, controller.signal, { identity: probeIdentity, timeoutMs: remaining })
        .catch(() => false);
      controller.abort();
      // stop 在探测期间发生 → 迟到的成功不得把状态改回 running（也不得误杀已停进程）。
      if (this.epoch !== epoch) return this.status();
      // A child can exit while an in-flight probe still resolves true. The
      // exit listener already released its executor owner: never resurrect it.
      if (exited || this.child !== child) return this.status();
      if (ok) {
        this.state = "running";
        log.info(`[workflow-engine:${this.engineId}] ready on 127.0.0.1:${port}`);
        return this.status();
      }
      await this.ports.sleep(200);
      if (this.epoch !== epoch) return this.status();
    }
    if (this.epoch !== epoch) return this.status();
    // Timeout: request SIGKILL, but NEVER release the owner until the child
    // actually exits (kill() returning true is not an exit confirmation).
    try { child.kill("SIGKILL"); } catch { /* keep the claim until later exit */ }
    return this.fail(`引擎在 ${readyTimeoutMs}ms 内没有就绪`);
  }

  /** 停止（幂等）。先 SIGTERM，宽限期后强杀。 */
  async stop(graceMs = DEFAULT_STOP_GRACE_MS): Promise<EngineRuntimeStatus> {
    if (this.stopping) return this.status();
    this.stopping = true;
    try {
      // Invalidate in-flight startup without accidentally reopening a race.
      this.epoch += 1;
      this.starting = null;
      const child = this.child;
      if (child === null) {
        this.state = "stopped";
        this.port = null;
        this.notifyTerminated();
        return this.status();
      }
      const confirmedExit = await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (exited: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(exited);
        };
        child.onExit(() => done(true));
        try { child.kill("SIGTERM"); }
        catch { done(false); return; }
        void this.ports.sleep(graceMs).then(() => {
          if (settled) return;
          try { child.kill("SIGKILL"); } catch { /* may still be alive */ }
          // If SIGKILL never produces an exit callback, remain failed and
          // hold ownership; restarting would risk two simultaneously live flows.
          void this.ports.sleep(200).then(() => done(false));
        });
      });
      if (!confirmedExit) {
        this.state = "failed";
        this.reason = "停止引擎后未确认子进程退出，保留 flow owner 并拒绝重新启动";
        this.port = null;
        log.warn(`[workflow-engine:${this.engineId}] ${this.reason}`);
        return this.status();
      }
      this.child = null;
      this.state = "stopped";
      this.port = null;
      this.reason = null;
      log.info(`[workflow-engine:${this.engineId}] stopped`);
      this.notifyTerminated();
      return this.status();
    } finally {
      this.stopping = false;
    }
  }

  /** Synchronous last line of defence for Node/Electron process exit hooks. */
  terminateOnProcessExit(): void {
    ++this.epoch;
    this.starting = null;
    this.terminateChild();
    this.state = "stopped";
    this.port = null;
    this.reason = null;
    this.notifyTerminated();
  }

  /** 强制收掉子进程（超时/失败路径用）。 */
  private terminateChild(): void {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已经死了 */
    }
  }

  private fail(reason: string): EngineRuntimeStatus {
    this.state = "failed";
    this.reason = reason;
    this.port = null;
    log.warn(`[workflow-engine:${this.engineId}] ${reason}`);
    // A failed/timeout process may still be executing; release only after
    // its exit event. Launch failures before spawn have no such child.
    if (this.child === null) this.notifyTerminated();
    return this.status();
  }
}

/** 生产端口实现。 */
export const defaultEngineRuntimePorts: EngineRuntimePorts = {
  spawn: (spec) => {
    const child = nodeSpawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      // IPC is a private ownership preflight for Node-RED Admin deploys.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      // 不经过 shell：命令是宿主给的，参数里可能有用户路径，shell 会二次解释。
      shell: false,
      // Windows 上把子进程放进自己的进程组，stop 时能连带它的子进程一起收掉。
      detached: process.platform !== "win32",
    });
    return wrapChild(child);
  },
  probe: defaultProbe,
  allocatePort: defaultAllocatePort,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/* ══════════════ 共享启动参数生成（ARC-006 Gate B / P1-4） ══════════════ */

/**
 * `WorkflowEngineLaunchSpec` 在 runtimeSupervisor 这一侧的镜像。
 *
 * 刻意不 import `@main/ipc/workflowEngine.js`：注册表与真 Electron 套件都要用
 * 这个生成器，而 ipc 模块会拖进 `electron` 的 IpcMain 类型依赖。结构相同即可
 * 赋值（TypeScript 结构化类型），字段语义见那边。
 */
export interface EngineLaunchSpec {
  command: string;
  args: (port: number, dataDir: string) => string[];
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** 宿主签发的控制面身份 —— 探针据此确认「这是我们自己的引擎」。 */
  probeIdentity?: { adminToken: string };
}

/**
 * Node-RED 5.x 自己的最低运行时要求（`packages/node_modules/node-red/package.json`
 * 的 `engines.node` 为 `>=22.9`；`lib/red.js` 的 checkVersion 也以 `>=22.9.0` 为准）。
 * 启动前用**引擎实际会用的**那个 Node 版本核对，而不是宿主进程的 `process.version`
 * （Electron-as-Node 下两者不同：Electron 44 内嵌的是 Node 24）。
 */
export const NODE_RED_MIN_NODE = "22.9.0";

/** 数字版本比较（`22.9.0` vs `22.10.1`）；不处理 prerelease —— 引擎要求里没有。 */
export function compareNodeVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `app.getAppPath()` 的惰性解析：无 electron（无头/纯 node）时返回 null，**不猜 cwd**。 */
function defaultGetAppPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as { app?: { getAppPath?: () => string } };
    const appPath = electron.app?.getAppPath?.();
    return typeof appPath === "string" && appPath.length > 0 ? appPath : null;
  } catch {
    return null;
  }
}

/** `process.versions.electron` 的可注入读取面（套件在纯 node 里模拟 Electron 宿主）。 */
export interface EngineLaunchEnvironment {
  /** 当前进程的执行文件（生产是 electron.exe / node）。 */
  execPath: string;
  /** 当前进程内嵌的 Node 版本（默认 `process.versions.node`）。 */
  nodeVersion: string;
  /** 当前进程是否 Electron 运行时（默认看 `process.versions.electron`）。 */
  isElectron: boolean;
  /** Electron 的 `app.getAppPath()`（默认惰性 require；无 electron 时 null）。 */
  getAppPath(): string | null;
  /** Electron 下内嵌 Node 的版本（默认用当前进程的 —— 同一二进制的同一运行时）。 */
  electronNodeVersion?: string;
  /** Electron extraResources 的磁盘根；无头套件可注入打包布局。 */
  resourcesPath?: string;
}

function defaultLaunchEnvironment(): EngineLaunchEnvironment {
  return {
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    isElectron: typeof process.versions.electron === "string",
    getAppPath: defaultGetAppPath,
    ...(typeof process.resourcesPath === "string" ? { resourcesPath: process.resourcesPath } : {}),
  };
}

/**
 * 解析引擎引导脚本的真实路径 —— 开发态与打包态**只有一个**出口。
 *
 *   - 参数里的绝对路径直接采用（调用方已解析好，比如套件/测试）；
 *   - `<dataDir>/<file>` 存在则用它（**包括** `node_modules` 里的实现包）；
 *   - 都不存在时用 app 路径解析（`app.getAppPath()`）：
 *       · app 路径是 `.../app.asar` → 用 `.../app.asar.unpacked/<rel>`（asar 里的
 *         文件不是普通磁盘路径，`node <asar>/x.cjs` 起不来；打包配置需要把引导
 *         资产放进 `asarUnpack`）；
 *       · 开发态（`apps/desktop`）→ `<appPath>/<rel>`；
 *   - **拿不到 app 路径（无 electron / 未就绪）→ 抛错**。不静默回落到 cwd：
 *     那样会"看起来启动成功"却跑的是另一个目录里的脚本。
 *
 * `rel` 必须是仓库/包相对路径（如 `resources/engine-bootstrap/node-red.cjs`）；
 * 绝对路径只接受参数本身。
 */
export function resolveEngineEntry(options: {
  entryFile: string;
  dataDir: string;
  /** 相对 app 根（`app.getAppPath()`）的路径。 */
  appRelativeEntry?: string;
  getAppPath?: () => string | null;
}): string {
  if (isAbsolute(options.entryFile)) return options.entryFile;
  const inDataDir = join(options.dataDir, options.entryFile);
  if (existsSync(inDataDir)) return inDataDir;
  const appRelative = options.appRelativeEntry ?? options.entryFile;
  const appPath = (options.getAppPath ?? defaultGetAppPath)();
  if (appPath === null || appPath === "") {
    throw new Error(
      `无法解析引擎入口 ${appRelative}：拿不到 app 路径（无 electron 宿主），且 ${inDataDir} 不存在`,
    );
  }
  const resolved = appPath.includes("app.asar")
    ? join(appPath.replace("app.asar", "app.asar.unpacked"), appRelative)
    : join(appPath, appRelative);
  if (!existsSync(resolved)) {
    throw new Error(`无法解析引擎入口：${resolved} 不存在（app 路径 ${appPath}）`);
  }
  return resolved;
}

/** {@link createEngineLaunchSpec} 的可注入依赖（套件/注册表用）。 */
export interface EngineLaunchSpecOptions {
  engineId: string;
  /** 引擎数据目录（已由宿主创建）。 */
  dataDir: string;
  /** 引导脚本：绝对路径，或相对 dataDir / app 根的文件名。 */
  entryFile: string;
  /** `entryFile` 是相对路径时，它在 app 根下的位置（默认同 `entryFile`）。 */
  appRelativeEntry?: string;
  /** 引擎实现包（`<dataDir>/node_modules/<installPackage>` 必须存在）。 */
  installPackage: string;
  /** 该引擎要求的最低 Node 版本（`22.9.0`）。 */
  minNodeVersion: string;
  /** 额外环境变量（宿主白名单 env 之外，引擎自己的配置）。 */
  env?: NodeJS.ProcessEnv;
  /** 控制面令牌文件的绝对路径；内容会被读进 env.MCODE_ENGINE_ADMIN_TOKEN 与探针身份。 */
  adminTokenFile?: string;
  /** 缺省时读取/生成 `.engine-secret` 的目录（默认 `dataDir` 本身）。 */
  secretFile?: string;
  environment?: EngineLaunchEnvironment;
  /** 供生产注册表显式记录 vendor / npm fallback 的解析结果。 */
  onPackageResolution?: (result: NodeRedPackageResolution) => void;
}

export const NODE_RED_VENDOR_VERSION = "5.0.8";
export interface NodeRedPackageResolution {
  source: "vendor" | "npm";
  directory: string;
  reason?: string;
  nodePath?: string;
}

/**
 * 固定路径、固定版本的 Node-RED 官方发行源码优先；既存 npm 安装是显式 fallback。
 * 路径只能来自 Electron app 根和 resources 根，绝不扫描 cwd 或用户安装的社区节点。
 * NODE_PATH 只交给子进程，且仅包含 vendor 官方包与锁定的生产依赖。
 */
export function resolveNodeRedPackage(options: {
  dataDir: string;
  getAppPath: () => string | null;
  resourcesPath?: string;
}): NodeRedPackageResolution {
  const appPath = options.getAppPath();
  const candidates = [
    ...(options.resourcesPath ? [join(options.resourcesPath, "node-red")] : []),
    ...(appPath && !appPath.endsWith("app.asar")
      ? [resolve(appPath, "..", "node-red"), resolve(appPath, "..", "..", "node-red")]
      : []),
  ];
  const rejected: string[] = [];
  for (const dir of [...new Set(candidates)]) {
    const pkg = join(dir, "packages", "node_modules", "node-red", "package.json");
    if (!existsSync(pkg)) { rejected.push(`${dir}: package missing`); continue; }
    try {
      const info = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string };
      if (info.name !== "node-red" || info.version !== NODE_RED_VENDOR_VERSION) {
        rejected.push(`${dir}: unexpected vendor version ${String(info.version)}`);
        continue;
      }
      if (!existsSync(join(dir, "node_modules"))
        || !existsSync(join(dir, "packages", "node_modules", "@node-red", "editor-client", "public", "red", "red.min.js"))) {
        rejected.push(`${dir}: vendor production dependencies/editor missing`);
        continue;
      }
      return {
        source: "vendor", directory: dir,
        nodePath: [join(dir, "packages", "node_modules"), join(dir, "node_modules")].join(delimiter),
      };
    } catch (error) {
      rejected.push(`${dir}: unreadable vendor metadata (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const npmPackage = join(options.dataDir, "node_modules", "node-red", "package.json");
  if (!existsSync(npmPackage)) {
    throw new Error(`Node-RED vendor unavailable (${rejected.join("; ") || "no configured vendor path"}); npm fallback missing: ${npmPackage}`);
  }
  return { source: "npm", directory: dirname(npmPackage), reason: rejected.join("; ") || "vendor not configured" };
}

/**
 * **唯一**的生产启动参数生成器（ARC-006 Gate B / P1-4）。
 *
 * 收口的四件事：
 *   1. **Electron-as-Node**：`process.execPath` 在 Electron 宿主里是 electron.exe，
 *      不加 `ELECTRON_RUN_AS_NODE=1` 会起一个 GUI 进程而不是 Node —— 生产与
 *      真 Electron 套件从此走同一个判断（按命令是不是 Electron 二进制，而不是
 *      按"测试要不要补"）；
 *   2. **打包路径**：入口解析只走 {@link resolveEngineEntry}；拿不到 app 路径时
 *      抛错而不是静默猜；
 *   3. **版本要求**：用引擎**实际会用的** Node 版本（Electron 内嵌版本）核对
 *      `minNodeVersion`，不满足直接抛错（错误信息点名两个版本）；
 *   4. **宿主身份**：`.engine-secret`（凭据解密）与 `.engine-admin-token`（控制面
 *      认证）在这里生成/读取，并同时进入 env 与 `probeIdentity` —— 探针不再依赖
 *      调用方记得传。
 *
 * 命令是 Electron 二进制时还会带 `ELECTRON_NO_ATTACH_CONSOLE=1`：Node 语义下
 * 这个变量避免子进程在 Windows 上抢占父进程控制台（与 `genofficeCli` 同一取向）。
 */
export function createEngineLaunchSpec(options: EngineLaunchSpecOptions): EngineLaunchSpec {
  const environment = options.environment ?? defaultLaunchEnvironment();
  const nodeRedSource = options.installPackage === "node-red"
    ? resolveNodeRedPackage({ dataDir: options.dataDir, getAppPath: environment.getAppPath, resourcesPath: environment.resourcesPath })
    : null;
  if (nodeRedSource) options.onPackageResolution?.(nodeRedSource);
  else {
    const packageJson = join(options.dataDir, "node_modules", options.installPackage, "package.json");
    if (!existsSync(packageJson)) {
      throw new Error(`引擎 ${options.engineId} 未安装：找不到 ${packageJson}`);
    }
  }
  const entry = resolveEngineEntry({
    entryFile: options.entryFile,
    dataDir: options.dataDir,
    ...(options.appRelativeEntry !== undefined ? { appRelativeEntry: options.appRelativeEntry } : {}),
    ...(environment.getAppPath !== undefined ? { getAppPath: environment.getAppPath } : {}),
  });
  // 版本要求按引擎实际会用到的 Node：Electron 宿主里是内嵌 Node，不是宿主的 node。
  const runtimeNode = environment.isElectron
    ? (environment.electronNodeVersion ?? environment.nodeVersion)
    : environment.nodeVersion;
  if (compareNodeVersions(runtimeNode, options.minNodeVersion) < 0) {
    throw new Error(
      `引擎 ${options.engineId} 要求 Node >= ${options.minNodeVersion}，当前引擎运行时是 ${runtimeNode}`,
    );
  }
  // 凭据密钥：每个数据目录一个。不写进 flows.json / creds，也不进日志。
  const secret = readOrCreateSecret(join(options.secretFile ?? options.dataDir, ".engine-secret"));
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? {}),
    // 显式覆盖调用者传来的 NODE_PATH，防止社区节点抢在官方依赖前面。
    ...(nodeRedSource ? { NODE_PATH: nodeRedSource.nodePath ?? "" } : {}),
    NODE_RED_CREDENTIAL_SECRET: secret,
  };
  let probeIdentity: EngineLaunchSpec["probeIdentity"];
  if (options.adminTokenFile !== undefined) {
    const adminToken = readOrCreateSecret(options.adminTokenFile);
    env.MCODE_ENGINE_ADMIN_TOKEN = adminToken;
    probeIdentity = { adminToken };
  }
  const commandIsElectron = environment.isElectron
    || /^electron(\.exe)?$/i.test(basename(environment.execPath));
  if (commandIsElectron) {
    // Electron 二进制必须在 Node 语义下跑：否则它开的是一个 GUI app。
    env.ELECTRON_RUN_AS_NODE = "1";
    env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  }
  return {
    command: environment.execPath,
    args: (port, dataDir) => [entry, String(port), dataDir],
    dataDir: options.dataDir,
    env,
    ...(probeIdentity !== undefined ? { probeIdentity } : {}),
  };
}

/**
 * 引擎密钥只在首次安装（ENOENT）时创建。
 *
 * 空文件表示原密钥已损坏，绝不能生成新值覆盖：否则持久化的 Node-RED 凭据
 * 会在看似正常启动后失去原解密密钥。EACCES/EISDIR 等读取故障也不能被当成
 * "首次安装"。私有暂存文件先 `wx` 完整写盘并 `fsync`，再用 hard link
 * 原子无覆盖地发布，避免直接对最终文件写入时被并发读取到半成品。
 * 不校验旧的非空密钥是否 64 位十六进制：历史版本/用户可能使用自定义密钥。
 */
function readOrCreateSecret(path: string): string {
  // 只允许初次 lstat 自身返回 ENOENT 后签发新身份；既存档案通过 lstat，
  // 随后 open/read 时遭竞态删除或临时 ENOENT 绝不能被解释成全新安装。
  let initiallyAbsent = false;
  const readExisting = (): string => {
    // 【MC-058】发布采用 hard-link 原子 no-replace，极短时间内同时存在
    // staging + 最终路径两条链接（nlink=2）。这不是可直接信任的状态；
    // 仅做有限等待**重新核查**。持续的外部硬链接、符号链接仍一律拒绝。
    // 同步启动接口中最多等待 8×5ms，避免跨 OS 进程竞争时的误报坏档。
    const linkSettling = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 9; attempt++) {
      let original: ReturnType<typeof lstatSync>;
      try {
        original = lstatSync(path);
      } catch (err) {
        if (attempt === 0 && (err as NodeJS.ErrnoException).code === "ENOENT") initiallyAbsent = true;
        throw err;
      }
      if (!original.isFile() || original.nlink !== 1) {
        if (original.isFile() && original.nlink === 2 && attempt < 8) {
          Atomics.wait(linkSettling, 0, 0, 5);
          continue;
        }
        throw new Error(`工作流引擎密钥必须是独立普通文件（拒绝链接或特殊文件）：${path}`);
      }
      // 不能只 lstat 再按路径读取：两次调用之间仍可能被替换。
      // Unix 内核 O_NOFOLLOW 阻断末端 symlink；fstat 检查同一个 inode。
      const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      try {
        const opened = fstatSync(fd);
        if (opened.isFile() && opened.nlink === 2 && attempt < 8) {
          Atomics.wait(linkSettling, 0, 0, 5);
          continue;
        }
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== original.dev || opened.ino !== original.ino) {
          throw new Error(`工作流引擎密钥文件已被替换或链接，拒绝使用：${path}`);
        }
        const value = readFileSync(fd, "utf8").trim();
        if (value === "") {
          throw new Error(`工作流引擎密钥文件为空，拒绝静默覆盖：${path}`);
        }
        return value;
      } finally {
        closeSync(fd);
      }
    }
    throw new Error(`工作流引擎密钥在限定等待后仍不是独立普通文件：${path}`);
  };
  try {
    return readExisting();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !initiallyAbsent) throw err;
  }
  mkdirSync(dirname(path), { recursive: true });
  const value = randomBytes(32).toString("hex");
  // 【MC-058】直接 wx 写最终密钥路径会先暴露一个 0 字节的新 inode，随后才写
  // 完 64 字节。另一进程看到空内容会误判为密钥损坏并拒启。先在**同目录私有**
  // 暂存文件完整写入并 fsync，再通过 hard link 原子、不可覆盖地发布最终名字。
  // linkSync 的 EEXIST 是并发赢家已发布；绝不能用 renameSync 覆盖它的值。
  const stagingPath = join(dirname(path), `.${basename(path)}.stage-${randomBytes(12).toString("hex")}`);
  let stagingFd: number | null = null;
  let staged = false;
  let collision = false;
  try {
    stagingFd = openSync(stagingPath, "wx", 0o600);
    staged = true;
    writeFileSync(stagingFd, value, "utf8");
    fsyncSync(stagingFd);
    closeSync(stagingFd);
    stagingFd = null;
    try {
      linkSync(stagingPath, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      collision = true;
    }
  } finally {
    if (stagingFd !== null) closeSync(stagingFd);
    if (staged) unlinkSync(stagingPath);
  }
  // 另一个进程可能赢得发布，须在自己的暂存名字清理后才读对方内容。
  // 碰到 EACCES/ENOENT/坏档一律真实报错，不生成新的身份去覆盖。
  return collision ? readExisting() : value;
}
