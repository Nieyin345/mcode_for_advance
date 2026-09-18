/**
 * 命令节点的执行器 —— 起一个进程,等它退出,把「退出码」和「输出尾部」交给下游。
 *
 * ## 为什么它不在 `runner.ts` 里
 *
 * `runner.ts` 是"节点会话"那一摊:建会话、绑运行时、订阅回合事件。命令节点**什么会话
 * 都不建** —— 它就是 `spawn` 一个进程然后等。塞进去只会让那边的分岔又多一层。它也
 * 不在调度器里:调度器管的是"什么时候轮到这一步",不管"这一步怎么跑"(跑的办法走
 * `RunPorts.execute` 进来,见 `scheduler.ts`)。
 *
 * ## 三条刻意的规矩(见内置清单 `mcode.command` 的 usage)
 *
 * 1. **非零退出码不算这一步失败。** 直跑的语义是"等它跑完",不是"断言它成功" ——
 *    训练脚本退出码 1,流程照样往下走,分流是下游那个"决定权给模型"的分支看
 *    「退出码」做的事。**spawn 失败**(命令根本没起来)才是失败。
 * 2. **输出只留尾部**(`COMMAND_OUTPUT_TAIL_CHARS`)。长任务动辄几万行日志,全量
 *    进产出变量是把下游的提示词往死里撑;错误栈和最后几行结果都在尾部。
 * 3. **超时和中止都要连子进程一起杀。** `shell: true` 起的是 shell,shell 死了它带的
 *    孙进程不一定死 —— 用户按了停止之后训练还在偷偷跑,是这类功能最招恨的翻车方式。
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { COMMAND_OUTPUT_TAIL_CHARS } from "@contracts/nodeType";
import { NODE_STDOUT_PROTOCOL_PREFIX, type NodeArtifact, type NodeOutcome } from "@contracts/nodeType";
import { normalizeNodeArtifacts } from "./artifactRefs.js";

export interface CommandProgress {
  percent?: number;
  message?: string;
}

interface ProtocolResult {
  summary?: string;
  outputs?: Record<string, unknown>;
  artifacts?: NodeArtifact[];
}

function consumeProtocolLine(
  line: string,
  onProgress: ((progress: CommandProgress) => void) | undefined,
  state: { result?: ProtocolResult },
): boolean {
  if (!line.startsWith(NODE_STDOUT_PROTOCOL_PREFIX)) return false;
  const match = line.match(/^@@mcode:(progress|result)\s+(.+)$/);
  if (!match) return true;
  try {
    const payload = JSON.parse(match[2]) as unknown;
    if (match[1] === "progress" && payload && typeof payload === "object") {
      const value = payload as Record<string, unknown>;
      const progress: CommandProgress = {};
      if (typeof value.percent === "number" && Number.isFinite(value.percent)) progress.percent = value.percent;
      if (typeof value.message === "string") progress.message = value.message;
      onProgress?.(progress);
    } else if (match[1] === "result" && payload && typeof payload === "object") {
      const value = payload as Record<string, unknown>;
      state.result = {
        ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
        ...(value.outputs && typeof value.outputs === "object" && !Array.isArray(value.outputs)
          ? { outputs: value.outputs as Record<string, unknown> }
          : {}),
        ...(Array.isArray(value.artifacts) ? { artifacts: value.artifacts as NodeArtifact[] } : {}),
      };
    }
  } catch {
    // Protocol lines are control output; malformed payloads are ignored rather than crashing the runner.
  }
  return true;
}

function consumeChunk(
  pending: string,
  chunk: Buffer,
  onProgress: ((progress: CommandProgress) => void) | undefined,
  state: { result?: ProtocolResult },
  append: (text: string) => void,
): string {
  const text = pending + chunk.toString("utf-8");
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (!consumeProtocolLine(line, onProgress, state)) append(line + "\n");
  }
  return remainder;
}

/** `node:child_process` 的 `spawn` 的形状 —— 留一个缝,冒烟脚本能塞假的进来。 */
export type SpawnFn = typeof nodeSpawn;

/** 杀进程树:Windows 用 `taskkill /T`(连孙进程),其余平台先 TERM 后 KILL。 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // /T = 连整棵树,/F = 强制。taskkill 找不到进程(已经退了)不算错。
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000).unref();
}

/** 把一段新输出并进环形缓冲,超长只留尾部。 */
function appendTail(buf: string, chunk: Buffer): string {
  const next = buf + chunk.toString("utf-8");
  return next.length > COMMAND_OUTPUT_TAIL_CHARS
    ? next.slice(next.length - COMMAND_OUTPUT_TAIL_CHARS)
    : next;
}

/**
 * 跑一条命令直到它退出。**这个 promise 一定 settle**:退出、超时、中止,三条路都通。
 *
 * `cwd` 省略时进程落在宿主的当前目录 —— 调用方(runner.ts)应当传**项目目录**,
 * 让 `python train.py` 这种相对路径的命令落在用户画图时想的那块地上。
 *
 * `deps.spawn` 只给冒烟测试用:塞一个假的 spawn,不真起进程。
 */
export async function runCommandNode(
  args: {
    command: string;
    /** Optional structured stdin payload from workflow inputs/upstream artifacts. */
    input?: unknown;
    /** 毫秒。0 = 不限(见 `@contracts/nodeType` 的 `commandTimeoutOf`)。 */
    timeoutMs: number;
    cwd?: string;
    signal: AbortSignal;
    onProgress?: (progress: CommandProgress) => void;
  },
  deps?: { spawn?: SpawnFn },
): Promise<NodeOutcome> {
  const { command, input, timeoutMs, cwd, signal, onProgress } = args;
  const spawn = deps?.spawn ?? nodeSpawn;
  if (command.length === 0) {
    return { status: "failed", summary: "", error: "命令节点没有填要跑的命令" };
  }
  if (signal.aborted) return { status: "cancelled", summary: "" };

  let child: ChildProcess;
  try {
    child = spawn(command, {
      shell: true,
      windowsHide: true,
      ...(cwd !== undefined ? { cwd } : {}),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return { status: "failed", summary: "", error: `命令起不来:${(err as Error).message}` };
  }
  // `shell: true` 时 spawn 几乎不抛(错误走 error 事件),这一拦兜的是后一种。
  let spawnError: Error | undefined;
  child.on("error", (err: Error) => {
    spawnError = err;
  });

  let tail = "";
  let stdoutPending = "";
  const protocolState: { result?: ProtocolResult } = {};
  const append = (text: string): void => {
    tail = appendTail(tail, Buffer.from(text, "utf-8"));
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutPending = consumeChunk(stdoutPending, chunk, onProgress, protocolState, append);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = appendTail(tail, chunk);
  });

  const killedBy = { timeout: false, abort: false };
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          killedBy.timeout = true;
          killTree(child);
        }, timeoutMs)
      : undefined;
  const onAbort = (): void => {
    killedBy.abort = true;
    killTree(child);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, sig) => resolve({ code, signal: sig }));
    },
  );

  if (timer !== undefined) clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);

  if (stdoutPending.length > 0) {
    if (!consumeProtocolLine(stdoutPending, onProgress, protocolState)) append(stdoutPending);
  }
  const text = tail.trim();
  const protocol = protocolState.result;
  const artifacts = normalizeNodeArtifacts(protocol?.artifacts, cwd ?? process.cwd());
  // **spawn 就没成**(ENOENT 那一类):shell 都没起来,谈不上"跑完了"。
  if (spawnError !== undefined && child.pid === undefined) {
    return { status: "failed", summary: text, error: `命令起不来:${spawnError.message}` };
  }
  if (killedBy.abort) return { status: "cancelled", summary: text };
  if (killedBy.timeout) {
    return {
      status: "failed",
      summary: text,
      error: `命令超过 ${timeoutMs} 毫秒还没完,被杀掉了 —— 要等它就别填超时,或把超时填大些`,
    };
  }
  if (exit.code === null) {
    // 不是我们杀的(没有 abort/timeout 标记)却没拿到退出码 —— 被外部信号终止了。
    return {
      status: "failed",
      summary: text,
      error: `命令被信号终止(${exit.signal ?? "未知"}),没有拿到退出码`,
    };
  }
  return {
    status: "success",
    summary: protocol?.summary ?? text,
    outputs: {
      ...(protocol?.outputs ?? {}),
      exitCode: exit.code,
      stdout: text,
    },
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}
