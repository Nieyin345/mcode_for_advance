/**
 * `@main/window.js` 的替身 —— 真的那个拿着 BrowserWindow,也就 import 了 `electron`。
 *
 * 模版那一层只用它广播两个事件(`composer:attach` / `templates:changed`),而这个套件
 * **一个广播都不触发**:它只读文件、只看读回来的是什么形状。所以空操作是诚实的 —— 要是
 * 将来有人把广播接进了读取这条路,这个桩会让那条断言仍然过,但那正是它该过的意思
 * (广播不是这个套件要验的东西)。
 */
export function sendToRenderer(channel: string, payload: unknown): void {
  process.stderr.write(`[stub] sendToRenderer(${channel}) ${JSON.stringify(payload)}\n`);
}
