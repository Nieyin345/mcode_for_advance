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
