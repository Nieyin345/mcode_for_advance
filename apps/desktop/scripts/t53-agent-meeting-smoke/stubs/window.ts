/**
 * `@main/window.js` 的替身 —— 只给无头脚本用。
 *
 * 真的那个拿着 `BrowserWindow`(也就 import 了 electron)。本套要观察的是
 * **主进程往渲染端推出去的东西**:`RuntimeManager.fanOutToClients` 走
 * `sendToRenderer`,而"运行集合变了要广播一帧 running 快照"这条修复(2026-10-11)
 * 的唯一可观测痕迹就是那一帧。所以这里把每一条 `sendToRenderer` **记下来**。
 *
 * `hasLiveRendererWindow` 也必须给:广播那一帧要带 `desktopAttached`,它读的就是这个。
 * 真实现是"窗口在、没销毁、没崩" —— 这里给一个可拨的开关(默认 true,模拟"桌面开着")。
 */

let rendererAlive = true;

/** 拨"桌面窗口此刻在不在"(广播帧里的 `desktopAttached` 取它)。 */
export function setRendererAlive(alive: boolean): void {
  rendererAlive = alive;
}

export function hasLiveRendererWindow(): boolean {
  return rendererAlive;
}

export function getMainWindow(): null {
  return null;
}

/** 推给渲染端的每一条——本套据此断言"running 快照真的发出去了"。 */
export const sent: Array<{ channel: string; payload: unknown }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  sent.push({ channel, payload: args[0] });
}

export function updateTitleBarOverlay(): void {}
export function createMainWindow(): never {
  throw new Error("agent-mail-smoke 不该走到 createMainWindow");
}
