/**
 * `@main/window.js` 的替身。真的那个拿着 `BrowserWindow`(也就 import 了 electron)。
 *
 * 本套要控制的正是**"窗口在不在前台"** —— `NotificationManager.onEvent` 的头两行就是
 * 拿这个当闸门(前台时界面自己有 toast,不该再弹系统通知)。所以这里必须能拨。
 *
 * `sendToRenderer` 也记下来:点通知会推一条 `notification:focusSession`,那是"点一下
 * 能不能跳过去"的唯一可观测痕迹。本套不模拟点击(那要走 `notif.on("click")`,桩里
 * 没留回调),但**记下来**是为了让"通知弹出时不该顺手推导航"这条将来能断言。
 */
import type { RuntimeEvent } from "@contracts/runtime";

let windowAlive = true;
let focused = false;
let minimized = false;

export function setWindow(opts: { alive?: boolean; focused?: boolean; minimized?: boolean }): void {
  if (opts.alive !== undefined) windowAlive = opts.alive;
  if (opts.focused !== undefined) focused = opts.focused;
  if (opts.minimized !== undefined) minimized = opts.minimized;
}

interface FakeWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export function getMainWindow(): FakeWindow | null {
  if (!windowAlive) return null;
  return {
    isDestroyed: () => false,
    isFocused: () => focused,
    isMinimized: () => minimized,
    restore: () => {},
    show: () => {},
    focus: () => {},
  };
}

/** 推给渲染端的每一条(点通知时的导航走这里)。 */
export const sent: Array<{ channel: string; payload: unknown }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  sent.push({ channel, payload });
}

/** 有的模块会读它,给个空实现兜着(本套不断言 toast 层)。 */
export function sendToRendererQuiet(channel: string, payload: unknown): void {
  sendToRenderer(channel, payload);
}

/** 类型占位,免得 `RuntimeEvent` 那个 import 被 lint 当成没用。 */
export type { RuntimeEvent };
