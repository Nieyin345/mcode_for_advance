/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么这一套必须替整个包
 *
 * 本套要 import `@main/ipc/orchestration.js`(被测文件)与 `@main/orchestration/library.js`,
 * 而它们的 import 图里碰 electron 的地方不止一处:
 *   - `ipc/orchestration.ts` 自己 `import { dialog }`(导入/导出那两个文件框);
 *   - `store/db.ts` 要 `app.getPath`(数据根指针);
 *   - `lib/secretStore.ts` 要 `safeStorage`;
 *   - `plugins/pluginManager.ts` 要 electron 的路径常量。
 * 一个个堵会变成打地鼠,而每漏一个报出来的都是"找不到模块 electron"。
 *
 * ## 不是空实现,是**照实说"没有"**
 *
 * `safeStorage.isEncryptionAvailable()` 返回 `false` 是**真的那条路**(没有系统钥匙串
 * 时真代码本来就退回明文,见 secretStore 的注释)。
 *
 * `dialog` 的两个方法**返回"用户取消了"** —— 那是本套要走的那条路:导入/导出在被问
 * 到路径时本来就要处理取消。其余一律**显式抛**:真被调到要立刻显形,而不是安静返回
 * undefined 让断言去猜。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`orchestration-ipc-smoke 不该走到 electron.${name}`);
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

/** 本套自己装了 `ipcMain`(记名替身),这个不该被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };

/**
 * `session` / `WebContentsView` 是被 `browser/BrowserManager.ts` 的**顶层 import** 拉
 * 进来的(`library/downloader.ts` → …),而 BrowserManager 在本套里**一次都不会被调到**
 * (它管的是内嵌浏览器下载那一路)。给成员只为让打包过 —— 真调到要立刻显形。
 */
export const session = {
  fromPartition: notHere("session.fromPartition"),
  defaultSession: notHere("session.defaultSession"),
};

export class WebContentsView {
  constructor() {
    notHere("new WebContentsView")();
  }
}

/**
 * 两个文件框。**默认返回"用户取消了"** —— 这是本套大部分断言要走的那条路。
 *
 * 但"取消"只是两条路里的一条:`WORKFLOW_EXPORT` 真正的写盘、`WORKFLOW_IMPORT_FROM_FILE`
 * 真正的读盘都发生在拿到路径**之后**。只钉死取消的话,那两个 handler 里最长的一段
 * (读写 + 失败分支)一行都覆盖不到。所以这里做成**可摆的**:`setSavePath(p)` 之后
 * 下一次保存框给回 `p`,`setOpenPaths([p])` 之后下一次打开框给回那些文件。用完
 * `resetDialog()` 摆回"取消"。
 */
let savePath: string | null = null;
let openPaths: string[] = [];

export function setSavePath(p: string | null): void {
  savePath = p;
}
export function setOpenPaths(ps: string[]): void {
  openPaths = ps;
}
export function resetDialog(): void {
  savePath = null;
  openPaths = [];
}

export const dialog = {
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> =>
    savePath === null ? { canceled: true } : { canceled: false, filePath: savePath },
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    openPaths.length === 0 ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: openPaths },
};
