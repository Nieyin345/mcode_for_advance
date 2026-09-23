/**
 * `@main/window.js` 的替身 —— 真的那个 import 了 `electron`。
 *
 * 本套只走"导出 / 检索 / 分档"这三件事,唯一会碰到它的是 `library/broadcast.ts`
 * 的 `sendToRenderer`。它不是空实现:记下来,顺手把"真的发了没有"也变成可断言的。
 */
import { IPC } from "@contracts/ipc";

export const sent: Array<{ channel: string; payload: unknown }> = [];

export function resetSent(): void {
  sent.length = 0;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  sent.push({ channel, payload });
  if (channel !== IPC.LIBRARY_CHANGED) {
    process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(payload)}\n`);
  }
}