/** `@renderer/lib/icons.js` 替身 —— TerminalPanel / TerminalCommandsMenu 从它取具名图标。
 *  真那份是个几百导出的 barrel,还牵 `react-icons` / `@tabler/icons-react`;图标在
 *  fakeReact 里只会作为 `{type, props}` 留在树上、从不会被调用,所以整份退化成
 *  "任何具名导出都是一个返回 null 的组件"。CJS Proxy 保证任意具名 import 都能解析。 */
module.exports = new Proxy({}, { get: () => () => null });
