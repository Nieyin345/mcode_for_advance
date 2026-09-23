/**
 * `@main/window.js` 的替身 —— 真的那个 import 了 `electron`(它拿着 BrowserWindow)。
 *
 * 与前几套的空操作桩不同,这一套**有几条断言看的就是广播**:「模板移进回收站之后
 * 另一个入口知不知道」靠 `templates:changed`,「挂进对话了没有」靠 `composer:attach`。
 * 空操作的话那几条是自证 —— 验的是这个桩,不是被测代码。所以这里记下来,main.ts
 * 通过**相对路径** import 这一份(而不是 `@main/window.js` 那个别名),两个 bundle
 * 看见的才是同一个数组。
 */
import type { ComposerAttachMessage, TemplatesChangedMessage } from "@contracts/ipc";

/** 按顺序记下推出去的每一条 `{ channel, payload }`。 */
export interface SentMessage {
  channel: string;
  payload: unknown;
}

export const sent: SentMessage[] = [];

/** 让测试能模拟"窗口已经没了"(`sendToRenderer` 抛)。 */
export let failNext = false;

export function setFailNext(value: boolean): void {
  failNext = value;
}

export function resetSent(): void {
  sent.length = 0;
  failNext = false;
}

/** 只挑某个 channel 的那几条(断言时看得清)。 */
export function sentOn(channel: string): unknown[] {
  return sent.filter((m) => m.channel === channel).map((m) => m.payload);
}

export function resetSentOn(channel: string): void {
  // 就地删掉:调用方可能还握着 `sent` 的引用
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (sent[i]!.channel === channel) sent.splice(i, 1);
  }
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (failNext) throw new Error("no window");
  sent.push({ channel, payload: args[0] });
}

/** 这两个是 `window.ts` 导出、import 图里会拉到的别的名字(本套不验它们)。 */
export function getMainWindow(): null {
  return null;
}

export type { ComposerAttachMessage, TemplatesChangedMessage };