/** Tiny deterministic hook/effect scheduler for ItemLinks' actual async callbacks. */
let slots: unknown[] = [];
let cursor = 0;
let pending: Array<() => void | (() => void)> = [];
let cleanups: Array<() => void> = [];
export function reset(): void { slots = []; cursor = 0; pending = []; cleanups = []; }
export function beginRender(): void { cursor = 0; pending = []; }
export function commitEffects(): void {
  for (const fn of pending) {
    const cleanup = fn();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  pending = [];
}
export function cleanupEffects(): void { for (const fn of cleanups) fn(); cleanups = []; }
export function stateAt<T>(index: number): T { return slots[index] as T; }
export function useState<T>(initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const index = cursor++;
  if (!(index in slots)) slots[index] = initial;
  return [slots[index] as T, (next) => {
    slots[index] = typeof next === "function" ? (next as (prev: T) => T)(slots[index] as T) : next;
  }];
}
export function useRef<T>(initial: T | null): { current: T | null } {
  const index = cursor++;
  if (!(index in slots)) slots[index] = { current: initial };
  return slots[index] as { current: T | null };
}
export function useEffect(fn: () => void | (() => void), _deps?: unknown[]): void { pending.push(fn); }
export function useCallback<T extends (...args: any[]) => any>(fn: T, _deps?: unknown[]): T { return fn; }

/**
 * **默认导出** —— zustand 5 的 `esm/react.mjs` 第 1 行是 `import React from 'react'`,
 * 然后 `React.useSyncExternalStore(...)`。ESM 没有"具名导入自动合并进默认命名空间"这回事:
 * 桩不导出 `default`,esbuild 就在**打包期**报 `No matching export … for import "default"`
 * (2026-10-23 T38,`maintainer smoke` 的 `links.ts` / `import.ts` 两段都卡在这里)。
 *
 * 形状与 `preview-panel-smoke/fakeReact.ts` 的 default 一致:把上面那些具名导出聚成
 * 一个对象。**不在这里重复实现** —— 将来加 hook 只改上面一处。
 */
export default {
  useState,
  useRef,
  useEffect,
  useCallback,
};
