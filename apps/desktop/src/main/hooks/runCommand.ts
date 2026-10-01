/**
 * 跑**一条**钩子命令 —— 起进程、喂载荷、收输出、超时收尸。
 *
 * ## 为什么单独一个文件
 *
 * 它是整个钩子能力里唯一会**真起进程**的地方,也是唯一一处写错了会让用户的机器上留下
 * 僵尸进程、或者让一次对话永远卡住的地方。所以它被刻意做成**不依赖主进程任何东西**的
 * 模块:只 import node 内建 + `@contracts/hook` + `lib/outBuf`(那也是一份纯 node 的
 * 模块)。这样它才能被无头脚本直接喂真实命令跑一遍(见 `scripts/hooks-smoke`),而不是
 * 只能靠手点。
 *
 * 「什么时候跑」在 `HookRunner` 里;这里只管「怎么跑一次」。
 *
 * ## 起进程的机制在 `lib/spawnRun`
 *
 * 原先这里自己写了一份 `spawn` + `killTree` + 字节缓冲 —— 与命令节点、代码节点各写
 * 一遍,三份的完备程度还不一样(这份的 `killTree` 有 try/catch 兜底,另外两份没有)。
 * 现在机制收口在 `lib/spawnRun`,这里只保留**钩子特有的语义**:
 *
 *  - 超时要报 `timeout` 这个**独立状态**(不是 failed)—— 钩子的调用方分得清
 *    "它跑挂了"和"它跑太久被我们中止了";
 *  - 输出被截断要**在文本里写明**(见 {@link markTail})—— 钩子的输出是给人看的,
 *    多出来的一句说明比一个布尔标记有用;
 *  - `cwd` **可能已经不存在了**(工作树被删掉、项目被移除),那种情况要让命令在宿主
 *    当前目录里跑,而不是起不来。
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_ENV,
  HOOK_OUTPUT_LIMIT,
  type HookPayload,
  type HookRun,
  type HookSpec,
} from "@contracts/hook";
import { decodeOutput } from "@main/lib/outBuf.js";
import { killTree, spawnRun } from "@main/lib/spawnRun.js";

// `decodeOutput` 从这一层**照旧导出**:`hooks-smoke` 直接喂字节给它验编码判定,
// 那条路不该因为搬家而断。`killTree` 同理(它现在住在 `lib/spawnRun`)。
export { decodeOutput, killTree };

/**
 * 跑一次。**永不 reject** —— 所有失败(命令不存在、超时、非零退出)都变成返回的一条
 * 记录。调用方是事件流上的一个回调,它没有地方接异常。
 */
export async function runHookCommand(spec: HookSpec, payload: HookPayload): Promise<Partial<HookRun>> {
  const timeout = spec.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

  const run = await spawnRun({
    command: spec.command,
    // `shell: true`:钩子写的就是 shell 命令(`python x.py --flag`、管道都该能用)。
    shell: true,
    // 工作目录**可能已经不在那儿了**(工作树被删掉、项目被移除)。给一个不存在的
    // cwd 会让 spawn 直接失败,而那和"命令自己写错了"是两件事 —— 所以先探一下,
    // 不在了就退到用户主目录里跑(见下)。
    //
    // ⚠️ 探的是**目录**不是"存在"(`isDirectory`):一个**文件**也能通过 `existsSync`,
    // 于是它会被原样交给 spawn,而报错是 `ENOENT`。那句话指着 cmd.exe 说"找不到",
    // 用户去看自己写的命令,怎么看都是对的 —— 一个把排查方向带偏的错。
    //
    // 退路是**用户主目录**而不是继承宿主进程的 cwd:打包后的应用里那是 `/`(macOS
    // 从访达启动)或安装目录 —— 前者什么都写不了,后者会把钩子的产物撒进安装目录。
    cwd: isDirectory(payload.cwd) ? payload.cwd : homedir(),
    env: { ...process.env, ...envOf(payload) },
    // 载荷走 stdin。命令没读 stdin 也不会卡住(写完就 end)。
    stdin: JSON.stringify(payload, null, 2),
    timeoutMs: timeout,
    // 钩子没有取消通道 —— 没有 signal 可听,所以给一个**永不会响**的。
    signal: new AbortController().signal,
    limitBytes: HOOK_OUTPUT_LIMIT,
  });

  const stdout = run.stdout;
  const stderr = run.stderr;
  // 输出一起走:三条路都带上,超时那条也要(见下面那段注释)。
  const output: Partial<HookRun> = {
    ...(stdout.length > 0 ? { stdout: markTail(stdout, run.stdoutTruncated) } : {}),
    ...(stderr.length > 0 ? { stderr: markTail(stderr, run.stderrTruncated) } : {}),
  };

  if (run.spawnError !== undefined) {
    return { status: "failed", ...output, error: `起不来:${run.spawnError.message}` };
  }
  if (run.killedBy.timeout) {
    // ⚠️ **超时也要带上已经收到的输出。** 它是用户回答"我的钩子为什么卡住"的唯一线索:
    // 一个跑到一半挂住的脚本,卡住之前那几行(下到第几个文件、正在等哪个接口)正是现场,
    // 而底层(`lib/spawnRun`)是收着的 —— 早先这里把它丢掉,设置页上就只剩一句"超过
    // N ms 被中止",一个字的现场都没有。
    return {
      status: "timeout",
      ...(run.code !== null ? { exitCode: run.code } : {}),
      ...output,
      error: `超过 ${timeout}ms 被中止`,
    };
  }
  return {
    status: run.code === 0 ? "ok" : "failed",
    ...(run.code !== null ? { exitCode: run.code } : {}),
    ...(run.code === 0 ? {} : { error: `退出码 ${run.code ?? "未知"}` }),
    ...output,
  };
}

/** 这个路径存在**而且是个目录**吗。`spawn` 的 `cwd` 只接受目录,别的都给 `ENOENT`。 */
function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 命令拿到的环境变量。`data` 那种大块东西走 stdin,不塞进环境(有大小上限)。 */
export function envOf(payload: HookPayload): Record<string, string> {
  return {
    [HOOK_ENV.event]: payload.event,
    [HOOK_ENV.sessionId]: payload.session.id,
    [HOOK_ENV.sessionKind]: payload.session.kind,
    [HOOK_ENV.cwd]: payload.cwd,
    ...(payload.toolName !== undefined ? { [HOOK_ENV.toolName]: payload.toolName } : {}),
  };
}

/** 输出被截断过就加一句说明 —— 否则用户会以为命令只打印了这么多。 */
export function markTail(text: string, truncated: boolean): string {
  return truncated ? `…(输出超过 ${HOOK_OUTPUT_LIMIT} 字节,只留了结尾)\n${text}` : text;
}