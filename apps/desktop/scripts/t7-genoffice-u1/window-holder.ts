/**
 * T7 —— `@main/window.js` 的替身：把**探针自己创建的** BrowserWindow 交给生产单例。
 *
 * ## 为什么必须替身（而不是用真 window.ts）
 *
 * 生产 `@main/window.js` 会拖进语音引擎的原生模块（sherpa-onnx `.node`），esbuild
 * 在 node 平台下解析不了；本套件一个字节都不需要它（与
 * `document-view-electron-smoke/stubs/window.ts` 同一取舍）。
 *
 * ## 为什么不能像那个替身一样返回 null
 *
 * T7 的 GenOffice 视图要挂到窗口上（`DocumentViewHost.open` → `liveWindow()`）。
 * 而且 sheets/slides 的 Pane 围栏（`genofficeNativeVendor.ts` 的 `paneGuard`）
 * 闭包引用的就是**生产 `documentViewHost` 单例** —— 围栏的 `ownsSender` 用
 * `documentViewHost.docIdForSender`。探针若另建一个 Host 实例，围栏永远不认
 * 探针的视图（实测：`sheets:has-queued-workbook` 被判「未授权的文档视图」）。
 * 所以 T7 必须用**同一个单例**，它 `getMainWindow()` 返回探针窗口 —— 就靠本文件。
 */
import type { BrowserWindow } from "electron";

let mainWindow: BrowserWindow | null = null;

/** 由 `harness.ts` 在 setup 时注入（探针窗口）。 */
export function setMainWindowForU1(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow !== null && mainWindow.isDestroyed()) {
    mainWindow = null;
  }
  return mainWindow;
}

export function sendToRenderer(..._args: unknown[]): void {
  // 探针不经过 Mcode 的渲染端广播；GenOffice 视图的推送走各自的 webContents。
}

export function hasLiveRendererWindow(): boolean {
  return getMainWindow() !== null;
}
