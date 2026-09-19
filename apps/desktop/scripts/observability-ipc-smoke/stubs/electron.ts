/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么替整个包
 *
 * 本套要走的两个 handler 背后拖着 `store/db.ts`(它 `import { app } from "electron"`,
 * 拿 `app.getPath` 拼库路径)与 `lib/logger.ts`(同样 `app.getPath("userData")` 写日志)。
 * 顺着 alias 一个个去堵会变成打地鼠。
 *
 * 真 `electron` 包打出来是 CJS 的 Electron 引导脚本,在**纯 node** 下
 * `require("electron")` 给的是那个「electron 二进制路径」字符串,不是一个模块 ——
 * 于是 import 到的东西全是 undefined,报出来看着像"被测代码坏了"。
 * 见 `library-delete-smoke/stubs/electron.ts` 文件头那一整段。
 *
 * ## 它不是空实现:该抛的照抛
 *
 * `app.getPath` 一旦真被调到,说明有东西从临时数据根旁边绕过去拿真路径了 ——
 * 那正是这套脚本最怕的事,必须立刻显形而不是安静回落。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(
      `observability-ipc-smoke 不该走到 electron.${name}(数据根/日志都换成桩了)`,
    );
  };
}

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
};

export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};

export const nativeTheme = { shouldUseDarkColors: false };

/** 本套自己造了一个 `ipcMain`(记名替身,从它身上取 handler),这个一定不该被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };

export const dialog = { showOpenDialog: notHere("dialog.showOpenDialog") };
