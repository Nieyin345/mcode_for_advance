/**
 * Resolve which shell executable to spawn for an integrated terminal.
 *
 * Order:
 *  1. Explicit override (per-create or settings key)
 *  2. Platform smart defaults (pwsh → powershell → git-bash → cmd on Windows;
 *     $SHELL → bash → zsh → sh on POSIX)
 *
 * Returns an absolute-ish path (or bare command name that spawn can find) plus
 * argv. Callers should still handle spawn failures gracefully — the resolved
 * binary may not exist on PATH at runtime.
 */
import { existsSync } from "node:fs";
import { log } from "@main/lib/logger.js";
import { which } from "@main/lib/binaryResolve.js";

export interface ResolvedShell {
  /** Executable path or command name passed to node-pty. */
  file: string;
  /** argv (not including the executable). */
  args: string[];
  /** Display label for UI / TerminalInfo.shell. */
  label: string;
}

/**
 * **让 Windows 上的 shell 吐 UTF-8**（2026-09-21）。
 *
 * ## 为什么非做不可
 *
 * 中文 Windows 的控制台代码页是 **GBK**，而 node-pty 把子进程的输出**按 UTF-8 解**成
 * string 交给 `pty.onData` —— 于是 `dir` 的中文、或者用户自己跑的 `python xxx.py`
 * 打的中文，全变成乱码。用户报的就是这个。
 *
 * ⚠️ **不能靠 `env.LANG`**：`TerminalManager` 里那句 `env.LANG = "en_US.UTF-8"` 对
 * cmd / PowerShell **无效**（那是 POSIX 的约定，Windows 的 shell 不认）。
 *
 * ## 各家各自的解法
 *
 * - **PowerShell / pwsh**：`[Console]::OutputEncoding` 控制它自己写出去的字是什么
 *   编码。用 `-NoExit -Command` 在启动时设一次，然后把交互权还给用户（`-NoExit`
 *   非有不可，否则它设完就退出了）。
 * - **cmd**：`/K` 挂着一条 `chcp 65001`（切到 UTF-8 代码页），`/K` 让窗口留着。
 * - **bash（Git Bash）**：**本来就在吐 UTF-8**，不动。
 * - 认不出来的 shell：**不动** —— 宁可保持现状，也别给它塞一个它不认的参数
 *   （那会让终端直接起不来，比乱码更糟）。
 */
const PS_UTF8 = "$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8";

function winShellFromPath(file: string): ResolvedShell {
  const lower = file.toLowerCase();
  if (lower.endsWith("pwsh.exe") || lower.endsWith("\\pwsh") || lower.endsWith("/pwsh")) {
    return { file, args: ["-NoLogo", "-NoExit", "-Command", PS_UTF8], label: file };
  }
  if (lower.includes("powershell")) {
    return { file, args: ["-NoLogo", "-NoExit", "-Command", PS_UTF8], label: file };
  }
  if (lower.endsWith("bash.exe") || lower.endsWith("\\bash") || lower.endsWith("/bash")) {
    return { file, args: ["--login", "-i"], label: file };
  }
  if (lower.endsWith("cmd.exe") || lower.endsWith("\\cmd") || lower.endsWith("/cmd")) {
    return { file, args: ["/K", "chcp 65001"], label: file };
  }
  return { file, args: [], label: file };
}

function posixShellFromPath(file: string): ResolvedShell {
  // Login shell keeps user PATH/profile; -i is interactive.
  const base = file.split("/").pop() ?? file;
  if (base === "bash" || base === "zsh") {
    return { file, args: ["-l"], label: file };
  }
  return { file, args: [], label: file };
}

/** Resolve shell from an explicit user override (setting or per-create). */
function resolveOverride(override: string): ResolvedShell | null {
  const trimmed = override.trim();
  if (!trimmed) return null;
  const found = which(trimmed) ?? (existsSync(trimmed) ? trimmed : null);
  if (!found) {
    log.warn(`terminal.shell override not found: ${trimmed}`);
    return null;
  }
  return process.platform === "win32" ? winShellFromPath(found) : posixShellFromPath(found);
}

/** Platform smart-default shell. Always returns something spawnable-ish;
 *  last resort is `cmd.exe` / `/bin/sh` even if which() missed them. */
export function resolveDefaultShell(override?: string | null): ResolvedShell {
  if (override) {
    const o = resolveOverride(override);
    if (o) return o;
  }

  if (process.platform === "win32") {
    // ⚠️ **args 一律交给 `winShellFromPath` 算，别在这里再写一份**（2026-09-21 修）。
    // 这里原先是自己列了一遍 `["-NoLogo"]` / `[]`，于是"给 shell 加 UTF-8 参数"那件事
    // 只对**用户显式 override** 那条路生效，默认那条路仍然乱码 —— 两份实现迟早分家，
    // 而分家之后**默认那条才是绝大多数人走的**。这正是仓库硬规矩第 2 条踩的坑。
    for (const name of ["pwsh", "powershell", "bash", "cmd"]) {
      const file = which(name);
      if (file) return winShellFromPath(file);
    }
    // Last resort — node-pty on Windows can usually find cmd via COMSPEC.
    const comspec = process.env.ComSpec || "cmd.exe";
    return winShellFromPath(comspec);
  }

  const shellEnv = process.env.SHELL;
  if (shellEnv) {
    const found = which(shellEnv) ?? (existsSync(shellEnv) ? shellEnv : null);
    if (found) return posixShellFromPath(found);
  }
  for (const name of ["bash", "zsh", "sh"]) {
    const file = which(name);
    if (file) return posixShellFromPath(file);
  }
  return { file: "/bin/sh", args: [], label: "/bin/sh" };
}
