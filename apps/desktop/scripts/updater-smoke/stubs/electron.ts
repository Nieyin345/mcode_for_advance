/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么直接换掉整个包(而不是逐个堵用到 electron 的模块)
 *
 * `updater.ts` 自己 `import { app } from "electron"`;它的 import 图里
 * `store/db.ts` 也有一句(只 import、没用到)。整包换掉比一个个堵窄也准 ——
 * 同 `library-delete-smoke/stubs/electron.ts` 的取舍。
 *
 * ## 三个方法各自的理由
 *
 *  - `getVersion()` —— 每条"已是最新版本(vX)"都用它兜底;本套要断言那个 vX 是哪个版本。
 *  - `getAppPath()` —— **只有 macOS 那条路**会拿它去问 codesign(见 updater.ts 的
 *    `detectManualInstallRequired`)。本套**有**一条断言要走 macOS 那条路,所以它是
 *    可用的;给的是个固定假路径(codesign 是桩、根本不看它)。
 *  - `isPackaged` —— 真 electron-updater 会看它决定 `isUpdaterActive()`;本套把
 *    autoUpdater 整个换掉了,这个值只作参考,**故意不拿它当"是不是 prod"的判据**
 *    (那个判据在 `lib/utils.ts` 的 `is.prod`,走 `ELECTRON_RENDERER_URL`)。
 *
 * ⚠️ **一律显式抛,不返回 undefined** —— 安静地返回 undefined 会让断言去猜
 * (同 library-delete-smoke 的取舍)。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`updater-smoke 不该走到 electron.${name}`);
  };
}

/** `getAppPath()` 的返回值。**不是这台机器上的任何真实路径** —— 它只会被交给
 *  本套自己那份 `child_process` 桩,而那份桩不看路径。 */
const FAKE_APP_PATH = "/Applications/Mcode.app";

export const app = {
  getVersion: () => "9.9.9-smoke",
  getAppPath: () => FAKE_APP_PATH,
  isPackaged: true,
  getPath: notHere("app.getPath"),
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
  relaunch: notHere("app.relaunch"),
  exit: notHere("app.exit"),
};

/** 本套不注册 IPC handler(`ipc/updater.ts` 那条路由不在本套范围,那套叫
 *  `updater-tools-smoke`)。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const nativeTheme = { shouldUseDarkColors: false, themeSource: "system" };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };

export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
};
