/**
 * `electron` 的替身 —— **能喂** userData 根、能记 dialog 调用。
 *
 * 本套验的是 `ipc/settingsTransfer.ts` 的**导入**那一条:它 `import { app, dialog } from
 * "electron"`。app 要 `getPath("userData")`(备份落点)与 `getVersion()`(导出文档里那个
 * 版本字段),dialog 要 `showOpenDialog`(让脚本喂回"选了哪个文件")。
 *
 * ⚠️ `userData` **必须由脚本指到临时目录**,而且不许回落到真的那个 —— 备份就写在那儿。
 * 脚本用 `setUserData()` 先钉死再往下走(与别的套件"先断言钉上了"同一条)。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`settings-import-backup-smoke 不该走到 electron.${name}`);
  };
}

let userData = "";
export function setUserData(dir: string): void {
  userData = dir;
}

/** 每次 `showOpenDialog` / `showSaveDialog` 收到的参数。 */
export const dialogCalls: Array<{ kind: string; options: Record<string, unknown> }> = [];

/** 排好的打开框返回值。没排队就调 = 夹具摆错了,直接抛(别安静返回一个"取消")。 */
const openQueue: Array<{ canceled: boolean; filePaths: string[] }> = [];
export function pushOpenResult(result: { canceled: boolean; filePaths: string[] }): void {
  openQueue.push(result);
}

export function resetDialog(): void {
  dialogCalls.length = 0;
  openQueue.length = 0;
}

export const app = {
  getPath: (name: string): string => {
    if (name === "userData") {
      if (!userData) throw new Error("settings-import-backup-smoke: userData 没钉 —— 先调 setUserData()");
      return userData;
    }
    throw new Error(`settings-import-backup-smoke: electron.app.getPath(${name}) 没造桩`);
  },
  getVersion: () => "0.0.0-smoke",
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
};

export const dialog = {
  showOpenDialog: async (options: Record<string, unknown>) => {
    dialogCalls.push({ kind: "open", options });
    const next = openQueue.shift();
    if (!next) throw new Error("dialog.showOpenDialog 被调了但脚本没喂返回值 —— pushOpenResult 少了一次");
    return next;
  },
  showSaveDialog: notHere("dialog.showSaveDialog"),
  showMessageBox: notHere("dialog.showMessageBox"),
};

export const shell = { openPath: notHere("shell.openPath") };
export const nativeTheme = { shouldUseDarkColors: false };
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };
export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
