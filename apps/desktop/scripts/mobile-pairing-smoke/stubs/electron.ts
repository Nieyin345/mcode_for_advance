/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么整包换(照 frontend-smoke / library-delete-smoke 的做法)
 *
 * `main/` 下有一堆文件**直接**写 `import { … } from "electron"`(`lib/secretStore.ts`
 * 的 `safeStorage`、`browser/BrowserManager.ts` 的 `WebContentsView/session/clipboard`、
 * `ipc/files.ts` 的 `nativeImage` …)。顺着 alias 一个个堵会变成打地鼠,而每漏一个报出来
 * 的都是 esbuild 那句 `No matching export … for import "x"` —— 看起来和"被测代码坏了"
 * 一模一样。
 *
 * ## 与 library-delete-smoke 那份的差别:**导出面必须覆盖整条 import 图**
 *
 * 那一份只覆盖它自己那半条路(`shell` / `app` / `nativeTheme` / `ipcMain` /
 * `BrowserWindow`)。本套的 import 图更宽(`mobileRpc.ts` → `ipc/piModels.ts`、
 * `ipc/skills.ts`、`ipc/files.ts`、`ipc/git.ts` …),所以这里把 `main/` 里出现过的
 * **每一个具名导入**都列出来。esbuild 对具名 export 是严格匹配的:少一个名字就是一句
 * 打包错误,而那条错误会**盖住**本套真正要报的东西。
 *
 * ⚠️ **一律显式抛,不是空实现** —— 真被调到了要立刻显形,而不是安静地返回 undefined
 * 让断言去猜(同 library-mcp-smoke 里 browserManager 的取舍)。唯一的例外写在下面。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`mobile-pairing-smoke 不该走到 electron.${name}(本套不起 Electron)`);
  };
}

/** 每个成员都是一个"被调到就炸"的替身。 */
const notHereObj = new Proxy(
  {},
  {
    get(_t, prop: string): unknown {
      return notHere(prop);
    },
  },
);

/** 真被调到的**类**(`new SafeStorage()` 之类)也炸,但要先撑住 `extends` / `instanceof`。 */
class NotHereClass {
  constructor() {
    throw new Error("mobile-pairing-smoke 不该 new 一个 electron 类(本套不起 Electron)");
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

export const nativeTheme = {
  shouldUseDarkColors: false,
  on: notHere("nativeTheme.on"),
};

export const ipcMain = { handle: notHere("ipcMain.handle"), on: notHere("ipcMain.on") };

/**
 * ⚠️ `BrowserWindow` **不是一个纯炸的替身**:`lib/window.ts` 里有
 * `BrowserWindow | null` 这样的**类型**位置(打包期就抹掉了),但也有
 * `BrowserWindow.getAllWindows()` 这种运行期调用。这里给一个静态方法齐全的类,
 * 真调到 `new` 才炸。
 */
export class BrowserWindow {
  constructor() {
    throw new Error("mobile-pairing-smoke 不该 new BrowserWindow(本套不起窗口)");
  }
  static getAllWindows(): never {
    throw new Error("mobile-pairing-smoke 不该走到 BrowserWindow.getAllWindows");
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
export const Cookie = notHere("Cookie");
export const CookiesSetDetails = notHere("CookiesSetDetails");
export const Debugger = notHere("Debugger");
export const DownloadItem = notHere("DownloadItem");
export const IpcMain = notHere("IpcMain");
export const IpcMainEvent = notHere("IpcMainEvent");
export const Rectangle = notHere("Rectangle");
export const Session = notHere("Session");
export const WebContents = notHere("WebContents");
