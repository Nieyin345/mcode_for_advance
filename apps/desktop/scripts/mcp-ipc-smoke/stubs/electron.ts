/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么换整个包而不是逐个 alias 模块
 *
 * `ipc/mcp.ts` 自己的 import 图里有三处拉 electron,而且都藏在深处:
 *   - `@main/lib/logger.js` → `app.getPath("userData")`(日志文件);
 *   - `@main/lib/secretStore.js`(经 `codexModelsStore` → `materializeAllMcpViews`
 *     的动态 import)→ `safeStorage`;
 *   - `@main/window.js`(经 `TerminalManager` → `loadNodePty` 那条)。
 * 顺着 alias 一个个堵会变成打地鼠,而且每漏一个报出来的都是 esbuild 把真 electron
 * 打成 CJS 之后那句 `ERR_AMBIGUOUS_MODULE_SYNTAX`,看起来和"被测代码坏了"一模一样
 * (见 library-delete-smoke/stubs/electron.ts 的同一段说明)。
 *
 * ## ⚠️ 这个桩**有真实现**,不是一律显式抛
 *
 * 与 `library-delete-smoke` 那边不同:那套的路一次都不碰 Electron,所以一律抛。
 * 本套**必须要** `app.getPath("userData")` —— 因为 `@main/lib/logger.js` 在
 * 模块顶层就会拿它建 logs 目录(`getLogFile`),而 logger 是本套**故意不换**的
 * (见 run.sh:日志要真落到临时目录,而不是被静默吞掉)。给一个能用的
 * userData 比给一个会抛的桩更接近真机。
 *
 * `safeStorage` 同理:`codexModelsStore` → `secretStore` 在**模块加载时**就会问
 * `isEncryptionAvailable()`。这里的返回值决定它把密钥当密文还是 base64 ——
 * 本套不配任何 codex provider(夹具里没有),所以两条路都不影响断言。
 *
 * `BrowserWindow` / `nativeTheme` / `shell` / `session` 一律**显式抛**:
 * MCP 管理这条路一个都不该走到,真被调到了要立刻显形。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`mcp-ipc-smoke 不该走到 electron.${name}`);
  };
}

/** 数据根:指向 run.sh 给的临时目录。**没设就抛** —— 与本套的 dataRoot 桩同一条
 *  安全前提:悄悄回落到真 userData 等于在用户目录里建 logs、建库。 */
function smokeDataRoot(): string {
  const dir = process.env.MCODE_SMOKE_DATA_ROOT;
  if (!dir) {
    throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— mcp-ipc-smoke 拒绝回落到真 userData");
  }
  return dir;
}

export const app = {
  getPath: (name: string): string => {
    if (name === "userData") return smokeDataRoot();
    throw new Error(`mcp-ipc-smoke 的 electron 桩只实现了 app.getPath("userData"),被问的是 "${name}"`);
  },
  getAppPath: () => process.cwd(),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: () => Promise.resolve(),
};

/** 见文件头:只为了让 `secretStore` 的模块顶层那一次探测有个确定答案。 */
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
