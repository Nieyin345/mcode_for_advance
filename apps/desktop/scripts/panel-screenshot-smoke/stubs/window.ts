/** `@main/window.js` 的替身 —— 真的那个 import electron。本套自造一个可控的「主窗口」,
 *  让 `screenshot_panel` 能走到 `capturePage` 那一步(而不是一进去就"窗口没开")。
 *  `setMainWindow(null)` 模拟"窗口没开"。 */
export interface FakeWebContents {
  isDestroyed(): boolean;
  capturePage(rect?: unknown): Promise<{ isEmpty(): boolean; toPNG(): Buffer }>;
}
export interface FakeWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  webContents: FakeWebContents;
}

let current: FakeWindow | null = null;

export function setMainWindow(w: FakeWindow | null): void {
  current = w;
}
export function getMainWindow(): FakeWindow | null {
  return current;
}
export function sendToRenderer(..._args: unknown[]): void {}
