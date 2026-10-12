/**
 * `react/jsx-runtime` 的替身:`jsx(type, props, key)` 委托 `fakeReact.createElement` ——
 * 后者在遇到 `ref` prop 时按 `key` 挂/取假 iframe 元素(见 `fakeReact.ts` 文件头)。
 */
import { createElement } from "./fakeReact.js";

export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): unknown {
  return createElement(type, props ?? null, key);
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol.for("fake.fragment");
