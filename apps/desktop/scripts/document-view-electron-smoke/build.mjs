/**
 * 【ARC-007】真 Electron 文档视图宿主 U1 的启动器。
 *
 * ## 与无头套件的分工
 *
 * `document-view-host-smoke` 用假 WebContentsView 验状态机（快、可变异）；这一套
 * 起**真 Electron 二进制**、真窗口、真 WebContentsView + 真 preload，只验无头
 * 证明不了的那几件（挂载 / preload 注入 / menu:command 端到端 / 身份反查）。
 *
 * ## 隔离
 *
 * 所有 app 路径（userData/sessionData/logs/crashDumps/home/data）都重指到本套件
 * 的 mktemp 目录 —— 不碰用户真实数据根。不联网：页面是本地文件 + CSP `connect-src 'none'`。
 *
 * ## 为什么必须由启动器判成败
 *
 * 隐藏窗口关掉后 Electron 会隐式 exit 0；断言失败若只看进程退出码会被吞掉。
 * 探针把每条断言写进 `checks.json`，启动器要求 **exit 0 且每条都 PASS** 才算过。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
const dir = mkdtempSync(join(desktop, ".tmp/document-view-electron-"));
console.log("Document view U1 evidence: " + dir);

// 探针与**视图 preload** 都按真产物形态打包：preload 必须是 CJS（Electron 的
// sandbox preload 不支持 ESM），主机名与宿主 `resolveViewPreload()` 找的
// `documentViewPreload.js` 同名 —— 探针把它放在 probe.cjs 旁边。
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
  // `documentViewHost` 顶层 import `@main/window.js`（生产默认解析器），而那个模块
  // 拖上了语音引擎的原生模块（sherpa-onnx .node）。探针**显式注入**自己的窗口，
  // 用不到默认解析器 —— 换桩即可，与 document-view-host-smoke 同一手法。
  alias: { "@main/window.js": join(suite, "stubs/window.ts") },
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

const require = createRequire(join(desktop, "package.json"));
copyFileSync(join(suite, "electron-host.cjs"), join(dir, "electron-host.cjs"));
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
  MCODE_DV_DIR: dir,
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
const complete = checks.length >= 10 && failed.length === 0;
const result = { dir, exitCode: run.status, signal: run.signal, checks: checks.length, failed, complete };
writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
if (run.status !== 0 || !complete) {
  console.error(`DOCUMENT VIEW U1 FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  console.log(`document-view-electron-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过`);
}
