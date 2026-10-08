/** `@base-ui/react/menu` 替身:只提供被测 JSX 引用到的成员。它们都是子元素,不会被
 *  fakeReact 调用 —— 只要 import 能解析即可(整棵 JSX 树已经作为 `{type, props}`
 *  物化出来了,所以这些组件内部的 input/button 依然可被 `__nodes()` 找到)。 */
const Pass = (p: { children?: unknown }) => p.children;
const members = {
  Root: Pass,
  Trigger: Pass,
  Portal: Pass,
  Positioner: Pass,
  Popup: Pass,
  Item: Pass,
  Separator: Pass,
};
export const Menu = members;
export const ContextMenu = members;
