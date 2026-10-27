/**
 * W26 —— `@main/window.js` 的替身（与 T7/T8 的 `window-holder.ts` 同一取舍）。
 *
 * 生产 `src/main/window.ts` 会拖进语音引擎的原生模块（sherpa-onnx `.node`），本
 * 套件一个字节都不需要它；而 `DocumentViewHost` 的生产单例通过 `getMainWindow()`
 * 取宿主窗口 —— 探针在这里把**自己创建的** BrowserWindow（也就是加载了真
 * `App.tsx` 的那个宿主窗口）交出去。
 *
 * ⚠️ 与 T8 的差异：T8 的旅程 `window:false`（它自己建窗口装编辑器视图），本套件
 * 的旅程 `window:true` —— 宿主窗口**就是**渲染端页面所在的窗口。`documentView`
 * 的原生视图会作为该窗口 contentView 的子视图盖在 `data-engine-view-stage` 的
 * 位置上，这正是生产形态。
 */
import type { BrowserWindow } from "electron";

let mainWindow: BrowserWindow | null = null;

/** 由 `harness.ts` 在 setup 时注入（探针窗口）。 */
export function setMainWindowForU1(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow !== null && mainWindow.isDestroyed()) mainWindow = null;
  return mainWindow;
}

export function hasLiveRendererWindow(): boolean {
  return getMainWindow() !== null;
}

/** 探针不经过 Mcode 的渲染端广播。 */
export function sendToRenderer(): void {
  /* no-op */
}

/** 与生产签名同形（`lib/theme.ts` 也会 import 它）。 */
export function updateTitleBarOverlay(): void {
  /* no-op */
}

/** 探针自己建窗口；生产入口在本套件里不应被调用。 */
export function createMainWindow(): BrowserWindow {
  throw new Error("W26 harness: createMainWindow 不在本套件的能力面内");
}
