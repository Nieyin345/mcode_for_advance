/**
 * Minimal stand-in for React's `useState`, enough to drive one hook the way
 * React does: state persists across renders, and a setState DURING render
 * makes the caller re-run the render immediately (React's "adjust state while
 * rendering" semantics). Only `useState` is provided — chatDerived.ts must not
 * need anything else.
 */
let slot: { v: unknown } | null = null;
let dirty = false;
export function useState<T>(init: T): [T, (v: T) => void] {
  if (!slot) slot = { v: init };
  const s = slot;
  return [s.v as T, (v: T) => { if (v !== s.v) { s.v = v; dirty = true; } }];
}
/** Render `fn` like React would for one component instance. */
export function render<R>(fn: () => R): { value: R; passes: number } {
  let passes = 0;
  for (;;) {
    dirty = false;
    passes++;
    const value = fn();
    if (!dirty) return { value, passes };
    if (passes > 5) throw new Error("render loop");
  }
}
export function resetHooks(): void { slot = null; }
