/**
 * 极小浏览器全局。main.ts 第一个 import 它 —— ES 模块按顺序求值,这些要在
 * 任何会读 `window` / `document` 的模块求值之前就位。
 *
 * 与 browser-tabs-a11y-smoke 的 prelude 同一形状(见那边的说明):sessionStore
 * 传递地 import 真的 `lib/api.ts`(相对路径 `./api.js`,`--alias` 拦不住),
 * 它求值时做 `window.api ?? createWebApi()` —— 给个空 window 走 ?? 左支。
 */
const globalTarget = globalThis as unknown as Record<string, unknown>;

// 让这个文件成为**模块**,不污染 tsconfig 的全局作用域(仓库里每个套件的
// prelude 都各自成模块,模板相同但互不声明)。
export {};

if (typeof globalTarget.window === "undefined") {
  globalTarget.window = { api: {} };
}

// 【MC-049】window 的 keydown 登记表:popover 的 Escape 出口挂在 window 上,
// 要有一条真的能"按一下"的路径才能验行为(而不是读源码)。测试侧用
// `globalThis.__fireWindowKey("Escape")` 触发所有已登记 handler。
{
  const win = globalTarget.window as Record<string, unknown>;
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  win.addEventListener = (type: string, fn: (e: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  };
  win.removeEventListener = (type: string, fn: (e: unknown) => void) => {
    listeners.get(type)?.delete(fn);
  };
  // ContextStatsPopover 用 window.innerWidth/innerHeight 定位置,用
  // window.setTimeout/clearTimeout 做防抖重测。
  win.innerWidth = 1440;
  win.innerHeight = 900;
  win.setTimeout = (fn: () => void, ms?: number) => setTimeout(fn, ms) as unknown as number;
  win.clearTimeout = (h: number) => clearTimeout(h as unknown as NodeJS.Timeout);
  /* 【UI 重建 2026-10-27】**假键盘事件要补齐 KeyboardEvent 的常用面。**
   *
   * 原来只给 `{ key }`。生产里的 window keydown handler 会调
   * `preventDefault`（吞掉宿主默认行为，比如 Esc 关闭浮层时别连带退出全屏）
   * 和 `stopPropagation`（不让同一个键被别的监听器再吃一次）。
   * 缺了它们，一处 `e.preventDefault()` 就让整个套件**崩在运行时**，
   * 而看起来像「组件坏了」。
   *
   * 补成一套完整的假事件：能被读 `key` / `defaultPrevented`，也能被调用这两个方法。
   * **不改被测行为** —— 只是让假事件长得更像真的。 */
  globalTarget.__fireWindowKey = (key: string) => {
    for (const fn of listeners.get("keydown") ?? []) {
      const event = {
        key,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { event.defaultPrevented = true; },
        stopPropagation() { event.propagationStopped = true; },
        target: win.document ?? null,
        currentTarget: win,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
        nativeEvent: { isComposing: false, keyCode: 0 },
      };
      fn(event);
    }
  };
  globalTarget.__windowListenerCount = (type: string) => listeners.get(type)?.size ?? 0;
}

if (typeof globalTarget.document === "undefined") {
  globalTarget.document = {
    documentElement: { classList: { contains: () => false, add: () => {}, remove: () => {} }, setAttribute: () => {}, lang: "zh" },
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
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
