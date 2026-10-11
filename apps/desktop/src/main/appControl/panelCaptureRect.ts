/**
 * 「面板截图」的**纯几何** —— 把一个 iframe 的屏幕矩形(`getBoundingClientRect()` 的结果)
 * 换算成主窗口 `webContents.capturePage(rect)` 该用的矩形:裁到窗口可见区内、四舍五入到整数,
 * 退化(量不到 / 尺寸为 0 / 完全划出视口)时**返回原因**,而不是给一个空矩形让调用方去截一张
 * 空图(仓库硬规矩 3:坏东西显式报出来,不静默)。
 *
 * ## 为什么单独一个零依赖模块
 *
 * `capturePage` 那一步要起 Electron,无头 smoke 验不了"像素对不对"。但**「矩形怎么算」是纯
 * 函数**,能验 —— 抽出来才测得到(与 `uiBridge` 抽出 `RendererPort` 让界面通道可测同一动机)。
 * 所以这里**不 import electron / DOM / react**,smoke 直接 bundle 测。
 *
 * ## 坐标系(为什么可以拿 `getBoundingClientRect` 直接当 `capturePage(rect)`)
 *
 * 全仓没有 `zoomFactor` / `setZoom`(grep 无命中),所以 CSS px == DIP;`getBoundingClientRect`
 * 的 `left/top` 是**相对视口**的,而 `capturePage(rect)` 的 rect 也是相对 **webContents 视口**
 * 左上角 —— 两者同一套坐标。`devicePixelRatio` 只影响返回 PNG 的**像素尺寸**(2x 屏截出来是
 * 2x 像素的图),不改这里的坐标系,所以不必换算。
 *
 * ## 为什么要与「窗口可见区」求交
 *
 * `float`(浮窗)在 Dialog 浮层里,基本总在视口内;但 `preview`(设置页那格预览)与 `tab`
 * (右栏页签)都在**滚动容器**里 —— 面板可能被滚出去一半甚至整块滚出视口。`getBoundingClientRect`
 * 给的正是它此刻**实际落在屏幕上的位置**(已经算进滚动),所以与 `[0,0,视口宽,视口高]` 求交
 * 得到的就是"真正能看见的那一部分";整块滚出去(width/height 求交后 < 1)就如实报错,而不是
 * 截一块窗口上别处的内容冒充面板。
 */
import type { PanelCaptureRect } from "@contracts/appControl";

/** 面板矩形的宽松输入(`getBoundingClientRect()` 的形状)。 */
export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 面板屏幕矩形 + 窗口可见区尺寸 → 给 `capturePage` 用的矩形,或一个**说得清的原因**。
 *
 * 判据是"能不能截":拿不到矩形 / 窗口尺寸非法 / 面板尺寸为 0 / 求交后小于 1px,都算截不了。
 */
export function computePanelCaptureRect(
  panel: RectLike | null | undefined,
  viewport: { width: number; height: number } | null | undefined,
): { ok: true; rect: PanelCaptureRect } | { ok: false; reason: string } {
  if (!panel) {
    return { ok: false, reason: "量不到面板的屏幕位置(面板可能还没布局好、或它所在的容器被折叠了)" };
  }
  const vw = viewport && Number.isFinite(viewport.width) ? viewport.width : 0;
  const vh = viewport && Number.isFinite(viewport.height) ? viewport.height : 0;
  if (vw <= 0 || vh <= 0) {
    return { ok: false, reason: "拿不到主窗口的可见区域尺寸(界面可能还没准备好)" };
  }
  if (!(panel.width > 0) || !(panel.height > 0)) {
    return { ok: false, reason: `面板尺寸为 0(${panel.width}×${panel.height}),没有可截的内容` };
  }
  // 与窗口可见区求交:preview / tab 两个挂载位在滚动容器里,可能被滚出去一半。
  const left = Math.max(0, panel.x);
  const top = Math.max(0, panel.y);
  const right = Math.min(vw, panel.x + panel.width);
  const bottom = Math.min(vh, panel.y + panel.height);
  const width = right - left;
  const height = bottom - top;
  if (width < 1 || height < 1) {
    return { ok: false, reason: "面板不在窗口可见区内(被滚出视口了,或整个在窗口之外)" };
  }
  return {
    ok: true,
    rect: {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    },
  };
}
