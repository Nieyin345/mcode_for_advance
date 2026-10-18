/**
 * `@monaco-editor/react` 替身。本套只挂 `EditorToolbar` / `GenofficeViewHostPane`
 * 与 `FileEditor` 的路由分支 —— 选中的 pane 是 `GenofficeViewHostPane`（或 Office 的
 * OnlyOffice 桩），Monaco 的 `Editor`/`DiffEditor` 被惰性物化、从不调用。
 */
export const Editor = (p: Record<string, unknown>) => p.children;
export const DiffEditor = (p: Record<string, unknown>) => p.children;
export function useMonaco(): unknown {
  return null;
}
export default Editor;
