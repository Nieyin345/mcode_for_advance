/** `@renderer/components/ui/index.js` 替身:`Button` 与 `Dialog` 的全部成员都退化成
 *  "渲染 children 的直通"。被测的是 GitRepoCard 内部的**表单/键盘逻辑**,不是这些
 *  primitives 的样式 —— 它们作为 `{type, props}` 留在树里,内部的 input/button 仍可被
 *  `__nodes()` 找到并驱动。 */
const Pass = (p: { children?: unknown }) => p.children;

export const Button = Pass;
export const Dialog = {
  Root: Pass,
  Trigger: Pass,
  Portal: Pass,
  Backdrop: Pass,
  Popup: Pass,
  Title: Pass,
  Description: Pass,
  Close: Pass,
};
export const Input = Pass;
export const ConfirmDialog = Pass;
export const Select = { Root: Pass, Trigger: Pass, Portal: Pass, Positioner: Pass, Popup: Pass, List: Pass, Item: Pass, Value: Pass, Group: Pass, GroupLabel: Pass };
export const EmptyState = Pass;
export const ErrorNote = Pass;
export const Spinner = Pass;
export const Field = Pass;
export const Badge = Pass;
export const Skeleton = Pass;
export const LoadingNote = Pass;
export const Switch = Pass;
export const Checkbox = Pass;
export const Tooltip = Pass;
