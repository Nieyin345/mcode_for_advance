// 【ARC-005】真 Electron 端到端探针的宿主启动器 —— 隔离窗口，不碰用户数据根。
//
// 与 settings-panels-electron-smoke / document-view-electron-smoke 同一骨架：
// 所有 app 路径重指到套件自己的 mktemp 目录（`MCODE_HPE_DIR`），必须在
// app.whenReady 之前完成；隐藏窗口；只由启动器（build.mjs）判定成败。
const { app } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');

const dir = process.env.MCODE_HPE_DIR;
if (!dir || !isAbsolute(dir)) throw Error('An absolute MCODE_HPE_DIR is required');
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

const timeout = setTimeout(() => { console.error('HTML preview electron U1 timed out'); app.exit(97); }, 150000);
app.whenReady().then(async () => {
  try {
    const { runHtmlPreviewProbe } = require(join(dir, 'probe.cjs'));
    await runHtmlPreviewProbe(dir);
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
