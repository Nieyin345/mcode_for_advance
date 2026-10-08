/**
 * `react/jsx-runtime` 的替身:JSX 只变成惰性的 `{type, props}`(子组件**不会被调用**),
 * 但 `ref` prop 要**真的挂上假元素** —— `DocxPreview` 的 effect 头两行就靠它,见
 * `fakeReact.ts` 文件头。所以这里**委托** `fakeReact.createElement`,不另写一份。
 */
import { createElement } from "./fakeReact.js";

export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): unknown {
  const el = createElement(type, props ?? null) as { key?: unknown };
  if (key !== undefined) el.key = key;
  return el;
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol.for("fake.fragment");
