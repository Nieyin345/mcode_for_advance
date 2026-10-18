/**
 * 浏览器全局 —— 手机网页壳的最小环境(没有 `window.api`、没有 `mcodeElectron`)。
 * 这份 prelude 只服务于 `createWebApi()` 的 assembly / 方法调用,不需要假主进程:
 * 本套**不发**任何真 RPC(需要走网络的那几条只在"静态对账"里被点名,不会被调用)。
 */
const globalTarget = globalThis as unknown as Record<string, unknown>;

const localStorageMap = new Map<string, string>();
globalTarget.window = { matchMedia: () => ({ matches: false }) };
globalTarget.document = {
  documentElement: { setAttribute: () => {}, lang: "zh" },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  visibilityState: "visible",
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
if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}
