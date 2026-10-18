// 【MC-002】真 Electron 探针的宿主启动器 —— 隔离窗口,不碰用户数据根。
//
// 与 document-view-electron-smoke/electron-host.cjs 同一骨架:所有 app 路径重指到
// 套件自己的 mktemp 目录(`MCODE_SDP_DIR`),必须在 app.whenReady 之前完成;隐藏窗口;
// 只由启动器(build.mjs)判定成败 —— 关掉最后一个窗口不得把断言失败吞成 exit 0。
const { app } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');

const dir = process.env.MCODE_SDP_DIR;
if (!dir || !isAbsolute(dir)) throw Error('An absolute MCODE_SDP_DIR is required');
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps', 'home']) {
  mkdirSync(join(dir, name), { recursive: true });
  app.setPath(name, join(dir, name));
}
mkdirSync(join(dir, 'data'), { recursive: true });
writeFileSync(join(dir, 'userData/data-root.json'), JSON.stringify({ root: join(dir, 'data') }));

app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

const timeout = setTimeout(() => { console.error('Scene deploy electron U1 timed out'); app.exit(97); }, 170000);
app.whenReady().then(async () => {
  try {
    const { runSceneDeployProbe } = require(join(dir, 'probe.cjs'));
    await runSceneDeployProbe(dir);
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
