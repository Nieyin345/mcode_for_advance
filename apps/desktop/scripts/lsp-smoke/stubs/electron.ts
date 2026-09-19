/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * `main/store/db.ts` 与 `main/lsp/LspManager.ts` 各有一句 `import { app } from "electron"`,
 * 而 `app.getPath("userData")` 在无头脚本里给不出来。整个包换掉比顺着 alias 一个个堵
 * 窄、也不会变成打地鼠(理由同 `library-delete-smoke/stubs/electron.ts` 的文件头)。
 *
 * ⚠️ **不是空实现**:
 *   - `app.getPath("userData")` 返回本套的临时目录 —— LspManager 的 Java 安装目录
 *     (`<userData>/lsp/java`)会真的落到那里,落到用户真正的 userData 就等于往外写垃圾;
 *   - 其余一律**显式抛**,真被调到了要立刻显形,而不是安静返回 undefined 让断言去猜。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 本套自己的「userData」。只在第一次 getPath 时建。 */
let fakeUserData: string | null = null;
function userData(): string {
  if (!fakeUserData) fakeUserData = mkdtempSync(join(tmpdir(), "mcode-lsp-userdata-"));
  return fakeUserData;
}

function notHere(name: string): () => never {
  return () => {
    throw new Error(`lsp-smoke 不该走到 electron.${name}(被验的两条路都不碰 Electron)`);
  };
}

export const app = {
  getPath: (name: string): string => {
    if (name === "userData") return userData();
    throw new Error(`lsp-smoke: electron.app.getPath(${name}) 没造桩`);
  },
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
};

export const ipcMain = { handle: notHere("electron.ipcMain.handle") };

export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
};

export const nativeTheme = { shouldUseDarkColors: false };

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };

export const session = { defaultSession: {} };
