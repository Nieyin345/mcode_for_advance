/**
 * 极小浏览器全局。main.ts 第一个 import 它 —— ES 模块按顺序求值,这些要在
 * 任何会读 `window` / `document` 的模块求值之前就位。
 *
 * 与 clickable-row-a11y-smoke 的 prelude 同一形状:sessionStore 传递地 import
 * 真的 `lib/api.ts`(相对路径,`--alias` 拦不住),它求值时做
 * `window.api ?? createWebApi()` —— 给个空 window 走 ?? 左支。
 */
const globalTarget = globalThis as unknown as Record<string, unknown>;
export {};

if (typeof globalTarget.window === "undefined") {
  globalTarget.window = { api: {} };
}
