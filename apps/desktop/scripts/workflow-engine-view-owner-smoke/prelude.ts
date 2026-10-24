/**
 * Browser globals the renderer module graph touches while it evaluates. Imported
 * FIRST by main.ts — ES module evaluation order guarantees these land before
 * `lib/api.ts` runs its `window.api ?? createWebApi()`.
 *
 * Same stub shape as `scripts/workflow-view-smoke/prelude.ts` (kept separate: a
 * smoke has to be runnable on its own). The suite renders through
 * `react-dom/server`, so effects never run and the RPCs are never actually
 * called; the data path is covered by the pure-function assertions in main.ts.
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

globalTarget.window = {
  api: deepApiStub(),
  mcodeElectron: true,
};
globalTarget.document = {
  documentElement: { setAttribute: () => {}, lang: "zh" },
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
globalTarget.requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 16) as unknown as number;
globalTarget.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
// The holder table's deferred close uses queueMicrotask; Node has it, but the
// renderer expects it on the global object like a browser.
if (typeof globalTarget.queueMicrotask !== "function") {
  globalTarget.queueMicrotask = (cb: () => void) => void Promise.resolve().then(cb);
}

export {};
