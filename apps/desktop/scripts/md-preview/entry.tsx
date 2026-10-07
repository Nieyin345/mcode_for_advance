/**
 * md 预览里图片那一环的真浏览器预览台。
 *
 * 规划里「预览里 md 图片是裂的」改过（`FileViewer` 给 `Markdown` 传了 `baseDir`），
 * 但**从没在真浏览器里看过图**（见 docs/planning/优化方向.md 3.8⑧）。这里把
 * `Markdown` 组件分别在**有 / 无 baseDir** 两种情况下渲染出来，用 ui-probe 量：
 *   - 有 baseDir：正文里出现**真的 `<img>`**，src 是 `data:` URL（不是裂图 chip）
 *   - 无 baseDir：退化成**可点的文件名 chip**（这正是用户看到的"图全裂"）
 *
 * `api.file.readBinary` 用桩给一张 1×1 的 PNG data URL —— 主进程围栏那一环由
 * `md-image-guard-smoke` 单独钉，这里只验**渲染端到底把图放出来没有**。
 */
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { Markdown } from "@renderer/components/chat/Markdown.js";

// 1×1 红点 PNG。
const RED_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 桩:任何路径都回这张图 —— 路径围栏不是这一层的事。 */
(window as unknown as { __mdStub: unknown }).__mdStub = RED_DOT;

const doc = [
  "# 一篇带图的论文",
  "",
  "正文里引用了一张图：",
  "",
  "![图一](images/fig1.png)",
  "",
  "还有一张网络图（应当保持原样）：",
  "",
  "![网络图](https://example.com/x.png)",
].join("\n");

function App() {
  const params = new URLSearchParams(window.location.search);
  const withBase = params.get("base") !== "0";
  return createElement(
    "div",
    { style: { width: 520, background: "rgb(var(--surface))", padding: 12 } },
    createElement(Markdown, {
      children: doc,
      baseDir: withBase ? "D:/work/paper" : undefined,
    }),
  );
}

createRoot(document.getElementById("root")!).render(createElement(App));
