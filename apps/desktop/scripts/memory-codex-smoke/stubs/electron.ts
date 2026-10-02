/**
 * `electron` 的替身 —— 只给无头脚本用。**导出面按本套 import 图的实测结果定**
 * (`apps/desktop/src/main/**` 里出现过的每一个 `from "electron"` 的具名导入)。
 *
 * ## 为什么整包换,而不是一个个 `--alias:@main/window.js`
 *
 * 本套要 import `@main/ipc/index.js` —— 那座总注册表把 37 个域的 `register*Handlers`
 * 串起来,import 图是**整个主进程**。碰 electron 的地方一路数不清:`files.ts` 的
 * `nativeImage/clipboard`、`notifications/NotificationManager.ts` 的 `Notification`、
 * `lib/secretStore.ts` 的 `safeStorage`、`providers/bridge/extensionBridge.ts` 的
 * `http`/`session`……顺着 alias 一个个堵会变成打地鼠,而每漏一个报出来的都是 esbuild
 * 那句 `No matching export … for import "x"`,看起来和"被测代码坏了"一模一样。
 *
 * ## ⚠️ 这一份**不是**"一律显式抛",两处是真值,理由在下面
 *
 *  1. **`safeStorage.isEncryptionAvailable()` 返回 `false`** —— 这是**真的**一条路
 *     (没有系统钥匙串时真代码本来就退回 base64,见 `secretStore.ts` 文件头)。本套要
 *     验的是"明文密钥没过 IPC",而这条路下 `encrypt()` 仍然产出**密文**;把它换成
 *     抛,`codexModels.save` 第一条就挂了,验的东西反而变成"钥匙串在不在"。
 *     `encryptString` / `decryptString` 给的是 base64 往返 —— 与真代码在
 *     `isEncryptionAvailable() === false` 时的行为**逐字节一致**。
 *  2. **`app.getPath("userData")` 返回本套的临时目录** —— `lib/dataRoot.ts` 的指针文件
 *     住在那儿;返回真的 userData 会让 `setDataRoot` 往用户真目录写东西。`getPath("home")`
 *     同理(`codexModelsStore.codexHomePath()` 是 `homedir()/.mcode/codex`,`homedir()`
 *     由 `run.sh` 改 `USERPROFILE` 指到临时目录,不走这条路)。
 *
 * 其余一律**显式抛**:真被调到要立刻显形,而不是安静返回 undefined 让断言去猜。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function notHere(name: string): () => never {
  return () => {
    throw new Error(`memory-codex-smoke 不该走到 electron.${name}(本套不起 Electron)`);
  };
}

/** 被调到的对象成员一律炸。 */
const notHereObj = new Proxy(
  {},
  {
    get(_t, prop: string): unknown {
      return notHere(prop);
    },
  },
);

/** 被 `new` 到的类也炸,但先撑住打包期的 `extends` / 类型位置。 */
class NotHereClass {
  constructor() {
    throw new Error("memory-codex-smoke 不该 new 一个 electron 类(本套不起 Electron)");
  }
}

/* ── 两个真值(见文件头) ── */

const fakeUserData = mkdtempSync(join(tmpdir(), "mcode-memcodex-userdata-"));

export const app = {
  getPath: (name: string): string => {
    if (name === "userData") return fakeUserData;
    if (name === "home") return fakeUserData;
    throw new Error(`memory-codex-smoke: electron.app.getPath(${name}) 没造桩`);
  },
  getVersion: () => "0.0.0-smoke",
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
  relaunch: notHere("app.relaunch"),
  exit: notHere("app.exit"),
  quit: notHere("app.quit"),
};

/** ⚠️ 见文件头第 1 条:`isEncryptionAvailable() === false` 是**真的那条路**,
 *  base64 往返与真代码在该分支下的行为逐字节一致。 */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (plain: string): Buffer => Buffer.from(plain, "utf8"),
  decryptString: (buf: Buffer): string => buf.toString("utf8"),
};

export const nativeTheme = {
  shouldUseDarkColors: false,
  on: notHere("nativeTheme.on"),
};

/**
 * `ipcMain` —— **记名替身,不是抛的那种**(本套唯一的一处例外,理由见下)。
 *
 * ## 为什么要能收下注册
 *
 * `@main/ipc/index.ts` 的 `registerIpcHandlers()` **不用调用方给的 ipcMain** —— 它
 * `import { ipcMain } from "electron"`,再包一层 `createDbGuardedIpc`。所以"那座总注册表
 * 到底注册了哪些渠道、有没有重复"这件事,**只有在替身里收得下来才验得了**(本套要验的
 * 就是那一层)。给它一个抛的替身,`registerIpcHandlers()` 第一句就炸,而炸出来的
 * `memory-codex-smoke 不该走到 electron.ipcMain.handle` 和"注册表坏了"长得一模一样。
 *
 * ## 重复注册**当场炸** —— 这条就是 Electron 自己的行为
 *
 * 真的 `ipcMain.handle` 对重复渠道是直接 throw(`Attempted to register a second
 * handler for 'x'`),发生在 `registerIpcHandlers()` 里 = **应用启动即崩**。替身照抄
 * 这个行为,于是"两处注册同一个 channel"变成一次能读的失败,而不是等到用户装起来
 * 才发现。
 */
export const registeredChannels = new Map<string, (event: unknown, raw: unknown) => unknown>();

export const ipcMain = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    if (registeredChannels.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    registeredChannels.set(channel, listener);
  },
  on: notHere("ipcMain.on"),
  removeHandler: notHere("ipcMain.removeHandler"),
};

export class BrowserWindow {
  constructor() {
    throw new Error("memory-codex-smoke 不该 new BrowserWindow(本套不起窗口)");
  }
  static getAllWindows(): never {
    throw new Error("memory-codex-smoke 不该走到 BrowserWindow.getAllWindows");
  }
}

export class WebContentsView extends NotHereClass {}

export const shell = notHereObj;
export const clipboard = notHereObj;
// Electron 44 export: this suite still must not exercise the OS clipboard.
export const ClipboardItem = NotHereClass;
export const dialog = notHereObj;
export const nativeImage = notHereObj;
export const session = notHereObj;
// R41 自定义面板的 mcode-panel:// 协议(main/customUi/panelProtocol.ts)只在 import 链上出现。
export const protocol = notHereObj;
export const Notification = NotHereClass;

/** 纯类型,运行期不该存在 —— 留个值让 `import type` 被误写成普通 import 时炸。 */
export const AuthInfo = notHere("AuthInfo");
export const Cookie = notHere("Cookie");
export const CookiesSetDetails = notHere("CookiesSetDetails");
export const Debugger = notHere("Debugger");
export const DownloadItem = notHere("DownloadItem");
export const Rectangle = notHere("Rectangle");
export const Session = notHere("Session");
export const WebContents = notHere("WebContents");
