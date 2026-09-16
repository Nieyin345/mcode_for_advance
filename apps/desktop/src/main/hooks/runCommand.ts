/**
 * 跑**一条**钩子命令 —— 起进程、喂载荷、收输出、超时收尸。
 *
 * ## 为什么单独一个文件
 *
 * 它是整个钩子能力里唯一会**真起进程**的地方,也是唯一一处写错了会让用户的机器上留下
 * 僵尸进程、或者让一次对话永远卡住的地方。所以它被刻意做成**不依赖主进程任何东西**的
 * 模块:只 import node 内建 + `@contracts/hook`。这样它才能被无头脚本直接喂真实命令跑
 * 一遍(见 `scripts/hooks-smoke`),而不是只能靠手点。
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
    const out = new OutBuf();
    const err = new OutBuf();

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

/**
 * 一条流的**字节**滚动窗口,留最后 {@link HOOK_OUTPUT_LIMIT} 个字节。
 *
 * 为什么不攒字符串:留哪一段得按**字节**算(上限说的是字节),而按字符切会切在半个
 * 多字节字符上;更要紧的是**到结束才解码**(见 {@link decodeOutput}),所以要留住原始
 * 字节。
 *
 * ⚠️ 是**滚动窗口**,不是"攒到上限就停"。攒到上限就停看着更简单,但那样留下的是命令的
 * **开头**,而一条跑久了的命令最后几行才是结果。
 */
class OutBuf {
  private chunks: Buffer[] = [];
  private size = 0;
  /** 丢过东西。 */
  truncated = false;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    // 从**头**丢,直到装得下。`subarray` 不复制 —— 一次大输出不会因为反复拼接而翻倍。
    while (this.size > HOOK_OUTPUT_LIMIT) {
      const head = this.chunks[0];
      const over = this.size - HOOK_OUTPUT_LIMIT;
      this.truncated = true;
      if (head.length <= over) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(over);
        this.size -= over;
      }
    }
  }

  text(): string {
    if (this.size === 0) return "";
    return decodeOutput(Buffer.concat(this.chunks, this.size));
  }
}

/**
 * 去掉开头**落单的续字节**(0b10xxxxxx)。
 *
 * 窗口是从**中间**截出来的,所以开头可能正好落在某个多字节字符的中间。留着那几个续
 * 字节,严格 UTF-8 解码就会失败,于是整段被误判成"不是 UTF-8"而转去试 GBK —— 一段
 * 好端端的中文就变成了乱码。
 */
function trimLeadingOrphans(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return start === 0 ? buf : buf.subarray(start);
}

/** 砍掉结尾**一个**不完整的 UTF-8 序列(见 {@link decodeUtf8Strict} 的第二步)。 */
function trimTrailingPartialUtf8(buf: Buffer): Buffer {
  for (let back = 1; back <= 4 && back <= buf.length; back += 1) {
    const byte = buf[buf.length - back];
    if ((byte & 0xc0) === 0x80) continue; // 续字节 —— 还在序列中间,继续往回找
    const need = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return need > back ? buf.subarray(0, buf.length - back) : buf;
  }
  return buf;
}

/**
 * 严格解 UTF-8 —— **解不出来就返回 `null`,不返回乱码**。
 *
 * 用 `fatal: true`(遇到非法字节直接抛)而不是"数替换字符",是因为后者的判据太软:
 * 一个正好切在半个字符上的窗口只会产生**一个** U+FFFD,却足以让整段输出被判成"不是
 * UTF-8"。让解码器自己回答"这是不是合法的 UTF-8",边界清楚得多。
 *
 * 两步:先原样试;失败则砍掉结尾那**一个**不完整的序列(那只是窗口切在了半个字符上,
 * 不是编码不对)再试。再失败就说明真的不是 UTF-8。
 */
function decodeUtf8Strict(buf: Buffer): string | null {
  const strict = new TextDecoder("utf-8", { fatal: true });
  try {
    return strict.decode(buf);
  } catch {
    const trimmed = trimTrailingPartialUtf8(buf);
    if (trimmed.length === buf.length) return null;
    try {
      return strict.decode(trimmed);
    } catch {
      return null;
    }
  }
}

/**
 * 把一条流的字节解成文本。
 *
 * ## 为什么要猜编码
 *
 * 命令的输出**不一定是 UTF-8**。Windows 上 `cmd.exe` 自己的提示(「'xxx' 不是内部或
 * 外部命令」、`taskkill` 的结果……)用的是**控制台的代码页** —— 中文机器上是 GBK。按
 * UTF-8 硬解,那半行中文就变成一串 U+FFFD(实测踩到:一条打错的命令,整条错误提示
 * 全是乱码,而用户唯一能得到的线索正是那句话)。
 *
 * 所以:严格的 UTF-8 解得出就用它(干净、无歧义);解不出才按 GBK 再解一次,并在
 * "GBK 的结果"和"有损 UTF-8 的结果"之间挑替换字符少的那个 —— 命令前半段吐 UTF-8、
 * 后半段吐 GBK 这种混着来的情况,只能这样挑一个不那么烂的。
 *
 * **不能穷举代码页**:非中文 Windows(Shift_JIS / CP866……)仍然会是乱码,因为 Node 的
 * ICU 认哪些编码要看构建,而每多试一个就多一分把好输出判成坏的风险。中文机器是这一版
 * 的目标。
 *
 * 首尾的**半截字符**在这一层切掉,而不是推给调用方 —— "给任意一段字节都能解对"是这个
 * 函数自己的承诺;靠调用方记得先切一刀,就迟早会有一条路径忘了切(写这条断言时就先踩了
 * 一次:清理放在 `OutBuf.text()` 里,直接调 `decodeOutput` 就绕过去了)。
 */
export function decodeOutput(raw: Buffer): string {
  if (raw.length === 0) return "";
  const buf = trimLeadingOrphans(raw);
  if (buf.length === 0) return "";

  const utf8 = decodeUtf8Strict(buf);
  if (utf8 !== null) return utf8;

  const lossy = new TextDecoder("utf-8").decode(buf);
  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    return countReplacement(gbk) < countReplacement(lossy) ? gbk : lossy;
  } catch {
    // 这份 Node 的 ICU 没带 gbk。退回有损 UTF-8 —— 至少 ASCII 部分是对的。
    return lossy;
  }
}

const REPLACEMENT = "�";

function countReplacement(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === REPLACEMENT) count += 1;
  return count;
}
