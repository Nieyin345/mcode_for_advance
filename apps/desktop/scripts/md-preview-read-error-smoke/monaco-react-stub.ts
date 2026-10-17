/**
 * `@monaco-editor/react` 替身。
 *
 * 这套判据落在 `EditPane` 的**引用组合逻辑**(选中 → 冻结快照 → 切目标 → 落草稿),
 * 不在 Monaco 本体上。真 Monaco 装不起来(要 DOM / worker / canvas),所以:
 *   - `Editor` / `DiffEditor` 退化成惰性 `{type, props}`(fakeReact 不调用子组件),
 *     真正的 `onMount` 由 main.ts 从树里取出来**手动调用** —— 也就是跑**真**
 *     `handleEditorMount`(它注册 `onDidChangeCursorSelection` 等监听);
 *   - `useMonaco()` 给 null(本套走 warm-start,不需要它建 model)。
 */
export const Editor = (p: Record<string, unknown>) => p.children;
export const DiffEditor = (p: Record<string, unknown>) => p.children;
export function useMonaco(): unknown {
  return null;
}
export default Editor;
