/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * 本套要验的 import 图里只有一个 Electron API:`models.ts` 的
 * `app.getPath("userData")`(默认模型根)。`main/store/db.ts` 里那句
 * `import { app } from "electron"` 是个**死导入** —— 它从头到尾没调用过 `app`,
 * 所以这里给一个 `app` 就够了(返回一个临时目录,见下面 `__setUserData`)。
 *
 * ⚠️ **一律显式抛,不是空实现**:真被调到要立刻显形,而不是安静地返回 `undefined`
 * 让断言去猜(同 library-mcp-smoke / mobile-pairing-smoke 的取舍)。
 *
 * Run: scripts/voice-smoke/run.sh
 */
let userDataDir = "";

/** 主脚本在起跑前把它设成自己的临时目录 —— 默认模型根就落在那儿。 */
export function __setUserData(dir: string): void {
  userDataDir = dir;
}

function notHere(name: string): () => never {
  return () => {
    throw new Error(`voice-smoke 不该走到 electron.${name}(本套不起 Electron)`);
  };
}

export const app = {
  getPath(name: string): string {
    if (name !== "userData") {
      throw new Error(`voice-smoke 只替了 app.getPath("userData"),被问的是 "${name}"`);
    }
    if (!userDataDir) {
      throw new Error(
        "voice-smoke: userData 还没设 —— __setUserData() 必须先跑。无头脚本下它就是",
      );
    }
    return userDataDir;
  },
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
  quit: notHere("app.quit"),
};

export const shell = notHere("shell");
export const nativeTheme = { shouldUseDarkColors: false, on: notHere("nativeTheme.on") };
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };
export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
