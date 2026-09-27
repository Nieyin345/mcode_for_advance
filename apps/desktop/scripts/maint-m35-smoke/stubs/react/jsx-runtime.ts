export const Fragment = Symbol.for("react.fragment");
export function jsx(type: unknown, props: Record<string, unknown>, key?: string) {
  return { type, props, key: key ?? null };
}
export const jsxs = jsx;
