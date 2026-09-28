/**
 * maint-audit-smoke 的浏览器全局桩 —— 抄 session-store-smoke/prelude.ts 的形状
 * (那份是 M23 的独占文件,只读不改),多一件事:**逐笔记录** window.api 上被调用的
 * 路径与首参,§2 要断言"覆盖旧提问时有没有把它 dismiss 掉",看的就是这份流水。
 */
const asyncNoop = (): Promise<undefined> => Promise.resolve(undefined);

export interface ApiCall {
  path: string;
  arg: unknown;
}
export const apiCalls: ApiCall[] = [];

function deepApiStub(path: string[] = []): unknown {
  return new Proxy(asyncNoop, {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      if (prop === "constructor") return Object;
      return deepApiStub([...path, String(prop)]);
    },
    apply: (_target, _this, args: unknown[]) => {
      apiCalls.push({ path: path.join("."), arg: args[0] });
      return Promise.resolve(undefined);
    },
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
globalTarget.window = { api: deepApiStub(), mcodeElectron: true };
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
