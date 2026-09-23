/**
 * PDF 高亮的**坐标换算**与**批注组装** —— 纯函数、不含 I/O，所以放在契约包：
 * **渲染端和主进程都要用它**（渲染端在那里拿 viewer 算，主进程在无头测试里算）。
 *
 * ## 为什么必须在契约包，不能在 `main/`
 *
 * 渲染端从来不 import 主进程模块（那是架构边界）。换算逻辑放 `main/` 的话，
 * 渲染端要么够不着、要么就得**抄一份** —— 而"共享实现只有一份"是这个仓库的硬规矩
 * （两处判据分家 = 迟早出现"这个角度对、那个角度错"）。
 *
 * ## 两边说的不是同一种坐标
 *
 * | | 谁给的 | 单位 | 原点 |
 * |---|---|---|---|
 * | 高亮库 / pdf.js 划出来的 | `ScaledPosition` | **归一化**（0~1） | **左上**（网页那套 y 向下） |
 * | PDF 批注要的 | `QuadPoints` / `Rect` | **点值**（绝对） | **左下**（y 向上） |
 *
 * 中间还夹着 `usePdfCoordinates` 那一档：库允许坐标已经是"PDF 坐标空间"的
 * （那就**不能**再拿页面高度去翻 y，否则批注会跑到页外）。
 *
 * 换算错的表现很安静：批注**照样写进去、照样能在 Acrobat 面板里看到**，
 * 只是位置整体跑到别的地方 —— 用户在 Acrobat 里才发现。所以这一层要测得死死的
 * （`apps/desktop/scripts/pdf-annotation-smoke`，90 条断言 + 变异验证）。
 */
import type { PdfHighlight, PdfHighlightRect } from "./library.js";

/** 页面尺寸（点值），PDF 自己的坐标系。 */
export interface PdfPageSize {
  width: number;
  height: number;
}

/** 一个矩形在 **PDF 坐标系**里的样子（点值、左下原点）。 */
export interface PdfQuad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const finite = (v: number): boolean => typeof v === "number" && Number.isFinite(v);

/**
 * 一条矩形 → **PDF 坐标系**里的矩形。只做换算，不管怎么用。
 *
 * - **默认（归一化）**：乘页面尺寸 + 翻 y。`(0,0)` 是**左上角**，在 PDF 里
 *   对应 y = 页面高。
 * - **`pdfCoordinates: true`**：库给的**本来就是** PDF 点值、左下原点，
 *   **原样用** —— 再乘再翻，批注会跑到页外几倍远的地方。
 */
export function toPdfQuad(
  r: PdfHighlightRect,
  page: PdfPageSize,
  opts?: { pdfCoordinates?: boolean },
): PdfQuad {
  if (opts?.pdfCoordinates) {
    return {
      x1: Math.min(r.x1, r.x2),
      y1: Math.min(r.y1, r.y2),
      x2: Math.max(r.x1, r.x2),
      y2: Math.max(r.y1, r.y2),
    };
  }
  return {
    x1: clamp01(Math.min(r.x1, r.x2)) * page.width,
    x2: clamp01(Math.max(r.x1, r.x2)) * page.width,
    // ⚠️ y **反过来**：网页的上边（y 小）对应 PDF 的高 y。这一行写反了整条批注
    //    会上下镜像 —— 而且它照样是个合法矩形，除了比对具体数字没人能发现。
    y1: (1 - clamp01(Math.max(r.y1, r.y2))) * page.height,
    y2: (1 - clamp01(Math.min(r.y1, r.y2))) * page.height,
  };
}

/** 一条高亮的**全部**矩形（跨行就是多个）。空 rects 时退到 `boundingRect`。 */
export function toPdfQuads(h: PdfHighlight, page: PdfPageSize): PdfQuad[] {
  const rects = h.position.rects.length > 0 ? h.position.rects : [h.position.boundingRect];
  const opts = { pdfCoordinates: h.position.usePdfCoordinates === true };
  return rects.map((r) => toPdfQuad(r, page, opts));
}

/**
 * 包住全部四边形的外接矩形 —— `/Rect` 要的是这个。
 *
 * ⚠️ 不能只拿第一段：跨行时真正的最小外框是**所有段求并集**。
 */
export function unionRect(quads: PdfQuad[]): [number, number, number, number] {
  if (quads.length === 0) return [0, 0, 0, 0];
  let llx = Infinity;
  let lly = Infinity;
  let urx = -Infinity;
  let ury = -Infinity;
  for (const q of quads) {
    if (q.x1 < llx) llx = q.x1;
    if (q.y1 < lly) lly = q.y1;
    if (q.x2 > urx) urx = q.x2;
    if (q.y2 > ury) ury = q.y2;
  }
  return [llx, lly, urx, ury];
}

/**
 * 一个四边形 → PDF 规范的 `QuadPoints` 那 8 个数。
 *
 * ## 顺序不能乱
 *
 * 规范里是四对坐标，绕四边形一圈：**(左上) (右上) (左下) (右下)**。
 * 注意 PDF 是**逆时针**（数学坐标系），跟网页里顺时针写的习惯相反。
 * 写反了 Adobe 读起来照样是个四边形，但**高亮范围会歪**。
 */
export function quadToQuadPoints(q: PdfQuad): number[] {
  return [q.x1, q.y2, q.x2, q.y2, q.x1, q.y1, q.x2, q.y1];
}

/** 全部四边形摊平成 `QuadPoints`（8 个数 × N 段）。 */
export function toQuadPoints(quads: PdfQuad[]): number[] {
  const out: number[] = [];
  for (const q of quads) out.push(...quadToQuadPoints(q));
  return out;
}

/** 颜色：库里存 `#rrggbb`，PDF 要 0~1 的三元组。 */
export function hexToPdfRgb(hex: string | undefined): [number, number, number] {
  // 兜底是那支黄 —— **不要退回黑**：黑色高亮看起来像把字涂掉了。
  const fallback: [number, number, number] = [1, 0.886, 0.561];
  if (!hex) return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 校验一条高亮的形状。返回 `null` 表示能用，否则一句人话说明是哪一种坏。 */
export function validatePdfHighlight(h: PdfHighlight): string | null {
  if (!h || typeof h.id !== "string" || h.id.length === 0) return "缺 id";
  const p = h.position;
  if (!p || !p.boundingRect) return "缺 position";
  const br = p.boundingRect;
  if (!finite(br.x1) || !finite(br.y1) || !finite(br.x2) || !finite(br.y2)) return "坐标里有非数字";
  // pageNumber 必须是**正整数**：0 或负数是"第几页"这个语义下的坏值，
  // 拿它去拿页面会抛一个看不懂的越界错。
  if (!Number.isInteger(br.pageNumber) || br.pageNumber < 1) {
    return `页码不是正整数：${br.pageNumber}`;
  }
  if (!Array.isArray(p.rects) || p.rects.length === 0) return "没有 rects（空选区）";
  for (const r of p.rects) {
    if (!finite(r.x1) || !finite(r.y1) || !finite(r.x2) || !finite(r.y2)) return "rects 里有非数字";
  }
  return null;
}

/** 按页分组（页号是 **1 基**，和用户看到的页码一致）。 */
export function groupByPage(highlights: PdfHighlight[]): Map<number, PdfHighlight[]> {
  const out = new Map<number, PdfHighlight[]>();
  for (const h of highlights) {
    const n = h.position.boundingRect.pageNumber;
    const list = out.get(n);
    if (list) list.push(h);
    else out.set(n, [h]);
  }
  return out;
}

/* ───────────────────── pdf.js 的批注形状 ───────────────────── */

/** pdf.js 的 `AnnotationEditorType.HIGHLIGHT`。写死数字比 import 整个 pdf.mjs 轻。 */
export const PDFJS_HIGHLIGHT_TYPE = 9;

/**
 * ⚠️ **pdf.js 认的 key 前缀** —— 别改成别的。
 *
 * worker 里是这么筛的：`if (!key.startsWith(AnnotationEditorPrefix)) continue;`
 * 不带前缀的项被**静默跳过**，`saveDocument()` 出来还是原文件，一点提示都没有
 * （只在 storage 完全为空时打一句 warning）。这是 pdf.js 的 `AnnotationEditorPrefix`。
 */
export const PDFJS_EDITOR_KEY_PREFIX = "pdfjs_internal_editor_";

/** pdf.js 认的 `EditorAnnotation`（`annotationStorage.setValue` 的第二个参数）。 */
export interface PdfjsEditorAnnotation {
  annotationType: number;
  /** ⚠️ **0~255 的整数**，不是 0~1。pdf.js 内部自己 `/255`。 */
  color: [number, number, number, number];
  /** 0~1，**独立字段**。 */
  opacity: number;
  quadPoints: number[];
  /**
   * ⚠️ **扁平数字数组的数组**，不是对象数组。
   *
   * pdf.js 的 `HighlightAnnotation.createNewAppearanceStream` 是这么读的：
   * `for (const outline of outlines) { numberToString(outline[0]) … outline[i] }`
   * —— 每个 outline 必须形如 `[x0,y0, x1,y1, …]`（一条闭合路径）。
   *
   * 给它 `{x,y,width,height,path}` 对象会走到 `numberToString(undefined)` →
   * `Cannot read properties of undefined (reading 'toFixed')`，包成一个
   * `UnknownErrorException`，**完全看不出是形状问题**。
   */
  outlines: number[][];
  /** ⚠️ **0 基**（pdf.js 内部口径），而库里的 `pageNumber` 是 1 基。 */
  pageIndex: number;
  rect: [number, number, number, number];
  rotation: number;
  parentTreeId: string | null;
}

/**
 * 一条高亮 → pdf.js 的批注形状。
 *
 * `page` 由调用方给（渲染端从 `page.getViewport({ scale: 1 })` 拿）。
 * **渲染端和主进程走的是同一个函数** —— 不各写一份。
 */
export function toPdfjsAnnotation(h: PdfHighlight, page: PdfPageSize): PdfjsEditorAnnotation {
  const quads = toPdfQuads(h, page);
  const [r, g, b] = hexToPdfRgb(h.color);
  return {
    annotationType: PDFJS_HIGHLIGHT_TYPE,
    color: [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255],
    opacity: 0.5,
    quadPoints: toQuadPoints(quads),
    // 每段一个闭合路径：左下 → 右下 → 右上 → 左上
    outlines: quads.map((q) => [q.x1, q.y1, q.x2, q.y1, q.x2, q.y2, q.x1, q.y2]),
    pageIndex: h.position.boundingRect.pageNumber - 1,
    rect: unionRect(quads),
    rotation: 0,
    parentTreeId: null,
  };
}
