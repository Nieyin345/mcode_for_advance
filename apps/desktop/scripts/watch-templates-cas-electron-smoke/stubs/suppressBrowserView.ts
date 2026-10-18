/**
 * `@renderer/hooks/useSuppressBrowserView.js` 的替身 —— 只为本套件的真 Electron 页面。
 *
 * 真 hook 订阅 `sessionStore` 的 `suppressBrowserView`（那个 store 7000+ 行，拖
 * monaco/pdf 一整棵编辑器依赖）并做浏览器视图的几何测量。本套验的是**守望模板的
 * 并发保存**，页面里根本没有内嵌浏览器视图 —— 抑制与否没有可观察语义。真组件
 * `WatchSegment` 只要求这个 hook 存在且能调用；传空实现不改变被测行为。
 */
export function useSuppressBrowserView(_open: boolean, _popupRef?: unknown): void {
  /* 本套页面没有 BrowserView，无需抑制 */
}
