/**
 * `@main/window.js` 的替身 —— 真的那个拿着 `BrowserWindow`,`lib/theme.ts` 从它那儿
 * 取两个符号:`sendToRenderer`(广播 `theme:changed`)与 `updateTitleBarOverlay`
 * (原生标题栏颜色跟主题走)。
 *
 * 这一套要断言的正是**这两个被调了没有、参数是什么**,所以桩要记账,**不能纯抛** ——
 * 纯抛型下「拒了」和「根本没走到」都是"抛了",分不开(同 `dialog-shell-smoke` 里
 * electron 桩的取舍)。
 *
 * ## 顺带解开一个循环 import
 *
 * 真代码里 `lib/theme.ts` → `window.js` → `lib/theme.ts` 是个**环**(两边都只在函数体
 * 里用对方,所以 ESM 下没问题)。换掉这一半之后环就断了 —— 这是桩的一个附带好处,
 * 不是目的。
 */
import { IPC } from "@contracts/ipc";

export interface Broadcast {
  channel: string;
  payload: Record<string, unknown>;
}

/** 按顺序记下每一次推给界面的消息。 */
export const broadcasts: Broadcast[] = [];

/** `updateTitleBarOverlay()` 被调了几次(启动同步一次,之后每次主题/OS 变化一次)。 */
let overlayCalls = 0;

export function overlayCallCount(): number {
  return overlayCalls;
}

/** 每个小节的起点:把记录清空。**故意不提供"只清一半"的口子** —— 数错一次就会
 *  得到一条空过的断言。 */
export function resetWindowRecords(): void {
  broadcasts.length = 0;
  overlayCalls = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  broadcasts.push({
    channel,
    payload: (args[0] ?? {}) as Record<string, unknown>,
  });
}

export function updateTitleBarOverlay(): void {
  overlayCalls += 1;
}

export function getMainWindow(): never {
  throw new Error("theme-ipc-smoke 不该走到 getMainWindow(这一套不碰窗口)");
}

/** 真代码里 `window.ts` 还导出一堆别的;这一套一个都不该碰,碰到就喊出来。 */
export function createMainWindow(): never {
  throw new Error("theme-ipc-smoke 不该走到 createMainWindow");
}

export { IPC };