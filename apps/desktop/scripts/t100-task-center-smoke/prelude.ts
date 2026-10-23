/**
 * 极小浏览器全局 —— main.ts 第一个 import 它，ES 模块按顺序求值，这些要在任何会读
 * `window` / `document` 的模块求值之前就位（与 `md-preview-read-error-smoke` 同一份
 * 理由：sessionStore 传递地 import 了用相对路径拉真 `api.ts` 的模块）。
 *
 * 本套额外给一个**可驱动的 ResizeObserver**：`GenofficeViewHostPane` 的 bounds 同步
 * 走它，判据要能"触发一次尺寸变化、看组件真的把新几何发给主进程"。node 下没有这个
 * 全局，桩会把观察到的元素记下来，`__triggerResize(el)` 手动回调（带 resize 条目）。
 */

const globalTarget = globalThis as unknown as Record<string, unknown>;

export {};

/** 待执行的 rAF 回调。`GenofficeViewHostPane` 的几何同步走
 *  `requestAnimationFrame(rAF 回调里再读 rect)`，测试不能真的等 16ms —— 这里把回调
 *  排队，`__flushRaf()` 按序跑掉（每次最多 50 个，防自激循环）。 */
const rafQueue: Array<(t: number) => void> = [];
export function __flushRaf(): void {
  for (let i = 0; i < 50 && rafQueue.length > 0; i++) {
    const cb = rafQueue.shift();
    cb?.(Date.now());
  }
}

if (typeof globalTarget.window === "undefined") {
  globalTarget.window = { api: {} };
}
{
  const w = globalTarget.window as Record<string, unknown>;
  w.setTimeout = (fn: (...a: unknown[]) => void, ms?: number) => setTimeout(fn, ms);
  w.clearTimeout = (h: unknown) => clearTimeout(h as NodeJS.Timeout);
  w.addEventListener = () => {};
  w.removeEventListener = () => {};
  w.requestAnimationFrame = (cb: (t: number) => void) => rafQueue.push(cb);
  w.cancelAnimationFrame = (h: unknown) => void h;
  if (typeof w.innerWidth === "undefined") w.innerWidth = 1280;
  if (typeof w.innerHeight === "undefined") w.innerHeight = 800;
  if (typeof w.devicePixelRatio === "undefined") w.devicePixelRatio = 1;
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
// 组件里裸用 `requestAnimationFrame`（走全局）与 `window.requestAnimationFrame`
// 两种写法都存在 —— 两边都指到同一个可 flush 的队列。无条件覆盖（node 22 自带
// 的 rAF 在无 DOM 时行为未定义，而且不能同步 flush）。
globalTarget.requestAnimationFrame = (cb: (t: number) => void) => rafQueue.push(cb) as unknown as number;
globalTarget.cancelAnimationFrame = (h: unknown) => void h;
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

/* ── 可驱动的 ResizeObserver ── */

type ROCallback = (entries: Array<{ target: unknown }>) => void;
const observed = new Map<unknown, Set<ROCallback>>();
/** 测试驱动面：对某个被观察元素触发一次 resize 回调（含"该元素尺寸已变"的语义）。 */
export function __triggerResize(target: unknown): void {
  for (const cb of observed.get(target) ?? []) cb([{ target }]);
}
/** 当前还有没有活着的观察（组件卸载必须 disconnect —— 泄漏会跨用例触发旧回调）。 */
export function __observedCount(): number {
  let n = 0;
  for (const set of observed.values()) n += set.size;
  return n;
}

class ResizeObserverStub {
  private readonly cb: ROCallback;
  private readonly targets = new Set<unknown>();
  constructor(cb: ROCallback) {
    this.cb = cb;
  }
  observe(target: unknown): void {
    this.targets.add(target);
    let set = observed.get(target);
    if (!set) {
      set = new Set();
      observed.set(target, set);
    }
    set.add(this.cb);
  }
  unobserve(target: unknown): void {
    this.targets.delete(target);
    observed.get(target)?.delete(this.cb);
  }
  disconnect(): void {
    for (const t of this.targets) observed.get(t)?.delete(this.cb);
    this.targets.clear();
  }
}
if (typeof (globalTarget as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  (globalTarget as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}
