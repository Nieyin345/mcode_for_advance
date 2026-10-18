/**
 * 【ARC-007 / GenOffice AI 交互】AI Ask 链路真 Electron 启动器。
 *
 * 与 document-view-vendor-page-smoke 同一形态：真实 vendor docs 构建产物 +
 * `documentViewPreload.ts` 打包为 CJS preload + 隔离 app 路径。产物缺失时如实
 * skip（exit 0）。
 *
 * ## 与生产 preload 的关系
 *
 * 生产源码一字不动地打包；随后在**打包产物**末尾机械追加本套件需要的探针桥
 * （`aiStream`/`aiStreamCancel`/`onAiStream`，并把 `getAiSettings` 指向本地 mock
 * 端点）。理由：后半段「发送 → 流式 → 工具 → 文档被改」必须经 vendor 的 AI
 * 传输三件套，而生产 preload 有意不提供它们（AI 归 Mcode 三引擎）。探针断言
 * 会核对生产源码里没有这些键，探针桥只存在于本套件的产物。
 *
 * ## mock 端点
 *
 * 探针在 Electron 主进程里起 `node:http`，只绑 127.0.0.1 随机端口，并用 vendor
 * **同一份** `streamForProvider` 协议栈消费 SSE —— 不联网、不手写协议解析。
 *
 * 断言由探针写进 `checks.json`，启动器要求 exit 0 且每条 PASS。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// smokes-for 的覆盖声明：本套件把生产 preload 原样打包进真 Electron。
// @smoke-covers src/main/document/documentViewPreload.ts

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repoRoot = resolve(desktop, "../..");
const pagePath = join(repoRoot, "genoffice", "apps", "docs", "out", "renderer", "index.html");

if (process.argv.length > 2) throw Error("Unknown test option");

if (!existsSync(pagePath)) {
  console.log(`genoffice-ai-ask-smoke: skip（未构建：${pagePath}）`);
  process.exit(0);
}

const pnpm = resolve(desktop, "../../node_modules/.pnpm");
const esbuildDir = readdirSync(pnpm).find((n) => n.startsWith("esbuild@"));
if (!esbuildDir) throw Error("Installed esbuild required (no install/network fallback)");
const { build } = await import(pathToFileURL(join(pnpm, esbuildDir, "node_modules/esbuild/lib/main.js")).href);

mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp/genoffice-ai-ask-"));

await build({
  entryPoints: [join(suite, "probe.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "probe.cjs"),
  logLevel: "error",
  external: ["electron"],
  // 本探针在主进程里复用 vendor 的**真** AI 协议栈（`streamForProvider`）处理
  // mock 端点的流式回包 —— 与 vendor 主进程同一份实现，不手写 SSE 解析。
  // vendor 包在 genoffice/node_modules 里是指向源码的 symlink，esbuild 从
  // apps/desktop 出发解析不到；显式 alias 到源码入口。
  alias: {
    "@genoffice/ai-provider": join(repoRoot, "genoffice/packages/ai-provider/src/index.ts"),
    // 真 `DocumentViewHost` 顶层 import `@main/window.js`（生产默认解析器），那个
    // 模块拖上语音引擎原生模块；探针显式注入窗口，用不到默认解析器 —— 换桩。
    "@main/window.js": join(suite, "stubs/window.ts"),
  },
  nodePaths: [join(repoRoot, "genoffice/node_modules")],
});
await build({
  entryPoints: [join(desktop, "src/main/document/documentViewPreload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "documentViewPreload.js"),
  logLevel: "error",
  external: ["electron"],
});

// 【探针专用】在**生产产物**上机械追加本套件需要的三个桥桩。生产源码
// `documentViewPreload.ts` 一字不动（它的 `getAiSettings` 仍是「未配置」）；
// 这里只是把打包后的 bundle 末尾换成"先挂桩、再冻结暴露"——同一文件、同一
// contextBridge 调用，桩清单由本套件独一无二地决定。断言会核对生产源码里没有
// 这些键（防越界）。
const preloadBundle = join(dir, "documentViewPreload.js");
const bundleSource = readFileSync(preloadBundle, "utf8");
// esbuild 产物的暴露语句带着 `import_electron.` 前缀 —— marker 必须整行匹配，
// 否则替换后留下 `import_electron.` 半截、preload 语法错误、整页白屏。
const exposeMarker = "import_electron.contextBridge.exposeInMainWorld(\"desktop\", Object.freeze(api));";
if (!bundleSource.includes(exposeMarker)) {
  throw new Error("preload bundle shape changed: expose marker not found");
}
const probeBridge = `
// ── 【genoffice-ai-ask-smoke 探针覆盖】仅存在于打好的探针 preload 里 ──
// 真 Electron 页面要用 vendor 的 AI 传输三件套（docs/src/shared/ipc.ts:559-561,648）：
// aiStream / aiStreamCancel / onAiStream。生产 preload 有意不提供（AI 由 Mcode
// 三引擎驱动），本套件用它们驱动**本地 mock 端点**验证「发送→流→工具→文档被改」。
// getAiSettings 同时覆盖为指向 mock 的 custom provider（生产仍是 genspark 未配置，
// 由源码级断言钉住）。settings 经 IPC 从主进程取 —— sandboxed preload 里没有
// process.env，不能把 mock 配置烘进 bundle。
api.getAiSettings = () => import_electron.ipcRenderer.invoke("probe:mock-ai-settings");
api.aiStream = (request) => import_electron.ipcRenderer.invoke("ai:stream", request);
api.aiStreamCancel = (requestId) => import_electron.ipcRenderer.invoke("ai:stream-cancel", requestId);
api.onAiStream = (handler) => {
  const listener = (_event, chunk) => handler(chunk);
  import_electron.ipcRenderer.on("ai:stream-chunk", listener);
  return () => import_electron.ipcRenderer.removeListener("ai:stream-chunk", listener);
};
// 宿主 openPath 会推 menu:command("open-path", path)；vendor 收到后走 openRecent →
// openDocxPath → 宿主 openPath(refresh) → 再推 —— 在没有真实 docs:open-path 数据
// 供给的探针里会无限回环。本套件只测**保存**链路（打开链由
// document-view-electron-smoke 覆盖），因此这里记录命令而不交给页面。
globalThis.__gasMenuCommands = [];
api.onMenuCommand = (handler) => {
  const listener = (_event, command, payload) => {
    globalThis.__gasMenuCommands.push({ command, payload });
    void handler; // 记录但不调用：见上
  };
  import_electron.ipcRenderer.on("menu:command", listener);
  return () => import_electron.ipcRenderer.removeListener("menu:command", listener);
};
// vendor 的替换守卫：探针里永远"保留当前文档"（没有可替换的真实打开数据源）。
api.confirmDocumentReplace = () => Promise.resolve(false);
`;
const patched = bundleSource.replace(exposeMarker, probeBridge + "\n" + exposeMarker);
if (patched === bundleSource) throw new Error("preload probe patch failed");
writeFileSync(preloadBundle, patched);

copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify(
    {
      pagePath,
      preloadPath: join(dir, "documentViewPreload.js"),
      waitMs: 10000,
      urlSuffix: "?mode=tab",
    },
    null,
    2,
  ),
);

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
  MCODE_GAS_DIR: dir,
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
// 20 条（AI 全链 12 + 保存段 8）。下限钉住，防止探针提前崩退只写了一半。
const complete = checks.length >= 20 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`GENOFFICE AI ASK FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  console.log(`genoffice-ai-ask-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过（真实 vendor docs 页）`);
}
