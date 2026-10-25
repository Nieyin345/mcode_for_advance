/**
 * Owned OS subprocess with bounded output and tree cleanup.
 * Unlike spawnSync, async spawn allows timeout/SIGINT handlers to run while
 * an Electron child is active, so a failed UI test cannot silently retain
 * a Chromium process tree. Callers only use this for processes THEY spawn.
 */
import { spawn, spawnSync } from "node:child_process";

export function terminateOwnedTree(child, platform = process.platform) {
  if (!child?.pid) return;
  if (platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore", timeout: 5000,
    });
    if (result.status !== 0 || result.error) {
      try { child.kill("SIGKILL"); } catch {}
    }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

/** spawnSync-shaped return: {status, signal, stdout, stderr, error, pid}. */
export function runOwnedProcess(command, args, {
  cwd, env, timeout = 180_000, maxBuffer = 32 * 1024 * 1024,
  /** Exact per-child supervisor challenge. Kills only THIS owned child tree. */
  killOnStdout = null,
} = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(maxBuffer) || maxBuffer <= 0)
    return Promise.reject(new Error("Invalid subprocess resource budget"));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ pid: null, status: null, signal: null, stdout: "", stderr: "", error });
      return;
    }
    const out = [], err = [];
    let bytes = 0, reason = null, spawnError = null, killing = false;
    let supervisorKilled = false, outputTail = "";
    const stop = (code) => {
      if (!reason) reason = code;
      if (!killing) { killing = true; terminateOwnedTree(child); }
    };
    const collect = (dest, stdout = false) => (data) => {
      bytes += data.length;
      if (bytes > maxBuffer) return stop("ENOBUFS");
      dest.push(data);
      if (stdout && typeof killOnStdout === "string" && killOnStdout.length > 0 && !supervisorKilled) {
        // The child is not allowed to choose its own exit code as proof of
        // SIGKILL. This external supervisor executes the termination itself.
        outputTail = (outputTail + String(data)).slice(-Math.max(512, killOnStdout.length * 2));
        if (outputTail.includes(killOnStdout)) {
          supervisorKilled = true;
          terminateOwnedTree(child);
        }
      }
    };
    child.stdout?.on("data", collect(out, true));
    child.stderr?.on("data", collect(err));
    const timer = setTimeout(() => stop("ETIMEDOUT"), timeout);
    const int = () => stop("SIGINT");
    const term = () => stop("SIGTERM");
    process.once("SIGINT", int);
    process.once("SIGTERM", term);
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      process.off("SIGINT", int);
      process.off("SIGTERM", term);
      const result = {
        pid: child.pid ?? null,
        status: reason ? null : code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        error: spawnError ?? (reason ? Object.assign(new Error(reason), { code: reason }) : undefined),
        supervisorKilled,
      };
      // Signal handling must retain the parent's nonzero exit status; do not
      // start the next Electron relaunch generation after an interruption.
      if (reason === "SIGINT" || reason === "SIGTERM") {
        process.exitCode = reason === "SIGINT" ? 130 : 143;
      }
      resolve(result);
    });
  });
}
