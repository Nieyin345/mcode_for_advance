/**
 * 一个**只够跑一个函数组件**的极小 React 运行时 —— 这套 smoke 的地基。
 *
 * 为什么需要它:要红灯的是 `MobileGitScreen` 的**异步回包竞态**(切仓库 / 切项目
 * 后,旧的 `git:discoverRepos` / `git:status` 回包把新状态盖掉)。这个形状只在
 * "effect 真跑起来、setState 真落到状态里"时才显形 —— 读源码断言不到,
 * `react-dom/server` 不跑 effect,而这个仓库里没有 jsdom / react-test-renderer,
 * 也不许联网装。
 *
 * 于是换一条路:`run.sh` 用 esbuild `--alias:react=` 把**真 react 换成这个文件**,
 * 组件源码一个字不改地跑在上面。组件函数本体、它的 `useEffect` 回调、它的
 * `onChange` handler 都是**真的那份代码**,只有调度器是假的。
 *
 * 边界(故意不做的):
 *   - 只渲染根组件。子组件(BranchSheet / DiffOverlay / 图标)只以 `{type, props}`
 *     的形式留在树里,**不会被调用** —— 这套要验的状态全在根组件里。
 *   - 没有 key/diff/并发特性。`__flush()` 是"跑到不再脏为止"的确定性刷新。
 */
type AnySlot = Record<string, unknown>;

let slots: AnySlot[] = [];
let idx = 0;
let rootFn: (() => unknown) | null = null;
let tree: unknown = null;
let dirty = false;
let pending: Array<{ slot: AnySlot; create: () => unknown; changed: boolean }> = [];

function sameDeps(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

function slot(): AnySlot {
  const i = idx++;
  slots[i] ??= {};
  return slots[i];
}

export function useState<T>(init: T | (() => T)): [T, (u: T | ((p: T) => T)) => void] {
  const s = slot();
  if (!("v" in s)) s.v = typeof init === "function" ? (init as () => T)() : init;
  const set = (u: T | ((p: T) => T)): void => {
    const next = typeof u === "function" ? (u as (p: T) => T)(s.v as T) : u;
    if (!Object.is(next, s.v)) {
      s.v = next;
      dirty = true;
    }
  };
  return [s.v as T, set];
}

export function useReducer<S, A>(reducer: (s: S, a: A) => S, init: S): [S, (a: A) => void] {
  const [v, set] = useState<S>(init);
  return [v, (a: A) => set((p) => reducer(p, a))];
}

export function useRef<T>(init: T): { current: T } {
  const s = slot();
  s.ref ??= { current: init };
  return s.ref as { current: T };
}

export function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  const s = slot();
  if (!("v" in s) || !sameDeps(s.deps as unknown[] | undefined, deps)) {
    s.v = factory();
    s.deps = deps;
  }
  return s.v as T;
}

export function useCallback<T>(fn: T, deps?: unknown[]): T {
  return useMemo(() => fn, deps);
}

function effectHook(create: () => unknown, deps?: unknown[]): void {
  const s = slot();
  const changed = !("deps" in s) || !sameDeps(s.deps as unknown[] | undefined, deps);
  s.deps = deps;
  pending.push({ slot: s, create, changed });
}
export const useEffect = effectHook;
export const useLayoutEffect = effectHook;
export const useInsertionEffect = effectHook;

export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T {
  const s = slot();
  if (!s.subscribed) {
    s.subscribed = true;
    s.unsub = subscribe(() => {
      dirty = true;
    });
  }
  return getSnapshot();
}

export function useDebugValue(): void {}
export function useId(): string {
  const s = slot();
  s.id ??= `:r${idx}:`;
  return s.id as string;
}
export function useTransition(): [boolean, (fn: () => void) => void] {
  return [false, (fn) => fn()];
}
export function useImperativeHandle(): void {}
export function useContext<T>(ctx: { _v: T }): T {
  return ctx._v;
}
export function createContext<T>(v: T): { _v: T; Provider: unknown; Consumer: unknown } {
  const ctx = { _v: v, Provider: (p: { children?: unknown }) => p.children, Consumer: null };
  return ctx;
}

export function createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown {
  const p = { ...(props ?? {}) };
  if (children.length > 0) p.children = children.length === 1 ? children[0] : children;
  return { type, props: p };
}
export const Fragment = Symbol.for("fake.fragment");
export function memo<T>(c: T): T {
  return c;
}
export function forwardRef<T>(c: T): T {
  return c;
}
export function isValidElement(v: unknown): boolean {
  return !!v && typeof v === "object" && "type" in (v as object);
}
export const StrictMode = Fragment;

// `lazy` / `Suspense`：本套被挂的根组件（TerminalPanel）用它们做终端的惰性加载。
// fakeReact 只渲染根组件，被 lazy 包住的子件永远不会被调用 —— `lazy` 直接返回工厂、
// `Suspense` 直通 children 即可（判据不依赖子件真的实例化）。
export function lazy<T>(factory: () => T): () => T {
  return factory as unknown as () => T;
}
export function Suspense(p: { children?: unknown }): unknown {
  return p.children;
}

// ── 测试侧的驱动面 ────────────────────────────────────────────────────────
export function __mount(fn: () => unknown): void {
  rootFn = fn;
  slots = [];
  __render();
}

export function __render(): void {
  if (!rootFn) throw new Error("__mount first");
  dirty = false;
  idx = 0;
  pending = [];
  tree = rootFn();
  for (const e of pending) {
    if (!e.changed) continue;
    const prev = e.slot.cleanup as (() => void) | undefined;
    if (prev) prev();
    const next = e.create();
    e.slot.cleanup = typeof next === "function" ? next : undefined;
  }
}

/** 跑到"既没有待处理的微/宏任务、也不再脏"为止 —— 让乱序回包各自落地。 */
export async function __flush(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    if (dirty) __render();
    else if (i > 1) return;
  }
}

export function __tree(): unknown {
  return tree;
}

/** 深度优先收集树里的所有元素节点。 */
export function __nodes(): Array<{ type: unknown; props: Record<string, unknown> }> {
  const out: Array<{ type: unknown; props: Record<string, unknown> }> = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    if (!("type" in el)) return;
    out.push({ type: el.type, props: el.props ?? {} });
    walk(el.props?.children);
  };
  walk(tree);
  return out;
}

/** 树里渲染出来的所有文本,拼成一条。 */
export function __text(): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || n === false || n === true) return;
    if (typeof n === "string" || typeof n === "number") return void parts.push(String(n));
    if (Array.isArray(n)) return void n.forEach(walk);
    if (typeof n === "object") walk((n as { props?: { children?: unknown } }).props?.children);
  };
  walk(tree);
  return parts.join(" ");
}

export default {
  useState, useReducer, useRef, useMemo, useCallback, useEffect, useLayoutEffect,
  useInsertionEffect, useSyncExternalStore, useDebugValue, useId, useTransition,
  useImperativeHandle, useContext, createContext, createElement, Fragment, memo,
  forwardRef, isValidElement, StrictMode,
};
