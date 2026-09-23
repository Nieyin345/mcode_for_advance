/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 `electron`。
 *
 * 与前几个套件的桩不同,这一套**要断言广播了什么**:一跳展开的全部可观测行为就是
 * "推了几条 composer:attach、每条长什么样"。所以这里把调用记下来,main.ts 跑完再读。
 */
import type { ComposerAttachMessage } from "@contracts/ipc";

/** 按顺序记下推出去的每一条。 */
export const sent: ComposerAttachMessage[] = [];

/** 让测试能模拟"窗口已经没了"(sendToRenderer 抛)。 */
export let failNext = false;

export function setFailNext(value: boolean): void {
  failNext = value;
}

export function resetSent(): void {
  sent.length = 0;
  failNext = false;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  if (failNext) throw new Error("no window");
  if (channel === "composer:attach") {
    sent.push(payload as ComposerAttachMessage);
    return;
  }
  process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(payload)}\n`);
}