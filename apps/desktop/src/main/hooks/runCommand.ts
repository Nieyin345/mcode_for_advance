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
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_ENV,
  HOOK_OUTPUT_LIMIT,
  type HookPayload,
  type HookRun,
  type HookSpec,
} from "@contracts/hook";
import { OutBuf, decodeOutput } from "@main/lib/outBuf.js";

// 输出的字节缓冲与编码判定在 `lib/outBuf`(命令节点共用同一份 —— 那边原先按块解码,
// 中文输出会乱码)。`decodeOutput` 从这一层**照旧导出**:`hooks-smoke` 直接喂字节给它
// 验编码判定,那条路不该因为搬了家而断。
export { decodeOutput };

/**
 * 跑一次。**永不 reject** —— 所有失败(命令不存在、超时、非零退出)都变成返回的一条
 * 记录。调用方是事件流上的一个回调,它没有地方接异常。
 */
export function runHookCommand(spec: HookSpec, payload: HookPayload): Promise<Partial<HookRun>> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(spec.command, {
        // `shell: true`:钩子写的就是 shell 命令(`python x.py --flag`、管道都该能用)。
        shell: true,
        // 工作目录**可能已经不存在了**(工作树被删掉、项目被移除)。给一个不存在的
        // cwd 会让 spawn 直接失败,而那和"命令自己写错了"是两件事 —— 所以先探一下,
        // 不在了就让命令在宿主当前的目录里跑。
        ...(existsSync(payload.cwd) ? { cwd: payload.cwd } : {}),
        env: { ...process.env, ...envOf(payload) },
        stdio: ["pipe", "pipe", "pipe"],
        // Windows 上不加这个会闪一个黑框。
        windowsHide: true,
      });
    } catch (err) {
      resolve({ status: "failed", error: `起不来:${(err as Error).message}` });
      return;
    }

    const timeout = spec.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    let timedOut = false;
    let settled = false;
    // 收的是**原始字节**,到结束时才解码 —— 理由见 `decodeOutput`(Windows 上命令的输出
    // 未必是 UTF-8,得看过一整段才能判断)。
    const out = new OutBuf(HOOK_OUTPUT_LIMIT);
    const err = new OutBuf(HOOK_OUTPUT_LIMIT);

    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);

    const finish = (patch: Partial<HookRun>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = out.text();
      const stderr = err.text();
      resolve({
        ...patch,
        ...(stdout.length > 0 ? { stdout: markTail(stdout, out.truncated) } : {}),
        ...(stderr.length > 0 ? { stderr: markTail(stderr, err.truncated) } : {}),
      });
    };

    child.on("error", (err) => {
      finish({ status: "failed", error: `跑不起来:${err.message}` });
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({ status: "timeout", exitCode: code ?? undefined, error: `超过 ${timeout}ms 被中止` });
        return;
      }
      finish({
        status: code === 0 ? "ok" : "failed",
        ...(code !== null ? { exitCode: code } : {}),
        ...(code === 0 ? {} : { error: `退出码 ${code ?? "未知"}` }),
      });
    });

    // 载荷走 stdin。命令没读 stdin 也不会卡住(写完就 end)。
    try {
      child.stdin?.on("error", () => {}); // 命令不读 stdin 时写会报 EPIPE,不算错
      child.stdin?.end(JSON.stringify(payload, null, 2));
    } catch {
      /* 写不进去就算了 —— 环境变量那条路还在 */
    }
  });
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

/** 超时了要把**整棵进程树**收掉:shell:true 意味着我们手上的那个进程是 shell,真正
 *  的脚本是它的子进程 —— 只杀 shell 会把脚本留在后台继续跑。 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    // Windows 上没有信号,`child.kill()` 只终结那一个 pid。`/T` 连子树。
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      child.kill();
    }
    return;
  }
  child.kill("SIGKILL");
}

/** 输出被截断过就加一句说明 —— 否则用户会以为命令只打印了这么多。 */
export function markTail(text: string, truncated: boolean): string {
  return truncated ? `…(输出超过 ${HOOK_OUTPUT_LIMIT} 字节,只留了结尾)\n${text}` : text;
}