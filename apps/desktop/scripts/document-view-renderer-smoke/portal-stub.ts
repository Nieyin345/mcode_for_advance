/**
 * `react-dom` 替身：`createPortal(node)` 原样返回（fakeReact 惰性物化，浮层节点从
 *  树里取即可）。`flushSync` 直接调用。
 */
export function createPortal(node: unknown): unknown {
  return node;
}
export function flushSync<T>(fn: () => T): T {
  return fn();
}
export default { createPortal, flushSync };
