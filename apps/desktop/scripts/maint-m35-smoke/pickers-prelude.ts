/**
 * 极小浏览器全局 —— pickers.ts 第一个 import。ES 模块按顺序求值,这些要在任何会读
 * `window` / `document` 的模块求值之前就位(与 preview-panel-smoke 的 prelude 同款)。
 * `LibraryPicker` 的 effect 会 `document.addEventListener` 并聚焦输入框、`ItemNotes`
 * 的删除确认走 `window.confirm` —— 无头下给空实现即可(用例不触发删除)。
 */
const globalTarget = globalThis as unknown as Record<string, unknown>;

// 让它成为**模块**而不是全局脚本(避免与其它 prelude 在全局作用域重复声明)。
export {};

if (typeof globalTarget.window === "undefined") {
  // 【ARC-005】FileMentionPicker 现在用 `window.setTimeout` 做关闭后的焦点恢复，
  // 无头 window 得带上计时器（直接转全局，避免替身与真计时器行为不一致）。
  globalTarget.window = {
    api: {}, confirm: () => true,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}
if (typeof globalTarget.document === "undefined") {
  globalTarget.document = {
    documentElement: { classList: { contains: () => false, add: () => {}, remove: () => {} }, setAttribute: () => {}, lang: "zh" },
    body: { appendChild: () => {}, removeChild: () => {} },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {}, addEventListener: () => {} }),
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
