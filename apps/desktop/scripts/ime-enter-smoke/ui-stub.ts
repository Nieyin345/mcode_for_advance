/**
 * `@renderer/components/ui/{index,input,button}.js` 替身。
 *
 * 与被 alias 的组件里的两个关键原语:
 *   - `Input` —— 必须渲染成**真实的 `input` 元素节点**(带 `onKeyDown` 等 props),
 *     断言才能通过 `__nodes()` 找到并驱动它(AuthPromptDialog 的判据就挂在输入框
 *     的 onKeyDown 上)。直通成 children 的话那个处理器根本不在树里。
 *   - 其余(Dialog / Button / …)—— 退化成"渲染 children 的直通",只要求能解析。
 */
export const Input = (props: Record<string, unknown>) => ({ type: "input", props });
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
export const ConfirmDialog = Pass;
export const Select = { Root: Pass, Trigger: Pass, Portal: Pass, Popup: Pass, Item: Pass, Value: Pass };
export const EmptyState = Pass;
export const ErrorNote = Pass;
export const Spinner = Pass;
export const Field = Pass;
export const Badge = Pass;
export const Skeleton = Pass;
export const LoadingNote = Pass;
