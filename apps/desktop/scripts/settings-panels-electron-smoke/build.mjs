/**
 * 【MC-026 复核】真 Electron 下三个设置面板的「读失败可见 / 重试真重发 / 保存失败保留
 * 输入」U1 —— 启动器。
 *
 * ## 与无头套件的分工
 *
 * `settings-form-lifecycle-smoke` 用极小 React 运行时验同一批状态机(快、可变异);
 * 这一套起**真 Electron 二进制**、隐藏窗口、真 DOM + 真 React 渲染真面板,验无头
 * 证明不了的那一半:错误条**真的画在页面上**、点「重试」**真的重发**、保存失败后
 * 输入框里**仍是用户敲的字**。
 *
 * ## 隔离
 *
 * `electron-host.cjs` 把 app 的全部路径(userData/sessionData/logs/crashDumps/home)
 * 重指到本套件的 mktemp 目录;`window.api` 由 `api-stub.js` 在页面脚本之前注入
 * (纯内存,不联网、不碰用户数据根)。被测组件、i18n、UI 原语、CSS 都是生产源码。
 *
 * ## 为什么必须由启动器判成败
 *
 * 隐藏窗口关掉后 Electron 会隐式 exit 0;断言失败若只看进程退出码会被吞掉。探针把
 * 每条断言写进 `checks.json`,启动器要求 **exit 0 且每条都 PASS 且条数 ≥ 15** 才算过。
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
const dir = mkdtempSync(join(desktop, ".tmp/settings-panels-electron-"));
console.log("Settings panels electron evidence: " + dir);

// ── 1. 主进程探针(CJS,electron 外置) ──
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
});

// ── 2. 渲染端:真面板的 IIFE + Tailwind CSS + 页面 ──
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
    name: "worker-stub",
    setup(b) {
      b.onResolve({ filter: /\?worker$/ }, (a) => ({ path: a.path, namespace: "test-worker" }));
      b.onLoad({ filter: /.*/, namespace: "test-worker" }, () => ({ loader: "js", contents: "export default class WorkerStub {}" }));
    },
  }],
});

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

// 夹具:节点类型目录(内置清单,生成物随套件提交,不读用户环境)。
copyFileSync(join(suite, "catalog.generated.json"), join(dir, "catalog.generated.json"));
copyFileSync(join(suite, "api-stub.js"), join(dir, "api-stub.js"));
copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));

writeFileSync(
  join(dir, "page.html"),
  `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:">
<link rel="stylesheet" href="./app.css">
<title>settings panels electron u1</title></head>
<body><div id="root"></div><script src="./api-stub.js"></script><script src="./bundle.js"></script></body></html>`,
);

// ── 3. 真 Electron 二进制 + 隔离环境 ──
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
  MCODE_SPE_DIR: dir,
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
  timeout: 170000,
  maxBuffer: 32 * 1024 * 1024,
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
const complete = checks.length >= 13 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`SETTINGS PANELS U1 FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  for (const f of failed) console.error(`  FAIL ${f.name}: ${f.error ?? ""}`);
  process.exitCode = 1;
} else {
  console.log(`settings-panels-electron-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过`);
}
