/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 `electron`。
 *
 * `library/broadcast.ts` 用它推 `library:changed`(左栏那棵树要重拉)。本套接住、
 * 记下来 —— 删除之后没通知界面的话,左栏那棵树会一直停在删之前的样子。
 * (`library:jobChanged` 随下载队列一起退役,2026-09-27。)
 */
import { IPC } from "@contracts/ipc";

/** 按顺序记下推给界面的每一条 `library:changed`。 */
export const changedReasons: string[] = [];

export function resetSent(): void {
  changedReasons.length = 0;
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const payload = args[0] ?? {};
  if (channel === IPC.LIBRARY_CHANGED) {
    const reason = (payload as { reason?: unknown }).reason;
    changedReasons.push(typeof reason === "string" ? reason : String(reason));
    return;
  }
  process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(payload)}\n`);
}

export function getMainWindow(): never {
  throw new Error("本套不该走到 getMainWindow(删除这条路上没人碰窗口)");
}