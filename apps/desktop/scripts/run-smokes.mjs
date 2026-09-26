#!/usr/bin/env node
/** Shared smoke entry for pnpm/CI. Reuse each suite's run.sh; do not copy its
 * bundling/stubs. Windows explicitly selects Git Bash (not the WSL shim).
 * Logs are unique per invocation; empty selections and child failures fail. */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CRITICAL_SUITES = Object.freeze([
  "db-migrate-smoke", "db-persistence-smoke", "mobile-pairing-smoke",
  "run-store-smoke", "session-store-smoke", "scheduler-smoke",
  "ipc-wiring-smoke", "path-guard-smoke",
]);
const SUITE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-smoke$/;

export function discoverSuites(appDir = APP_DIR) {
  return readdirSync(join(appDir, "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SUITE_NAME.test(entry.name))
    .map((entry) => entry.name).sort();
}

export function selectSuites(args, available) {
  const names = args.length === 0 || (args.length === 1 && args[0] === "--critical")
    ? [...CRITICAL_SUITES]
    : args.length === 1 && args[0] === "--all" ? [...available] : [...args];
  if (names.length === 0) throw new Error("No smoke suites selected; refusing a false-green run");
  for (const name of names) {
    if (!SUITE_NAME.test(name) || !available.includes(name)) throw new Error(`Unknown smoke suite: ${name}`);
  }
  return [...new Set(names)];
}

export function resolveBash(env = process.env, platform = process.platform) {
  if (env.MCODE_TEST_BASH) {
    if (!existsSync(env.MCODE_TEST_BASH)) throw new Error("MCODE_TEST_BASH must point to an existing Bash executable");
    return env.MCODE_TEST_BASH;
  }
  if (platform !== "win32") return "bash";
  const candidates = [];
  for (const base of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]]) {
    if (base) candidates.push(join(base, "Git", "bin", "bash.exe"));
  }
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  // Portable/Scoop installs: locate Bash next to Git, never take bash.exe from
  // System32/WindowsApps (those start WSL, not the Windows Node environment).
  for (const bin of (env.Path ?? env.PATH ?? "").split(";").filter(Boolean)) {
    if (existsSync(join(bin, "git.exe"))) {
      candidates.push(join(dirname(bin), "bin", "bash.exe"), join(dirname(bin), "usr", "bin", "bash.exe"));
    }
  }
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Git Bash was not found. Install Git for Windows or set MCODE_TEST_BASH explicitly.");
  return found;
}

/** Kill only the owned test process tree on timeout, not unrelated Node/Electron
 * processes. A plain child.kill() would leave grandchildren holding ports. */
function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killed = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore", timeout: 5000,
    });
    if (killed.error || killed.status !== 0) child.kill("SIGKILL");
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
}

async function runOne(bash, name, appDir, logFile, timeoutMs) {
  const fd = openSync(logFile, "w");
  let child;
  try {
    child = spawn(bash, [`scripts/${name}/run.sh`], {
      cwd: appDir, stdio: ["ignore", fd, fd], windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, npm_config_yes: "false", npm_config_offline: "true" },
    });
    return await new Promise((done) => {
      let timedOut = false;
      let interrupted = false;
      let spawnError;
      const timer = setTimeout(() => { timedOut = true; terminateTree(child); }, timeoutMs);
      const interrupt = () => { interrupted = true; terminateTree(child); };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        done({ ok: code === 0 && !timedOut && !interrupted && !spawnError, code, signal, timedOut, interrupted, error: spawnError?.message });
      });
    });
  } finally {
    closeSync(fd);
  }
}

export async function runSuites(names, { appDir = APP_DIR, bash = resolveBash(), timeoutMs = 240_000, logger = console } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid smoke timeout");
  // Validate ALL entries before launching anything; a missing run.sh is not a
  // reason to silently omit a suite from --all.
  const available = discoverSuites(appDir);
  const selected = selectSuites(names, available);
  for (const name of selected) {
    if (!existsSync(join(appDir, "scripts", name, "run.sh"))) throw new Error(`Missing entry: ${name}/run.sh`);
  }
  const logRoot = join(appDir, ".tmp", "smoke-runs");
  mkdirSync(logRoot, { recursive: true });
  const logDir = mkdtempSync(join(logRoot, `${Date.now()}-${process.pid}-`));
  logger.log(`Smoke logs: ${logDir}`);
  let failed = 0;
  for (const name of selected) {
    const logFile = join(logDir, `${name}.log`);
    const result = await runOne(bash, name, appDir, logFile, timeoutMs);
    if (result.ok) logger.log(`PASS  ${name}`);
    else {
      failed++;
      logger.error(`FAIL  ${name} (exit=${result.code}, signal=${result.signal ?? "none"}${result.timedOut ? ", timeout" : ""}${result.interrupted ? ", interrupted" : ""}${result.error ? `, ${result.error}` : ""})`);
      logger.error(readFileSync(logFile, "utf8").split(/\r?\n/).slice(-24).join("\n"));
      if (result.interrupted) {
        logger.error("Smoke run interrupted; remaining suites were NOT run.");
        return 130;
      }
    }
  }
  logger.log(`Smoke summary: ${selected.length - failed} pass, ${failed} fail (${selected.length} suites)`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--list")) {
      console.log(selectSuites(args.filter((arg) => arg !== "--list"), discoverSuites()).join("\n"));
    } else {
      process.exitCode = await runSuites(args);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
