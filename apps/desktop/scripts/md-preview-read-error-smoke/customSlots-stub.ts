/**
 * `@renderer/components/customUi/CustomSlotHosts.js` 替身。
 *
 * 真模块拉进 `@base-ui/react/menu` + customUiStore 一大串,而引用组合**不关心**
 * 自定义挂载位。`registerEditorSelectionActions` 在 `handleEditorMount` 里被调用,
 * 给它一个返回拆卸函数的 no-op 即可;`SelectionCustomButtons` 是子组件(不渲染)。
 */
export function registerEditorSelectionActions(): () => void {
  return () => {};
}
export function SelectionCustomButtons() {
  return null;
}
