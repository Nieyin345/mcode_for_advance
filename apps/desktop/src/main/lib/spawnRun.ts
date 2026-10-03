/**
 * **起一个进程、收它的输出、把生命周期管干净** —— 命令节点与代码节点共用这一层。
 *
 * ## 为什么要有这一层
 *
 * 在这之前,「起进程」这件事在仓库里有 38 处各写各的。其中**编排层的两个节点执行器**
 * (`commandRunner` / `codeRunner`)几乎是照着对方抄的,而抄着抄着就分了岔:
 *
 * | | commandRunner | codeRunner |
 * |---|---|---|
 * | 非零退出码 | 不算失败(直跑语义) | 算失败 |
 * | 超时之后 | 先 TERM 再补 SIGKILL | 只 TERM |
 * | 输出上限 | `COMMAND_OUTPUT_TAIL_CHARS` | 另一个常量 `16_000` |
 * | 编码 | 裸 `toString("utf-8")` | 裸 `toString("utf8")` |
 *
 * 前三行是**刻意的语义差异**,该留;第四行是**同一个坑踩了两遍** —— Windows 上
 * `cmd.exe` 打的是控制台代码页(中文机器 GBK),按 UTF-8 硬解会把用户唯一能得到的
 * 线索变成一串 U+FFFD。`lib/outBuf.ts` 早就把这件事解对了,但那两份都没用它。
 *
 * 所以这一层收口的是**机制**(起进程、杀进程树、超时、取消、按字节收、统一解码),
 * 把**语义**(退出码算不算失败、产出怎么拼)留给调用方。两种退出码规矩都能在这层
 * 之上表达,而编码与杀树只有一种正确写法。
 *
 * ## 逐行回调与编码判断的关系(这一层的核心难点)
 *
 * 协议行(`@@mcode:progress` / `@@mcode:result`)要**即时**处理 —— 它是进展上报,
 * 攒到进程结束就没意义了。但"按块解码"恰恰会踩坏中文:一个多字节字符可能跨在两个
 * chunk 之间,拆开解就是两个替换字符。
 *
 * 解法是**按字节找换行**:`0x0A` 在 UTF-8 与 GBK 里都不会出现在多字节字符内部
 * (两者对 ASCII 都是兼容的),所以按它切出来的每一段都是**完整的行**,再对整行调用
 * `decodeOutput` 就既及时又不会切坏字符。行尾那个 `\n` 去掉,由调用方决定要不要补。
 *
 * ## 窗口只留尾部,而且是**字节**窗口
 *
 * 长任务日志几万行,全留着是拿内存换一条没人看的内容,而错误栈与结果都在尾部。
 * 截断的判据必须是字节数:要能在推入时**不看内容**就算出来(见 `OutBuf`)。
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { OutBuf, decodeOutput } from "@main/lib/outBuf.js";

/** `node:child_process` 的 `spawn` 的形状 —— 留一个缝,冒烟脚本能塞假的进来。 */
export type SpawnFn = typeof nodeSpawn;

/**
 * `exit` 之后最多再等多少毫秒让 stdio 排空。
 *
 * 正常进程的管道排空是几毫秒的事,这个值只管"孙进程占着管道不放"那种情况 ——
 * 那时我们会带着已经读到的部分往下走,而不是干等一个永远不来的 `close`。
 */
const DRAIN_MS = 300;

/** 这次进程是怎么没的。三样都可能为假 —— 那就是正常跑完的。 */
export interface KillCause {
  timeout: boolean;
  abort: boolean;
}

export interface SpawnRunOptions {
  /** 要跑的命令。`shell` 为假时它是可执行文件路径。 */
  command: string;
  /** 参数数组。**只在 `shell` 为假时用** —— shell 那条路把整条命令当一个字符串。 */
  args?: string[];
  /** true = 走 shell(用户填的命令是给人写的:`python train.py`)。 */
  shell?: boolean;
  cwd?: string;
  /**
   * 环境变量。**给的就是完整的一份**(调用方自己合并 `process.env`)—— 这一层不做
   * "在继承的基础上加几个"的猜测,因为"该不该继承"恰恰是调用方的语义:钩子要继承
   * (命令是一般的 shell 命令),而将来某个沙箱化的执行器可能恰恰要不继承。
   */
  env?: NodeJS.ProcessEnv;
  /**
   * 往 stdin 写一段文本然后关掉。`undefined` = 不写,并且**把 stdin 接到 `ignore`**
   * (不接管道的话,某些程序会一直等着一个永远不来的输入)。
   */
  stdin?: string;
  /** 毫秒。**0 = 不限** —— 长跑的训练脚本不该被一个默认值杀掉。 */
  timeoutMs: number;
  signal: AbortSignal;
  /** 每条流最多留多少字节。超了从**头**丢(尾部是错误栈和结果)。 */
  limitBytes: number;
  /**
   * stdout 的每一行(**不含换行符**)。返回 `true` = 这一行被消费掉了(协议行),
   * 不进输出缓冲;返回 `false` = 照常并进去。
   *
   * 行是按**字节**切出来再解码的,所以中文不会因为跨 chunk 而碎掉(见文件头)。
   */
  onStdoutLine?: (line: string) => boolean;
  /** stderr 的每一行,语义同 {@link SpawnRunOptions.onStdoutLine}。 */
  onStderrLine?: (line: string) => boolean;
  /** Optional streaming observation (e.g. Git uses CR, not newline, progress). */
  /** Bounded raw capture for CR-only streams; bypasses line hooks. Opt-in only. */
  rawOutput?: boolean;
  onStdoutChunk?: (chunk: Buffer) => void;
  onStderrChunk?: (chunk: Buffer) => void;
  /**
   * **把两条流并进同一个缓冲。** 默认分开。
   *
   * 命令节点要合并(它只有一段"输出尾部"交给下游,不分 stdout/stderr);代码节点要
   * 分开(它把 `stdout` 与 `stderr` 都写进产出变量,是两个不同的键)。这是调用方的
   * 语义,不是这一层的 —— 所以做成开关而不是替它们选一个。
   */
  mergeStreams?: boolean;
  /** 只给冒烟测试用:塞一个假的 spawn,不真起进程。 */
  spawn?: SpawnFn;
}

export interface SpawnRunResult {
  /** 退出码。`null` = 没拿到(被信号终止,或者压根没起来)。 */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** 哪条流被截过(尾部之外的东西丢了)。调用方可以据此在文案里说明。 */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** `spawn` 抛了、或者 `error` 事件报了(ENOENT 那一类)。 */
  spawnError?: Error;
  killedBy: KillCause;
}

/**
 * **杀掉整个进程树。**
 *
 * `shell: true` 起的是 shell,shell 死了它带的孙进程**不一定死** —— 用户按了停止
 * 之后训练还在偷偷跑,是这类功能最招恨的翻车方式。
 *
 * Windows 上没有信号,`child.kill()` 只终结那一个 pid,所以走 `taskkill /T`(连子树)
 * `/F`(强制)。其余平台先 TERM 给个收尾的机会,2 秒后还在就 KILL。
 *
 * **三个执行器原先各写了一遍**,完备程度还不同(`hooks/runCommand.ts` 那份有
 * try/catch 兜底、另外两份没有)。这里取最完备的那一份收口。
 */
/**
 * 起进程时展开进 spawn 选项,让 {@link killTree} 在类 Unix 上**真能杀到整棵树**。
 *
 * 类 Unix 上 `child.kill()` 只给那一个 pid 发信号。`shell: true` 时那个 pid 是
 * `/bin/sh`,它起的真正命令(管道、`&&`、dash 不 exec 的简单命令)**收不到**,于是
 * shell 死了命令还在跑 —— 还攥着 stdout 管道,`close` 永远不来,状态卡在"运行中"。
 * `detached: true` 让子进程自成一个进程组(pgid = pid),`killTree` 按组发信号。
 * (Linux CI 上 hooks-smoke「超时的进程真的被杀了」与 maint-m14「stop 后是
 * stopped」就是这么红的;macOS 同理,只是 Windows 上的冒烟看不见。)
 *
 * ⚠️ **Windows 上绝不能给**:那里 `detached` 的意思是"开一个新控制台窗口";
 * 而 `taskkill /T` 本来就连子树。
 */
export const TREE_KILLABLE: { detached?: true } = process.platform === "win32" ? {} : { detached: true };

export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    try {
      child.kill();
    } catch {
      /* 已经没了 */
    }
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      // /T = 连整棵树,/F = 强制。taskkill 找不到进程(已经退了)不算错。
      nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
    }
    return;
  }
  // 先按**进程组**发(`-pid`,见 `TREE_KILLABLE`);子进程不是组长(调用方没带
  // `TREE_KILLABLE`)时那个组不存在 → ESRCH,退回只杀它自己 —— 与从前一样。
  const signalTree = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      /* 不是组长 / 组已经空了 */
    }
    try {
      child.kill(sig);
    } catch {
      /* 已经没了 */
    }
  };
  signalTree("SIGTERM");
  setTimeout(() => {
    // shell 先走了、孙进程还在,也算"还没杀干净":看组里还有没有人。
    let alive = child.exitCode === null && child.signalCode === null;
    if (!alive) {
      try {
        process.kill(-pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) signalTree("SIGKILL");
  }, 2_000).unref();
}

/**
 * 按字节切行 —— 攒着的残行 + 新来的一块字节 → (完整行列表, 新的残行)。
 *
 * **判据是 `0x0A` 这个字节**,不是"解码后再找换行"。UTF-8 与 GBK 对 ASCII 都兼容,
 * 所以 `0x0A` 不可能出现在任何一个多字节字符的内部;按它切出来的每一段都是完整的行,
 * 单独拿去解码不会切坏字符。这就是"既能逐行即时处理、又不会把中文解成两半"的解法。
 *
 * 返回值里的行**不含换行符** —— 补不补由调用方决定。
 */
function splitLines(pending: Buffer, chunk: Buffer): { lines: Buffer[]; rest: Buffer } {
  const buf = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0x0a) continue;
    // 行尾可能是 `\r\n`(Windows)—— 去掉那个 `\r`,它是行终止符的一部分。
    const end = i > start && buf[i - 1] === 0x0d ? i - 1 : i;
    lines.push(buf.subarray(start, end));
    start = i + 1;
  }
  return { lines, rest: start === 0 ? buf : buf.subarray(start) };
}

/**
 * 起一个进程,等它退出。**这个 promise 一定 settle**:退出、超时、中止,三条路都通。
 *
 * 调用方拿到的是一份**已经解码好的**结果(编码判定见 `decodeOutput`)与一组
 * "它是怎么没的"的标记;把那些标记翻译成什么状态(失败 / 取消)是调用方的事 ——
 * 两个节点执行器眼下翻译得一样,但将来未必。
 */
export async function spawnRun(options: SpawnRunOptions): Promise<SpawnRunResult> {
  const {
    command, args, shell = false, cwd, env, stdin,
    timeoutMs, signal, limitBytes, mergeStreams = false,
  } = options;
  const spawn = options.spawn ?? nodeSpawn;

  const killedBy: KillCause = { timeout: false, abort: false };
  const empty = (extra: Partial<SpawnRunResult>): SpawnRunResult => ({
    code: null, signal: null, stdout: "", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, killedBy, ...extra,
  });

  let child: ChildProcess;
  try {
    child = spawn(
      command,
      args !== undefined && !shell ? args : [],
      {
        ...(shell ? { shell: true } : {}),
        ...TREE_KILLABLE,
        windowsHide: true,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(env !== undefined ? { env } : {}),
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    // `shell: true` 时 spawn 几乎不抛(错误走 error 事件),这一拦兜的是后一种。
    return empty({ spawnError: err instanceof Error ? err : new Error(String(err)) });
  }

  let spawnError: Error | undefined;
  child.on("error", (err: Error) => {
    spawnError = err;
  });

  const out = new OutBuf(limitBytes);
  const err = new OutBuf(limitBytes);
  let outRest: Buffer = Buffer.alloc(0);
  let errRest: Buffer = Buffer.alloc(0);

  /** 一行解码好的内容交给 hook;hook 说"没消费"才并进缓冲。
   *
   * `withNewline` = 这一行原本以换行结束。**补回去是为了让并进缓冲的文本保持原来
   * 的换行结构**（两处调用方拿到的 `stdout` 都是给人看的、也可能被写进产出变量,
   * 行与行之间不能粘成一坨）。末尾那段**没有换行结尾**的残行不补 —— 补了就凭空
   * 多一个字符,而"只留尾部 N 个字符"是精确断言过的语义(见 command-runner-smoke
   * 的「尾部不多不少就是上限」)。 */
  const feed = (
    lineBuf: Buffer,
    hook: ((line: string) => boolean) | undefined,
    sink: OutBuf,
    withNewline: boolean,
  ): void => {
    const line = decodeOutput(lineBuf);
    if (hook?.(line) === true) return;
    sink.push(Buffer.from(withNewline ? line + "\n" : line, "utf-8"));
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    options.onStdoutChunk?.(chunk);
    if (options.rawOutput) { out.push(chunk); return; }
    const { lines, rest } = splitLines(outRest, chunk);
    outRest = rest;
    for (const line of lines) feed(line, options.onStdoutLine, out, true);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    options.onStderrChunk?.(chunk);
    if (options.rawOutput) { (mergeStreams ? out : err).push(chunk); return; }
    const { lines, rest } = splitLines(errRest, chunk);
    errRest = rest;
    if (mergeStreams) {
      // 合并模式:stderr 也并进**同一个**缓冲 —— 命令节点只有一段"输出尾部",
      // 它不分来源。行仍然逐行过 hook,所以协议行在任一线上都能被认出来。
      for (const line of lines) feed(line, options.onStderrLine ?? options.onStdoutLine, out, true);
      return;
    }
    for (const line of lines) feed(line, options.onStderrLine, err, true);
  });

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

  if (stdin !== undefined && child.stdin) {
    try {
      child.stdin.end(stdin);
    } catch {
      // 写不进去(进程已经退了)—— 不是错误,继续等它退出。
    }
  }

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, sig) => resolve({ code, signal: sig }));
      // `error` 之后不会再有 `exit`(进程压根没起来)—— 不接这一下会永远挂着。
      child.once("error", () => resolve({ code: null, signal: null }));
    },
  );

  if (timer !== undefined) clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);

  // **等 stdio 排空,但只等一小会儿。**
  //
  // `exit` 在**进程结束**那一刻就触发,而那时管道里的数据**可能还没读完** ——
  // 实测:一个吐了输出就退出的进程,`exit` 时手上是空的,要到下一个 tick 才收得到。
  // 直接在 `exit` 就读,会**丢掉尾部输出**,而尾部正是错误栈和结果所在。
  //
  // 那为什么不干脆等 `close`(`close` = 所有 stdio 都关了)?因为**孙进程会挂住它**:
  // 一个起后台进程的脚本,那个孙进程继承着 stdout 不放,`close` 就永远不来 ——
  // 钩子会卡在那儿直到超时。实测确认过这一点。
  //
  // 所以两个都要:优先等 `close`(数据完整),拿 `drainMs` 兜底(不会挂)。
  // 正常进程的管道排空是几毫秒的事,300ms 足够;真碰到孙进程占着管道,300ms 之后
  // 我们拿着已经读到的部分往下走,而不是干等。
  if (child.exitCode !== null || child.signalCode !== null) {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        resolve();
      };
      const guard = setTimeout(finish, DRAIN_MS);
      child.once("close", finish);
    });
  }

  // 残行(没有以换行结尾的最后一段)也要交出去 —— 一个只写了一句不带换行的脚本,
  // 输出全在这一段里。**不补换行**(它本来就没有)。
  if (outRest.length > 0) feed(outRest, options.onStdoutLine, out, false);
  if (errRest.length > 0 && !mergeStreams) feed(errRest, options.onStderrLine, err, false);

  return {
    code: exit.code,
    signal: exit.signal,
    stdout: out.text(),
    stderr: mergeStreams ? "" : err.text(),
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    ...(spawnError !== undefined ? { spawnError } : {}),
    killedBy,
  };
}
