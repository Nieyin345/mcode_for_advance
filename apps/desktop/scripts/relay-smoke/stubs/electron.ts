/**
 * `electron` 的替身 —— 只给无头脚本用(照 mobile-pairing-smoke / frontend-smoke 的做法)。
 *
 * 本套的 import 图比手机端那套窄得多:中继只拖到
 * `store/repositories` → `store/db`(`app.getPath` 那一路,已被 dataRoot 桩接管)、
 * `lib/logger`(已换桩)和 `lib/window`(已换桩)。列出来的名字就是这条图上出现过的
 * 每一个具名导入 —— esbuild 对具名 export 是严格匹配的,少一个名字报的是
 * `No matching export … for import "x"`,那条错误会**盖住**本套真正要报的东西。
 *
 * ⚠️ **一律显式抛,不是空实现**:真被调到了要立刻显形,而不是安静地返回 `undefined`
 * 让断言去猜。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`relay-smoke 不该走到 electron.${name}(本套不起 Electron)`);
  };
}

const notHereObj = new Proxy(
  {},
  {
    get(_t, prop: string): unknown {
      return notHere(prop);
    },
  },
);

class NotHereClass {
  constructor() {
    throw new Error("relay-smoke 不该 new 一个 electron 类(本套不起 Electron)");
  }
}

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  whenReady: notHere("app.whenReady"),
  on: notHere("app.on"),
  quit: notHere("app.quit"),
};

export const nativeTheme = { shouldUseDarkColors: false, on: notHere("nativeTheme.on") };

export const ipcMain = { handle: notHere("ipcMain.handle"), on: notHere("ipcMain.on"), removeHandler: notHere("ipcMain.removeHandler") };

export class BrowserWindow {
  constructor() {
    throw new Error("relay-smoke 不该 new BrowserWindow(本套不起窗口)");
  }
  static getAllWindows(): never {
    throw new Error("relay-smoke 不该走到 BrowserWindow.getAllWindows");
  }
}

export class WebContentsView extends NotHereClass {}

export const shell = notHereObj;
export const clipboard = notHereObj;
// Electron 44 export: this suite still must not exercise the OS clipboard.
export const ClipboardItem = NotHereClass;
export const dialog = notHereObj;
export const nativeImage = notHereObj;
export const safeStorage = notHereObj;
export const session = notHereObj;
export const Notification = NotHereClass;

/** 纯类型,运行期不该存在 —— 留个值让 `import type` 被误写成普通 import 时炸。 */
export const AuthInfo = notHere("AuthInfo");
export const IpcMain = notHere("IpcMain");
export const IpcMainEvent = notHere("IpcMainEvent");
export const WebContents = notHere("WebContents");
