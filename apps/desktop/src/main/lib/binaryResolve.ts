/**
 * Binary PATH lookup shared by the terminal shell resolver and the LSP
 * manager. Extracted from `terminal/shellResolve.ts` so the LSP code can reuse
 * the same cross-platform `which()` without pulling terminal concerns.
 *
 * Returns an absolute path to the first matching executable found, or null.
 * Callers should still handle spawn failures gracefully - the resolved binary
 * may not be executable at runtime (permissions, broken symlink, etc.).
 */
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { decodeOutput } from "./outBuf.js";

/**
 * `where <name>` 的**第一个真实存在的**命中(win32)。找不到 / 非 win32 返回 null。
 *
 * ## 为什么是"逐行找第一个存在的",不是"第一行"
 *
 * `where` 会列出 PATH 上所有同名项。第一行**未必**能用:WindowsApps 的
 * app-execution 别名(如 WSL 的 `bash` 别名)视 Node/libuv 版本会以 EACCES 让
 * `existsSync` 失败,陈旧的 npm 目录也会先被列出来。只看第一行会把一台**装了**的机器
 * 误判成"没装"(用户看到"未安装",明明 `npm i -g` 装好了)。
 *
 * ## 为什么是唯一一份
 *
 * 这条规则从前在 `binaryResolve.which()`(只看第一行)与 `bashEnv.whereFirst()`(逐行)
 * 各写一份、且**方向相反** —— LSP 装没装、终端用哪个 shell 两处判据不一致。收在这里,
 * 两边都调它。中文 Windows 上 `where.exe` 按系统代码页(GBK)输出,所以经 `decodeOutput`
 * 在 UTF-8/GBK 间择优 —— 用户目录带中文的路径不能成乱码(乱了 `existsSync` 就不过)。
 */
export function whereFirstOnPath(name: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = decodeOutput(execFileSync("where.exe", [name], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      // 同步跑在主进程上:别让一个卡住的 PATH 项(如不可达的网络盘)冻住整个应用。
      // 超时会抛,调用方落到下面的 well-known 目录。
      timeout: 5000,
    }));
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p && existsSync(p)) return p;
    }
  } catch {
    // `where` unavailable / not on PATH
  }
  return null;
}

/** Try to locate `name` on PATH (and a few well-known install dirs on Win).
 *
 *  `name` may be:
 *   - a bare command (`typescript-language-server`) -> PATH search
 *   - an absolute or relative path -> existence check (no PATH lookup)
 *
 *  On Windows, appends `.exe` to bare names when probing well-known dirs, and
 *  shells out to `where.exe` for the PATH search (matches cmd's resolution). */
export function which(name: string): string | null {
  // Absolute / relative path that already exists - trust the caller.
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : null;
  }

  if (process.platform === "win32") {
    const onPath = whereFirstOnPath(name);
    if (onPath) return onPath;
    // Well-known install locations not always on PATH (e.g. npm global bin).
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";
    const appdata = process.env["APPDATA"] ?? "";
    const candidates = [
      join(pf, "PowerShell", "7", `${name}.exe`),
      join(pf, "PowerShell", "7-preview", `${name}.exe`),
      join(local, "Microsoft", "WindowsApps", `${name}.exe`),
      join(pf, "Git", "bin", `${name}.exe`),
      join(pf, "Git", "usr", "bin", `${name}.exe`),
      join(pf86, "Git", "bin", `${name}.exe`),
      // npm global bin (where language servers like typescript-language-server
      // get installed by `npm i -g`).
      join(appdata, "npm", `${name}.cmd`),
      join(appdata, "npm", `${name}`),
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", `${name}.exe`),
      join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", `${name}.exe`),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  // POSIX: search PATH manually (avoid shelling out).
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  // Common absolute locations.
  for (const full of [`/bin/${name}`, `/usr/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (existsSync(full)) return full;
  }
  return null;
}

/** Locate the first of `names` that exists on PATH. Useful when a language
 *  server ships under multiple binary names across versions/distros. */
export function whichAny(names: string[]): string | null {
  for (const n of names) {
    const found = which(n);
    if (found) return found;
  }
  return null;
}

/** Directories that mark a `bash.exe` as the WSL launcher rather than a real
 *  Git Bash / MSYS shell. WSL's `C:\Windows\System32\bash.exe` cannot resolve
 *  Windows paths (`D:/...`, `/d/...`) — the cause of the Pi provider's bash
 *  failures — so it must never win shell resolution. */
const WSL_BASH_DIR_RE = /(System32|SysWOW64|WindowsApps)/i;

/**
 * Resolve a real Git Bash (`bash.exe`) on Windows, or null when none is
 * found. This is the shell the provider SDKs should execute the Bash tool
 * with: Git Bash's MSYS runtime converts `/d/...` and `D:/...` paths natively,
 * while the SDKs' own fallbacks can silently pick WSL's
 * `C:\Windows\System32\bash.exe` (via `where bash.exe` on PATH), which can't
 * see Windows paths at all.
 *
 * Resolution order:
 *   1. well-known install dirs (Program Files / Program Files (x86) /
 *      LocalAppData Git layouts);
 *   2. derived from `git` on PATH — `D:\soft\Git\cmd\git.exe` implies a Git
 *      for Windows install whose sibling `..\bin\bash.exe` is its bash;
 *   3. `bash` on PATH, skipping WSL/WindowsApps launchers.
 *
 * Returns null on non-Windows or when nothing resolves — callers then keep
 * their SDK's default shell resolution (unchanged behavior).
 *
 * Memoized (hit AND miss): the provider's startTurn calls this on EVERY turn,
 * and step 2 shells out to `where.exe git` synchronously (execFileSync blocks
 * the main process) when Git isn't in a well-known dir — uncached, every
 * message pays a subprocess spawn before the CLI can even be spawned. The
 * resolved shell doesn't change within a process (mirrors detectBashEnv's
 * cache in bashEnv.ts).
 */
let cachedGitBash: string | null | undefined;

export function resolveGitBash(): string | null {
  if (process.platform !== "win32") return null;
  if (cachedGitBash !== undefined) return cachedGitBash;
  const resolved = resolveGitBashUncached();
  cachedGitBash = resolved;
  return resolved;
}

function resolveGitBashUncached(): string | null {
  const exists = (p: string): string | null => (existsSync(p) ? p : null);

  // 1. Well-known install dirs (Git for Windows is often NOT on PATH).
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] ?? "";
  const wellKnown = [
    join(pf, "Git", "bin", "bash.exe"),
    join(pf, "Git", "usr", "bin", "bash.exe"),
    join(pf86, "Git", "bin", "bash.exe"),
    join(local, "Programs", "Git", "bin", "bash.exe"),
  ];
  for (const c of wellKnown) {
    const hit = exists(c);
    if (hit) return hit;
  }

  // 2. Derive from `git` on PATH: walk up from the git binary looking for a
  //    Git for Windows layout. Handles both `cmd\git.exe` and
  //    `mingw64\bin\git.exe` (Git puts different shims on PATH per setup):
  //    `D:\soft\Git\cmd\git.exe` or `...\mingw64\bin\git.exe` both imply a
  //    sibling `..\bin\bash.exe` / `..\usr\bin\bash.exe` under the install
  //    root. Covers non-default installs that Program Files misses.
  const git = which("git");
  if (git) {
    let ancestor = dirname(git);
    for (let level = 0; level < 3 && ancestor.length > 3; level++) {
      for (const rel of ["bin", "usr\\bin"]) {
        const hit = exists(join(ancestor, rel, "bash.exe"));
        if (hit) return hit;
      }
      ancestor = dirname(ancestor);
    }
  }

  // 3. `bash` on PATH, excluding the WSL/WindowsApps launchers.
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    if (WSL_BASH_DIR_RE.test(dir)) continue;
    const hit = exists(join(dir, "bash.exe"));
    if (hit) return hit;
  }
  return null;
}
