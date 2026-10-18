/**
 * 【ARC-005】真 Electron 端到端 —— 启动器（骨架同 document-view-electron-smoke /
 * settings-panels-electron-smoke）。
 *
 * 组装：
 *   - `probe.cjs`：主进程探针（真 DB + 真 browser IPC handler + 真 BrowserManager）；
 *   - `bundle.js`：渲染端 IIFE（真 `HtmlPreviewButton` + 真 `BrowserPanel`）；
 *   - `bridge.cjs`：preload（生产同款 `window.api.browser.*` + 两只只读查询）；
 *   - `electron-host.cjs`：隔离窗口宿主。
 *
 * 隔离：全部 app 路径重指到本套 mktemp 目录；不联网（页面 CSP connect-src 'none'）。
 * 判据由启动器汇总 `checks.json`：必须 exit 0 且每条 PASS 且条数 ≥ 8。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildTailwindCached } from "../lib/tailwind-cache.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
if (process.argv.length > 2) throw Error("Unknown test option");

const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const esbuildDir = readdirSync(pnpm).find((n) => n.startsWith("esbuild@"));
if (!esbuildDir) throw Error("Installed esbuild required (no install/network fallback)");
const esbuild = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/html-preview-electron-"));
console.log("HTML preview electron evidence: " + dir);

// ── 1. 主进程探针（CJS，electron 外置） ──
await esbuild.build({
  entryPoints: [join(suite, "probe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "probe.cjs"),
  logLevel: "error",
  external: ["electron"],
  // 真 window.ts 惰性拖上 sherpa-onnx 的原生模块(.node) —— 本套不需要它,
  // 换成只提供 getMainWindow/sendToRenderer 的替身(探针把真 BrowserWindow 注入)。
  alias: { "@main/window.js": join(suite, "windowStub.ts") },
});

// ── 2. 渲染端：真 HtmlPreviewButton + 真 BrowserPanel ──
await esbuild.build({
  entryPoints: [join(suite, "renderer.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty", ".woff2": "empty", ".woff": "empty", ".ttf": "empty", ".png": "dataurl", ".svg": "dataurl" },
  outfile: join(dir, "bundle.js"),
  logLevel: "error",
  plugins: [{
    name: "heavy-stubs",
    setup(b) {
      // 重量级 / 与判据无关的模块换成空壳：
      //  - monacoSetup：真实现会拉 monaco 的 worker 装配（本套不挂 Monaco 编辑器，
      //    只挂工具栏按钮与浏览器面板）；
      //  - 图标 barrel：几千导出，JSX 里只是组件类型，从不影响判据。
      b.onResolve({ filter: /^@renderer\/lib\/monacoSetup\.js$/ }, () => ({ path: "empty", namespace: "stub" }));
      b.onResolve({ filter: /\?worker$/ }, (a) => ({ path: a.path, namespace: "test-worker" }));
      b.onLoad({ filter: /.*/, namespace: "test-worker" }, () => ({
        loader: "js",
        contents: "export default class WorkerStub {}",
      }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "", loader: "js" }));
    },
  }],
});

// ── 3. Tailwind（真 styles.css）──
const tailwindDir = readdirSync(pnpm).find((n) => n.startsWith("tailwindcss@"));
if (!tailwindDir) throw Error("Installed tailwindcss required");
const configPath = join(dir, "tailwind.config.cjs");
writeFileSync(
  configPath,
  readFileSync(join(desktop, "tailwind.config.js"), "utf8")
    .replace("export default", "module.exports =")
    .replace(
      'content: ["./src/renderer/**/*.{ts,tsx,html}"]',
      "content: " + JSON.stringify([join(desktop, "src/renderer").replaceAll("\\", "/") + "/**/*.{ts,tsx,html}"]),
    ),
);
const css = buildTailwindCached({
  cliPath: join(pnpm, tailwindDir, "node_modules/tailwindcss/lib/cli.js"),
  configPath,
  inputCss: "src/renderer/styles.css",
  outPath: join(dir, "app.css"),
  cwd: desktop,
});
if (css.status !== undefined && css.status !== 0) throw Error("tailwind failed");

copyFileSync(join(suite, "bridge.cjs"), join(dir, "bridge.cjs"));
copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));
writeFileSync(
  join(dir, "page.html"),
  `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:">
<link rel="stylesheet" href="./app.css">
<title>html preview electron u1</title></head>
<body><div id="root"></div><script src="./bundle.js"></script></body></html>`,
);

// ── 4. 真 Electron 二进制 + 隔离环境 ──
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
  MCODE_HPE_DIR: dir,
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
  timeout: 180000,
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
const complete = checks.length >= 8 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`HTML PREVIEW E2E FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  console.log(`html-preview-electron-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过`);
}
