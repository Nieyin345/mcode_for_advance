/**
 * `@renderer/lib/api.js` 的替身 —— 只为本套件的真 Electron 页面。
 *
 * 桌面生产里 `api.ts` 就是 `window.api ?? createWebApi()`；在真 Electron 窗口里
 * preload 注入的 `window.api` 永远存在，`createWebApi()` 从不构造。这里把这个事实
 * 写死：`api` 就是**真 preload 桥**，页面里的每次读写都经真 `ipcRenderer.invoke`
 * → 真 `ipcMain` → 真 handler。换掉它的唯一目的是不让 web/mobile 的 HTTP 壳进入
 * 本套件的 bundle（它在浏览器里会对不存在的端点发请求）。
 */
import type { Api } from "../../../src/preload/index.js";

export const api: Api = window.api;
