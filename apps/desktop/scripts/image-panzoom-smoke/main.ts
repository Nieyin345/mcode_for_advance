/**
 * 【T120】图片灯箱的平移 / 缩放 —— 判据与接入的回归。
 *
 * ## 钉的是什么
 *
 * `image-preview.tsx` 原先**零交互**：`grep wheel|pointerdown|scale|zoom` 只有一处
 * `group-hover:scale-[1.03]`（悬停微放大）。用户点开图片想看细节，**只能看不能动**。
 *
 * 上游 `MediaLightboxViewer.tsx`（605 行）有一套仿射平移缩放，数学在
 * `imageTransform.ts` 里逐条移植（每个公式标了上游行号）。
 *
 * ## 断言分三层（与 `message-collapse-smoke` 同构）
 *
 * | 层 | 验什么 |
 * |---|---|
 * | 判据 | 上游那四条公式：clamp / overflow / maxTranslate / 锚点缩放 |
 * | 行为 | 滚轮方向、死区、双击切换、边界钳制 |
 * | **接入** | `image-preview.tsx` 真的接了事件与 transform |
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DRAG_DEADZONE,
  INITIAL_TRANSFORM,
  MIN_MAX_SCALE,
  SNAP_MIN_SCALE,
  WHEEL_SENSITIVITY,
  calcMaxTranslate,
  calcOverflow,
  clampSymmetric,
  computeAnchorZoom,
  doubleClickToggle,
  exceedsDragDeadzone,
  isZoomed,
  maxScaleFor,
  panBy,
  transformCss,
  wheelZoomFactor,
  type FitRects,
} from "../../src/renderer/components/ui/imageTransform.js";

let total = 0;
let bad = 0;
const ck = (s: string, b: boolean, detail?: unknown): void => {
  total++;
  if (!b) bad++;
  console.log((b ? "PASS " : "FAIL ") + s + (b || detail === undefined ? "" : " — " + JSON.stringify(detail)));
};

/* ── ① 常数与上游同值 ─────────────────────────────────────────────── */

console.log("\n① 常数（全部照上游）");
ck("MIN_MAX_SCALE = 2.0", MIN_MAX_SCALE === 2.0);
ck("DRAG_DEADZONE = 4.0", DRAG_DEADZONE === 4.0);
ck("WHEEL_SENSITIVITY = 0.01", WHEEL_SENSITIVITY === 0.01);
ck("SNAP_MIN_SCALE = 1.05", SNAP_MIN_SCALE === 1.05);
ck("INITIAL_TRANSFORM 是 scale=1 无偏移", INITIAL_TRANSFORM.scale === 1 && INITIAL_TRANSFORM.tx === 0);

/* ── ② 上游那三条数学原语 ─────────────────────────────────────────── */

console.log("\n② 数学原语");
ck("clamp 对称", clampSymmetric(10, 5) === 5 && clampSymmetric(-10, 5) === -5 && clampSymmetric(3, 5) === 3);
ck("★ clamp 的 max 为负时退化成 0（不产生反号）", clampSymmetric(5, -3) === 0);
ck("overflow：内容小于视口 → 0", calcOverflow(400, 800) === 0);
ck("overflow：内容大于视口 → 一半差", calcOverflow(1200, 800) === 200);

console.log("\n③ ★ 缩放不到 1.05 倍时**完全不允许平移**（上游的核心取舍）");
// 这里用 **fitWidth = 800 > viewportWidth = 800**？不 —— 用相等的 800/800：
// 放大 1.5 倍后是 1200px，溢出 200px，factor 也 >0，两个条件都满足。
// 如果用 400/800（图比视口窄一半），放大 1.5 倍才 600px **仍然装得下**，
// overflow = 0 → maxTranslate = 0 是**正确**的，测不出 factor 的作用。
// 第一版我就用了 400/800，那条断言红了 —— 红的是 fixture，不是公式。
const fitPan: FitRects = {
  fitWidth: 800, fitHeight: 600, viewportWidth: 800, viewportHeight: 800, maxScale: 3,
};
ck("scale = 1 → maxTranslate = 0", calcMaxTranslate(fitPan.fitWidth, fitPan.viewportWidth, 1) === 0);
ck("scale = 1.05 → 仍为 0（factor 的零点）",
  calcMaxTranslate(fitPan.fitWidth, fitPan.viewportWidth, 1.05) === 0);
ck("★ scale = 1.5 → 大于 0（溢出 200px × factor≈0.47）",
  calcMaxTranslate(fitPan.fitWidth, fitPan.viewportWidth, 1.5) > 0,
  calcMaxTranslate(fitPan.fitWidth, fitPan.viewportWidth, 1.5));
ck("scale = 2.0 → factor 到 1，等于纯 overflow",
  Math.abs(calcMaxTranslate(fitPan.fitWidth, fitPan.viewportWidth, 2.0)
    - calcOverflow(fitPan.fitWidth * 2, fitPan.viewportWidth)) < 1e-9);
// 另一条独立的对照：图**本来就比视口宽**时，scale=1 就允许平移？
// 不允许 —— factor 在 scale=1 时是 0，这是刻意的（未放大时不拖）。
ck("★ 图本身比视口宽，scale=1 仍不允许平移（factor=0）",
  calcMaxTranslate(2000, 800, 1) === 0);

/* ── ④ 锚点缩放 ─────────────────────────────────────────────────── */

console.log("\n④ 锚点缩放");
const fit: FitRects = {
  fitWidth: 800, fitHeight: 600, viewportWidth: 1000, viewportHeight: 800, maxScale: 3,
};
ck("从 1 放大到 1.5（无锚点）→ 无偏移", computeAnchorZoom(fit, INITIAL_TRANSFORM, 1.5).tx === 0);
ck("★ 目标超过 maxScale 会被钳住", computeAnchorZoom(fit, INITIAL_TRANSFORM, 99).scale === 3);
ck("★ 目标小于 1 会被钳到 1", computeAnchorZoom(fit, INITIAL_TRANSFORM, 0.2).scale === 1);
{
  // 在右移锚点放大：图应该往左移（锚点下的内容保持不动）
  const z = computeAnchorZoom(fit, INITIAL_TRANSFORM, 2, { x: 100, y: 0 });
  ck("★ 锚点在右侧放大 → tx 为负（内容向锚点对齐）", z.tx < 0, z.tx);
  ck("★ 偏移被钳在 maxTranslate 内",
    Math.abs(z.tx) <= calcMaxTranslate(fit.fitWidth, fit.viewportWidth, z.scale) + 1e-9, z.tx);
}

/* ── ⑤ 滚轮 / 死区 / 双击 / 平移 ──────────────────────────────────── */

console.log("\n⑤ 交互行为");
ck("★ 滚轮向上（deltaY < 0）→ 放大", wheelZoomFactor(-100) > 1);
ck("★ 滚轮向下（deltaY > 0）→ 缩小", wheelZoomFactor(100) < 1);
ck("deltaY = 0 → 不变", Math.abs(wheelZoomFactor(0) - 1) < 1e-12);
ck("★ 死区 4px：3.9px 不算拖", exceedsDragDeadzone(3, 2) === false); // hypot≈3.6
ck("★ 死区 4px：5px 算拖", exceedsDragDeadzone(3, 4) === true);      // hypot=5
{
  const zoomed = computeAnchorZoom(fit, INITIAL_TRANSFORM, 2);
  const moved = panBy(fit, zoomed, 30, 20);
  ck("平移改变 tx/ty", moved.tx !== zoomed.tx && moved.ty !== zoomed.ty, { from: zoomed, to: moved });
  ck("★ 平移不改 scale", moved.scale === zoomed.scale);
  const huge = panBy(fit, zoomed, 99999, 99999);
  ck("★ 平移被钳在视口内", Math.abs(huge.tx) <= calcMaxTranslate(fit.fitWidth, fit.viewportWidth, 2) + 1e-9, huge.tx);
}
{
  const zoomed = doubleClickToggle(fit, INITIAL_TRANSFORM);
  ck("★ 双击（未放大）→ 放到最大", zoomed.scale === fit.maxScale, zoomed.scale);
  const back = doubleClickToggle(fit, zoomed);
  ck("★ 双击（已放大）→ 回到 1", back.scale === 1, back.scale);
}

console.log("\n⑥ CSS 与状态");
ck("transform 串含 translate 与 scale",
  transformCss({ scale: 2, tx: 10, ty: -5, idealTx: 10, idealTy: -5 }).includes("translate3d(10px, -5px, 0)"));
ck("isZoomed：1 不算", isZoomed(INITIAL_TRANSFORM) === false);
ck("isZoomed：2 算", isZoomed({ ...INITIAL_TRANSFORM, scale: 2 }) === true);
ck("maxScaleFor 至少 2", maxScaleFor(100, 1000) === 2);
ck("maxScaleFor 取原图比例", maxScaleFor(3000, 1000) === 3);
ck("maxScaleFor 坏输入 → 回落到 2", maxScaleFor(Number.NaN, 0) === 2);

/* ── ⑦ ★ 接入：生产代码真的接了 ───────────────────────────────────── */

console.log("\n⑦ 接入（没有这一节，数学写对了也可能没人用）");
{
  const src = readFileSync(resolve("src/renderer/components/ui/image-preview.tsx"), "utf8");
  ck("★ 导入了 imageTransform", src.includes('"./imageTransform.js"'));
  ck("★ 接了 onWheel", src.includes("onWheel={onWheel}"));
  ck("★ 接了 onPointerDown", src.includes("onPointerDown={onPointerDown}"));
  ck("★ 接了 onPointerMove", src.includes("onPointerMove={onPointerMove}"));
  ck("★ 接了 onDoubleClick", src.includes("onDoubleClick={onDoubleClick}"));
  ck("★ img 的 transform 真的用 transformCss", /transform:\s*transformCss\(/.test(src));
  ck("★ 换图/加载后重置变换", src.includes("onLoad={resetTransform}"));
  ck("★ 用 ref 避免闭包拿到过期 scale", src.includes("scaleRef"));
  ck("★ 没有直接拼 translate3d（单一出口）", !src.includes("translate3d("));
}

/* ── ⑧ 与上游同形 ─────────────────────────────────────────────────── */

console.log("\n⑧ 上游常数核对（直接读上游文件，不写死一份）");
{
  const upstream = readFileSync(
    resolve("../../open-claude-ui/code-examples/MediaLightboxViewer.tsx"),
    "utf8",
  );
  ck("上游 MIN_MAX_SCALE = 2.0", upstream.includes("MIN_MAX_SCALE = 2.0"));
  ck("上游 DRAG_DEADZONE = 4.0", upstream.includes("DRAG_DEADZONE = 4.0"));
  ck("上游 WHEEL_SENSITIVITY = 0.01", upstream.includes("WHEEL_SENSITIVITY = 0.01"));
  ck("上游 SNAP_MIN_SCALE = 1.05", upstream.includes("SNAP_MIN_SCALE = 1.05"));
  ck("★ 上游滚轮确实是 Math.exp 指数", upstream.includes("Math.exp(-deltaY"));
}

console.log(`\nimage-panzoom-smoke: ${total - bad}/${total} 通过`);
if (bad > 0) process.exitCode = 1;
