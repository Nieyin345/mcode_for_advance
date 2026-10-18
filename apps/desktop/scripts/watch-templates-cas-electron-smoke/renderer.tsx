/**
 * 渲染端页面入口 —— **真组件**（`WatchSegment`）+ **真 preload 桥**，只替换两样由
 * 手机/web 壳才会用到的模块：
 *   - `@renderer/lib/api.js`：桌面下它就是 `window.api`（真 preload），这里显式写出来，
 *     免得 `createWebApi()` 在真 Electron 里凭空造 HTTP 客户端；
 *   - `@renderer/hooks/useSuppressBrowserView.js`：它依赖 `sessionStore`（7000+ 行、拖
 *     monaco/pdf 一整棵图）与 `browserOcclusion`（几何测量）—— 本套验的是模板 CAS，
 *     不验浏览器视图几何；这两个由 `build.mjs` 的 alias 换成本目录的叶子桩。
 *
 * 除此之外 React、i18n 词典/`useI18n`、UI 原语（Button/Input/Select/InfoHint）、
 * `watchTemplatesSync` 与 `WatchSegment` 本身**都是真代码**，不经过任何复制改写。
 */
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { WatchSegment } from "@renderer/components/chat/WatchSegment.js";

declare global {
  interface Window {
    wtErrors: string[];
  }
}

// 渲染端未捕获错误收集：探针据此断言"组件真的没炸"。
window.wtErrors = [];
window.addEventListener("error", (e) => window.wtErrors.push(String(e.error ?? e.message)));
window.addEventListener("unhandledrejection", (e) => window.wtErrors.push(String(e.reason)));

function App() {
  return createElement(
    "div",
    { style: { padding: 24, width: 520 } },
    createElement(WatchSegment, { sessionId: "smoke-origin-session", layout: "row" }),
  );
}

createRoot(document.getElementById("root")!).render(createElement(App));
