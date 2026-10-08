/**
 * 浏览器全局 —— `renderer-pure-smoke` 里唯一需要它们的是 `lib/commands.ts`
 * (它经 `lib/api.js` / `lib/icons.js` 在模块求值时碰 `window`/`document`/`navigator`)。
 * 本文件必须在 main.ts **最先** import,ES 模块按顺序求值,这样这些全局在
 * `lib/api.ts` 执行 `window.api ?? createWebApi()` 之前就已就位。
 *
 * 与 session-store-smoke 的 prelude 同类,但**更薄** —— 这一套只验纯派生,不需要
 * 记录 RPC。`window.api` 给一个"任何方法都返回 undefined"的深桩,`isElectron` 走
 * false(不设 `mcodeElectron`),于是不会真起 web shim 的网络路径。
 */
const asyncNoop = (): Promise<undefined> => Promise.resolve(undefined);

function deepApiStub(): unknown {
  return new Proxy(asyncNoop, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      if (prop === "constructor") return Object;
      return deepApiStub();
    },
    apply: () => Promise.resolve(undefined),
  });
}

const globalTarget = globalThis as unknown as Record<string, unknown>;
if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}
const ls = new Map<string, string>();
globalTarget.window = { api: deepApiStub() };
globalTarget.document = {
  documentElement: {
    classList: { contains: () => false, add: () => {}, remove: () => {} },
    setAttribute: () => {},
    style: { setProperty: () => {}, removeProperty: () => {} },
    lang: "zh",
  },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalTarget.localStorage = {
  getItem: (k: string) => ls.get(k) ?? null,
  setItem: (k: string, v: string) => void ls.set(k, String(v)),
  removeItem: (k: string) => void ls.delete(k),
  clear: () => ls.clear(),
  key: (i: number) => [...ls.keys()][i] ?? null,
  get length() {
    return ls.size;
  },
};

export {};
