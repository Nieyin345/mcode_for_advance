/**
 * 【MC-060 残余】**第三方 Module action 的隔离执行进程**。
 *
 * ## 它在补哪个洞(源码可确认的旧行为)
 *
 * 上一轮把 `action` 能力的**准入**(清单/元数据能否挂)与**执行点审批闸 + 作用域**都落了,
 * 但 `capability.run` 仍与宿主**同进程**执行。第三方 action 代码一旦接入,一个改全局 /
 * 死循环 / `process.exit` / 抛未捕获异常的执行体就能污染宿主的内存与全局、把宿主拖住甚至
 * 一起带走。台账原话:「运行时无 worker/child-process 的 action 执行路径,故未凭空造沙箱」。
 * 本模块就是那条**从此存在**的执行路径。
 *
 * ## 它挡得住什么、挡不住什么(如实)
 *
 * 走 `node:worker_threads`(**同进程、不同线程**),不是 child_process,不是沙箱:
 *
 *   - **挡得住**:①全局污染(`globalThis` / 模块注册表在 worker 里是**另一份**,宿主那份不变);
 *     ②`process.exit` / 未捕获异常**只终止 worker 线程**,宿主存活,并回一条**可区分的失败**;
 *     ③挂死(`while(true)` 或永不 resolve)—— 宿主侧定时器 `terminate()` 能**真的停掉**一个
 *     忙循环 worker(实测 <100ms);④取消 —— `AbortSignal` 触发即 `terminate()`。
 *   - **挡不住**:①**内存不隔离** —— 同进程同堆,worker 能通过 `SharedArrayBuffer` 等共享内存
 *     与宿主交互,恶意代码可读到宿主放在共享内存里的东西;②**没有系统调用/文件系统沙箱** ——
 *     worker 里的代码照样 `require("node:fs")` 读写盘、起子进程、发网络请求;③CPU 占满一个核
 *     直到被 terminate。想要真隔离(独立堆 + 受限 syscall)应换 `child_process` /
 *     `utilityProcess` + OS 级沙箱,那是另一条更大的路。**别把 worker_threads 当沙箱**。
 *
 * ## 串行化契约
 *
 * worker 里跑的是一段**源码字符串**(`async (input) => ModuleResult`),经 `eval` 得到函数后
 * 执行;入参与结果经 `postMessage` 结构化克隆往返 —— 故 action 的 input/output 必须是可克隆
 * 的纯数据(本仓的 `ModuleResource` / `ModuleResult` 正是)。这就是"作业按数据切、不按闭包切"。
 *
 * ## 与宿主闸的关系
 *
 * 本模块**不**做任何作用域/审批判定 —— 那是 `ModuleHost.invoke` 在执行**之前**已判完的。
 * 宿主只在两道闸(资源授权 + 逐次审批)都通过后才调 `capability.run`,而 `run` 正是这里产出的
 * 派发函数。故"闸在派发到隔离进程之前"由宿主保证,并于 smoke 里以「拒绝 → 零 spawn」钉住。
 */
import { Worker } from "node:worker_threads";
import type { ModuleResult } from "@contracts/modules";

/** 隔离执行的执行体规格:一段 `async (input) => ModuleResult` 的源码,在 worker 线程里 `eval`。 */
export interface IsolatedActionSpec { source: string }

export const ISOLATION_FAILURE_CODES = ["isolated_timeout", "isolated_cancelled", "isolated_crash", "isolated_spawn_failed"] as const;
export type IsolationFailureCode = (typeof ISOLATION_FAILURE_CODES)[number];
export interface IsolationFailure { code: IsolationFailureCode; reason: string }

/** 用**结构标记**而不是 `instanceof`:调用方不必 import 本模块即可判出失败的**种类**。 */
export const ISOLATION_FAILURE_MARKER = "mcodeModuleIsolationFailure" as const;

function isolationError(code: IsolationFailureCode, reason: string): Error {
  const error = new Error(reason);
  (error as unknown as Record<string, unknown>)[ISOLATION_FAILURE_MARKER] = { code, reason } satisfies IsolationFailure;
  return error;
}

/** 读回一个 `Error` 上的隔离失败标记(没有 / 形状不对 / 码不在册 → `null`,绝不猜)。 */
export function isolationFailure(error: unknown): IsolationFailure | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[ISOLATION_FAILURE_MARKER];
  if (!value || typeof value !== "object") return null;
  const { code, reason } = value as { code?: unknown; reason?: unknown };
  if (typeof code !== "string" || typeof reason !== "string") return null;
  if (!(ISOLATION_FAILURE_CODES as readonly string[]).includes(code)) return null;
  return { code: code as IsolationFailureCode, reason };
}

/** worker 里最小引导脚本(CommonJS `eval` 上下文,`require` 可用,与父包是否 ESM 无关)。 */
const WORKER_BOOTSTRAP = [
  'const { parentPort, workerData } = require("node:worker_threads");',
  "(async () => {",
  "  try {",
  '    const handler = eval("(" + workerData.source + ")");',
  '    if (typeof handler !== "function") throw new Error("隔离执行体不是一个函数");',
  "    const result = await handler(workerData.input);",
  "    parentPort.postMessage({ ok: true, result });",
  "  } catch (error) {",
  '    parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });',
  "  }",
  "})();",
].join("\n");

/** `Worker` 的最小面(测试可塞替身,不 import node:worker_threads 也能驱动)。 */
export interface IsolatedWorkerLike {
  on(event: "message" | "error" | "exit", listener: (...args: unknown[]) => void): unknown;
  terminate(): unknown;
}
export type IsolatedWorkerFactory = (boot: { source: string; input: unknown }) => IsolatedWorkerLike;

/** 默认工厂:**真起一个 worker 线程**执行隔离源码。 */
export const defaultIsolatedWorkerFactory: IsolatedWorkerFactory = ({ source, input }) =>
  new Worker(WORKER_BOOTSTRAP, { eval: true, workerData: { source, input } }) as unknown as IsolatedWorkerLike;

let workerFactory: IsolatedWorkerFactory = defaultIsolatedWorkerFactory;
/** 装配缝隙(与 `configureModuleApprovalPort` 同款取向):测试可塞计数/替身工厂。传 `null` 复位。 */
export function configureIsolatedWorkerFactory(next: IsolatedWorkerFactory | null): void {
  workerFactory = next ?? defaultIsolatedWorkerFactory;
}

export interface IsolatedActionOptions { timeoutMs?: number; signal?: AbortSignal }

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 在隔离 worker 里跑一段 action 源码,返回它的结果。
 *
 * 四种**可区分**的终止:正常返回(executor 抛错原样透传为普通 Error)、`isolated_timeout`
 * (超时terminate)、`isolated_cancelled`(AbortSignal)、`isolated_crash`(worker error / 提前
 * 退出)。四种都在 `terminate()` 之后 reject,宿主不崩。
 */
export async function runIsolatedAction(
  spec: IsolatedActionSpec,
  input: unknown,
  options: IsolatedActionOptions = {},
): Promise<ModuleResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return await new Promise<ModuleResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let worker: IsolatedWorkerLike | null = null;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try { void worker?.terminate(); } catch { /* 已经退出 */ }
      outcome();
    };
    function onAbort(): void {
      settle(() => reject(isolationError("isolated_cancelled", "隔离执行已取消。")));
    }
    try {
      worker = workerFactory({ source: spec.source, input });
    } catch (error) {
      settle(() => reject(isolationError("isolated_spawn_failed", "隔离执行进程启动失败:" + (error instanceof Error ? error.message : String(error)))));
      return;
    }
    if (options.signal?.aborted) { onAbort(); return; }
    worker.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") {
        settle(() => reject(isolationError("isolated_crash", "隔离执行进程返回了无法识别的消息。")));
        return;
      }
      const reply = message as { ok?: unknown; result?: unknown; error?: unknown };
      if (reply.ok === true) settle(() => resolve(reply.result as ModuleResult));
      else settle(() => reject(Error(typeof reply.error === "string" ? reply.error : "隔离执行体抛出未知错误")));
    });
    worker.on("error", (error: unknown) => {
      settle(() => reject(isolationError("isolated_crash", "隔离执行进程异常:" + (error instanceof Error ? error.message : String(error)))));
    });
    worker.on("exit", (code: unknown) => {
      // 正常路径在收到 message 时已 settle;走到这里说明**没回结果就退出了**(含 process.exit)。
      settle(() => reject(isolationError("isolated_crash", "隔离执行进程在返回结果前退出(退出码 " + String(code) + ")。")));
    });
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settle(() => reject(isolationError("isolated_timeout", "隔离执行超时(" + timeoutMs + " 毫秒),已终止。")));
    }, timeoutMs);
    timer.unref?.();
  });
}

/** 把一段隔离源码包成 `Capability.run` 的形状:**派发到隔离 worker**,并接上 context 的取消信号。 */
export function createIsolatedActionRun(
  spec: IsolatedActionSpec,
  defaults: { timeoutMs?: number } = {},
): (input: unknown, context: { signal: AbortSignal }) => Promise<ModuleResult> {
  return (input, context) => runIsolatedAction(spec, input, {
    ...(defaults.timeoutMs === undefined ? {} : { timeoutMs: defaults.timeoutMs }),
    signal: context.signal,
  });
}
