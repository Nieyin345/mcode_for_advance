/**
 * `electron` 的功能替身 —— 只给 `browser-smoke/navigate-main` 那一路用(验
 * `BrowserManager.waitForLoad` 的 cookie 恢复时序,MC-045)。
 *
 * ## 为什么是"功能替身",不是"被调到就抛"
 *
 * 这一路要**真的**把 `BrowserManager.create()` + `loadUrl()` + `waitForLoad()` 跑起来,
 * 而这三条会碰到 `WebContentsView` / `session` / `safeStorage` / `BrowserWindow` 的
 * 运行期行为 —— 抛的替身会让整条路第一步就炸,什么都验不到。所以这里给一个**能跑**的
 * 最小实现:一张假 `WebContentsView`,它下面那张 `webContents` 有真正的
 * `isLoading()` / `loadURL()` / `once/on/removeListener` / `getURL()` / `getTitle()`。
 *
 * ## 本替身刻意保留的三条"真"事实(断言的前提)
 *
 *   1. **`loadURL()` 会先让 `isLoading()` 变 true,过一拍才发 `did-finish-load`**
 *      —— 与真 Chromium 一致(did-finish-load 是异步的);
 *   2. **`session.fromPartition()` 每次都返回同一个 session 对象** —— 真 Electron 也是
 *      这么缓存的(见 BrowserManager.browserSession 的注释);
 *   3. **`cookies.set()` 会 await 一个"闸门"** —— 由本文件的 {@link releaseCookieGate}
 *      放行,用来模拟"cookie 保管库恢复得慢"(MC-045 的那个窗口)。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeUserData = mkdtempSync(join(tmpdir(), "mcode-browser-nav-userdata-"));

/* ── cookie 恢复的闸门 ── */
let gate: Promise<void> = Promise.resolve();
let releaseGate: () => void = () => {};
/** 重置闸门:下一次 `cookies.set()` 会挂起,直到 {@link releaseCookieGate} 放行。 */
export function armCookieGate(): void {
  gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
}
export function releaseCookieGate(): void {
  releaseGate();
}

/** 假会话分区的 cookies —— `set` 挂闸门,`get` 空。 */
const fakeCookies = {
  async get(): Promise<unknown[]> {
    return [];
  },
  async set(): Promise<void> {
    await gate;
  },
  async remove(): Promise<void> {},
  async flushStore(): Promise<void> {},
};

const fakeSession = {
  cookies: fakeCookies,
  on(): void {},
  async clearCache(): Promise<void> {},
  async clearStorageData(): Promise<void> {},
  async downloadURL(): Promise<void> {},
};

export const session = {
  fromPartition(): typeof fakeSession {
    return fakeSession;
  },
  fromPath(): typeof fakeSession {
    return fakeSession;
  },
};

export class WebContentsView {
  webContents: FakeWebContents;
  constructor(opts?: { webPreferences?: { session?: unknown } }) {
    this.webContents = new FakeWebContents();
  }
  setBackgroundColor(): void {}
  setBounds(): void {}
}

/** 记录当前测试建出来的最后一张 webContents —— 断言读它。 */
export const liveWebContents: FakeWebContents[] = [];

class FakeWebContents {
  id: number;
  private _url = "";
  private _title = "";
  private _loading = false;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor() {
    this.id = 1000 + liveWebContents.length;
    liveWebContents.push(this);
  }
  getUserAgent(): string {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Electron/33.0.0";
  }
  setUserAgent(): void {}
  isDestroyed(): boolean {
    return false;
  }
  isLoading(): boolean {
    return this._loading;
  }
  getURL(): string {
    return this._url;
  }
  getTitle(): string {
    return this._title;
  }
  /** 真 Chromium:先 isLoading=true,过一拍发 did-finish-load。 */
  loadURL(url: string): Promise<void> {
    this._url = url;
    this._title = "目标页";
    this._loading = true;
    this.emit("did-start-loading");
    setTimeout(() => {
      this._loading = false;
      this.emit("did-finish-load");
      this.emit("did-stop-loading");
    }, 5);
    return Promise.resolve();
  }
  reload(): void {}
  close(): void {}
  focus(): void {}
  sendInputEvent(): void {}
  setWindowOpenHandler(): void {}
  executeJavaScript(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  capturePage(): Promise<unknown> {
    return Promise.resolve({ toPNG: () => Buffer.alloc(0) });
  }
  printToPDF(): Promise<Buffer> {
    return Promise.resolve(Buffer.alloc(0));
  }
  on(event: string, cb: (...a: unknown[]) => void): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
    return this;
  }
  once(event: string, cb: (...a: unknown[]) => void): this {
    const wrap = (...a: unknown[]): void => {
      this.removeListener(event, wrap);
      cb(...a);
    };
    return this.on(event, wrap);
  }
  removeListener(event: string, cb: (...a: unknown[]) => void): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((c) => c !== cb));
    return this;
  }
  emit(event: string, ...a: unknown[]): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...a);
  }
  debugger = {
    attach(): void {},
    detach(): void {},
    sendCommand(): Promise<unknown> {
      return Promise.resolve(undefined);
    },
  };
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack(): void {}, goForward(): void {} };
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s, "utf8"),
  decryptString: (b: Buffer): string => b.toString("utf8"),
};

export const app = {
  getPath: (name: string): string => {
    if (name === "userData" || name === "pictures") return fakeUserData;
    if (name === "downloads") return join(fakeUserData, "downloads");
    return fakeUserData;
  },
  getAppPath: (): string => process.cwd(),
  isPackaged: false,
  on(): void {},
};

export const ipcMain = { on(): void {}, handle(): void {}, off(): void {} };

export const shell = {
  openExternal: (): Promise<void> => Promise.resolve(),
  openPath: (): Promise<string> => Promise.resolve(""),
  showItemInFolder(): void {},
};

/** 假主窗口 —— `BrowserManager` 只用到这几样(`contentView` / `isDestroyed` /
 *  `getContentSize` / `webContents`)。 `@main/window.js` 的替身返回它。 */
export const fakeMainWindow = {
  contentView: {
    addChildView(): void {},
    removeChildView(): void {},
  },
  isDestroyed: (): boolean => false,
  getContentSize: (): [number, number] => [1280, 800],
  webContents: { on(): void {}, id: 1 },
};

export const BrowserWindow = {
  getAllWindows: (): unknown[] => [],
};

/** theme.js 读它。 */
export const nativeTheme = { shouldUseDarkColors: false, on(): void {} };
