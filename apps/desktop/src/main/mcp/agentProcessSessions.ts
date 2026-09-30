/**
 * Small in-process session manager for the web-agent MCP terminal tools.
 *
 * `agent_bash` remains the one-shot path. This manager is only for commands
 * that need continuity (REPLs, dev servers, long builds): start once, then
 * read/write by an opaque id owned by the originating mcode conversation.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * `data` 事件给的是**字节块**,边界可以落在**一个多字节字符的中间**。
 *
 * 直接 `chunk.toString()` 会把那个字符切成两半、各自变成 `U+FFFD`,而这份缓冲是交给
 * 模型的日志 —— 损坏了就**永久**损坏(`next_cursor` 续读也拿不回来)。`StringDecoder`
 * 会把不完整的尾巴留到下一块,正是干这个的。
 *
 * ⚠️ **每个进程会话、每条流各一份**(挂在 {@link ProcessSession} 上,不是模块级):
 * 模块级的话,进程 A stdout 留下的半个字符会被进程 B 的第一批字节补完 —— 串味,
 * 而且比不修还难查。
 *
 * (2026-09-24 审查发现;`agent_bash` 那处同款问题见那边。)
 */
function newDecoder(): StringDecoder {
  return new StringDecoder("utf8");
}

/** `data` 回调按 Node 的类型可以是 string(设了 encoding 时)——统一成 Buffer 喂解码器。 */
function toBuf(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60_000;
export const MAX_PROCESS_TIMEOUT_MS = 60 * 60_000;

/**
 * 一次 `read` / `write` 最多等多久。
 *
 * ⚠️ **这个数是被 ChatGPT 的客户端超时反推出来的，不是随便挑的。** OpenAI 对
 * **单次工具调用**有约 60 秒的硬上限，超了直接回 `-32001` 超时——那是它的服务端
 * 实现，我们改不了。所以等待**必须压在 60 秒之下**，55 秒留 5 秒余量。
 *
 * 为什么是这个量级:早先这里是 **5 秒** —— 于是一个跑 10 分钟的任务会变成
 * **上百次**"读 → 空 → 再读"，每次空返回都跟着一轮模型往返和一段"我在等"的解释。
 * 这就是用户报的"断断续续停下来汇报"。阻塞语义(等数据真的来了再返回)一次调用能等到
 * 一大批输出,10 分钟的任务从上百次降到十几次。
 *
 * 流式解决不了这个问题:ChatGPT 不发 `progressToken`(MCP 的进度通知用不上),且模型
 * **必须等这次调用返回**才看得见结果——长于 60 秒的任务在它那儿必然跨多次调用。
 */
export const MAX_PROCESS_WAIT_MS = 55_000;

/**
 * 一次读取里,**拿到第一段输出之后再等多久就交出去**(见 `waitForOutput` 的第 2 条)。
 *
 * 为什么需要它:长任务常常"吐几行进度 → 憋很久 → 再吐几行"。等满 55 秒会把这些进度
 * 一直扣着不给模型看,而它明明已经能读了。
 *
 * 为什么不是 0(有就立刻回):日志往往**一次吐好几行**(`printf` 多条、或程序 flush 一批),
 * 立刻回会把同一波切成好几次调用。300ms 够它们落地,又短到用户察觉不出。
 *
 * 这个值只在**已经有未读输出**时才起作用 —— 静默期仍然按 `waitMs` 长等(那是"别空轮询"
 * 的另一半,见 `MAX_PROCESS_WAIT_MS`)。
 */
const SETTLE_MS = 300;

const MAX_PROCESS_BUFFER_CHARS = 120_000;
const MAX_RUNNING_PER_OWNER = 8;
const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = 60_000;

type ProcessStatus = "running" | "exited" | "stopped" | "timed_out" | "failed";

interface ProcessSession {
  id: string;
  /** stdout / stderr 各自的**流式**解码器 —— 扛跨界多字节字符,见 `newDecoder`。
   *  挂在会话上(不是模块级),否则两个进程的半个字符会互相补完、串味。 */
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  ownerSessionId: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  startedAt: number;
  status: ProcessStatus;
  forcedStatus: ProcessStatus | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  buffer: string;
  baseCursor: number;
  endCursor: number;
  timeout: NodeJS.Timeout;
  waiters: Set<() => void>;
}

export interface AgentProcessReadResult {
  processId: string;
  status: ProcessStatus;
  command: string;
  cwd: string;
  output: string;
  requestedCursor: number;
  nextCursor: number;
  bufferStartCursor: number;
  skippedChars: number;
  hasMore: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface AgentProcessListItem {
  processId: string;
  status: ProcessStatus;
  command: string;
  cwd: string;
  startedAt: number;
  endCursor: number;
}

export interface AgentProcessSessions {
  start(input: {
    ownerSessionId: string;
    command: string;
    cwd: string;
    timeoutMs?: number;
    waitMs?: number;
  }): Promise<AgentProcessReadResult>;
  read(input: {
    ownerSessionId: string;
    processId: string;
    cursor?: number;
    maxChars?: number;
    waitMs?: number;
  }): Promise<AgentProcessReadResult>;
  write(input: {
    ownerSessionId: string;
    processId: string;
    input: string;
    appendNewline?: boolean;
    cursor?: number;
    maxChars?: number;
    waitMs?: number;
  }): Promise<AgentProcessReadResult>;
  stop(input: {
    ownerSessionId: string;
    processId: string;
    cursor?: number;
    maxChars?: number;
  }): Promise<AgentProcessReadResult>;
  list(ownerSessionId: string): AgentProcessListItem[];
  /** The owning conversation is gone: stop its running processes and forget
   *  all of its entries (otherwise running ones keep going until their own
   *  timeout, and finished ones stay listed until pruneCompleted evicts them). */
  disposeOwner(ownerSessionId: string): void;
}

export function createAgentProcessSessions(): AgentProcessSessions {
  const sessions = new Map<string, ProcessSession>();

  const requireOwned = (ownerSessionId: string, processId: string): ProcessSession => {
    const session = sessions.get(processId);
    if (!session) throw new Error(`没有这个进程会话:${processId}`);
    if (session.ownerSessionId !== ownerSessionId) {
      throw new Error(`进程会话 ${processId} 不属于当前对话`);
    }
    return session;
  };

  const notify = (session: ProcessSession): void => {
    for (const wake of [...session.waiters]) wake();
  };

  const append = (session: ProcessSession, text: string): void => {
    if (!text) return;
    session.buffer += text;
    session.endCursor += text.length;
    if (session.buffer.length > MAX_PROCESS_BUFFER_CHARS) {
      const drop = session.buffer.length - MAX_PROCESS_BUFFER_CHARS;
      session.buffer = session.buffer.slice(drop);
      session.baseCursor += drop;
    }
    notify(session);
  };

  const finalize = (
    session: ProcessSession,
    fallbackStatus: ProcessStatus,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (session.status !== "running") return;
    clearTimeout(session.timeout);
    session.status = session.forcedStatus ?? fallbackStatus;
    session.exitCode = exitCode;
    session.signal = signal;
    append(
      session,
      `\n[process ${session.status}: exit=${exitCode ?? "null"}${signal ? ` signal=${signal}` : ""}]\n`,
    );
    notify(session);
  };

  const terminate = (session: ProcessSession): void => {
    if (session.status !== "running") return;
    const pid = session.child.pid;
    if (process.platform === "win32" && pid) {
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        const fallbackKill = (): void => {
          if (session.status !== "running") return;
          try {
            session.child.kill("SIGTERM");
          } catch {
            // The child may already be gone.
          }
        };
        killer.once("error", fallbackKill);
        killer.once("close", (code) => {
          if (code && code !== 0) fallbackKill();
        });
        killer.unref();
        return;
      } catch {
        // Fall through to ChildProcess.kill below.
      }
    }
    try {
      session.child.kill("SIGTERM");
    } catch {
      // close/error will settle it if the process already disappeared.
    }
  };

  /**
   * 等到"有新东西可回报"为止。四种情况任一即醒:
   *
   *   1. `waitMs` 到期 —— 静默期的上限(长任务在憋,不能永远不返回);
   *   2. **首段输出到了、又静了一小会儿** —— 见 {@link SETTLE_MS}。这是"别让模型干等"
   *      那条:长任务吐了几行重要日志之后往往还要憋很久,等满 55 秒才交出去太亏;
   *   3. **攒够了一次能返回的量**(`maxChars`)—— 再多也塞不下,再等只是白占时间;
   *   4. **进程结束** —— `finalize` 会 `notify`,短任务一次调用就拿到全部结果。
   *
   * ## 为什么要有第 2 条(2026-09-24,用户报的)
   *
   * 原先只有 1/3/4:有输出也得**攒满 2 万字符**才返回。于是"跑一个长任务,它每隔一会
   * 吐一行进度"这种最常见的形状,反而每次都要等满 55 秒 —— 明明有东西可看。
   * 现在改成:**拿到第一段输出后,再等 `SETTLE_MS` 让它把这一波吐完**(日志常常一次
   * 吐好几行),然后就交出去。没有输出时才继续按 `waitMs` 长等。
   *
   * 唤醒本身一直是事件驱动的(`waiters` + `notify`),这里改的只是**什么时候该醒**。
   */
  const waitForOutput = async (
    session: ProcessSession,
    cursor: number,
    waitMs: number,
    maxChars: number,
  ): Promise<void> => {
    if (waitMs <= 0 || session.status !== "running" || session.endCursor > cursor) return;
    const target = cursor + maxChars;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      /** 首段输出到手后的"合流"计时器 —— 一次性,用完即弃。 */
      let settleTimer: NodeJS.Timeout | null = null;
      const done = (): void => {
        clearTimeout(timer);
        if (settleTimer) clearTimeout(settleTimer);
        session.waiters.delete(wake);
        resolve();
      };
      const wake = (): void => {
        // (4) 进程结束 —— 立刻回,这是最该马上告诉模型的事。
        if (session.status !== "running") {
          done();
          return;
        }
        // (3) 攒够一次能返回的量 —— 不用再等。
        if (session.endCursor >= target) {
          done();
          return;
        }
        // (2) **确实有未读输出**了,但还没攒满:给它 `SETTLE_MS` 把这一波吐完再回。
        //
        // ⚠️ 必须判 `endCursor > cursor` —— `wake()` 在注册时会被调一次(自查),
        // 那时**可能根本没有新输出**,不判的话会白挂一个 300ms 定时器,于是"静默期
        // 该长等 55 秒"被它改成 300ms 就返回(这是第一版真踩到的坑)。
        // 只挂一次:后续再有输出不推迟它,否则持续输出会让返回时间无限后延。
        if (settleTimer === null && session.endCursor > cursor) {
          settleTimer = setTimeout(done, SETTLE_MS);
        }
      };
      timer = setTimeout(done, Math.min(waitMs, MAX_PROCESS_WAIT_MS));
      session.waiters.add(wake);
      // 注册后立刻自查一次:上次判定与 add 之间可能已经有产出/退出,漏了要等到期。
      wake();
    });
  };

  const waitForExit = async (session: ProcessSession, waitMs: number): Promise<void> => {
    if (session.status !== "running") return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const done = (): void => {
        clearTimeout(timer);
        session.waiters.delete(wake);
        resolve();
      };
      const wake = (): void => {
        if (session.status !== "running") done();
      };
      timer = setTimeout(done, waitMs);
      session.waiters.add(wake);
    });
  };

  const pruneCompleted = (): void => {
    if (sessions.size < 64) return;
    const completed = [...sessions.values()]
      .filter((session) => session.status !== "running")
      .sort((a, b) => a.startedAt - b.startedAt);
    while (sessions.size >= 64 && completed.length > 0) {
      const stale = completed.shift();
      if (stale) sessions.delete(stale.id);
    }
  };

  const snapshot = (
    session: ProcessSession,
    cursorInput: number | undefined,
    maxCharsInput: number | undefined,
  ): AgentProcessReadResult => {
    const requestedCursor = Math.max(0, Math.floor(cursorInput ?? session.baseCursor));
    const effectiveCursor = Math.min(
      Math.max(requestedCursor, session.baseCursor),
      session.endCursor,
    );
    const maxChars = Math.max(1, Math.min(Math.floor(maxCharsInput ?? DEFAULT_READ_CHARS), MAX_READ_CHARS));
    const relative = effectiveCursor - session.baseCursor;
    const output = session.buffer.slice(relative, relative + maxChars);
    const nextCursor = effectiveCursor + output.length;
    return {
      processId: session.id,
      status: session.status,
      command: session.command,
      cwd: session.cwd,
      output,
      requestedCursor,
      nextCursor,
      bufferStartCursor: session.baseCursor,
      skippedChars: Math.max(0, session.baseCursor - requestedCursor),
      hasMore: nextCursor < session.endCursor,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  };

  return {
    async start(input) {
      pruneCompleted();
      const running = [...sessions.values()].filter(
        (s) => s.ownerSessionId === input.ownerSessionId && s.status === "running",
      ).length;
      if (running >= MAX_RUNNING_PER_OWNER) {
        throw new Error(`当前对话已有 ${MAX_RUNNING_PER_OWNER} 个运行中的进程,请先停止不用的会话`);
      }

      const timeoutMs = Math.max(
        1_000,
        Math.min(Math.floor(input.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS), MAX_PROCESS_TIMEOUT_MS),
      );
      const child = spawn(input.command, {
        shell: true,
        cwd: input.cwd,
        windowsHide: true,
        env: { ...process.env },
      });
      const id = `proc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const session: ProcessSession = {
        id,
        ownerSessionId: input.ownerSessionId,
        command: input.command,
        cwd: input.cwd,
        child,
        startedAt: Date.now(),
        status: "running",
        forcedStatus: null,
        exitCode: null,
        signal: null,
        buffer: "",
        baseCursor: 0,
        endCursor: 0,
        timeout: setTimeout(() => undefined, 0),
        waiters: new Set(),
        stdoutDecoder: newDecoder(),
        stderrDecoder: newDecoder(),
      };
      clearTimeout(session.timeout);
      sessions.set(id, session);

      child.stdout?.on("data", (chunk: Buffer | string) =>
        append(session, session.stdoutDecoder.write(toBuf(chunk))),
      );
      child.stderr?.on("data", (chunk: Buffer | string) =>
        append(session, `[stderr] ${session.stderrDecoder.write(toBuf(chunk))}`),
      );
      child.on("error", (err) => {
        append(session, `\n[process error] ${err.message}\n`);
        finalize(session, "failed", null, null);
      });
      child.on("close", (code, signal) => finalize(session, "exited", code, signal));
      session.timeout = setTimeout(() => {
        if (session.status !== "running") return;
        session.forcedStatus = "timed_out";
        append(session, `\n[process timeout after ${timeoutMs}ms; terminating]\n`);
        terminate(session);
      }, timeoutMs);

      const cursor = 0;
      await waitForOutput(session, cursor, input.waitMs ?? 250, DEFAULT_READ_CHARS);
      return snapshot(session, cursor, undefined);
    },

    async read(input) {
      const session = requireOwned(input.ownerSessionId, input.processId);
      const cursor = input.cursor ?? session.baseCursor;
      // 默认等到"有输出 / 进程结束 / 攒满一次可返回量"——见 MAX_PROCESS_WAIT_MS。
      // 早先默认 0(立刻返回),那是空轮询的直接来源。
      await waitForOutput(session, cursor, input.waitMs ?? MAX_PROCESS_WAIT_MS, input.maxChars ?? DEFAULT_READ_CHARS);
      return snapshot(session, cursor, input.maxChars);
    },

    async write(input) {
      const session = requireOwned(input.ownerSessionId, input.processId);
      if (session.status !== "running") {
        throw new Error(`进程 ${session.id} 已经是 ${session.status},不能再写 stdin`);
      }
      if (!session.child.stdin || session.child.stdin.destroyed) {
        throw new Error(`进程 ${session.id} 的 stdin 已关闭`);
      }
      const cursor = input.cursor ?? session.endCursor;
      const payload = input.appendNewline === false ? input.input : `${input.input}\n`;
      await new Promise<void>((resolve, reject) => {
        session.child.stdin!.write(payload, (err) => (err ? reject(err) : resolve()));
      });
      await waitForOutput(session, cursor, input.waitMs ?? 250, input.maxChars ?? DEFAULT_READ_CHARS);
      return snapshot(session, cursor, input.maxChars);
    },

    async stop(input) {
      const session = requireOwned(input.ownerSessionId, input.processId);
      const cursor = input.cursor ?? session.endCursor;
      if (session.status === "running") {
        session.forcedStatus = "stopped";
        append(session, "\n[process stop requested]\n");
        terminate(session);
        await waitForExit(session, 1_000);
      }
      return snapshot(session, cursor, input.maxChars);
    },

    list(ownerSessionId) {
      return [...sessions.values()]
        .filter((session) => session.ownerSessionId === ownerSessionId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((session) => ({
          processId: session.id,
          status: session.status,
          command: session.command,
          cwd: session.cwd,
          startedAt: session.startedAt,
          endCursor: session.endCursor,
        }));
    },

    disposeOwner(ownerSessionId) {
      for (const session of [...sessions.values()]) {
        if (session.ownerSessionId !== ownerSessionId) continue;
        if (session.status === "running") {
          session.forcedStatus = "stopped";
          terminate(session);
        }
        // Wake any in-flight read/write wait so it returns instead of idling
        // out its waitMs against a conversation that no longer exists.
        notify(session);
        sessions.delete(session.id);
      }
    },
  };
}