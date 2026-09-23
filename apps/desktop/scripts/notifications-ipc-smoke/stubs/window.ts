/**
 * `@main/window.js` 的替身。真的那个拿着 `BrowserWindow`(也就 import 了 electron)。
 *
 * 本套要拨的正是**「窗口现在是什么状态」** —— `NOTIFICATION_FOCUS_SESSION` 那条路
 * 从头到尾就是在问这个。窗口对象本身在 `stubs/electron.ts` 里(带调用顺序记录),
 * 这里只做两件事:把它交给被测代码、把推给界面的每一条记下来。
 *
 * `sendToRenderer` **必须记下来**:`notification:focusSession` 是"点了通知能不能跳
 * 过去"的唯一痕迹 —— 推丢了用户看到的就是"点了没反应",而这条路由里没有任何别的
 * 可观测物。真那个 `sendToRenderer` 在窗口销毁时静默 return(见 window.ts 注释),
 * 桩照抄这个语义:窗口不在时**不推也不炸**。
 */
import { theWindow, type FakeWindow } from "./electron.js";

/** 推给渲染端的每一条。 */
export const sent: Array<{ channel: string; payload: unknown }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function getMainWindow(): FakeWindow | null {
  return theWindow;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = theWindow;
  if (!win || win.isDestroyed()) return;
  sent.push({ channel, payload: args[0] });
}