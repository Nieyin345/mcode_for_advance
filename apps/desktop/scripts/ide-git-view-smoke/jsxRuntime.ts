/** `react/jsx-runtime` 的替身:JSX 只变成惰性的 `{type, props}`,子组件不会被调用。 */
export function jsx(type: unknown, props: Record<string, unknown>): unknown {
  return { type, props: props ?? {} };
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol.for("fake.fragment");
