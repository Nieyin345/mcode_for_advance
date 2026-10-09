// FilePreview's hook states are injected to exercise its real render decisions.
let values: unknown[] = [];
export function setRenderStates(...states: unknown[]): void { values = [...states]; }
/** 记录 state setter 收到的值 —— 用来观察"某个按钮点了以后 relPath 变成什么"。
 *  现有用例只注入初值、不点 setter,所以加这个数组不影响它们。 */
export const setterCalls: unknown[] = [];
export function useState<T>(initial: T): [T, (value: unknown) => void] {
  if (!values.length) throw new Error("Missing injected hook state");
  return [values.shift() as T, (value: unknown) => { setterCalls.push(value); }];
}
export function useRef<T>(initial: T | null) { return { current: initial }; }
export function useEffect(_effect: () => unknown, _deps?: unknown[]): void {}
export function useCallback<T extends (...args: any[]) => any>(fn: T, _deps?: unknown[]): T { return fn; }
export function useMemo<T>(fn: () => T, _deps?: unknown[]): T { return fn(); }

/* ── 下面这几个是 2026-09-29 补的 ──────────────────────────────────────────
 *
 * `FilePreview` 那条依赖链后来引入了 context / forwardRef / useLayoutEffect,而这份桩
 * 只有最早那五个 hook —— esbuild 于是直接 `No matching export`,整套**编译都过不去**
 * (不是断言失败,是根本没跑)。补齐的原则同上:**确定性**,不做真实调度。
 */

/** 与 `jsx-runtime` 那份**同一个形状**(`{type, props, key}`)—— `preview.ts` 的 `find()`
 *  靠 `el.type === component` 和 `el.props.children` 往下走,形状不一致它就什么都找不到。 */
export function createElement(
  type: unknown,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
): { type: unknown; props: Record<string, unknown>; key: null } {
  const merged: Record<string, unknown> = { ...(props ?? {}) };
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type, props: merged, key: null };
}

/** 直接还回渲染函数本身,`ref` 恒为 null。这套量的是**元素树的形状**,ref 转发在这里
 *  没有观察点 —— 假装转发反而会让人以为它被测过了。 */
export function forwardRef<P, R>(render: (props: P, ref: R | null) => unknown): (props: P) => unknown {
  return (props: P) => render(props, null);
}

export interface StubContext<T> {
  _currentValue: T;
  Provider: (props: { value: T; children?: unknown }) => unknown;
  Consumer: (props: { children: (value: T) => unknown }) => unknown;
}

/** 值就存在 context 对象上,`Provider` 写、`useContext` 读。`Provider` 直接还回
 *  `children` 而不是包一层元素 —— 包一层会在树里多出一级,`find()` 仍能穿过去,但
 *  断言里数层数的地方会平白多一层。 */
export function createContext<T>(defaultValue: T): StubContext<T> {
  const context: StubContext<T> = {
    _currentValue: defaultValue,
    Provider: (props) => {
      context._currentValue = props.value;
      return props.children;
    },
    Consumer: (props) => props.children(context._currentValue),
  };
  return context;
}

export function useContext<T>(context: StubContext<T>): T {
  return context._currentValue;
}

/** 同 `useEffect`:这套只看**一次渲染的产物**,不跑副作用。 */
export function useLayoutEffect(_effect: () => unknown, _deps?: unknown[]): void {}

/** PDF branch test: lazy Markdown must not load or render a DOM editor. */
export function lazy(_load: () => Promise<unknown>) { return () => { throw new Error("Unexpected lazy component rendering in PDF test"); }; }
export const Suspense = (props: { children?: unknown }) => props.children;
