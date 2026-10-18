// 【ARC-007 / GenOffice AI 交互】真 Electron 下的 AI Ask 链路 —— 隔离窗口。
//
// 与 document-view-vendor-page-smoke/electron-host.cjs 同一骨架：所有 app 路径
// 重指到套件自己的临时目录，必须在 app.whenReady 之前完成；隐藏窗口；只由启动器
// 判定成败（关掉最后一个窗口不得把断言失败吞成 exit 0）。
const { app } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');

const dir = process.env.MCODE_GAS_DIR;
if (!dir || !isAbsolute(dir)) throw Error('An absolute MCODE_GAS_DIR is required');
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

const timeout = setTimeout(() => { console.error('GenOffice AI ask timed out'); app.exit(97); }, 120000);
app.whenReady().then(async () => {
  try {
    const { runAiAskProbe } = require(join(dir, 'probe.cjs'));
    await runAiAskProbe(dir);
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
