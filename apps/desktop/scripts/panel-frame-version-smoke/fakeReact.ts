/**
 * 一个**只够跑 `PanelFrame` 一个函数组件**的极小 React 运行时 —— 这套 smoke 的地基。
 *
 * 要红灯的是 `PanelFrame` 的**换版竞态**:同一条 `item.id` 的面板 HTML 改了之后,旧
 * iframe 在新文档 stage 完成前仍然挂着,而它发来的 `window.mcode` 调用会被派给**新**
 * 的 `hostRef`(新 action/item/target)—— 用户刚改过的配置由被替掉的那一版在生效。这个
 * 形状只在"effect 真跑起来、ref 真被挂上、message 真被派发"时才显形 —— 读源码断言不到,
 * `react-dom/server` 不跑 effect,而仓库里没有 jsdom / react-test-renderer。
 *
 * 于是 `run.sh` 用 esbuild `--alias:react=` 把真 react 换成这个文件,`PanelFrame.tsx`
 * 源码一个字不改地跑在上面:组件本体、它的 `useEffect` 回调都是**真的那份代码**,只有
 * 调度器与 DOM 是假的。
 *
 * 与仓库里其它 fakeReact 的一处关键差别:**ref 要真的挂上一个假 iframe 元素,且这个
 * 元素按 JSX `key` 缓存** —— 真 React 里同一 `key`(=`${url}#${reloadKey}`)的 iframe
 * 节点跨渲染是同一个 DOM 节点,`contentWindow` 不变。假运行时里若每次渲染都造一个新
 * 元素,旧窗口的"身份"就丢了,换版竞态根本模拟不出来。所以 `createElement` 遇到 `key`
 * 时按 key 取/造一个假元素(带稳定的 `contentWindow`),`ref.current` 指向它。
 *
 * 边界(故意不做的):只渲染根组件;子组件只以 `{type, props}` 留在树里,不被调用;
 * 没有 diff / 并发;`__flush` 是"跑到不再脏为止"的确定性刷新。
 */
type AnySlot = Record<string, unknown>;

/** 假 iframe 窗口 —— 够 `PanelFrame` 的 `frameRef.current?.contentWindow` 用。 */
export interface FakeWin {
  postMessage: (msg: unknown) => void;
  /** 收到过的回包(测试读它断言"旧窗口收到 panel closed")。 */
  _msgs: unknown[];
}
/** 假 DOM 元素 —— 够 `PanelFrame`(`contentWindow` / `getBoundingClientRect`)。 */
export interface FakeEl {
  contentWindow: FakeWin;
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number };
}
function makeWin(): FakeWin {
  const win: FakeWin = { _msgs: [], postMessage: (msg: unknown) => void win._msgs.push(msg) };
  return win;
}
function makeEl(): FakeEl {
  return { contentWindow: makeWin(), getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }) };
}

/** 按 JSX key 缓存的假元素 —— 同 key 跨渲染同一个节点(见文件头)。 */
const refEls = new Map<string, FakeEl>();

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

export function createElement(type: unknown, props: Record<string, unknown> | null, key?: unknown): unknown {
  const p = { ...(props ?? {}) };
  // ★ ref 真的挂上假元素(按 key 缓存),见文件头。
  const ref = p.ref as { current: unknown } | undefined;
  if (ref && typeof ref === "object") {
    const cacheKey = key !== undefined ? String(key) : `__${String(type)}`;
    let el = refEls.get(cacheKey);
    if (!el) {
      el = makeEl();
      refEls.set(cacheKey, el);
    }
    ref.current = el;
  }
  if (p.children === undefined) p.children = undefined;
  const el: { type: unknown; props: Record<string, unknown>; key?: unknown } = { type, props: p };
  if (key !== undefined) el.key = key;
  return el;
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
  refEls.clear();
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

/** 跑到"既没有待处理的微/宏任务、也不再脏"为止 —— 让 stage 回包各自落地。 */
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
export function __nodes(): Array<{ type: unknown; props: Record<string, unknown>; key?: unknown }> {
  const out: Array<{ type: unknown; props: Record<string, unknown>; key?: unknown }> = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const el = n as { type?: unknown; props?: Record<string, unknown> };
    if (!("type" in el)) return;
    out.push({ type: el.type, props: el.props ?? {}, key: (el as { key?: unknown }).key });
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
  useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect, useInsertionEffect,
  createElement, Fragment, memo, forwardRef, isValidElement, StrictMode,
};
