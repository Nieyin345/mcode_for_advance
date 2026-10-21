/**
 * 极小浏览器全局。main.ts 第一个 import 它 —— ES 模块按顺序求值,这些要在
 * 任何会读 `window` / `document` 的模块求值之前就位。
 *
 * 为什么需要:`sessionStore` 传递地 import 了 `lib/notifPrefsCache.ts`,而它用
 * **相对路径** `./api.js` 拉真的 `lib/api.ts`(esbuild 的 `--alias` 只匹配 import
 * 说明符文本,`@renderer/lib/api.js` 拦不住 `./api.js`)。那个模块求值时执行
 * `window.api ?? createWebApi()` —— 给它一个 `window` 就行,真 api 在被测组件那条
 * 路径上根本不会被调用(被测组件走的是 alias 到 api-stub 的那份)。
 */
const globalTarget = globalThis as unknown as Record<string, unknown>;

// 让这个文件成为**模块**(而不是全局脚本):两个套件各有一份同名的 prelude,
// 不隔离就会在 tsconfig 的全局作用域里重复声明同一批变量。
export {};

const documentListeners = new Map<string, Set<(...args: unknown[]) => void>>();
export function __fireDocumentEvent(type: string): void {
  for (const cb of documentListeners.get(type) ?? []) cb();
}
export function __resetDocumentListeners(): void {
  documentListeners.clear();
}

if (typeof globalTarget.window === "undefined") {
  // 真的 lib/api.ts 会做 `window.api ?? createWebApi()`。给个空 api 走 ?? 左支 ——
  // createWebApi 在 node 下会去摸 fetch/localStorage,能免则免。
  globalTarget.window = { api: {} };
}
// 组件里常写 `window.setTimeout` / `window.clearTimeout`(如 useSuppressBrowserView)——
  // node 的 window 是壳对象,得把这两个方法补上,否则 effect 一跑就 TypeError。
{
  const w = globalTarget.window as Record<string, unknown>;
  w.setTimeout = (fn: (...a: unknown[]) => void, ms?: number) => setTimeout(fn, ms);
  w.clearTimeout = (h: unknown) => clearTimeout(h as NodeJS.Timeout);
  w.addEventListener = () => {};
  w.removeEventListener = () => {};
  w.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
  w.cancelAnimationFrame = (h: unknown) => clearTimeout(h as NodeJS.Timeout);
}

if (typeof globalTarget.document === "undefined") {
  globalTarget.document = {
    documentElement: { classList: { contains: () => false, add: () => {}, remove: () => {} }, setAttribute: () => {}, lang: "zh" },
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    addEventListener: (type: string, cb: (...a: unknown[]) => void) => {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type)?.add(cb);
    },
    removeEventListener: (type: string, cb: (...a: unknown[]) => void) => {
      documentListeners.get(type)?.delete(cb);
    },
    querySelector: () => null,
    visibilityState: "visible",
  };
}

const localStorageMap = new Map<string, string>();
if (typeof globalTarget.localStorage === "undefined") {
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
}

if (typeof globalTarget.navigator === "undefined") {
  Object.defineProperty(globalTarget, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}

if (typeof globalTarget.getComputedStyle === "undefined") {
  globalTarget.getComputedStyle = () => ({ lineHeight: "18" });
}
if (typeof globalTarget.requestAnimationFrame === "undefined") {
  globalTarget.requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number;
  globalTarget.cancelAnimationFrame = (h: number) => clearTimeout(h);
}

// `useMonacoTheme` 观察 `<html>` 的 class 变化 —— node 下没有 MutationObserver,
// 给一个 no-op(它只跟着主题翻转,与引用组合判据无关)。
if (typeof (globalTarget as { MutationObserver?: unknown }).MutationObserver === "undefined") {
  class MutationObserverStub {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  }
  (globalTarget as { MutationObserver?: unknown }).MutationObserver = MutationObserverStub;
}

// `SelectionToolbar` / `SelectionQuoteMenu` 用 `window.innerWidth` / `innerHeight`
// 给浮层定位 —— 值不参与判据,给个确定尺寸免得算出 NaN。
{
  const w = globalTarget.window as Record<string, unknown>;
  if (typeof w.innerWidth === "undefined") w.innerWidth = 1280;
  if (typeof w.innerHeight === "undefined") w.innerHeight = 800;
  if (typeof w.devicePixelRatio === "undefined") w.devicePixelRatio = 1;
}
