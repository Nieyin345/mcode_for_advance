/** Dialog / Button 的惰性桩：只保留 children 与 props，不起真 base-ui。 */
import type { ReactNode } from "react";

const passthrough = (props: { children?: ReactNode }) => props.children ?? null;

export const Dialog = {
  Root: passthrough,
  Portal: passthrough,
  Backdrop: () => null,
  Popup: passthrough,
  Title: passthrough,
  Description: passthrough,
  Close: () => null,
  Trigger: passthrough,
};

// 不做成"渲染成 <button>"——假运行时不会调用函数组件，节点就停在
// `{type: Button, props}` 这一层，测试按 props 形状认那颗确认键。
export const Button = (_props: Record<string, unknown>): null => null;
