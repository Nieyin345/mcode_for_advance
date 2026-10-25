/**
 * T16 —— 真 Electron U1 骨架的**启动器**（普通 Node，不是 Electron）。
 *
 * 职责链：
 *   1. 一次性构建：真 App bundle（App.tsx + 真 store + api-stub）、产品真 preload、
 *      旅程 runner（driver/runner.ts）、旅程注册表（journeys/index.ts）、最小页面。
 *   2. 每条旅程：mkdir 证据目录 → 按「一代进程」运行受控 Electron 子进程
 *      （runner 以 exit 77 请求 relaunch 时换新进程继续）→ 读回 journey-result.json。
 *   3. 汇总三档退出码（见 driver/verdict.ts）：
 *        0 = 全部旅程按声明通过（**含**「故意失败」按预期失败）；
 *        1 = 至少一条「预期失败」旅程没有失败（断言被旁路 / 变异跑）；
 *        2 = 出现非预期失败（真正的坏消息）。
 *
 * ## 变异验证（任务卡判据 5）
 *
 * `--mutation=unconditional-pass` 把 `driver/runner.ts` 里 `assertionStatus` 的
 * 函数体替换成 `return "PASS";`（内存替换，产品源码与磁盘上的套件源码都不动），
 * 然后用**同一份** runner 构建跑全部旅程。断言被旁路后：
 *   - journey-3（expect:"fail"）不再失败 → 退出码 1；
 *   - journey-1/2 仍是 0 / 1 的其余部分照常。
 * `run.sh` 会把正常跑（必须出现「预期红」）与变异跑（必须变全绿）的退出码、
 * 以及 journey-3 的 literalStatus 翻转一并落盘为 mutation.json。
 *
 * ## 证据保留
 *
 * 证据根默认 `<repo>/.tmp/electron-u1/<timestamp>/`；**失败时不删**（默认也不删，
 * 便于复核）。`--keep` 无实际作用，保留它是为了显式声明「不清理」。
 *
 * ## 零新依赖
 *
 * 只使用仓库已安装的 esbuild / electron / React / Tailwind（经由 pnpm 的
 * node_modules/.pnpm 解析）。理由与 Playwright 评估见 README。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runOwnedProcess } from "../lib/owned-test-process.mjs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { buildTailwindCached } from "../lib/tailwind-cache.mjs";
import { guardHeavyTestProcess } from "../lib/heavy-test-lease.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repo = resolve(desktop, "../..");
const rendererRoot = join(desktop, "src/renderer");
const pnpm = resolve(repo, "node_modules/.pnpm");

/** 允许的 CLI 选项（未知选项显式失败，不静默忽略）。 */
const args = process.argv.slice(2);
let mutation = null;
let registry = join(suite, "journeys/index.ts");
/** `--only=<journey-name>`：只跑一条（调试用；run.sh 永远跑全部）。 */
let only = null;
/**
 * T7 追加：`--esbuild=<file.mjs>` —— 旅程注册表打包时的附加 esbuild 选项
 * （alias / nodePaths / loader / plugins）。T7 的旅程要 import vendor 主进程
 * （`genoffice/apps/<kind>/src/main/<kind>-main.ts`），它们是指向 TS 源码的包，
 * 默认解析不了。值必须是指向导出 `{ options }` 的 mjs 文件路径（需要函数型
 * plugin 时 JSON 表达不了）。
 */
let esbuildSpec = null;
/**
 * T7 追加：`--prebuild=<file.mjs>` —— 在 buildDir 建好、旅程跑起来之前执行的
 * 一个模块（导出 `prepare({ buildDir, desktop, repo })`）。T7 用它把**生产的**
 * `documentViewPreload.ts` 编到 `buildDir/documentViewPreload.js` —— 与发行布局
 * 同形（`documentViewHost` 的 `resolveViewPreload()` 从 `__dirname` 取同名文件，
 * 打包后 `__dirname` 就是 main bundle 所在的 `out/main/`）。
 */
let prebuildSpec = null;
for (const a of args) {
  if (a === "--mutation=unconditional-pass") mutation = "unconditional-pass";
  // W24：`--keep` 是**文档化过的 no-op**（见头注释「证据保留」——本脚本从不自动
  // 清理证据）。此前解析器不认它、直接 throw「Unknown option」，而旧包装器把
  // 「构建崩溃（exit 1）」读成「旅程预期红」并打印 PASS（t30 实测）。这里让它
  // 与文档一致地接受；即便将来再拒收，W24 的包装器也会归到 build-crashed（5），
  // 不会再变成 PASS。
  else if (a === "--keep") continue;
  else if (a.startsWith("--registry=")) registry = resolve(a.slice("--registry=".length));
  else if (a.startsWith("--only=")) only = a.slice("--only=".length);
  else if (a.startsWith("--esbuild=")) esbuildSpec = resolve(a.slice("--esbuild=".length));
  else if (a.startsWith("--prebuild=")) prebuildSpec = resolve(a.slice("--prebuild=".length));
  else throw Error("Unknown option: " + a);
}

// Claim the shared UI test budget *before* importing esbuild or launching Electron.
// Nested smoke wrappers inherit the parent lease token rather than deadlocking.
guardHeavyTestProcess(desktop, "electron-u1/build.mjs");

const pkgPath = (prefix, sub) => {
  const n = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
  if (!n) throw Error("Missing installed dependency " + prefix);
  return join(pnpm, n, "node_modules", sub);
};

const esbuildMod = await import(pathToFileURL(pkgPath("esbuild@", "esbuild/lib/main.js")).href);
const esbuild = esbuildMod.build ?? esbuildMod.default.build;
if (typeof esbuild !== "function") throw Error("esbuild entry missing .build");

// T7：`--prebuild=` 的模块拿到 esbuild 与目录，自己决定要多打哪些产物。
let prebuild = null;
if (prebuildSpec !== null) {
  prebuild = (await import(pathToFileURL(prebuildSpec).href)).prepare;
  if (typeof prebuild !== "function") throw Error("U1 build: --prebuild 模块必须导出 prepare({...})");
}

// 证据根：仓库 .tmp（已被 git 忽略）。**从不自动清理** —— 失败现场必须保留。
mkdirSync(join(desktop, ".tmp"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceRoot = join(repo, ".tmp/electron-u1", stamp);
mkdirSync(evidenceRoot, { recursive: true });

// 构建目录：每次全新（构建是确定性的，旧产物只会在排查时误导）。
const buildDir = mkdtempSync(join(desktop, ".tmp/electron-u1-build-"));
console.log("U1 evidence: " + evidenceRoot);
console.log("U1 build:    " + buildDir);

// T7：附加产物（在 buildDir 就绪后、旅程构建前跑；见 `--prebuild=` 说明）。
if (prebuild !== null) {
  await prebuild({ buildDir, desktop, repo, esbuild });
}

/* ────────────────────────────── 1. 真 App bundle ────────────────────────────── */

const absRenderer = (rel) => join(rendererRoot, rel).replaceAll("\\", "/");
const resolveTs = (p) => {
  const candidates = [p, p.replace(/\.js$/, ".tsx"), p.replace(/\.js$/, ".ts"), p + "/index.ts", p + "/index.tsx"];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c.replaceAll("\\", "/"); } catch { /* next */ }
  }
  return p.replaceAll("\\", "/");
};
// 与 arc005/settings-focus 同一取舍：只换「真 Chrome/Electron 起不来或与本卡判据无关」
// 的模块。真 App + 真 store 保留。
const stubs = {
  [absRenderer("lib/api.ts")]: "export const api=window.labApi;",
  [absRenderer("lib/monacoSetup.ts")]: "export const monacoSetup=()=>{};export default {};",
};

const entry = join(buildDir, "app-entry.tsx");
writeFileSync(entry, `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from ${JSON.stringify(absRenderer("App.tsx"))};
import {useSessionStore} from ${JSON.stringify(absRenderer("stores/sessionStore.ts"))};
import {useToastStore} from ${JSON.stringify(absRenderer("stores/toastStore.ts"))};
window.React=React;
window.__store=useSessionStore;
window.__toast=useToastStore;
window.addEventListener('error', (e) => console.error('[u1-window-error] ' + (e.error && e.error.stack || e.message)));
window.addEventListener('unhandledrejection', (e) => console.error('[u1-unhandled] ' + (e.reason && e.reason.stack || e.reason)));
try{
  // 与生产 main.tsx 相同：Uncaught error 打全栈（React 19 默认只留一句无栈日志）。
  createRoot(document.getElementById('root'), {
    onUncaughtError: (error, info) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error('[u1-react-uncaught] ' + detail + (info && info.componentStack ? '\\n' + info.componentStack : ''));
    },
  }).render(<App/>);
  window.__mounted=true;
}catch(e){
  window.__mountError=String((e&&e.stack)||e);
  throw e;
}
`);

await esbuild({
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  absWorkingDir: desktop,
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: join(buildDir, "bundle.js"),
  logLevel: "error",
  loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty", ".ttf": "empty", ".png": "empty", ".svg": "empty" },
  plugins: [{
    name: "shell-stubs",
    setup(b) {
      b.onResolve({ filter: /\?(worker|url|raw)$/ }, (a) => ({ path: a.path, external: true }));
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind !== "import-statement" && a.kind !== "require-call" && a.kind !== "dynamic-import") return undefined;
        const raw = a.path;
        const isAlias = raw.startsWith("@renderer/");
        const isRel = raw.startsWith("./") || raw.startsWith("../");
        if (!isAlias && !isRel) return undefined;
        const resolved = resolveTs(isAlias ? join(rendererRoot, raw.slice(10)) : resolve(a.resolveDir, raw));
        if (resolved in stubs) return { path: resolved, namespace: "mock" };
        return isAlias ? { path: resolved } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({ contents: stubs[a.path], loader: "tsx", resolveDir: desktop }));
    },
  }],
});

// Tailwind：与其余 UI 套件共用缓存实现（.tmp/tw-cache）。
const tailwindConfig = join(buildDir, "tailwind.config.cjs");
writeFileSync(
  tailwindConfig,
  readFileSync(join(desktop, "tailwind.config.js"), "utf8")
    .replace("export default", "module.exports =")
    .replace('content: ["./src/renderer/**/*.{ts,tsx,html}"]', "content: " + JSON.stringify([rendererRoot.replaceAll("\\", "/") + "/**/*.{ts,tsx,html}"])),
);
const css = buildTailwindCached({
  cliPath: pkgPath("tailwindcss@", "tailwindcss/lib/cli.js"),
  configPath: tailwindConfig,
  inputCss: "src/renderer/styles.css",
  outPath: join(buildDir, "app.css"),
  cwd: desktop,
});
if (css.status !== undefined && css.status !== 0) throw Error("tailwind failed");

copyFileSync(join(suite, "api-stub.js"), join(buildDir, "api-stub.js"));
// CSP 与 arc005 的页面一致：不联网。
writeFileSync(
  join(buildDir, "page.html"),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; worker-src 'none'">
<title>mcode u1 harness</title><link rel="stylesheet" href="./app.css"></head>
<body style="margin:0"><div id="root" style="height:100vh"></div><script src="./api-stub.js"></script><script src="./bundle.js"></script></body></html>`,
);

/* ─────────────────────── 2. 产品真 preload（journey-2 用） ─────────────────────── */

await esbuild({
  entryPoints: [join(desktop, "src/preload/index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(buildDir, "product-preload.cjs"),
  logLevel: "error",
  external: ["electron"],
});

/* ─────────────────────────── 3. 旅程 runner + 注册表 ─────────────────────────── */

// 变异：只替换 assertionStatus 的函数体（内存里），磁盘上的套件源码不动。
if (mutation === "unconditional-pass") {
  const runnerPath = join(suite, "driver/runner.ts");
  const original = readFileSync(runnerPath, "utf8");
  const hook = `export function assertionStatus(ok: boolean): "PASS" | "FAIL" {\n  return ok ? "PASS" : "FAIL";\n}`;
  if (!original.includes(hook)) throw Error("U1 mutation: assertionStatus 的原文变了，变异注入点失配（先更新 build.mjs 的 hook）");
  const mutated = original.replace(hook, `export function assertionStatus(_ok: boolean): "PASS" | "FAIL" {\n  return "PASS"; /* T16 mutation: 无条件通过 */\n}`);
  await esbuild({
    stdin: { contents: mutated, resolveDir: dirname(runnerPath), loader: "ts", sourcefile: "runner.ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    tsconfig: join(desktop, "tsconfig.json"),
    absWorkingDir: desktop,
    outfile: join(buildDir, "runner.cjs"),
    logLevel: "error",
    external: ["electron"],
  });
  console.log("U1 MUTATION ACTIVE: assertionStatus 无条件 PASS（仅本次构建，源码未改）");
} else {
  await esbuild({
    entryPoints: [join(suite, "driver/runner.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    tsconfig: join(desktop, "tsconfig.json"),
    absWorkingDir: desktop,
    outfile: join(buildDir, "runner.cjs"),
    logLevel: "error",
    external: ["electron"],
  });
}
/** T7：`--esbuild=` 指向的模块（可选）导出的附加选项。 */
const extraEsbuildOptions = esbuildSpec === null
  ? {}
  : (await import(pathToFileURL(esbuildSpec).href)).options ?? {};
if (esbuildSpec !== null && (typeof extraEsbuildOptions !== "object" || extraEsbuildOptions === null)) {
  throw Error("U1 build: --esbuild 模块必须导出 { options } 对象");
}

await esbuild({
  entryPoints: [registry],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(buildDir, "journeys.cjs"),
  logLevel: "error",
  external: ["electron"],
  ...extraEsbuildOptions,
});

/* ───────────────────────── 4. 旅程自带的最小页面模板 ───────────────────────── */

// 02 号旅程的页面：把内联 HTML 落到 build 目录（runner 按 launch.page.file 找）。
const sideEffectSrc = readFileSync(join(suite, "journeys/02-file-side-effect.ts"), "utf8");
const pageMatch = /const PAGE = `([\s\S]*?)`;\n/.exec(sideEffectSrc);
if (!pageMatch) throw Error("U1 build: 02-file-side-effect.ts 里找不到 PAGE 模板");
writeFileSync(join(buildDir, "file-save.html"), pageMatch[1]);

/* ────────────────────────────── 5. 逐旅程跑 ────────────────────────────── */

const require_ = createRequire(join(desktop, "package.json"));
const electron = require_("electron");
if (typeof electron !== "string" || !existsSync(electron)) {
  throw Error("Existing installed Electron binary required; no download allowed");
}

// 旅程名列表：从打包产物里读（避免 Node 直接 import TS）。
const journeysModule = await import(pathToFileURL(join(buildDir, "journeys.cjs")).href);
const allJourneys = journeysModule.default?.journeys ?? journeysModule.journeys;
if (!Array.isArray(allJourneys) || allJourneys.length === 0) throw Error("U1 build: journeys.cjs 没有导出 journeys 数组");
const selected = only === null ? allJourneys.map((_, i) => i) : allJourneys.map((j, i) => (j.name === only ? i : -1)).filter((i) => i >= 0);
if (only !== null && selected.length !== 1) throw Error(`--only=${only} 没有匹配到唯一旅程`);
const journeys = selected.map((i) => allJourneys[i]);

const results = [];
for (let k = 0; k < journeys.length; k++) {
  const journey = journeys[k];
  const journeyIndex = selected[k]; // 传给 runner 的是**原始**索引（journeys.cjs 的数组下标）
  const dir = join(evidenceRoot, journey.name);
  mkdirSync(dir, { recursive: true });
  const runDir = join(buildDir, "run", journey.name);
  const dataDir = join(runDir, "data");
  const projectDir = join(runDir, "project");
  const homeDir = join(runDir, "home");
  for (const p of [dataDir, projectDir, homeDir, join(runDir, "userData"), join(runDir, "temp")]) mkdirSync(p, { recursive: true });
  const stateFile = join(runDir, "state.json");
  const crashToken = randomUUID();
  writeFileSync(stateFile, "null");
  const docPath = join(projectDir, "u1-doc.txt");
  writeFileSync(docPath, "U1 alpha\n");

  const env = {
    ...process.env,
    MCODE_U1_DIR: dir,
    MCODE_U1_BUILD: buildDir,
    MCODE_U1_RUN: runDir,
    MCODE_U1_DATA: dataDir,
    MCODE_U1_PROJECT: projectDir,
    MCODE_U1_DOC: docPath,
    MCODE_U1_JOURNEY: String(journeyIndex),
    MCODE_U1_STATE: stateFile,
    MCODE_U1_CRASH_TOKEN: crashToken,
    MCODE_U1_REPO: repo,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: join(runDir, "userData"),
    LOCALAPPDATA: join(runDir, "localAppData"),
    TEMP: join(runDir, "temp"),
    TMP: join(runDir, "temp"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`\n=== journey ${k + 1}/${journeys.length}: ${journey.name} (expect=${journey.expect ?? "pass"}) ===`);
  let generation = 0;
  let lastStatus = null;
  for (;;) {
    generation += 1;
    const run = await runOwnedProcess(electron, [join(suite, "electron-host.cjs")], {
      cwd: desktop,
      env,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      killOnStdout: "MCODE_U1_CRASH_READY:" + crashToken,
    });
    const logFile = join(dir, `run-g${generation}.log`);
    writeFileSync(logFile, (run.stdout ?? "") + (run.stderr ?? ""));
    process.stdout.write(run.stdout ?? "");
    if (run.stderr) process.stderr.write(run.stderr);
    lastStatus = run.status;
    if (run.error?.code === "SIGINT" || run.error?.code === "SIGTERM") {
      throw run.error; // Stop the entire journey loop after interruption.
    }
    if (run.status === 77) {
      // relaunch 请求 —— 读 state 里下一步的偏移，仅用于日志。
      const st = JSON.parse(readFileSync(stateFile, "utf8"));
      console.log(`  [relaunch] generation ${generation} exited 77 (stepOffset=${st.stepOffset}); starting a NEW OS process`);
      continue;
    }
    // A dedicated crashRelaunch step must really kill the isolated Electron
    // OS process. Never treat a normal exit, arbitrary timeout/spawn error or
    // stale state from another generation as a successful crash.
    let crashState = null;
    try { crashState = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* absent */ }
    const armed = crashState?.crashArmed;
    const crashConfirmed = armed &&
      crashState.generation === generation &&
      armed.generation === generation &&
      armed.stepOffset === crashState.stepOffset &&
      armed.pid === crashState.pids?.at(-1) &&
      !run.error &&
      run.supervisorKilled === true &&
      (run.signal === "SIGKILL" || (process.platform === "win32" && run.status !== null && run.status !== 0 && run.status !== 77));
    if (crashConfirmed) {
      crashState.confirmedCrash = {
        pid: armed.pid, generation, status: run.status, signal: run.signal,
      };
      delete crashState.crashArmed;
      writeFileSync(stateFile, JSON.stringify(crashState, null, 2));
      console.log(`  [SIGKILL] verified abrupt Electron process death, pid=${armed.pid}, exit=${run.status}, signal=${run.signal}; starting fresh OS process`);
      continue;
    }
    if (run.status === null) {
      writeFileSync(join(dir, "spawn-error.json"), JSON.stringify({ error: String(run.error ?? "spawn failed"), signal: run.signal }, null, 2));
    }
    break;
  }

  let result = null;
  try { result = JSON.parse(readFileSync(join(dir, "journey-result.json"), "utf8")); } catch { /* missing below */ }
  if (!result) {
    const failedResult = {
      name: journey.name,
      status: "FAIL",
      literalStatus: "FAIL",
      expectation: "unexpected-failure",
      reason: `Electron 进程没有写出 journey-result.json（exit=${lastStatus}, generations=${generation}）—— 见 ${dir} 下 run-g*.log`,
      steps: [],
      evidenceDir: dir,
      generations: generation,
      pids: [],
    };
    writeFileSync(join(dir, "journey-result.json"), JSON.stringify(failedResult, null, 2));
    result = failedResult;
  }
  result.generations = generation;
  results.push(result);
  const failedStep = result.failedStep ? ` failedStep=${result.failedStep}` : "";
  console.log(`  → ${journey.name}: literal=${result.literalStatus} expectation=${result.expectation} (${generation} OS process${generation > 1 ? "es" : ""})${failedStep}`);
}

/* ────────────────────────────── 6. 汇总与退出码 ────────────────────────────── */

const unexpected = results.filter((r) => r.expectation === "unexpected-failure");
const expected = results.filter((r) => r.expectation === "expected-failure");
const allPass = results.filter((r) => r.expectation === "all-pass");

const summary = {
  schema: 1,
  mutation,
  evidenceRoot,
  buildDir,
  journeys: results.map((r) => ({
    name: r.name,
    expect: r.expect,
    literalStatus: r.literalStatus,
    expectation: r.expectation,
    failedStep: r.failedStep ?? null,
    generations: r.generations,
    pids: r.pids ?? [],
    steps: r.steps.length,
    evidenceDir: r.evidenceDir,
    ...(r.reason ? { reason: r.reason } : {}),
  })),
  counts: { total: results.length, allPass: allPass.length, expectedFailure: expected.length, unexpectedFailure: unexpected.length },
};
writeFileSync(join(evidenceRoot, "suite-summary.json"), JSON.stringify(summary, null, 2));

const exitCode = unexpected.length > 0 ? 2 : expected.length > 0 ? 1 : 0;
console.log(`\nU1 suite: ${results.length} journeys — all-pass=${allPass.length} expected-failure=${expected.length} unexpected-failure=${unexpected.length}`);
for (const r of results) {
  console.log(`  ${r.name}: literal=${r.literalStatus} expectation=${r.expectation}${r.failedStep ? ` (failed at ${r.failedStep})` : ""}`);
}
if (unexpected.length > 0) {
  for (const r of unexpected) console.error(`UNEXPECTED FAILURE ${r.name}: ${r.reason ?? "unknown"}`);
}

// 变异模式下的自我校验：断言被旁路后**不允许**再出现 expected-failure，
// 且 journey-3 的 literalStatus 必须是 PASS。否则变异没生效。
if (mutation === "unconditional-pass") {
  const deliberate = results.find((r) => r.expect === "fail");
  if (!deliberate || deliberate.literalStatus !== "PASS") {
    console.error("U1 MUTATION CHECK FAILED: 变异后「故意失败」旅程仍然是 FAIL —— 变异没有生效，或断言判定还有第二条路径");
    process.exitCode = 3;
  } else if (expected.length > 0) {
    console.error("U1 MUTATION CHECK FAILED: 变异后仍有预期失败旅程");
    process.exitCode = 3;
  } else {
    console.log("U1 MUTATION CHECK: 断言被旁路后「故意失败」旅程已变绿 —— 变异验证成立");
    process.exitCode = exitCode;
  }
} else {
  // 正常跑：若注册表声明了「故意失败」旅程，它**必须**以 expected-failure 出现；
  // 变绿说明断言没在判。T7 这类纯产品旅程注册表没有该旅程 —— 它的「断言在判」
  // 由 `--mutation=unconditional-pass` 对照跑证明（run.mjs 负责），这里不强制。
  const deliberate = results.find((r) => r.expect === "fail");
  if (deliberate && deliberate.expectation !== "expected-failure") {
    console.error("U1 SELF-CHECK FAILED: 「故意失败」旅程没有按预期失败 —— 骨架可能在假绿");
    process.exitCode = 3;
  } else {
    process.exitCode = exitCode;
  }
}

// 失败/变异时保留现场提示（默认也不删；构建目录在 .tmp 下，git 忽略）。
if (process.exitCode !== 0 && process.exitCode !== 1) {
  console.error(`U1 evidence kept at: ${evidenceRoot}`);
}
