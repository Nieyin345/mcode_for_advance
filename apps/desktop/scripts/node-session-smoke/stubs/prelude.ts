/**
 * 浏览器全局量的替身 —— 抄自 `scripts/session-store-smoke/prelude.ts`(那一套的文件
 * 不许改,所以另存一份),因为本套后半段要 import **渲染端的 store**
 * (`@renderer/stores/sessionStore.js`)来验"主进程发出去的那几条事件,渲染端认不认"。
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

const globalWindow = {
  api: deepApiStub(),
  mcodeElectron: true,
};

const globalTarget = globalThis as unknown as Record<string, unknown>;
if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}
globalTarget.window = globalWindow;
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

export {};
