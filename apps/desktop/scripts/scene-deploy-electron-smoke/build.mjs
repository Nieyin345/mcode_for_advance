/**
 * 【MC-002】真 Electron 下「场景部署崩溃续跑」UI U1 的启动器。
 *
 * ## 与无头套件的分工
 *
 * `scene-crash-resume-smoke` 用真三进程验主进程链路;`scene-deploy-view-smoke` 用纯函数
 * 验状态机。这一套起**真 Electron 二进制**、真 `BrowserWindow`、真渲染端、真
 * `SceneDeployPanel`,只验无头证明不了的那一半:用户在空输入框上**看得见**盘上的记录、
 * 点「恢复到输入框」把原快照拿回来、重新预览批准后点「续跑剩余步骤」只跑剩下的步。
 *
 * ## 隔离
 *
 * 所有 app 路径(userData/sessionData/logs/crashDumps/home/data)都重指到本套件的
 * mktemp 目录 —— 不碰用户真实数据根。数据根走 electron-host.cjs 写的
 * `userData/data-root.json`(与生产同一条读法:`@main/lib/dataRoot.ts`),不用桩 ——
 * 因为探针就跑在真 Electron 主进程里。
 *
 * ## 为什么必须由启动器判成败
 *
 * 隐藏窗口关掉后 Electron 会隐式 exit 0;断言失败若只看进程退出码会被吞掉。探针把每条
 * 断言写进 `checks.json`,启动器要求 **exit 0 且每条都 PASS 且条数 ≥ 12** 才算过。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildTailwindCached } from "../lib/tailwind-cache.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const pnpm = resolve(desktop, "../../node_modules/.pnpm");
if (process.argv.length > 2) throw Error("Unknown test option");

const esbuildDir = readdirSync(pnpm).find((n) => n.startsWith("esbuild@"));
if (!esbuildDir) throw Error("Installed esbuild required (no install/network fallback)");
const esbuild = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/scene-deploy-electron-"));
console.log("Scene deploy U1 evidence: " + dir);

/* ── 1. 主进程探针(CJS,external electron;原生模块外置) ──
 *
 * 探针 import 的是**生产**的 scene / orchestration IPC 注册链 —— 那条链会经
 * `providers/registry` 拖上 ssh2(cpu-features 原生模块)与 sherpa-onnx。真 Electron
 * 主进程里这两者都能 `require`(已实测);esbuild 侧把它们标 external、运行时按
 * `apps/desktop/node_modules` 解析 —— 与生产打包器对原生模块的处置同形。
 * `window.ts` 换成只有 5 个导出面的桩(探针自己管窗口,不用单例)。
 */
await esbuild.build({
  entryPoints: [join(suite, "probe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "probe.cjs"),
  logLevel: "error",
  external: ["electron", "ssh2", "cpu-features", "sherpa-onnx-node"],
  loader: { ".md": "text" },
  alias: {
    "@main/window.js": join(suite, "stubs/window.ts"),
    // T52: the scene probe never creates a native Office view; Vite ?raw vendor
    // browser scripts are not parseable by this headless esbuild CJS bundle.
    "@main/document/genofficeNativeVendor.js": join(desktop, "src/main/document/genofficeNativeVendorStub.ts"),
  },
});

/* ── 2. 渲染端:真 SceneDeployPanel 的 IIFE + Tailwind CSS + 页面 ──
 *
 * 不换任何被测模块:`api.ts` 在生产里就是 `window.api ?? createWebApi()`,而 bridge.cjs
 * 在页面脚本之前注入了真 `window.api.scene`。`?worker` 是打包器方言(只在 vite 里有),
 * 这里给一个不会被用到的空 worker(面板不挂编辑器)。
 */
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

copyFileSync(join(suite, "bridge.cjs"), join(dir, "bridge.cjs"));
copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));

/* ── 3. 探针加载的页面 —— 本地文件 + 严格 CSP(不联网) ── */
writeFileSync(
  join(dir, "page.html"),
  `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:">
<link rel="stylesheet" href="./app.css">
<title>scene deploy electron u1</title></head>
<body><div id="root"></div><script src="./bundle.js"></script></body></html>`,
);

/* ── 4. 真 Electron 二进制 + 隔离环境 ── */
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
  MCODE_SDP_DIR: dir,
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
const complete = checks.length >= 12 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`SCENE DEPLOY U1 FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  for (const f of failed) console.error(`  FAIL ${f.name}: ${f.error ?? ""}`);
  process.exitCode = 1;
} else {
  console.log(`scene-deploy-electron-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过`);
}
