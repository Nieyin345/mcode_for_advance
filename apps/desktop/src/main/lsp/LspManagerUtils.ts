/**
 * `LspManager` 的**路径 / Java 启动器工具函数**（从 `LspManager.ts` 拆出）。
 *
 * 路径归一与相等、URI 编码、server key、启动器 jar 定位、Java 安装完整性检查、
 * 探测进程树清理、`java` 可执行文件解析、带重试的删除。全是纯函数，只吃参数与
 * `node:fs` / `node:path` / `process`，对 `LspManagerImpl` 零引用。
 * **纯搬迁，函数体逐字节一致。**
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LspLanguageId } from "@contracts/ipc";
import { which } from "@main/lib/binaryResolve.js";

/** 路径相等(分隔符归一 + **按平台**折叠大小写)—— 与 `pathGuard.samePath` 同口径。
 *  ⚠️ 大小写折叠**只在 win32/darwin**(那里的文件系统不区分大小写);Linux 上 `/WT` 与
 *  `/wt` 是两个不同目录,无条件小写会把它们当成同一个,删一条会话可能顺手停掉那条大小写
 *  相异的兄弟工作树的 server。 */
export function samePathLoose(a: string, b: string): boolean {
  const fold = process.platform === "win32" || process.platform === "darwin";
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return fold ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/* ───────────────────────── path / uri helpers ───────────────────────── */

/** Lowercased extension with leading dot (e.g. ".ts"). */
export function extnameLower(p: string): string {
  const i = p.lastIndexOf(".");
  if (i === -1) return "";
  return p.slice(i).toLowerCase();
}

/** Extract the most useful error line from a server's stderr output. Looks
 *  for lines containing "Error"/"Exception" (Python/Java tracebacks) or the
 *  last non-empty line as a fallback. Returns a single-line summary. */
export function extractLastError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  // Prefer lines that look like the actual error message.
  const errorLine = lines.find((l) => /^(Error|Exception|Traceback|raise|FATAL)/i.test(l))
    ?? lines.find((l) => /error|exception|requires|not found|cannot|failed/i.test(l));
  if (errorLine) {
    // Strip Python traceback prefixes like "raise Exception(...)" -> "..."
    const cleaned = errorLine.replace(/^raise\s+/i, "").replace(/^Exception\(["']?/, "").replace(/["']?\)$/, "");
    return cleaned;
  }
  // Fallback: last line.
  return lines[lines.length - 1];
}

/** Remove a file or directory with retries. On Windows, AV scans and pending
 *  file handles can briefly lock files, causing EPERM/EBUSY on the first
 *  attempt. We retry a few times with increasing delay before giving up.
 *  Resolves on success, rejects with the last error. */
export async function removeWithRetry(target: string): Promise<void> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 200;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // Prefer rm (works for both files and directories). If the target is
      // already gone, treat as success.
      await rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // already gone
      // EPERM / EBUSY / ENOTEMPTY -- retry after delay.
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** Delete a single file with retries (same rationale as removeWithRetry). */
export async function unlinkWithRetry(target: string): Promise<void> {
  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 200;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await unlink(target);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return; // already gone
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** Convert an absolute file path to a `file://` URI (LSP convention). */
export function filePathToUri(p: string): string {
  // Normalize backslashes to forward slashes for Windows paths.
  const norm = p.replace(/\\/g, "/");
  // Windows absolute paths need a leading slash before the drive letter.
  const prefixed = /^[a-zA-Z]:/.test(norm) ? `/${norm}` : norm;
  // Encode filename data, not URI delimiters: literal %, # and ? must
  // survive Monaco/LSP parsing without changing the addressed file.
  return `file://${encodeURI(prefixed).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

/** Convert a directory path to a `file://` URI (for rootUri). */
export function dirPathToUri(p: string): string {
  const uri = filePathToUri(p);
  return uri.endsWith("/") ? uri : uri + "/";
}

/** Build the server map key. */
export function serverKey(workspacePath: string, language: LspLanguageId | null): string {
  return `${resolve(workspacePath)}::${language ?? "_"}`;
}

/** Hash a path to a short hex string (for workspace data dir naming). */
export function hashPath(p: string): string {
  let h = 0;
  for (let i = 0; i < p.length; i++) {
    h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16);
}

/** Find the equinox launcher jar in the jdtls plugins directory. There's
 *  exactly one `org.eclipse.equinox.launcher_<version>.jar` (the platform-
 *  specific fragments are separate). Returns the full path or throws. */
export function findLauncherJar(pluginsDir: string): string {
  const entries = readdirSync(pluginsDir);
  const jar = entries.find((e) => /^org\.eclipse\.equinox\.launcher_\d/.test(e));
  if (!jar) throw new Error(`未在 ${pluginsDir} 中找到 equinox launcher jar`);
  return join(pluginsDir, jar);
}

/** Locate the equinox launcher jar for an installed jdtls, given how the
 *  server binary was resolved. Checks the in-app install dir first, then
 *  directories relative to the binary for PATH-installed releases (typical
 *  layout: <release>/bin/jdtls + <release>/plugins/...). Returns the jar path
 *  or throws with the checked locations. */
export function findJavaLauncherJar(resolved: string, installDir: string): string {
  const bin = dirname(resolved);
  const candidates = [...new Set([join(installDir, "plugins"), join(bin, "plugins"), join(dirname(bin), "plugins")])];
  for (const dir of candidates) {
    try {
      return findLauncherJar(dir);
    } catch {
      // try the next candidate layout
    }
  }
  throw new Error(`未找到 org.eclipse.equinox.launcher_*.jar(检查过 ${candidates.join("、")})`);
}

/**
 * 【MC-037】换上去**之前**校验暂存树里确实有一份可用的 jdtls:equinox launcher jar 存在
 * 且非空,`configs/` 目录也在。`tar.gz` 截断/缺文件/解压不完整时,这一步会抛 —— 于是绝
 * 不会把一个残缺的安装 rename 成正式目录、把旧版本挤掉。抛错即**旧安装一字未动**。
 */
export function assertJavaInstallComplete(stageDir: string): void {
  const pluginsDir = join(stageDir, "plugins");
  const jar = findLauncherJar(pluginsDir); // 找不到即抛
  const st = statSync(jar);
  if (!st.isFile() || st.size === 0) throw new Error(`equinox launcher jar 为空或不是文件:${jar}`);
  if (!existsSync(join(stageDir, "configs"))) throw new Error(`jdtls 安装不完整:缺少 configs/ 目录`);
}

/** Kill a health-check probe process. On win32 the spawn used shell:true, so
 *  p.pid is the cmd.exe wrapper and the actual server is its child --
 *  p.kill() alone would orphan it, hence taskkill /T (tree). */
export function killProbeTree(p: ChildProcess): void {
  if (p.pid == null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
      // fall through to the plain kill
    }
  }
  try {
    p.kill();
  } catch {
    // already dead
  }
}

/** The platform-specific config directory name for jdtls. */
export function javaConfigDir(): string {
  switch (process.platform) {
    case "win32":
      return "config_win";
    case "darwin":
      return process.arch === "arm64" ? "config_mac_arm" : "config_mac";
    default:
      return process.arch === "arm64" ? "config_linux_arm" : "config_linux";
  }
}

/** Resolve the Java executable path. Priority: explicit override >
 *  JAVA_HOME/bin/java > `java` on PATH. */
export function resolveJavaExecutable(javaHomeOverride?: string): string {
  const home = javaHomeOverride || process.env.JAVA_HOME;
  if (home) {
    const exe = join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (existsSync(exe)) return exe;
  }
  return which("java") ?? "java";
}

/** Check that the Java at `javaBin` is at least `minMajor` (e.g. 21). Runs
 *  `java -version` and parses the major version from stderr. Returns
 *  { ok, version } where version is the major version number (or 0 if unknown). */
export function checkJavaVersionAtLeast(
  javaBin: string,
  minMajor: number,
): Promise<{ ok: boolean; version: number }> {
  return new Promise((resolveP) => {
    const p = spawn(javaBin, ["-version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    p.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.on("error", () => resolveP({ ok: false, version: 0 }));
    p.on("exit", () => {
      // `java -version` output: 'openjdk version "17.0.18"' or 'version "21"'
      const match = out.match(/version "(\d+)/);
      const version = match ? parseInt(match[1], 10) : 0;
      resolveP({ ok: version >= minMajor, version });
    });
  });
}
