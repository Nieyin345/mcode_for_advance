/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么可以直接替 `electron` 包本身
 *
 * 前几套的做法是 `--alias:@main/window.js=…` 把**用到 electron 的那几个模块**换掉。
 * 那在这里不够:`ipc/library.ts` 自己就有一句 `import { shell } from "electron"`
 * (给「用系统默认程序打开」那条 RPC 用的),而 `@main/lib/theme.js`(经
 * `library/mcp/*` 与 `BrowserManager`)另有 `nativeTheme`。顺着 alias 一个个去堵会
 * 变成打地鼠,而每漏一个报出来的都是 "Cannot determine intended module format" /
 * "找不到模块 electron",看起来和"被测代码坏了"一模一样 —— 实测第一次就是这么挂的:
 * esbuild 把真的 `electron` 打成 CJS,而 `index.js` 里同时有 `require` 和顶层 await,
 * Node 拒绝这个模块格式。
 *
 * 换掉整个包更窄也更准。本套要验的是**删除**那条路,它碰不到任何一个 Electron API。
 *
 * ⚠️ **不是空实现**:一律**显式抛**,真被调到了要立刻显形,而不是安静地返回
 * undefined 让断言去猜(同 library-mcp-smoke 里 browserManager 桩的取舍)。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`library-delete-smoke 不该走到 electron.${name}(删除那条路不碰 Electron)`);
  };
}

export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
};

export const nativeTheme = { shouldUseDarkColors: false };

/** 本套自己造了一个 `ipcMain`(记名替身,从它身上取 handler),这个**一定不该**被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
