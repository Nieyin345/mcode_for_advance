/**
 * 极小浏览器全局。main.ts 第一个 import 它 —— ES 模块按顺序求值，这些要在任何会读
 * `window` / `document` 的模块求值之前就位（与 ime-enter-smoke 的 prelude 同款）。
 */
const globalTarget = globalThis as unknown as Record<string, unknown>;

// 让它成为**模块**而不是全局脚本（避免与其它 prelude 在全局作用域重复声明）。
export {};

if (typeof globalTarget.window === "undefined") {
  globalTarget.window = { api: {} };
}

if (typeof globalTarget.document === "undefined") {
  globalTarget.document = {
    documentElement: {
      classList: { contains: () => false, add: () => {}, remove: () => {} },
      setAttribute: () => {},
      lang: "zh",
    },
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    visibilityState: "visible",
  };
}

if (typeof globalTarget.navigator === "undefined") {
  Object.defineProperty(globalTarget, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}
