/**
 * 一个**只够跑一个函数组件**的极小 React 运行时(形状同 ime-enter-smoke / maint-m35)。
 *
 * `PreviewPanel` 本体不用任何 hook,但这套仍装载它 —— 万一将来它接了 useState,
 * 不改测试就能继续跑;也避免 `react` 落到真的那份上。
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
