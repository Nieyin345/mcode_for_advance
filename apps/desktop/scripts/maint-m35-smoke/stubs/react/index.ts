// FilePreview's hook states are injected to exercise its real render decisions.
let values: unknown[] = [];
export function setRenderStates(...states: unknown[]): void { values = [...states]; }
export function useState<T>(initial: T): [T, (value: unknown) => void] {
  if (!values.length) throw new Error("Missing injected hook state");
  return [values.shift() as T, () => {}];
}
export function useRef<T>(initial: T | null) { return { current: initial }; }
export function useEffect(_effect: () => unknown, _deps?: unknown[]): void {}
export function useCallback<T extends (...args: any[]) => any>(fn: T, _deps?: unknown[]): T { return fn; }
export function useMemo<T>(fn: () => T, _deps?: unknown[]): T { return fn(); }
