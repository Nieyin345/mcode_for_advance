// 【ARC-007】真 Electron 下的文档视图宿主 U1 —— 隔离窗口，不碰用户数据根。
//
// 与 module-phase2-e2e-smoke/electron-host.cjs 同一骨架：所有 app 路径重指到
// 套件自己的临时目录，必须在 app.whenReady 之前完成；隐藏窗口；只由启动器
// 判定成败（关掉最后一个窗口不得把断言失败吞成 exit 0）。
const { app } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');

const dir = process.env.MCODE_DV_DIR;
if (!dir || !isAbsolute(dir)) throw Error('An absolute MCODE_DV_DIR is required');
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps', 'home']) {
  mkdirSync(join(dir, name), { recursive: true });
  app.setPath(name, join(dir, name));
}
mkdirSync(join(dir, 'data'), { recursive: true });
writeFileSync(join(dir, 'userData/data-root.json'), JSON.stringify({ root: join(dir, 'data') }));

app.on('window-all-closed', () => {});
// 【ARC-007 P0】一次性字节 handoff 的 scheme 特权**必须在 ready 之前**注册
// （Electron 硬性要求）。探针进程与生产主进程走同一个模块的同一入口 —— 这里
// 直接 require 打包后的 probe.cjs 会把模块实例分叉，所以由探针在 ready 后
// 调用 initDocumentHandoffProtocol；特权注册只能在这里做。
{
  const { registerDocumentHandoffSchemePrivileged } = require(join(dir, 'probe.cjs'));
  registerDocumentHandoffSchemePrivileged();
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

const timeout = setTimeout(() => { console.error('Document view U1 timed out'); app.exit(97); }, 120000);
app.whenReady().then(async () => {
  try {
    const { runDocumentViewProbe } = require(join(dir, 'probe.cjs'));
    await runDocumentViewProbe(dir);
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
