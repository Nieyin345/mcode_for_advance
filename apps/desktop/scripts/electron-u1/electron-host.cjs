// T16 —— U1 旅程骨架的真 Electron 宿主（每个 OS 进程跑一次）。
//
// 与 settings-focus-electron-smoke / document-view-electron-smoke 同一隔离纪律：
// 所有 app 路径（userData/sessionData/logs/crashDumps/home + 数据根指针）重指到
// 启动器 mktemp 出来的目录，必须在 app.whenReady **之前**完成；不联网（bundle 页
// 自带 CSP connect-src 'none'；旅程自造页面由 build.mjs 注入同样的 CSP）。
//
// 退出码协议：
//   0  本趟旅程按自身声明「通过」
//   1  本趟旅程失败（判据与证据由 runner 写入 journey-result.json）
//   77 旅程要求 relaunch —— 启动器会换一个进程继续
//   97 宿主超时
const { app } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, isAbsolute } = require("node:path");

const dir = process.env.MCODE_U1_DIR;
const runDir = process.env.MCODE_U1_RUN;
const buildDir = process.env.MCODE_U1_BUILD;
const dataDir = process.env.MCODE_U1_DATA;
if (!dir || !isAbsolute(dir)) throw Error("An absolute MCODE_U1_DIR is required");
if (!runDir || !isAbsolute(runDir)) throw Error("An absolute MCODE_U1_RUN is required");
if (!buildDir || !isAbsolute(buildDir)) throw Error("An absolute MCODE_U1_BUILD is required");
if (!dataDir || !isAbsolute(dataDir)) throw Error("An absolute MCODE_U1_DATA is required");

for (const name of ["userData", "sessionData", "logs", "crashDumps", "home"]) {
  mkdirSync(join(runDir, name), { recursive: true });
  app.setPath(name, join(runDir, name));
}
// 数据根指针：src/main/lib/dataRoot.ts 的唯一事实源。写进 runDir → 重开前后一致。
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(runDir, "userData/data-root.json"), JSON.stringify({ root: dataDir }));

// T7：旅程注册表可在 `app.whenReady()` **之前**导出一个 `beforeReady()` ——
// privileged scheme 注册是 Electron 硬性要求（必须在 ready 前），而 T16 的 runner
// 在 ready 之后才跑。没有这一步，GenOffice 的 `genoffice-app://` /
// `genoffice-docx-media://` 页面在真 Electron 里会因非特权 scheme 加载失败。
// 注册表由 build.mjs 打成 CJS；顶层 require 不能碰 electron 之外的重模块 ——
// 因此注册表的 vendor import 全部是**惰性**的（见 t7 journeys/registry.ts）。
let journeysModule = null;
try {
  journeysModule = require(join(buildDir, "journeys.cjs"));
} catch (error) {
  console.error("U1 journeys module failed to load:", error);
  throw error;
}
if (typeof journeysModule.beforeReady === "function") {
  journeysModule.beforeReady();
}

app.on("window-all-closed", () => {});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-features", "MediaRouter");

const timeout = setTimeout(() => {
  console.error("U1 electron host timed out (pid " + process.pid + ")");
  app.exit(97);
}, 150000);

app.whenReady().then(async () => {
  try {
    // T7：ready 之后的装配（协议处理等）。缺省（T16 原注册表）没有这一项。
    if (journeysModule && typeof journeysModule.afterReady === "function") {
      journeysModule.afterReady();
    }
    const { runGeneration } = require(join(buildDir, "runner.cjs"));
    await runGeneration(journeysModule.journeys);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
