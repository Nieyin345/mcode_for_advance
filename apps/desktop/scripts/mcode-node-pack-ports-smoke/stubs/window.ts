/**
 * `@main/window.js` 的替身 —— 只给这套无头脚本用。
 *
 * 真那个持有 `BrowserWindow`(electron),无头环境给不出来。被测文件只用到
 * `getMainWindow()`,而且只用它做两件事:
 *   1. 判断「有没有可弹窗的窗口」—— null / `isDestroyed()` 时必须 fail-closed;
 *   2. 把它交给 `dialog.showMessageBox`。
 *
 * 所以这里给一个**可摆状态**的最小窗口:脚本能控制「没有窗口」/「窗口已销毁」/
 * 「正常窗口」三种情形,并让第三个原样流进 electron 桩的调用记录里
 * (断言「弹窗挂在了主窗口上」)。
 */
const liveWindow = {
  isDestroyed: () => false,
  id: 1,
  marker: "main-window-stub",
};

export type WindowState = "live" | "none" | "destroyed";

let state: WindowState = "live";

/** 摆主窗口的状态。 */
export function setMainWindowState(next: WindowState): void {
  state = next;
}

export function getMainWindow(): typeof liveWindow | null {
  if (state === "none") return null;
  if (state === "destroyed") {
    return { ...liveWindow, isDestroyed: () => true };
  }
  return liveWindow;
}

export function hasLiveRendererWindow(): boolean {
  return state === "live";
}

export function sendToRenderer(): void {
  throw new Error("mcode-node-pack-ports-smoke 不该走到 sendToRenderer");
}
