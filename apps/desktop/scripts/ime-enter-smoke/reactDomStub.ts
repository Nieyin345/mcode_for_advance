/**
 * `react-dom` 替身 —— `SelectionQuoteMenu` 走 `createPortal` 把浮层挂到 body。
 * 假运行时里没有真 DOM,直通返回 children 就够(它的 keydown 处理器挂在树里的
 * `<input>` 上,不需要真的 portal 才能被驱动)。
 */
export function createPortal(children: unknown): unknown {
  return children;
}
