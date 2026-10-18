// 【ARC-007 P0】打开协议闭环 —— 隔离窗口，不碰用户数据根。
const { app } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');

const dir = process.env.MCODE_DV_OPEN_DIR;
if (!dir || !isAbsolute(dir)) throw Error('An absolute MCODE_DV_OPEN_DIR is required');
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps', 'home']) {
  mkdirSync(join(dir, name), { recursive: true });
  app.setPath(name, join(dir, name));
}
mkdirSync(join(dir, 'data'), { recursive: true });
writeFileSync(join(dir, 'userData/data-root.json'), JSON.stringify({ root: join(dir, 'data') }));

// 【ARC-007 P0】与生产 `main/index.ts` 同一个注册函数 —— 必须在 ready 之前。
// （probe.cjs 的顶层会 import 生产 `documentViewHandoff`；此处同步 require 后调用。）
require(join(dir, 'probe.cjs')).registerHandoffSchemeBeforeReady();

app.on('window-all-closed', () => {});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

const timeout = setTimeout(() => { console.error('document-view-open-smoke timed out'); app.exit(97); }, 150000);
app.whenReady().then(async () => {
  try {
    const { runOpenProtocolProbe } = require(join(dir, 'probe.cjs'));
    await runOpenProtocolProbe(dir);
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
