/**
 * `electron` 的替身 —— **只给 clean.ts(干净机器那一趟)用**。
 *
 * 那一趟要的是“这台机器上一个内核来源都探不到”的现场,而现场靠的是**bundle 旁边没有
 * `node_modules`**(见 run.sh):三个 probe 各自的 `createRequire` / `import.meta.resolve`
 * 都解析不到东西,于是如实返回 null。所以这个替身不需要伪装探测结果 —— 它只需要让
 * 打包**不必**把真的 electron 拖进来。
 *
 * `app.getAppPath()` 必须给**真的**应用目录:runtimeInstaller 的 `loadExpectedVersions()`
 * 就是拿它去读本应用自己的 package.json(`pinned` 版本就是从那儿来的)。给不出真路径,
 * `expectedVersion` 会退到 FALLBACK_VERSIONS —— 那样断言“钉版和 activeVersion 不同”
 * 就成了拿兜底常量自证,不算数。
 *
 * `getPath()` 一律**显式抛**:真那个存在时返回的是**用户真实 userData 路径**。万一
 * 将来有人把 install/remove 加进这一趟,让它抛比让它静默写到用户真目录里好得多。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 这个替身自己就在 apps/desktop/scripts/archiver-installer-smoke/stubs/ 下 ——
 *  往上五级就是 apps/desktop(runtimeInstaller 读的是 apps/desktop/package.json)。 */
const APP_DIR = fileURLToPath(new URL("../../../../", import.meta.url));

function notHere(name: string): () => never {
  return () => {
    throw new Error(`archiver-installer-smoke(clean)不该走到 electron.${name}`);
  };
}

export const app = {
  getAppPath: () => APP_DIR,
  getPath: notHere("app.getPath"),
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
export const ipcMain = { handle: notHere("ipcMain.handle") };
export const BrowserWindow = { getAllWindows: notHere("BrowserWindow.getAllWindows") };

void join;
