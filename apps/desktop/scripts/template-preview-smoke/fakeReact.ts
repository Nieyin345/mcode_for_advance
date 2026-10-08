/**
 * 一个**只够跑一个函数组件**的极小 React 运行时 —— 本套的地基。
 *
 * 要量的是 `DocxPreview` 的 effect 真跑起来之后**交给 `docx-preview` 的那组选项**。
 * 这个形状只在"effect 真执行、ref 真被挂上、动态 import 真 resolve"时才显形 ——
 * 读源码断言不到,`react-dom/server` 不跑 effect,而仓库里没有 jsdom / react-
 * test-renderer(也不许联网装)。于是 `run.sh` 用 esbuild `--alias:react=` 把真 react
 * 换成这个文件,**组件源码一个字不改**地跑在上面。
 *
 * 与仓库里其它 fakeReact 的一处差别:a15 ref 必须**真的被填上**。`DocxPreview` 的
 * effect 头两行就是 `const host = hostRef.current; if (!host || !styleHost) return;`
 * —— ref 留着 null 的话 effect 会在第一行原样退出,等于什么都没测。所以这里的
 * `createElement` 在遇到 `ref` prop 时给它的 `.current` 挂一个假元素。
 *
 * 边界(故意不做的):只渲染根组件;子组件只以 `{type, props}` 留在树里,不被调用;
 * 没有 key/diff/并发;`__flush` 是"跑到不再脏为止"的确定性刷新。
 */
type AnySlot = Record<string, unknown>;

/** 假 DOM 元素 —— 够 `DocxPreview` 的 effect 跑完(innerHTML/clientWidth/querySelector)。 */
export interface FakeEl {
  innerHTML: string;
  clientWidth: number;
  style: Record<string, string>;
  querySelector: (sel: string) => FakeEl | null;
}
function makeEl(): FakeEl {
  return { innerHTML: "", clientWidth: 300, style: {}, querySelector: () => null };
}

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
export function useDeferredValue<T>(v: T): T {
  return v;
}
export function useContext<T>(ctx: { _v: T }): T {
  return ctx._v;
}
export function createContext<T>(v: T): { _v: T; Provider: unknown; Consumer: unknown } {
  const ctx = { _v: v, Provider: (p: { children?: unknown }) => p.children, Consumer: null };
  return ctx;
}

export function createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown {
  const p = { ...(props ?? {}) };
  // ★ ref 真的挂上假元素 —— 见文件头。`DocxPreview` 的 effect 靠它才不早退。
  const ref = p.ref as { current: unknown } | undefined;
  if (ref && typeof ref === "object") ref.current = makeEl();
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

/** 跑到"既没有待处理的微/宏任务、也不再脏"为止。 */
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

export default {
  useState, useReducer, useRef, useMemo, useCallback, useEffect, useLayoutEffect,
  useInsertionEffect, useSyncExternalStore, useDebugValue, useId, useTransition,
  useImperativeHandle, useDeferredValue, useContext, createContext, createElement, Fragment, memo,
  forwardRef, isValidElement, StrictMode,
};
