/** Tiny hook harness for useVoiceInput; never renders a real page or mic. */
type EffectSlot = { deps: readonly unknown[] | undefined; cleanup?: () => void };
type Harness = { index: number; slots: unknown[]; cleanups: EffectSlot[] };
let current: Harness | null = null;
function take(): { harness: Harness; index: number } {
  if (!current) throw new Error("Hooks only run inside mountHook/rerender");
  return { harness: current, index: current.index++ };
}
function render<T>(h: Harness, fn: () => T): T {
  h.index = 0;
  current = h;
  try { return fn(); } finally { current = null; }
}
export function mountHook<T>(fn: () => T): {
  value: T; rerender: () => T; unmount: () => void;
} {
  const h: Harness = { index: 0, slots: [], cleanups: [] };
  return {
    value: render(h, fn),
    rerender: () => render(h, fn),
    unmount: () => {
      for (const e of h.cleanups) e.cleanup?.();
      h.cleanups.length = 0;
    },
  };
}
export function useRef<T>(initial: T): { current: T } {
  const { harness, index } = take();
  return (harness.slots[index] ??= { current: initial }) as { current: T };
}
export function useState<T>(initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const { harness, index } = take();
  const slot = (harness.slots[index] ??= { value: initial }) as { value: T };
  return [slot.value, (value) => {
    slot.value = typeof value === "function"
      ? (value as (prev: T) => T)(slot.value)
      : value;
  }];
}
export function useCallback<T extends (...args: never[]) => unknown>(fn: T, _deps: unknown[]): T {
  take();
  return fn;
}
export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void {
  const { harness, index } = take();
  const old = harness.slots[index] as EffectSlot | undefined;
  if (old && deps && old.deps && deps.length === old.deps.length && deps.every((d, i) => Object.is(d, old.deps![i]))) return;
  old?.cleanup?.();
  const slot: EffectSlot = { deps, cleanup: effect() ?? undefined };
  harness.slots[index] = slot;
  if (!old) harness.cleanups.push(slot);
}
