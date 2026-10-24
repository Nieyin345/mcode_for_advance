/**
 * 【T120】用户气泡的超长折叠 —— 超过阈值就截断并用底部渐变提示「还有」。
 *
 * ## 为什么加这个
 *
 * 2026-10-24 把 `open-claude-ui` 的 36 个组件逐个对过（`tasks/T120-open-claude-ui-adoption.md`）。
 * 上游 `ChatMessageBubbles.tsx` 对**用户消息**做了这件事（`:85` `collapseThreshold = 300`，
 * `:99-101` 量 `scrollHeight` 决定，`:156` 上 `max-h-[300px]` + `mask-image` 渐变，
 * `:163` 给展开/收起按钮）。**Mcode 的 `MessageRow.tsx:330` 用户气泡只有 `overflow-hidden`，
 * 没有高度上限、没有渐变、没有展开按钮。**
 *
 * 后果很直接：用户往输入框里贴一大段日志/报错/需求，**消息就把视口铺满**，
 * 而且看不出底下还有多少。
 *
 * ## 为什么判据单独放这里
 *
 * 与 `composerPhysicalRules.ts` 同一个理由：**行为要能在无头环境里被验**，
 * 不需要挂一个真实的 DOM 测量。所以「多高算溢出」「收起时多高」「渐变多高」
 * 都是纯函数，`collapsibleBubbleState()` 把它们收成一处。
 *
 * ## 与上游的取舍
 *
 * 上游用 `mask-image: linear-gradient(to bottom, black calc(100% - 3rem), transparent)`
 * —— 底部 3rem 淡出。这里**沿用同一个数值**：它不是一个随意挑的数，而是
 * 「渐变要盖住一行半左右的文字才看得出『还有』」的经验值，改它等于改观感。
 *
 * 折叠高度也沿用上游的 300px。**注意它与阈值是同一个数**（上游也是），
 * 所以「刚好超一点点」的消息折叠后和展开几乎一样高 —— 那看着像 bug，实际是
 * 上游的设计：宁可少截，也不要为了 5px 塞一个几乎没用的折叠。
 * 想改的话改 `COLLAPSE_THRESHOLD_PX`，两者会一起动。
 */

/** 超过这个高度就折叠（px）。上游 `collapseThreshold` 默认值。 */
export const COLLAPSE_THRESHOLD_PX = 300;

/** 折叠时的高度上限（px）。上游 `max-h-[300px]`。与阈值同值。 */
export const COLLAPSED_MAX_HEIGHT_PX = 300;

/** 底部渐变的高度（px）。上游 `calc(100% - 3rem)`。 */
export const FADE_HEIGHT_PX = 48;

export type BubbleCollapseState =
  /** 内容不够高，不折叠也不显示任何按钮。 */
  | "fits"
  /** 内容超了，当前是**收起**状态：截断 + 底部渐变 + 「展开」。 */
  | "collapsed"
  /** 内容超了，用户已经展开：全文显示 + 「收起」。 */
  | "expanded";

/**
 * 给定实测内容高度与用户是否已展开，决定气泡处于哪个状态。
 *
 * **`contentHeightPx <= 0` 一律当 `"fits"`** —— 那是还没测到（首次渲染、
 * 或者元素被隐藏），把「不知道多高」判成「溢出」会闪一下折叠按钮。
 */
export function collapsibleBubbleState(args: {
  contentHeightPx: number;
  userExpanded: boolean;
  thresholdPx?: number;
}): BubbleCollapseState {
  const threshold = args.thresholdPx ?? COLLAPSE_THRESHOLD_PX;
  if (!Number.isFinite(args.contentHeightPx) || args.contentHeightPx <= 0) return "fits";
  if (args.contentHeightPx <= threshold) return "fits";
  return args.userExpanded ? "expanded" : "collapsed";
}

/**
 * 某一状态下正文容器的内联样式（`null` = 不加任何限制）。
 *
 * 返回内联样式而不是 class 串，因为**遮罩那一条是动态的**（`FADE_HEIGHT_PX`
 * 要参与计算），而 Tailwind 的任意值写法在 JIT 里拼字符串会被 purge 掉。
 */
export function bubbleBodyStyle(
  state: BubbleCollapseState,
  fadeHeightPx: number = FADE_HEIGHT_PX,
): { maxHeight?: string; overflowY?: "hidden"; maskImage?: string; WebkitMaskImage?: string } | null {
  if (state !== "collapsed") return null;
  const fade = Math.max(0, fadeHeightPx);
  // 与上游同一条曲线：到底部还剩 fade 高度时开始透明。
  const mask = `linear-gradient(to bottom, black calc(100% - ${fade}px), transparent)`;
  return {
    maxHeight: `${COLLAPSED_MAX_HEIGHT_PX}px`,
    overflowY: "hidden",
    maskImage: mask,
    // WebKit 前缀：Electron 用的是 Chromium，其实不需要；但上游代码同时写了
    // 两边，保持同形便于对照。
    WebkitMaskImage: mask,
  };
}

/** 按钮上该显示「展开」还是「收起」；`null` = 不显示按钮（内容不够高）。 */
export function collapseToggleLabel(state: BubbleCollapseState): "expand" | "collapse" | null {
  if (state === "collapsed") return "expand";
  if (state === "expanded") return "collapse";
  return null;
}
