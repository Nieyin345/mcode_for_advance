/**
 * Browser globals the renderer module graph touches at evaluation time.
 * Imported FIRST by main.ts (ES module order guarantees they land before
 * `lib/api.ts` runs its `window.api ?? createWebApi()`).
 *
 * `workflowLive.ts` only reaches `api.on.claudeEvent` for its subscription
 * default, and this smoke drives the fold through `__applyWorkflowLiveEvent`
 * (never the IPC subscription), so a deep no-op stub is enough — `then` stays
 * undefined so `await api.foo()` never hangs as a thenable.
 */
const asyncNoop = (): Promise<undefined> => Promise.resolve(undefined);

function deepApiStub(): unknown {
  return new Proxy(asyncNoop, {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      if (prop === "constructor") return Object;
      return deepApiStub();
    },
    apply: () => Promise.resolve(undefined),
  });
}

const localStorageMap = new Map<string, string>();
const globalTarget = globalThis as unknown as Record<string, unknown>;

if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}

globalTarget.window = { api: deepApiStub() };
globalTarget.document = {
  documentElement: { classList: { contains: () => false, add: () => {}, remove: () => {} }, setAttribute: () => {}, lang: "zh" },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
};
globalTarget.localStorage = {
  getItem: (k: string) => localStorageMap.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageMap.set(k, String(v)),
  removeItem: (k: string) => void localStorageMap.delete(k),
  clear: () => localStorageMap.clear(),
  key: (i: number) => [...localStorageMap.keys()][i] ?? null,
  get length() {
    return localStorageMap.size;
  },
};

export {};
