/**
 * `@main/lib/pendingBackflow.js` 的替身 —— 真的那份把队列放在模块级 `Map` 里,
 * 从外面看不见。换掉才能断言"删项目时清掉了"。
 *
 * ⚠️ 这个桩**照抄真实现的行为要点**(空串丢掉、`dropBackflow` 只删不取),不然
 * 断言验的是桩自己的脾气:
 *   - `queueBackflow` 空/全空白一律不入队;
 *   - `dropBackflow` 是 `delete`,**不是** `clear`(`clearBackflow` 才是取用后清)。
 */
const pending = new Map<string, Array<{ text: string; source?: string }>>();

/** 记下每一次 `dropBackflow` 的实参。 */
export const dropped: string[] = [];
/** 记下每一次 `queueBackflow` 的实参。 */
export const queued: Array<{ sessionId: string; text: string }> = [];

export function resetBackflowStub(): void {
  pending.clear();
  dropped.length = 0;
  queued.length = 0;
}

export function queueBackflow(sessionId: string, text: string): void {
  const body = text.trim();
  if (body.length === 0) return;
  queued.push({ sessionId, text: body });
  const list = pending.get(sessionId) ?? [];
  list.push({ text: body });
  pending.set(sessionId, list);
}

export function peekBackflow(sessionId: string): string {
  const list = pending.get(sessionId);
  return list === undefined ? "" : list.map(entry => entry.text).join("\n\n");
}

export function clearBackflow(sessionId: string): void {
  pending.delete(sessionId);
}

export function dropBackflow(sessionId: string): void {
  dropped.push(sessionId);
  pending.delete(sessionId);
}

export function backflowPrompt(text: string): string {
  const body = text.trim();
  return body.length === 0 ? "" : `(以下是你上一轮跑完的产出,不用回复)\n\n${body}`;
}

export function replaceBackflowSource(sessionId: string, source: string, text: string): void {
  const list = (pending.get(sessionId) ?? []).filter(entry => entry.source !== source);
  if (text.trim()) list.push({ source, text: text.trim() });
  if (list.length) pending.set(sessionId, list); else pending.delete(sessionId);
}
export function pendingBackflowPrompt(sessionId: string): string { return backflowPrompt(peekBackflow(sessionId)); }
