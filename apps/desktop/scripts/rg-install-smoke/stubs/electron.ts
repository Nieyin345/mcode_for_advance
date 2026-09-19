/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么整包替掉,而不是一个个 alias 模块
 *
 * 本套 import 的是 `@main/ipc/rg.js` 与 `@main/lib/rgInstall.js`,它们自己只用
 * `app.getPath("userData")`。可选 alias 一个个堵也行,但 `@main/lib/rgSearch.js`
 * (install 那条路要调它的 `bundledRgPath` / `resetRgCache`)的 import 图里还有别的
 * Electron 面。整包换掉更窄也更准 —— 同 library-delete-smoke 的取舍。
 *
 * ## 为什么是"设指针"而不是"一个写死的路径"
 *
 * ⚠️ **这一套最要紧的安全前提。** `rgInstall.doInstall()` 的第一步就是
 * `app.getPath("userData")`,然后把下载、解压、最后 `renameSync` 进去的目标全挂在它
 * 下面。无头脚本给不出真的 electron,所以这个桩返回什么,就等于**这套脚本会往哪里
 * 写、往哪里 rename**。
 *
 * 它**不写死**成自己的临时目录:那样 `run.sh` 里 `MCODE_SMOKE_INSTALL_ROOT` 那行就成
 * 了摆设,而"安装根真的被换掉了"这件事没有任何断言在盯。所以这里只认环境变量,
 * **没设就抛** —— 抛比默默落到某个默认路径好得多(同 dataRoot 桩的取舍)。
 */
const root = process.env.MCODE_SMOKE_INSTALL_ROOT;
if (!root) {
  throw new Error(
    "MCODE_SMOKE_INSTALL_ROOT 没设 —— 这个桩只给无头脚本用,没设就是没有安装根可写",
  );
}

/** 让脚本能复核"桩和脚本用的是同一个根"(而不是各自记了一份)。 */
export const __installRoot = root;

function notHere(name: string): () => never {
  return () => {
    throw new Error(`rg-install-smoke 不该走到 electron.${name}(这套只碰 app.getPath)`);
  };
}

export const app = {
  getPath: (name: string): string => {
    // userData 之外的路径本套用不到。真被问到了要立刻显形,而不是返回一个
    // 看着像路径的字符串让断言去猜。
    if (name !== "userData") {
      throw new Error(`rg-install-smoke 的 electron 桩只实现了 getPath("userData"),问的是 ${name}`);
    }
    return root;
  },
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
  whenReady: notHere("app.whenReady"),
};

export const shell = {
  openPath: notHere("shell.openPath"),
  openExternal: notHere("shell.openExternal"),
  showItemInFolder: notHere("shell.showItemInFolder"),
};

export const nativeTheme = { shouldUseDarkColors: false, themeSource: "system" };
/** 本套自己造了一个 `ipcMain`(记名替身,从它身上取 handler),这个不该被用到。 */
export const ipcMain = { handle: notHere("electron.ipcMain.handle") };
export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };
