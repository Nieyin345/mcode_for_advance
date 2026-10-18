/**
 * 【MC-054】真 Electron 两端并发保存守望模板的 U1 —— 启动器。
 *
 * ## 与无头套件的分工
 *
 * `orchestration-ipc-smoke` §9 用 `fakeIpc` 验了 CAS 分支本身；这一套起**真 Electron
 * 二进制**、真窗口、真 preload、真 sql.js 库（mktemp 数据根），验台账 remaining 的
 * 那两条：真渲染端与 Agent 通路（`app_api_call`）**同时保存**，以及 `WatchSegment`
 * 真组件冲突后界面换成盘上内容。
 *
 * ## 隔离
 *
 * `electron-host.cjs` 把 app 的全部路径（userData/sessionData/logs/crashDumps/home）
 * 与 data-root 指针重指到本套件的 `.tmp/watch-templates-cas-electron-*` 目录 —— 不碰
 * 用户真实数据根。不联网：页面是本地 `file://`，CSP `connect-src 'none'`。
 *
 * ## 为什么必须由启动器判成败
 *
 * 隐藏窗口关掉后 Electron 会隐式 exit 0；断言失败若只看进程退出码会被吞掉。探针把
 * 每条断言写进 `checks.json`，启动器要求 **exit 0 且每条都 PASS** 才算过。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
if (process.argv.length > 2) throw Error("Unknown test option");

const esbuildDir = readdirSync(pnpm).find((n) => n.startsWith("esbuild@"));
if (!esbuildDir) throw Error("Installed esbuild required (no install/network fallback)");
const { build } = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/watch-templates-cas-electron-"));
console.log("Watch templates CAS U1 evidence: " + dir);

// ── 主进程探针（CJS，electron 外置）────────────────────────────────────────
// 四个 `.js` 换桩理由见 stubs/mainPorts.ts：`@main/window.js` 会拖进语音引擎原生模块；
// `RuntimeManager` / `providers/registry.js` / `probeProviderHealth` 会拉起三家引擎，
// 而本套只走"读/存守望模板"这一条 handler。被测的 `ipc/orchestration.ts`、
// `appControl/tools.ts`、`store/db.ts`、`SettingRepo` 全是真代码。
await build({
  entryPoints: [join(suite, "probe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "probe.cjs"),
  logLevel: "error",
  external: ["electron", "ssh2"],
  loader: { ".md": "text", ".py": "text", ".txt": "text", "": "text" },
  plugins: [
    {
      name: "main-ports",
      setup(b) {
        b.onResolve({ filter: /(?:^|\/)RuntimeManager\.js$/ }, () => ({ path: join(suite, "stubs/mainPorts.ts") }));
        b.onResolve({ filter: /providers\/registry\.js$/ }, () => ({ path: join(suite, "stubs/mainPorts.ts") }));
        b.onResolve({ filter: /(?:^|\/)window\.js$/ }, () => ({ path: join(suite, "stubs/mainPorts.ts") }));
      },
    },
  ],
});

// ── 真 preload（与生产同源：src/preload/index.ts，CJS）────────────────────
await build({
  entryPoints: [join(desktop, "src/preload/index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "preload.cjs"),
  logLevel: "error",
  external: ["electron"],
});

// ── 渲染端 bundle（真组件；只换 api 传输与浏览器视图抑制两个叶子）────────
await build({
  entryPoints: [join(suite, "renderer.tsx")],
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  nodePaths: [join(desktop, "node_modules"), resolve(desktop, "../..", "node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty", ".ttf": "empty", ".png": "dataurl", ".svg": "dataurl" },
  outfile: join(dir, "renderer.js"),
  logLevel: "error",
  plugins: [
    {
      name: "renderer-leaves",
      setup(b) {
        // monaco/pdf 的 `?worker` 只在编辑器路径上被 import；本套件一个都用不到。
        b.onResolve({ filter: /\?worker$/ }, (a) => ({ path: a.path, namespace: "smoke-worker" }));
        b.onLoad({ filter: /.*/, namespace: "smoke-worker" }, () => ({
          loader: "js",
          contents: "export default class WorkerStub {}",
        }));
      },
    },
  ],
  alias: {
    // 桌面下 `api` 就是真 preload 注入的 window.api（api.ts 的 `window.api ?? createWebApi()`）。
    "@renderer/lib/api.js": join(suite, "stubs/api.ts"),
    // 真 hook 依赖 7000 行的 sessionStore（拖 monaco）与几何测量；本套不验浏览器视图。
    "@renderer/hooks/useSuppressBrowserView.js": join(suite, "stubs/suppressBrowserView.ts"),
  },
});

writeFileSync(join(dir, "index.html"), `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:">
<title>watch templates cas u1</title></head>
<body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>`);

copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));

const require = createRequire(join(desktop, "package.json"));
const electron = require("electron");
if (typeof electron !== "string" || !existsSync(electron)) {
  throw Error("Existing installed Electron binary required; no download allowed");
}

const home = join(dir, "home");
const temp = join(dir, "temp");
mkdirSync(home, { recursive: true });
mkdirSync(temp, { recursive: true });
const env = {
  ...process.env,
  MCODE_WT_CAS_DIR: dir,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(dir, "userData"),
  LOCALAPPDATA: join(dir, "localAppData"),
  TEMP: temp,
  TMP: temp,
};
delete env.ELECTRON_RUN_AS_NODE;

const run = spawnSync(electron, [join(dir, "electron-host.cjs")], {
  cwd: desktop,
  env,
  encoding: "utf8",
  timeout: 150000,
  maxBuffer: 16 * 1024 * 1024,
});
const output = (run.stdout ?? "") + (run.stderr ?? "");
writeFileSync(join(dir, "run.log"), output);
process.stdout.write(output);

let checks = [];
try {
  checks = JSON.parse(readFileSync(join(dir, "checks.json"), "utf8"));
} catch {
  checks = [];
}
const failed = checks.filter((c) => c.status !== "PASS");
// 本套至少 8 条真 Electron 断言 —— 少于这个数说明探针根本没跑完（或有人在删断言）。
const complete = checks.length >= 12 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`WATCH TEMPLATES CAS U1 FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  console.log(`watch-templates-cas-electron-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过`);
}
