/**
 * T30 —— `@main/window.js` 的替身。**直接复用 T7 的 `window-holder.ts`**，
 * 只补本套件 import 链会碰到的两个导出（`lib/theme.ts` 与 `ipc/claude.ts` 会用到）。
 *
 * 为什么不改 T7 那一份：T7 的窗口替身是 T16/T7 的交付物，本卡边界写明不改它；
 * 这里用 esbuild alias 把 `@main/window.js` 指到本文件，T7 的旅程不受影响。
 *
 * 为什么不能直接用真 `window.ts`：它会拖进语音引擎的原生模块
 * （sherpa-onnx `.node`）与 Electron 窗口管理，esbuild 在 node 平台解析不了；
 * 探针只需要「把探针窗口交给生产单例」这一件事。
 */
import type { BrowserWindow } from "electron";

let mainWindow: BrowserWindow | null = null;

/**
 * 由本套件的 setup 注入（探针窗口）。
 *
 * ## ⚠️ 为什么还要问 T7 的替身（W24 实测，假门禁盖住的第二个缺陷）
 *
 * esbuild 把 `@main/window.js` 别名到**本文件**，而 `t7-genoffice-u1/harness.ts`
 * 是用**相对路径** `./window-holder.js` import 它自己那一份的 —— 于是同一份逻辑在
 * 产物里是**两个模块实例**（实测 `journeys.cjs` 里 `window_holder` + `window_holder2`）：
 *
 *  - `assembleHarness()` 调的是 T7 那份的 `setMainWindowForU1(win)`；
 *  - 生产 `documentViewHost.liveWindow()` 经 `@main/window.js` 读的是**本文件**这份，
 *    它的 `mainWindow` 永远是 null → `主窗口尚未就绪，无法创建文档视图`。
 *
 * 所以本文件不能自己存一份就完事：**先读 T7 那份**（若它在同一个 bundle 里），
 * 让两条路径看到同一个窗口。这样不必改 T7 的交付物，也不会出现两份状态。
 *
 * `import` 是惰性的且只在 t30 的 bundle 里成立；t30 的 vendor-esbuild 已把
 * `t7-genoffice-u1/harness.js` 打进同一产物，T7 的 `window-holder.js` 一定在。
 */
import * as t7WindowHolder from "../t7-genoffice-u1/window-holder.js";

const t7Holder = t7WindowHolder as unknown as {
  getMainWindow?: () => BrowserWindow | null;
};

export function setMainWindowForU1(win: BrowserWindow | null): void {
  mainWindow = win;
  // 同步给 T7 那份：`harness.ts` 自己会调它的 setter，但生产 `@main/window.js`
  // 在 t30 里指向本文件 —— 两边都要看得见同一个窗口。
  (t7WindowHolder as unknown as { setMainWindowForU1?: (w: BrowserWindow | null) => void })
    .setMainWindowForU1?.(win);
}

export function getMainWindow(): BrowserWindow | null {
  // T7 先（`harness.ts` 在 setup 阶段只调它的 setter）；本文件的副本作兜底。
  const fromT7 = t7Holder.getMainWindow?.() ?? null;
  if (fromT7 !== null && !fromT7.isDestroyed()) return fromT7;
  if (mainWindow !== null && mainWindow.isDestroyed()) mainWindow = null;
  return mainWindow;
}

export function sendToRenderer(..._args: unknown[]): void {
  // 探针不经过 Mcode 的渲染端广播；文档视图的推送走各自的 webContents。
}

export function hasLiveRendererWindow(): boolean {
  return getMainWindow() !== null;
}

/** `lib/theme.ts` 顶层的 import；探针不画标题栏，空实现即可。 */
export function updateTitleBarOverlay(): void {}

/** 探针不起主窗口（窗口由 T16 runner 建）；import 到了这里说明有模块在启动期建窗。 */
export function createMainWindow(): never {
  throw new Error("T30: 探针不创建主窗口（由 U1 runner 负责）");
}
