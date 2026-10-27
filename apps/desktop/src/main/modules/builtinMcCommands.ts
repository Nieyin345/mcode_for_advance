/**
 * Mcode 内置命令 —— 不依赖任何扩展、不依赖 ModuleHost 的那部分能力。
 *
 * ## 为什么有这一层
 *
 * 「检查文件（大小 / SHA-256）」原来是 `ModuleHost` 的内置模块（`core.file-report`）。
 * ModuleHost 被整体下线（扩展系统只剩 Theia），但那两个能力本身有用：它们让工作流
 * 在不写脚本的情况下拿到文件的字节数与摘要。
 *
 * 所以把它们剥出来，改成与扩展命令**同一种调用方式**：`mcode.<方法>`。
 * `mcodeBridge` 派发前先查这张表，命中就地执行；不命中才落 `panelApiCall`。
 *
 * ## 安全边界：与从前逐条相同
 *
 * 路径经 `resolveModuleResource`（工作区根围栏 + 真实路径 + 普通文件 + 拒绝硬链接），
 * 上限仍是 32 MiB，仍校验「读取期间文件没变」。**没有放松任何一条。**
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { resolveModuleResource } from "./fileCapabilities.js";

/** 一个内置命令。`run` 拿到的 `path` 已经过围栏解析。 */
export interface BuiltinMcCommand {
  readonly id: string;
  readonly summary: string;
  run(input: { path: string; knownRoot: (p: string) => boolean; signal: AbortSignal }): Promise<Record<string, unknown>>;
}

const MAX_BYTES = 32 * 1024 * 1024;

async function inspectFile(realPath: string, signal: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const file = await open(realPath, "r");
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.size > MAX_BYTES) throw Error("文件检查仅限不超过 32 MiB 的普通文件");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      if (signal.aborted) throw Error("已取消");
      const read = await file.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > MAX_BYTES) throw Error("文件在读取期间增大，超过 32 MiB 上限");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const final = await file.stat();
    const current = await stat(realPath);
    if (
      bytes !== initial.size || final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs ||
      current.ino !== initial.ino || current.dev !== initial.dev ||
      current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs
    ) {
      throw Error("文件在检查期间发生变化，请重试");
    }
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

/**
 * 内置命令表。
 *
 * ⚠️ id 用 `mcode.file.*`。桥在派发时**先查这张表**，命中就用内置实现，
 * 不命中才落 `panelApiCall` —— 于是内置与 RPC 两张表的名字不会互相遮蔽。
 */
export const BUILTIN_MCODE_COMMANDS: readonly BuiltinMcCommand[] = [
  {
    id: "mcode.file.inspect",
    summary: "计算文件的字节数与 SHA-256（只读，上限 32 MiB）",
    async run({ path, knownRoot, signal }) {
      const real = await resolveModuleResource({ projectPath: path, path }, knownRoot);
      return inspectFile(real, signal);
    },
  },
  {
    id: "mcode.file.info",
    summary: "读取文件的字节数与修改时间（只读）",
    async run({ path, knownRoot, signal }) {
      if (signal.aborted) throw Error("已取消");
      const real = await resolveModuleResource({ projectPath: path, path }, knownRoot);
      const value = await stat(real);
      if (!value.isFile()) throw Error("只能查看普通文件");
      return { bytes: value.size, modifiedAt: value.mtimeMs };
    },
  },
];

/** 按 id 查内置命令。`undefined` = 不是内置的，交给 `panelApiCall`。 */
export function findBuiltinMcCommand(id: string): BuiltinMcCommand | undefined {
  return BUILTIN_MCODE_COMMANDS.find(command => command.id === id);
}
