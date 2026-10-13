/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么这里要替整个包,而不是一个个堵 `@main/window.js`
 *
 * 主进程那条链上碰 electron 的地方不止 window 一处:`lib/secretStore.ts` 要
 * `safeStorage`(自定义模型令牌的加密),`lib/dataRoot.ts` 要 `app.getPath`(已另有桩),
 * `plugins/pluginManager.ts` 要 electron 的路径常量(已另有桩)。一个个堵会变成打地鼠,
 * 而每漏一个报出来的都是 "找不到模块 electron",看起来和"被测代码坏了"一模一样。
 *
 * ## 不是空实现,是**照实说"没有"**
 *
 * `safeStorage.isEncryptionAvailable()` 返回 `false` 是**真的那条路**:真代码本来就要
 * 处理"这台机器没有系统钥匙串"(见 secretStore 的注释,它退回 base64 并 warn)。冒烟里
 * 不该出现的是"加密能用"这种假前提。
 *
 * 其余一律**显式抛** —— 真被调到要立刻显形,而不是安静返回 undefined 让断言去猜。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`node-live-smoke 不该走到 electron.${name}`);
  };
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: notHere("safeStorage.encryptString"),
  decryptString: notHere("safeStorage.decryptString"),
};

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

/** 本套自己装了 `ipcMain`,这个不该被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };

/**
 * 文件框 —— §7e 注册**真的** `registerWorkflowHandlers` 后,`ipc/orchestration.ts`
 * 顶层就 `import { dialog } from "electron"`,缺了它 esbuild 在打包这一步直接报
 * `No matching export ... for import "dialog"`(看起来像"被测代码坏了",其实是桩少了一个名字)。
 *
 * 本套**不验**导入/导出那两个文件框,所以这里照 `orchestration-ipc-smoke` 的默认做法
 * 返回"用户取消了" —— 那是真代码本来就要处理的那条路。其余成员仍是显式抛。
 */
export const dialog = {
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true }),
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
};
