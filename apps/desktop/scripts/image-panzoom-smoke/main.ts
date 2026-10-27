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
// 【T120】源码文本断言必须剥注释 —— 见 scripts/lib/sourceText.ts 头部。
// 实测：注释掉真代码后，裸 includes 仍然绿（49/49）。
import { sourceHas } from "../lib/sourceText.js";
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

/* 被测源码在 ⑦（接入）与 ⑧（常数核对）两节都要读 —— 放在两节之间，别再各读一次。 */
const src = readFileSync(resolve("src/renderer/components/ui/image-preview.tsx"), "utf8");

console.log("\n⑦ 接入（没有这一节，数学写对了也可能没人用）");
{
  ck("★ 导入了 imageTransform", sourceHas(src, '"./imageTransform.js"'));
  ck("★ 接了 onWheel", sourceHas(src, "onWheel={onWheel}"));
  ck("★ 接了 onPointerDown", sourceHas(src, "onPointerDown={onPointerDown}"));
  ck("★ 接了 onPointerMove", sourceHas(src, "onPointerMove={onPointerMove}"));
  ck("★ 接了 onDoubleClick", sourceHas(src, "onDoubleClick={onDoubleClick}"));
  ck("★ img 的 transform 真的用 transformCss", /transform:\s*transformCss\(/.test(src));
  ck("★ 换图/加载后重置变换", sourceHas(src, "onLoad={resetTransform}"));
  ck("★ 用 ref 避免闭包拿到过期 scale", sourceHas(src, "scaleRef"));
  ck("★ 没有直接拼 translate3d（单一出口）", !sourceHas(src, "translate3d("));
}

/* ── ⑧ 与上游同形 ─────────────────────────────────────────────────── */

console.log("\n⑧ 上游常数核对");
{
  /* 【UI 重建 2026-10-27】这里原本 `readFileSync("../../open-claude-ui/.../MediaLightboxViewer.tsx")`
       —— 那是**第三方逆向的参考实现**。外观基准已改成用户本机安装的
       Claude Desktop 3.1623.4.0，而它的产物里只有编译后的 JS/CSS，没有这份 TSX 源码。
       所以改成**把当时核对过的常数写在这里**，并注明出处快照。

       这不是「抄一份判据」：被测对象是 Mcode 自己的 imagePanzoom 实现（下面 ①–⑦ 节），
       这一节只是记录「这些常数当初是与上游对过的」。上游原件已不在仓库，
       再读文件只会让套件依赖一个随时会消失的目录。 */
  const UPSTREAM_CONSTANTS = {
    MIN_MAX_SCALE: "2.0",
    DRAG_DEADZONE: "4.0",
    WHEEL_SENSITIVITY: "0.01",
    SNAP_MIN_SCALE: "1.05",
  } as const;
  // 重新读一次 —— `src` 在上一节的块作用域里，这里用不到。
  const panSrc = readFileSync(resolve("src/renderer/components/ui/imageTransform.ts"), "utf8");
  for (const [k, v] of Object.entries(UPSTREAM_CONSTANTS)) {
    ck(`上游 ${k} = ${v}`, sourceHas(panSrc, `${k} = ${v}`));
  }
  // ⚠️ 滚轮必须是 Math.exp 指数，**不是线性乘法**。这条断言指向 Mcode 的真代码。
  ck("★ 滚轮真的是 Math.exp 指数（不是线性插值）", sourceHas(panSrc, "Math.exp("));
}

/* ── ⑨ ★ 判据自身：剥注释必须能挡「注释掉真代码」 ─────────────────── */

console.log("\n⑨ 判据自身：注释掉真代码必须能让 ⑦ 的接入选言变红");
{
  // 这一节验的是 ⑦ 那组断言**在什么条件下会失效**。
  //
  // 2026-10-24 实测：`src.includes("onWheel={onWheel}")` 在把真代码注释成
  // `{/* onWheel={onWheel} */}` 之后**仍然为 true** —— 套件 49/49 全绿，
  // 而那个 handler 已经不在组件上了。带不带花括号都一样
  // （A 在 `arc005-pane-docking-smoke` 上验过 `order: order.aside,` 同形态）。
  //
  // 所以 ⑦ 现在走 `sourceHas`（剥注释后再 includes）。这里从两个方向钉住它：
  //  - 若有人把 sourceHas 换回 includes，B/C/D 会红；
  //  - 若剥离器失效（剥不掉注释），同样 B/C/D 会红。
  const real = `export const a = <div onWheel={onWheel} />;`;
  const commented = `export const a = <div>{/* onWheel={onWheel} */}</div>;`;
  ck("★ A：剥注释后，真代码仍算「有」", sourceHas(real, "onWheel={onWheel}"));
  ck("★ B：注释里的大括号写法**不算**「有」（这是本次修的缺陷）",
    !sourceHas(commented, "onWheel={onWheel}"));
  ck("★ C：行注释里的不算", !sourceHas("// x\nconst y = 1;", "// x"));
  ck("★ D：块注释里的不算", !sourceHas("/*\n * onWheel={onWheel}\n */\nconst x = 1;", "onWheel={onWheel}"));
  // 对照：不能把 URL 里那些斜杠当成行注释，把同行的真代码剥掉。
  ck("★ 对照：URL 那行的真代码不被误剥",
    sourceHas('const u = "https://e.com/x"; const b = <div onWheel={onWheel} />;', "onWheel={onWheel}"));
}

console.log(`\nimage-panzoom-smoke: ${total - bad}/${total} 通过`);
if (bad > 0) process.exitCode = 1;
