/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * 本来 `@main/lib/secretStore.js`(safeStorage)与 `db.ts`(app)那两个桩就够把
 * electron 挡在门外了。**额外换掉整个 `electron` 包是为了另一件事**:
 * `sdkBinaryPath.ts` 会 `require.resolve("@anthropic-ai/claude-agent-sdk-<平台>-<架构>/claude.exe")`
 * 去拿那个真二进制 —— 而本套里被测的 `customModel.ts` **真的会拿它去起一个子进程**。
 * 于是那个真二进制会反过来读这台机器上的用户级配置(见本套 main.ts 文件头"为什么先换掉
 * 用户根"):被这一步拖进来的东西**不是被测代码的职责**,却会决定这条测试是绿是红。
 *
 * 所以:凡是走 `electron` 的功能,要么被桩接住,要么**显式抛**(真被调到了要立刻显形,
 * 而不是安静地返回 undefined 让断言去猜)。
 *
 * ⚠️ 下面这几个不是"占位",是 `ipc/customModel.ts` 那条链的真实依赖:
 *
 *   - `app`              `db.ts` 顶层 `import { app } from "electron"`(只为了 `getPath`)
 *   - `safeStorage`      `secretStore.ts` 顶层 import —— 虽然那个模块已被换成桩,
 *                        但 `sdkBinaryPath.ts` 那条链上还有别的模块会碰到它
 *   - `ipcMain`          本套自己造了一个记名替身,这个**一定不该**被用到
 *   - `shell` / `nativeTheme` / `BrowserWindow`  `ipc/index.ts` 那条链上的邻居
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`custom-model-smoke 不该走到 electron.${name} —— 需要它就该在这里补桩`);
  };
}

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  setPath: notHere("app.setPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: notHere("safeStorage.encryptString"),
  decryptString: notHere("safeStorage.decryptString"),
};

/** 本套自造 `ipcMain`(记名替身,从它身上取 handler),这个一定不该被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};

export const nativeTheme = { shouldUseDarkColors: false };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
