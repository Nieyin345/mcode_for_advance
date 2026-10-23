/**
 * `react/jsx-runtime` 的替身:JSX 只变成惰性的 `{type, props}`,子组件不会被调用。
 *
 * ⚠️ 与 md-preview 那份的差别:这里把 `children` **链进 `props.children`**（真 React
 * 的形状）。不链的话，`__text()` 只能看到 `{children: "..."}` 这类对象节点里的一个
 * 静态串，写在元素之间的裸文本（"GenOffice 编辑器页未构建"这类）会整个从树里消失 ——
 * 判据会假绿。
 */
function withChildren(type: unknown, props: Record<string, unknown> | undefined, children: unknown[]): unknown {
  const p = { ...(props ?? {}) };
  if (children.length > 0) p.children = children.length === 1 ? children[0] : children;
  return { type, props: p };
}
export function jsx(type: unknown, props: Record<string, unknown> | undefined, key?: unknown): unknown {
  return withChildren(type, props, []);
}
export function jsxs(type: unknown, props: Record<string, unknown> | undefined, key?: unknown): unknown {
  return withChildren(type, props, []);
}
export function jsxDEV(
  type: unknown,
  props: Record<string, unknown> | undefined,
  key: unknown,
  _isStatic: boolean,
  _source: unknown,
  _self: unknown,
  ...rest: unknown[]
): unknown {
  void key;
  void _isStatic;
  void _source;
  void _self;
  void rest;
  return withChildren(type, props, []);
}
export const Fragment = Symbol.for("fake.fragment");
