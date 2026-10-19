/**
 * 「在 PATH 上找一个可执行文件」—— **唯一一份**。工具链检测(pandoc / latex 的版本
 * 探测、python 解释器候选)与 `lib/pythonResolve.ts` 都从这里来。
 *
 * ## 为什么单独一个文件
 *
 * 这条规则(逐行找**第一个 `existsSync` 通过的**命中)历史上在 `binaryResolve.which`
 * (只看第一行)与 `bashEnv.whereFirst`(逐行)各写了一份、且方向相反 —— 同类的坑不再
 * 踩第二遍。而且 `orchestration/codeRunner` 要用它,那个文件的无头 bundle **没有桩**,
 * 所以这里绝不能拖进 `electron`(只有 node 内置 + `outBuf`)。
 */
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { decodeOutput } from "./outBuf.js";

export interface ProbeResult {
  ok: boolean;
  stdout: string;
}

/** 跑一个命令并收 stdout。**任何**失败(不存在 / 超时 / 非零退出)都只是 `ok:false`
 *  —— 探测不该抛异常。 */
export function runProbe(file: string, args: string[], timeoutMs = 10_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    // 中文 Windows 上 where.exe 按系统代码页(GBK)输出 —— 按 UTF-8 解码,用户目录带中文的
    // 路径就成了乱码,existsSync 不过,工具被误报成"没装"。decodeOutput 会在 UTF-8/GBK 间择优。
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "buffer" }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout ? decodeOutput(stdout) : "" });
    });
  });
}

/** Native executable lookup command; `which` needs `-a` on POSIX.
 * Plain `which python` only returns the first candidate, preventing the
 * resolver from skipping an incompatible shim and finding a later interpreter. */
export function lookupSpec(name: string, platform: string): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "where.exe", args: [name] }
    : { command: "which", args: ["-a", name] };
}

/** 在 PATH 上找**所有**真实存在的同名可执行文件(按 `where`/`which` 给出的顺序)。
 *
 *  `where` 会列出 PATH 上所有同名项,而第一条**未必**是用户想要的那条(WindowsApps
 * 的 app-execution 别名、被别的程序注入到 PATH 最前的私有目录都可能排在前面)。要能
 * 跳过某一条去挑后面的,就得先拿到整串。 */
export async function findExecutables(name: string): Promise<string[]> {
  // Windows 用 where.exe,别的地方用 which。都不走 shell —— 参数里可能有用户
  // 路径,经 shell 解析就多了注入面。
  const { command, args } = lookupSpec(name, process.platform);
  const res = await runProbe(command, args);
  if (!res.ok) return [];
  const out: string[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const p = line.trim();
    if (!p) continue;
    try {
      // A PATH entry may name a directory, dangling shim or non-executable
      // POSIX file; those are not runnable Python/toolchain candidates.
      if (!statSync(p).isFile()) continue;
      if (process.platform !== "win32") accessSync(p, constants.X_OK);
      out.push(p);
    } catch {
      // Stale/locked/unrunnable PATH candidates must not eclipse later ones.
    }
  }
  return out;
}

/** PATH 上第一个真实存在的同名可执行文件,没有就 null。 */
export async function findExecutable(name: string): Promise<string | null> {
  return (await findExecutables(name))[0] ?? null;
}
