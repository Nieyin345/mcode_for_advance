/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 `electron`。
 *
 * `library/broadcast.ts` 用它推 `library:changed`(左栏那棵树要重拉)。本套不验
 * 广播的**内容**,但 `broadcast` 那一句是导入路径的一部分,所以这里接住、记下来 ——
 * 顺便能断言"导入成功后确实通知了界面",不然用户导入完左栏是空的。
 */
import { IPC } from "@contracts/ipc";

/** 按顺序记下推给界面的每一条 `library:changed`。 */
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