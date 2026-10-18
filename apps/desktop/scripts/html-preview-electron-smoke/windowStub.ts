/**
 * `@main/window.js` 的替身 —— 只给 HTML 预览真 Electron 探针用。
 *
 * 真的 `window.ts` 会（惰性）拖上语音引擎的 `sherpa-onnx` 原生模块，esbuild 在
 * node 平台下打不了 `.node`。本套件一个字节都不需要它 —— 探针自己 new
 * BrowserWindow，并通过 {@link setProbeWindow} 把它交给 BrowserManager
 * 的 `getMainWindow()`（BrowserManager 创建视图时要往窗口 contentView 挂子视图）。
 */
type Win = {
  isDestroyed(): boolean;
  contentView: { addChildView(view: unknown): void; removeChildView(view: unknown): void };
  webContents: { send(channel: string, payload: unknown): void };
};

let probeWindow: Win | null = null;

export function setProbeWindow(win: Win | null): void {
  probeWindow = win;
}

export function getMainWindow(): Win | null {
  return probeWindow;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  if (probeWindow !== null && !probeWindow.isDestroyed()) probeWindow.webContents.send(channel, payload);
}

export function hasLiveRendererWindow(): boolean {
  return probeWindow !== null && !probeWindow.isDestroyed();
}

export function updateTitleBarOverlay(): void {
  /* 无标题栏 overlay 需求 */
}
