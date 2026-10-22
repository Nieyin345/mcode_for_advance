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
    const { runGeneration } = require(join(buildDir, "runner.cjs"));
    // journeys.cjs 由 build.mjs 用 esbuild 打成 CJS（旅程文件是 TS，直接 require 不了）。
    const { journeys } = require(join(buildDir, "journeys.cjs"));
    await runGeneration(journeys);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
