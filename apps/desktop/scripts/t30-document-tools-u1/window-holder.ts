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

/** 由本套件的 setup 注入（探针窗口）。 */
export function setMainWindowForU1(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
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
