/**
 * 极小浏览器全局。main.ts 第一个 import 它 —— ES 模块按顺序求值,这些要在任何会读
 * `window` / `document` 的模块求值前就位。
 *
 * `PanelFrame` 用的是:`window.addEventListener`(接收 message)、`window.postMessage`
 * 在假 iframe 的 `contentWindow` 上(见 fakeReact)、`requestAnimationFrame`(主题
 * MutationObserver)、`document`(主题读取)。不起浏览器、不写盘。
 */
const globalTarget = globalThis as unknown as Record<string, unknown>;

export {};

/** `message` 监听器 —— `PanelFrame` 用 `window.addEventListener("message", ...)` 注册它,
 *  测试靠它把"面板发来的调用"派进去(带 `source = 某个 iframe 的 contentWindow`)。
 *  add/remove 成对存同一个 fn,卸载时真摘掉 —— 否则上一幕的监听器会跨幕继续收消息。 */
export const messageListeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
export function dispatchMessage(source: unknown, data: unknown): void {
  for (const fn of [...messageListeners]) fn({ source, data });
}

if (typeof globalTarget.window === "undefined") {
  globalTarget.window = {
    addEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
      if (type === "message") messageListeners.push(fn);
    },
    removeEventListener: (type: string, fn: (e: { source: unknown; data: unknown }) => void) => {
      if (type !== "message") return;
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
    },
    setInterval: (cb: () => void, ms: number) => setInterval(cb, ms) as unknown as number,
    clearInterval: (h: number) => clearInterval(h as unknown as NodeJS.Timeout),
    clearTimeout: (h: number) => clearTimeout(h as unknown as NodeJS.Timeout),
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number,
  };
}
if (typeof globalTarget.document === "undefined") {
  globalTarget.document = {
    documentElement: {
      classList: { contains: () => false, add: () => {}, remove: () => {} },
      setAttribute: () => {},
      lang: "zh",
    },
    body: { appendChild: () => {}, removeChild: () => {}, fontSize: "14px" },
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    visibilityState: "visible",
  };
}
if (typeof globalTarget.getComputedStyle === "undefined") {
  globalTarget.getComputedStyle = () => ({ fontSize: "14px", getPropertyValue: () => "", lineHeight: "18" });
}
if (typeof globalTarget.requestAnimationFrame === "undefined") {
  globalTarget.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
  globalTarget.cancelAnimationFrame = (h: number) => clearTimeout(h);
}
if (globalTarget.MutationObserver === undefined) {
  // PanelFrame 用它观察 <html> 的 class/style 变化发 theme —— 本套不验主题,给个空壳。
  globalTarget.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}
