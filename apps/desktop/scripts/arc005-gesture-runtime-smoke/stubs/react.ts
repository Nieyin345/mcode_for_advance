let cleanup: (() => void) | undefined;
export function useEffect(fn: () => void | (() => void)): void { cleanup = fn() ?? undefined; }
export function unmount(): void { cleanup?.(); cleanup = undefined; }
