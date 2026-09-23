/**
 * `@main/window.js` 的替身 —— 真的那个拿着 `BrowserWindow`(`electron`)。
 *
 * ⚠️ **不是空实现。** 这一套要验的是"主进程发了没有",而走到渲染端的那条路是
 * `lib/sessionSync.ts` 的 `sendToRenderer(IPC.CLAUDE_EVENT, …)` —— 桩里接住,**按顺序
 * 记下来**,断言才有东西可看。写成空函数的话,"一条都没发"和"发得很对"看起来一模一样。
 */
const sentEvents: unknown[] = [];

export function sent(): unknown[] {
  return sentEvents;
}

export function resetSent(): void {
  sentEvents.length = 0;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  const p = payload as { event?: unknown };
  if (p?.event !== undefined) sentEvents.push(p.event);
  else sentEvents.push({ channel });
}

export function getMainWindow(): null {
  return null;
}

export function updateTitleBarOverlay(): void {}

export function createMainWindow(): null {
  return null;
}