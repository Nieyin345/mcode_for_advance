/**
 * `react-dom` 替身:`createPortal(node, container)` 直接把 `node` 原样返回。
 *
 * `SelectionToolbar` / `SelectionQuoteMenu` 用 `createPortal(..., document.body)`
 * 把浮层挂到 body。fakeReact 只物化 `{type, props}`、不调用子组件,所以这两个浮层
 * 在树里以元素节点存在即可 —— 判据从 `__nodes()` 取它们,再调它们的 `onQuote` /
 * `onPick`(正是组件传下去的那两个**真**回调)。给 `createPortal` 一个恒等替身就够。
 */
export function createPortal(node: unknown): unknown {
  return node;
}
export default { createPortal };
