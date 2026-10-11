/**
 * `@main/window.js` 替身 —— 只给 `browser-smoke/navigate-main` 那一路。真那个 import
 * 了一大串 `BrowserWindow` / `WebContentsView` 管理逻辑;这一路只用到
 * `getMainWindow()`(假窗口)与 `sendToRenderer()`(记下来,本路不读它,但真代码会调)。
 */
import { fakeMainWindow } from "./electron.js";

export function getMainWindow(): unknown {
  return fakeMainWindow;
}

export const sent: Array<{ channel: string; args: unknown[] }> = [];
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  sent.push({ channel, args });
}

export function updateTitleBarOverlay(): void {}
export function hasLiveRendererWindow(): boolean {
  return true;
}
export function createMainWindow(): never {
  throw new Error("browser-smoke navigate 路不该走到 createMainWindow");
}
