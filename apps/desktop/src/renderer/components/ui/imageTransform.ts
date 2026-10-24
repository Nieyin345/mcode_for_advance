/**
 * 【T120】图片灯箱的平移 / 缩放数学 —— 纯函数，不碰 DOM。
 *
 * ## 为什么加这个
 *
 * 用户点开图片想看细节，**Mcode 的灯箱只能看、不能动**：`image-preview.tsx` 里
 * grep `wheel|pointerdown|scale|zoom` 只有一处 `group-hover:scale-[1.03]`（悬停微放大）。
 * 上游 `MediaLightboxViewer.tsx`（605 行）有一套完整的仿射平移缩放。
 *
 * ## 数学全部照搬上游，公式出处逐条标
 *
 * | 公式 | 上游位置 |
 * |---|---|
 * | `clamp(v, max) = min(max, max(-max, v))` | `:89` |
 * | `overflow = max(0, (size - viewport) / 2)` | `:94` |
 * | `maxTranslate = overflow(fit*scale, vp) * factor` | `:99-101` |
 * | `factor = min(1, max(0, (scale - 1.05) / 0.95))` | `:100` |
 * | `c = target / current`；`idealTx = offX - (offX - curTx) * c` | `:146-149` |
 * | 滚轮 `scale *= exp(-deltaY * 0.01)` | `:13`、`:69` |
 * | 拖拽死区 `hypot(dx,dy) < 4` | `:14`、`:68` |
 *
 * ## 为什么 `SNAP_MIN_SCALE` 这一条这么写
 *
 * `factor = (scale - 1.05) / 0.95`：**放大到 2.0 时 factor 才等于 1**。
 * 也就是说「缩放到 1.05 倍以下时完全不允许平移」（factor = 0），
 * 因为图还没超出视口，拖它只会露出背景。**这是上游的核心取舍，不是可调参数。**
 *
 * ## 不引 framer-motion
 *
 * 上游用的是 CSS transform + 自己的状态机，framer-motion 只在它的 **其它** 组件里用。
 * 本文件一个依赖都不需要。
 */

/* ── 与上游同值的常数（改它们等于改观感） ───────────────────────────── */

/** 最小/最大放大倍数（上游 `MIN_MAX_SCALE`）。 */
export const MIN_MAX_SCALE = 2.0;
/** 指针拖拽死区（px，上游 `DRAG_DEADZONE`）——小于它不算拖，杜绝微抖。 */
export const DRAG_DEADZONE = 4.0;
/** 滚轮缩放指数因子（上游 `WHEEL_SENSITIVITY`）。 */
export const WHEEL_SENSITIVITY = 0.01;
/** 缩放吸附下限（上游 `SNAP_MIN_SCALE`）：到此以下不允许平移。 */
export const SNAP_MIN_SCALE = 1.05;

/** 当前变换状态。`tx/ty` 是**实际生效**的偏移（已钳制），`idealTx/idealTy` 是未钳制的理想值。 */
export interface TransformState {
  scale: number;
  tx: number;
  ty: number;
  idealTx: number;
  idealTy: number;
}

export const INITIAL_TRANSFORM: TransformState = Object.freeze({
  scale: 1,
  tx: 0,
  ty: 0,
  idealTx: 0,
  idealTy: 0,
});

/** 图片在视口里的实际尺寸与两侧的可用空间（由调用方量好传进来）。 */
export interface FitRects {
  /** `object-contain` 之后图片的渲染宽（px）。 */
  fitWidth: number;
  fitHeight: number;
  /** 视口尺寸（px）—— 灯箱的可视区域，不含工具栏。 */
  viewportWidth: number;
  viewportHeight: number;
  /** 可放大的上限：至少 `MIN_MAX_SCALE`，但如果原图更大就按原图的 1:1 算。 */
  maxScale: number;
}

/** 把值钳制在 `[-max, max]`（上游 `:89`）。 */
export function clampSymmetric(value: number, max: number): number {
  const m = Math.max(0, max);
  return Math.min(m, Math.max(-m, value));
}

/** 超出视口的一半（上游 `calcOverflow` `:94`）。 */
export function calcOverflow(size: number, viewportSize: number): number {
  return Math.max(0, (size - viewportSize) / 2);
}

/**
 * 允许平移的最大距离（上游 `calcMaxTranslate` `:99-101`）。
 *
 * `factor` 让「还没放大到超过视口」时完全不能平移 —— 见文件头的说明。
 */
export function calcMaxTranslate(fitSize: number, viewportSize: number, scale: number): number {
  const factor = Math.min(1, Math.max(0, (scale - SNAP_MIN_SCALE) / 0.95));
  return calcOverflow(fitSize * scale, viewportSize) * factor;
}

/** 由原图与渲染尺寸算 `maxScale`（上游 `getFitRects` 里的 `Math.max(naturalW / fitWidth, 2)`）。 */
export function maxScaleFor(naturalWidth: number, fitWidth: number): number {
  if (!Number.isFinite(naturalWidth) || !Number.isFinite(fitWidth) || fitWidth <= 0) {
    return MIN_MAX_SCALE;
  }
  return Math.max(naturalWidth / fitWidth, MIN_MAX_SCALE);
}

/** 滚轮一次 delta 对应的缩放倍数（上游 `Math.exp(-deltaY * 0.01)`）。 */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * WHEEL_SENSITIVITY);
}

/**
 * 以某个视口内坐标（相对视口**中心**）为锚点缩放。
 *
 * 上游 `computeAnchorZoom`（`:136-160`）的逐行移植。`anchor` 省略即从中心缩放。
 *
 * **`targetScale` 会被钳到 `[1, fit.maxScale]`** —— 上游在调用处做这件事
 * （`:399` 等），这里收进来，避免调用方漏掉。
 */
export function computeAnchorZoom(
  fit: FitRects,
  current: TransformState,
  targetScale: number,
  anchor?: { x: number; y: number } | null,
): TransformState {
  const clampedTarget = Math.min(fit.maxScale, Math.max(1, targetScale));
  const maxTx = calcMaxTranslate(fit.fitWidth, fit.viewportWidth, clampedTarget);
  const maxTy = calcMaxTranslate(fit.fitHeight, fit.viewportHeight, clampedTarget);

  const offsetX = anchor ? anchor.x : 0;
  const offsetY = anchor ? anchor.y : 0;

  const c = clampedTarget / current.scale;
  const idealTx = offsetX - (offsetX - current.idealTx) * c;
  const idealTy = offsetY - (offsetY - current.idealTy) * c;

  const tx = clampSymmetric(idealTx, maxTx);
  const ty = clampSymmetric(idealTy, maxTy);

  // 上游在这里比较「上一档的 maxTx」：如果缩小了（maxTx 变小），理想值超出后
  // 会被记住成已钳制值，否则弹回去时会突然跳。见 `:152-158`。
  const prevMaxTx = calcMaxTranslate(fit.fitWidth, fit.viewportWidth, current.scale);
  const prevMaxTy = calcMaxTranslate(fit.fitHeight, fit.viewportHeight, current.scale);

  return {
    scale: clampedTarget,
    idealTx: maxTx < prevMaxTx ? tx : idealTx,
    idealTy: maxTy < prevMaxTy ? ty : idealTy,
    tx,
    ty,
  };
}

/** 是否已经越过拖拽死区（上游 `Math.hypot(dx, dy) < DRAG_DEADZONE` 的反面）。 */
export function exceedsDragDeadzone(dx: number, dy: number, deadzone = DRAG_DEADZONE): boolean {
  return Math.hypot(dx, dy) >= deadzone;
}

/**
 * 平移：在**当前缩放**下把偏移挪 `(dx, dy)`。
 *
 * 与 `computeAnchorZoom` 分开：缩放要保锚点，平移不需要，后者只是钳制。
 * 上游在 `:341` 起手处拦住死区，然后直接累加；这里把钳制一并做掉，
 * 免得调用方自己再调一次 `calcMaxTranslate`（漏了就会拖出边界）。
 */
export function panBy(
  fit: FitRects,
  current: TransformState,
  dx: number,
  dy: number,
): TransformState {
  const maxTx = calcMaxTranslate(fit.fitWidth, fit.viewportWidth, current.scale);
  const maxTy = calcMaxTranslate(fit.fitHeight, fit.viewportHeight, current.scale);
  const idealTx = current.idealTx + dx;
  const idealTy = current.idealTy + dy;
  return {
    scale: current.scale,
    idealTx,
    idealTy,
    tx: clampSymmetric(idealTx, maxTx),
    ty: clampSymmetric(idealTy, maxTy),
  };
}

/**
 * 双击：在「适应视口」与「放到最大」之间切换（上游 `toggleZoomAt` `:172-190`）。
 */
export function doubleClickToggle(
  fit: FitRects,
  current: TransformState,
  anchor?: { x: number; y: number } | null,
): TransformState {
  // 已经放大过就复原；否则放到最大。
  const target = current.scale > 1.001 ? 1 : fit.maxScale;
  return computeAnchorZoom(fit, target === 1 ? current : INITIAL_TRANSFORM, target, anchor);
}

/** 渲染用的 CSS transform 串。**单一出口** —— 调用方不许自己拼。 */
export function transformCss(t: TransformState): string {
  return `translate3d(${t.tx}px, ${t.ty}px, 0) scale(${t.scale})`;
}

/** 当前是否处于「放大」状态（用于决定是否显示「适合视口」按钮 / 光标样式）。 */
export function isZoomed(t: TransformState): boolean {
  return t.scale > 1.001;
}
