/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么换整个包,而不是逐个 alias 模块
 *
 * 这套的依赖图里**四处**拉 electron,而且都藏在深处:
 *   - `@main/lib/dataRoot.js`(`app.getPath`,数据根指针);
 *   - `@main/store/db.js`(`app.getPath`,库文件落哪儿);
 *   - `@main/lib/logger.js`(模块顶层就建 logs 目录);
 *   - `@main/lib/theme.js` / `webToolHost` 那条(`nativeTheme`)。
 *
 * 顺着 alias 一个个堵会变成打地鼠,而每漏一个报出来的都是 esbuild 把真 electron 打成
 * CJS 之后那句 `ERR_AMBIGUOUS_MODULE_SYNTAX`(真那个 `index.js` 里同时有 `require` 和
 * 顶层 await),看着像"被测代码坏了" —— 实测第一次就是这么挂的。
 * 换掉整个包更窄也更准(同 library-delete-smoke / mcp-ipc-smoke 的取舍)。
 *
 * ## ⚠️ 这个桩**有真实现**,不是一律显式抛
 *
 * `app.getPath("userData")` 必须能用:`db.ts` 靠它定位库文件,而本套**要真建库**
 * (名册读的就是会话表)。返回 run.sh 给的临时目录,**没设就抛** —— 悄悄回落到真 userData
 * 等于在用户目录里建 logs、建库(与本套的 dataRoot 桩同一条安全前提)。
 *
 * 其余一律**显式抛**:这套的路一次都不该碰 Electron,真被调到了要立刻显形,而不是安静地
 * 返回 undefined 让断言去猜。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`agent-mail-smoke 不该走到 electron.${name}`);
  };
}

function smokeDataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) {
    throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— agent-mail-smoke 拒绝回落到真 userData");
  }
  return dir;
}

export const app = {
  getPath: (name: string): string => {
    if (name === "userData") return smokeDataRoot();
    throw new Error(`agent-mail-smoke 的 electron 桩只实现了 app.getPath("userData"),被问的是 "${name}"`);
  },
  getAppPath: () => process.cwd(),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: () => Promise.resolve(),
};

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s, "utf8"),
  decryptString: (b: Buffer): string => b.toString("utf8"),
};

export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
export const nativeTheme = { shouldUseDarkColors: false };
export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};
export const session = { fromPartition: notHere("session.fromPartition") };
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };
export const dialog = {
  showSaveDialog: notHere("dialog.showSaveDialog"),
  showOpenDialog: notHere("dialog.showOpenDialog"),
};

/** `browser/BrowserManager.ts` 的**顶层** import 里就带着它(不是"用了才要")——
 *  所以它必须存在,哪怕这套路一次都不碰浏览器。构造出来立刻显形。 */
export class WebContentsView {
  constructor() {
    notHere("new WebContentsView")();
  }
}
