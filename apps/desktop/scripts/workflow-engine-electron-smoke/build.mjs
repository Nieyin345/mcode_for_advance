/**
 * 【ARC-006 NR2】真 Electron 工作流引擎编辑器宿主 U1 的启动器。
 *
 * ## 与无头套件的分工
 *
 * `workflow-engine-runtime-smoke` 用假进程验 `EngineRuntime` 状态机；
 * `document-view-host-smoke` 用假视图验宿主状态机；这一套起**真 Electron 二进制**、
 * 真窗口、真 `WebContentsView`，并用**生产 spawn 路径**（`process.execPath` +
 * `ELECTRON_RUN_AS_NODE=1`）起一个真引擎替身进程（真端口、真 HTTP 页面），
 * 只验无头证明不了的那几件：挂载/加载/隐藏保活/停止收尸/围栏/监听清理。
 *
 * ## 隔离
 *
 * 所有 app 路径（userData/sessionData/logs/crashDumps/home/data）都重指到本套件
 * 的 mktemp 目录 —— 不碰用户真实数据根。不联网：页面是引擎进程自己返回的本地
 * HTML，CSP `connect-src 'self'`；引擎只绑 127.0.0.1。
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
const dir = mkdtempSync(join(desktop, ".tmp/workflow-engine-electron-"));
console.log("Workflow engine U1 evidence: " + dir);

// 探针按真产物形态打包成 CJS（electron 外置）。`@main/window.js` 换桩的理由与
// document-view 套件相同：真模块会拖进语音引擎的原生模块，本套件一个字节都不用。
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
  alias: { "@main/window.js": join(suite, "stubs/window.ts") },
});

// 假引擎与隔离主机脚本原样拷进构建目录（探针按 dir/fake-engine.cjs 找它）。
copyFileSync(join(suite, "fake-engine.cjs"), join(dir, "fake-engine.cjs"));
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
  MCODE_WF_ENGINE_DIR: dir,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(dir, "userData"),
  LOCALAPPDATA: join(dir, "localAppData"),
  TEMP: temp,
  TMP: temp,
};
// 宿主进程必须真正以 Electron app 身份跑；`--run-as-node` 只给引擎子进程
// （由探针显式放进 spawn env）。
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
  console.error(`WORKFLOW ENGINE U1 FAILED: exit=${run.status} checks=${checks.length} failed=${failed.length}`);
  process.exitCode = 1;
} else {
  console.log(`workflow-engine-electron-smoke: ${checks.length}/${checks.length} 真 Electron 断言通过`);
}
