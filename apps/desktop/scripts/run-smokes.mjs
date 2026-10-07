#!/usr/bin/env node
/** Shared smoke entry for pnpm/CI. Reuse each suite's run.sh; do not copy its
 * bundling/stubs. Windows explicitly selects Git Bash (not the WSL shim).
 * Logs are unique per invocation; empty selections and child failures fail. */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CRITICAL_SUITES = Object.freeze([
  "db-migrate-smoke", "db-persistence-smoke", "mobile-pairing-smoke",
  "run-store-smoke", "session-store-smoke",
  // 调度器拆成三套(A5,2026-10-07):核心/数据/控制流。都是核心逻辑,一起算关键集。
  "scheduler-smoke", "scheduler-data-smoke", "scheduler-flow-smoke",
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

/** 解析 esbuild 可执行文件,写进 `.tmp/esbuild-path` 供所有 run.sh 的
 *  `lib/esbuild-path.sh` 读 —— **一次全量跑只解析一次**。
 *
 *  为什么要预解析:每个 run.sh 从前各跑一句 `find .pnpm -path '*esbuild/bin/esbuild'`,
 *  递归扫上千个包目录,单句 2.4 到 4.5 秒;而 esbuild 打包本身 0.16 秒。138 套累计
 *  5 到 10 分钟纯浪费。这里用 `readdirSync` 只看 `.pnpm` 顶层(0.14 秒),写好缓存,
 *  子进程 zero-cost 读到。 */
function precomputeEsbuildPath(appDir, logger) {
  try {
    const pnpm = resolve(appDir, "../../node_modules/.pnpm");
    if (!existsSync(pnpm)) return;
    const dir = readdirSync(pnpm).filter((n) => n.startsWith("esbuild@")).sort().at(-1);
    if (!dir) return;
    const exe = join(pnpm, dir, "node_modules/esbuild/bin/esbuild");
    if (!existsSync(exe)) return;
    mkdirSync(join(appDir, ".tmp"), { recursive: true });
    writeFileSync(join(appDir, ".tmp/esbuild-path"), exe, "utf8");
    logger.log(`esbuild: ${exe}`);
  } catch (err) {
    // 预解析失败不是致命 —— lib/esbuild-path.sh 自己会 glob/find 兜底。
    logger.log(`esbuild precompute skipped: ${err.message}`);
  }
}

/** 会起**真浏览器**的套件 —— 它们各自 spawn 一个 Chrome + 渲染,单套 ~30 秒,且彼此抢
 *  CPU/内存。并发跑要单独限流,免得一起起 13 个浏览器把机器拖垮。判据:目录里有 .mjs
 *  引用了 `withAuditPage`(共享的 CDP 辅助)或 `MCODE_TEST_BROWSER`。 */
function isBrowserSuite(appDir, name) {
  try {
    const dir = join(appDir, "scripts", name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".mjs")) continue;
      const text = readFileSync(join(dir, f), "utf8");
      if (text.includes("withAuditPage") || text.includes("MCODE_TEST_BROWSER")) return true;
    }
  } catch { /* 读不到就不当重型 */ }
  return false;
}

/** 跑一个 worker 池:并发上限 `jobs`,重型(浏览器)套件另受 `heavyJobs` 限制。
 *  按 `selected` 顺序领活;每个结果一出就回调(保留每套的 PASS/FAIL 行)。
 *
 *  ## 为什么要并发
 *
 *  从前是**纯串行** `for (… await runOne …)` —— 一次只跑一套。而 190 套里绝大多数是
 *  无头轻量件(await 文件/子进程,CPU 几乎闲着),串行 = 把大部分时间花在"等"上。
 *  并发后全量从十几分钟降到几分钟,且**不改变任何断言**——每套仍在自己的进程、自己的
 *  日志、自己的超时里跑,只是不再排队。 */
async function runPool(items, jobs, runner) {
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (true) {
      if (stopped) return;
      const i = next++;
      if (i >= items.length) return;
      const r = await runner(items[i], i);
      results[i] = r;
      // interrupted 时不再领新活(仍在跑的会自然收尾)。
      if (r.interrupted) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  return results;
}

/** 清理 `.tmp` 里的**残留构建目录**(`<名字>-<6位随机>`),只留最近 `keepRecent` 个。
 *
 *  ## 为什么需要它
 *
 * 各 UI 套件的 `build.mjs` 用 `mkdtempSync` 在 `.tmp/` 建工作目录、且**故意不删**
 * (留给失败时排查)。但从不清理会累积:实测一台机器上攒了 **1200+ 个目录、8.5 GB**
 * (`workflow-ui` 每个 29 MB)——既吃磁盘(用户反馈内存/磁盘不够),又拖慢 `find`/`du`
 * 这类工具(Windows 上遍历上万文件很慢)。
 *
 *  ## 策略
 *
 * 保留**最近 `keepRecent` 个**(按 mtime)——刚跑完/刚失败的那些正好留着可查,更老的删掉。
 * **只删** `.tmp` 顶层的构建目录,不碰缓存(`esbuild-path`/`tw-cache`/`*.tsbuildinfo`)
 * 与 `smoke-runs`(日志)。删不掉的(Chrome 还占着 profile)跳过,不算错。
 */
function pruneBuildDirs(appDir, keepRecent = 6) {
  const tmp = join(appDir, ".tmp");
  if (!existsSync(tmp)) return { removed: 0 };
  const KEEP = new Set(["smoke-runs", "tw-cache", "flow-preview", "md-preview"]);
  let entries;
  try { entries = readdirSync(tmp, { withFileTypes: true }); } catch { return { removed: 0 }; }
  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory() || KEEP.has(e.name)) continue;
    // 构建目录的形状:`<套件名>-<6位随机>`(mkdtemp 后缀)。排除其它普通目录。
    if (!/-[A-Za-z0-9]{6}$/.test(e.name)) continue;
    try { candidates.push({ name: e.name, mtime: statSync(join(tmp, e.name)).mtimeMs }); }
    catch { /* ignore */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const c of candidates.slice(keepRecent)) {
    try { rmSync(join(tmp, c.name), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); removed++; }
    catch { /* Chrome 可能还占着 profile —— 跳过,下次再清 */ }
  }
  return { removed };
}

export async function runSuites(names, { appDir = APP_DIR, bash = resolveBash(), timeoutMs = 240_000, jobs, logger = console } = {}) {
  precomputeEsbuildPath(appDir, logger);
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
  // 并发档:**按机器核数**定,显式 `jobs` / env 优先覆盖。
  //   轻量套件(无头,CPU 几乎闲置) → min(8, 核数) —— 它们等 IO 多,开满才不浪费。
  // 并发档:**内存是瓶颈**(每个真浏览器套件起一个 Chrome,几百 MB 起),不是核数。
  //   轻量套件(无头 node 进程,各几十 MB) → min(6, 核数)。
  //   浏览器套件(Chrome + 打包页,各几百 MB) → min(3, 核数/4) —— 保守,宁慢勿 OOM。
  //   显式 `jobs` / `MCODE_SMOKE_JOBS` / `MCODE_SMOKE_HEAVY_JOBS` 可覆盖。
  const cores = cpus().length;
  const totalJobs = Math.max(1, jobs ?? (Number(process.env.MCODE_SMOKE_JOBS) || Math.min(6, cores)));
  const heavyJobs = Math.max(1, jobs ?? (Number(process.env.MCODE_SMOKE_HEAVY_JOBS) || Math.min(3, Math.ceil(cores / 4))));
  logger.log(`Running ${selected.length} suites (light ×${totalJobs}, browser ×${heavyJobs})`);

  // 浏览器套件单独一条通道(它们各起一个 Chrome,吃内存);其余走主通道。
  const heavy = selected.filter((n) => isBrowserSuite(appDir, n));
  const light = selected.filter((n) => !isBrowserSuite(appDir, n));
  let failed = 0;
  let interrupted = false;

  const runOneLogged = async (name) => {
    const logFile = join(logDir, `${name}.log`);
    const result = await runOne(bash, name, appDir, logFile, timeoutMs);
    if (result.ok) logger.log(`PASS  ${name}`);
    else {
      failed++;
      logger.error(`FAIL  ${name} (exit=${result.code}, signal=${result.signal ?? "none"}${result.timedOut ? ", timeout" : ""}${result.interrupted ? ", interrupted" : ""}${result.error ? `, ${result.error}` : ""})`);
      logger.error(readFileSync(logFile, "utf8").split(/\r?\n/).slice(-24).join("\n"));
      if (result.interrupted) interrupted = true;
    }
    return result;
  };

  // 轻量与重型**同时**开跑:重型(浏览器,各 ~20s)是长尾,先让它们起跑、与轻量段时间重叠,
  // 而不是等 178 个轻量跑完才轮到它们。两条池各有自己的并发上限(重型更保守,吃内存)。
  await Promise.all([
    runPool(light, totalJobs, runOneLogged),
    runPool(heavy, heavyJobs, runOneLogged),
  ]);

  // 收尾清掉老的构建目录(留最近几个供排查),避免 `.tmp` 无限膨胀。
  const pruned = pruneBuildDirs(appDir);
  if (pruned.removed > 0) logger.log(`pruned ${pruned.removed} stale build dir(s) from .tmp`);

  if (interrupted) {
    logger.error("Smoke run interrupted; remaining suites were NOT run.");
    return 130;
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
