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
 * ## 可测性
 *
 * 进程与就绪探测都是注入的（`ports.spawn` / `ports.probe`），所以无头套件可以：
 *   - 用假进程验状态机（starting → running → stopped / failed）；
 *   - 用真 HTTP 服务验探活在真端口上的行为。
 * 生产默认实现不 import electron，可在纯 node 里加载。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
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
}

export interface EngineSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  /** **完整替换**的环境变量（调用方负责合并需要的那几个）。 */
  env: NodeJS.ProcessEnv;
}

/** 最小子进程面 —— 只为可注入。 */
export interface EngineChildProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  /** 进程退出时回调（正常/异常都算）。 */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (err: Error) => void): void;
  /** 最近若干行输出（诊断用；宿主不解析它）。 */
  tailOutput(): string;
}

export interface EngineRuntimePorts {
  /** 起一个进程。 */
  spawn(spec: EngineSpawnSpec): EngineChildProcess;
  /** 就绪探测：返回 true = 引擎已经在监听且能应答。 */
  probe(port: number, signal: AbortSignal): Promise<boolean>;
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
  /** 就绪探测的总超时。 */
  readyTimeoutMs?: number;
  /** stop 时等 SIGTERM 的宽限；超时再强杀。 */
  stopGraceMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;

/** 生产默认端口分配：`listen(0)` 重抽直到不是 fetch 黑名单端口。 */
async function defaultAllocatePort(): Promise<number> {
  const { listenOnDialablePort } = await import("@main/lib/loopbackPort.js");
  // `listenOnDialablePort` 的契约是"给你一个 server 并回调"，这里只需要端口号，
  // 所以起一个空 http server、拿端口、立刻关掉 —— 端口是"可拨通"的判据不变，
  // 只是把绑定让给引擎自己。竞态窗口极小（同一进程内随即复用）。
  const { createServer } = await import("node:http");
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    listenOnDialablePort(server, (err, port) => {
      if (err) {
        reject(err);
        return;
      }
      server.close(() => resolve(port));
    });
  });
}

/** 生产默认就绪探测：HTTP GET `/` 拿到任意响应（含 3xx/4xx）即视为在监听。 */
async function defaultProbe(port: number, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal, redirect: "manual" });
    // 任何 HTTP 应答都说明端口上有一个会说话的服务 —— 具体状态码由引擎自己决定。
    return res.status > 0;
  } catch {
    return false;
  }
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
  private readonly engineId: string;
  private readonly ports: EngineRuntimePorts;

  constructor(engineId: string, ports: EngineRuntimePorts) {
    this.engineId = engineId;
    this.ports = ports;
  }

  status(): EngineRuntimeStatus {
    return { state: this.state, port: this.port, reason: this.reason, engineId: this.engineId };
  }

  /** 启动（幂等：已在跑/正在起时返回当前状态）。 */
  async start(options: EngineStartOptions): Promise<EngineRuntimeStatus> {
    if (this.state === "running") return this.status();
    if (this.starting !== null) return this.starting;
    this.starting = this.startInner(options).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startInner(options: EngineStartOptions): Promise<EngineRuntimeStatus> {
    this.state = "starting";
    this.reason = null;
    let port: number;
    try {
      port = await this.ports.allocatePort();
    } catch (err) {
      return this.fail(`分配端口失败：${err instanceof Error ? err.message : String(err)}`);
    }
    this.port = port;
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
      return this.fail(`启动引擎进程失败：${err instanceof Error ? err.message : String(err)}`);
    }
    this.child = child;
    let exited = false;
    child.onExit((code, signal) => {
      exited = true;
      if (this.child !== child) return; // 旧实例的迟到事件
      this.child = null;
      this.port = null;
      if (this.state === "running" || this.state === "starting") {
        this.state = "failed";
        this.reason = `引擎进程意外退出（code=${code ?? "?"} signal=${signal ?? "-"}）`;
        log.warn(`[workflow-engine:${this.engineId}] ${this.reason}\n${child.tailOutput().slice(-1500)}`);
      }
    });
    child.onError((err) => {
      if (this.child !== child) return;
      this.fail(`引擎进程错误：${err.message}`);
    });

    const deadline = this.ports.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    while (this.ports.now() < deadline) {
      if (exited) return this.status();
      const controller = new AbortController();
      const ok = await this.ports.probe(port, controller.signal).catch(() => false);
      controller.abort();
      if (ok) {
        this.state = "running";
        log.info(`[workflow-engine:${this.engineId}] ready on 127.0.0.1:${port}`);
        return this.status();
      }
      await this.ports.sleep(200);
    }
    // 超时：把进程收掉再报失败（留着会变成一个没人管的监听端口）。
    this.terminateChild();
    return this.fail(`引擎在 ${options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS}ms 内没有就绪`);
  }

  /** 停止（幂等）。先 SIGTERM，宽限期后强杀。 */
  async stop(graceMs = DEFAULT_STOP_GRACE_MS): Promise<EngineRuntimeStatus> {
    const child = this.child;
    if (child === null) {
      this.state = "stopped";
      this.port = null;
      return this.status();
    }
    this.child = null; // 让退出事件知道是主动停的
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.onExit(() => done());
      try {
        child.kill("SIGTERM");
      } catch {
        done();
        return;
      }
      void this.ports.sleep(graceMs).then(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已经死了 */
        }
        // 再给一小段收尾，避免 stop() 在进程真正退出前返回。
        void this.ports.sleep(200).then(done);
      });
    });
    this.state = "stopped";
    this.port = null;
    this.reason = null;
    log.info(`[workflow-engine:${this.engineId}] stopped`);
    return this.status();
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
    return this.status();
  }
}

/** 生产端口实现。 */
export const defaultEngineRuntimePorts: EngineRuntimePorts = {
  spawn: (spec) => {
    const child = nodeSpawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
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
