/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么整包换掉,而不是一个个换 `@main/window.js`
 *
 * `ipc/runtimes.ts` 经 `runtimeInstaller.ts` 直接 `import { app } from "electron"`
 * (`loadExpectedVersions()` 读 `app.getAppPath()/package.json` 拿钉版)。
 * `ipc/toolchain.ts` 经 `env/agentEnv.ts` → `env/toolchain.ts` 也拖到 electron。
 * 顺着别名一个个堵会变成打地鼠,而每漏一个报出来的都是 "Cannot find module
 * electron",看着和"被测代码坏了"一样。换整包更窄也更准(同 library-delete-smoke)。
 *
 * ⚠️ **不是空实现**:一律**显式抛**,真被调到了要立刻显形,而不是安静地返回
 * undefined 让断言去猜。
 *
 * 本套要验的那两条路(注册 handler、调 handler)**都不碰 Electron**:
 *   - `removeRuntime` 只 `rmSync` 那个 agent 的目录;
 *   - `checkToolchain` 只 spawn `where.exe` / `python`(不碰 electron)。
 * 唯一会碰的是 `loadExpectedVersions()` 里的 `app.getAppPath()` —— 它整句在
 * `try/catch` 里,探到就退回代码里的兜底常量。那是**可以接受**的:本套不验钉版,
 * archiver-installer-smoke 已经用真 electron 桩钉过它了。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`installers-ipc-smoke 不该走到 electron.${name}`);
  };
}

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
};

export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};

export const nativeTheme = { shouldUseDarkColors: false };

/** 本套自己造了一个 `ipcMain`(记名替身),这个**一定不该**被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
