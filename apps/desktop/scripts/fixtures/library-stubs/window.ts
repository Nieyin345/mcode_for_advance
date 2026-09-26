/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 `electron`。
 *
 * `library/broadcast.ts` 用它推 `library:changed`(左栏那棵树要重拉)。本套不验广播的
 * **内容**,但那一句是被测路径的一部分,所以这里接住、记下来 —— 顺带能断言"入库之后
 * 确实通知了界面"。少了它,用户加完文献左栏是空的,而这和"事件漏发"是**两回事**、
 * 会各自单独坏,所以两样都断。
 */
import { IPC } from "@contracts/ipc";

/** 按顺序记下推给界面的每一条 `library:changed` 的 reason。 */
export const changedReasons: string[] = [];

export function resetSent(): void {
  changedReasons.length = 0;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  if (channel === IPC.LIBRARY_CHANGED) {
    const reason = (payload as { reason?: unknown }).reason;
    changedReasons.push(typeof reason === "string" ? reason : String(reason));
    return;
  }
  process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(payload)}\n`);
}