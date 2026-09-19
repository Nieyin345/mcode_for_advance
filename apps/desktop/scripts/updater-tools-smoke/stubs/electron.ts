/**
 * `electron` 的替身 —— 只有 `app` 是认真实现的。
 *
 * ## 为什么 `getPath("userData")` 必须读环境变量、而且没设就抛
 *
 * `rgInstall.ts` 把 ripgrep 装到 `app.getPath("userData")/bin/` —— 那是**用户真实的
 * 应用数据目录**(`%APPDATA%\@mcode\desktop`)。本套要跑真的下载/解包/改名落盘那条路,
 * 指错地方就是往用户的应用目录里塞一个几 MB 的二进制,而且 `installRg` 开头那句
 * `existsSync(target)` 会**在用户机器上误判成"已经装过"**,从此不再装。
 *
 * 所以这个替身照抄 `dataRoot` 那个桩的口径:**环境变量没设就抛**,不回落。
 */
function requiredDir(name: string): string {
  const dir = process.env[name];
  if (!dir) throw new Error(`${name} 没设 —— 这个桩只给无头脚本用,不许回落到用户真实目录`);
  return dir;
}

export const app = {
  /** 本套的 `<userData>`:rg 的落点(`bin/rg.exe`)与 `tools/` 的假根都从这里派生。 */
  getPath: (name: string) => {
    if (name === "userData") return requiredDir("MCODE_SMOKE_USER_DATA");
    throw new Error(`本套不该走到 app.getPath(${name})`);
  },
  /** 本应用真正在跑的那个版本号 —— 走查不到的路径时 `checkForUpdates` 会报它。 */
  getVersion: () => "0.0.0-smoke",
  /** `detectManualInstallRequired` 拿它去跑 codesign;给一个真目录即可。 */
  getAppPath: () => requiredDir("MCODE_SMOKE_USER_DATA"),
  isPackaged: true,
  on: () => {
    throw new Error("本套不该走到 app.on");
  },
  whenReady: () => {
    throw new Error("本套不该走到 app.whenReady");
  },
};

export const shell = {
  openPath: () => {
    throw new Error("本套不该走到 shell");
  },
};
export const nativeTheme = { shouldUseDarkColors: false, themeSource: "system" };
export const ipcMain = { handle: () => {
  throw new Error("本套自己造 fakeIpc,不该走到真的 ipcMain");
} };
export const BrowserWindow = { getAllWindows: () => [] };
