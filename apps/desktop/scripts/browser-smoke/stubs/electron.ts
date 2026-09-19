/**
 * `electron` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么连 `electron` 包整个换掉
 *
 * 被验的 `ipc/browser.ts` 自己只 import 类型(`import type { IpcMain } from "electron"`,
 * 编译后消失),但它拉进来的 `@main/lib/pathGuard.js` → `@main/store/repositories.js`
 * → `./db.js` 里有一句真的 `import { app } from "electron"`(db.ts 运行期其实一次都没用
 * 到 `app`,但 import 是实打实的,esbuild 会去解析它)。
 *
 * `--alias:electron=…` 一刀切掉整条链,比顺着 import 一个个去堵便宜,也不会漏。
 * (同 `library-delete-smoke/stubs/electron.ts` 的取舍。)
 *
 * ## 为什么一律**显式抛**而不是空实现
 *
 * 空实现(返回 undefined)会让"本套根本没覆盖到的那条路"看起来是绿的。真被调到了
 * 要立刻显形。`ipcMain` 尤其:本套用**自己的**记名替身收 handler,真 electron 的
 * `ipcMain.handle` 一旦被走到,说明 bundle 里进了第二份注册路径 —— 必须炸。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`browser-smoke 不该走到 electron.${name}(${name} 是 electron 的东西,无头脚本给不出来)`);
  };
}

export const app = {
  getPath: notHere("app.getPath"),
  getAppPath: notHere("app.getAppPath"),
  isPackaged: false,
  on: notHere("app.on"),
};

export const ipcMain = {
  handle: notHere("electron.ipcMain.handle"),
};

export const BrowserWindow = {
  getAllWindows: notHere("BrowserWindow.getAllWindows"),
};

export const nativeTheme = { shouldUseDarkColors: false };
