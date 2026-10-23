/**
 * 【T65】Deck spec 的**反模式检查器** —— 把 `guide slides design` 第 4 节
 * 「Anti-patterns (treat as defects)」里**能从结构算出来**的那几条，做成可执行判据。
 *
 * ## 为什么要在这里做
 *
 * 上游 `slides check` / `slides audit` 已经能报：出界、溢出、重叠、调色板外颜色、
 * outline 不一致、placeholder 文案。**这些都很准**（T62 亲手验过，我写错的每一处都被抓）。
 *
 * 但 T62 发现了一条它抓不到的：**留白过度**。那三张 452px 高的卡片里，文字只占
 * 上部三分之一，卡片下半截空着 —— 所有自动检查都是绿的，而规范第 3 节明写
 * 「Fill the page」。**这正是用户抱怨的「又烂又丑」里最常见的一种。**
 *
 * 反模式清单里还有几条上游也完全不看：每张卡片左侧的细竖条、装饰性角落方块、
 * 全篇统一页眉条、构图连续雷同。
 *
 * ## 为什么是 spec 级而不是文件级
 *
 * `DOCUMENT_QA_GATES` 那套是**文件级**门禁（对 .docx/.pptx 跑 CLI 命令）。这里算的
 * 是**页面描述本身**的结构 —— 不需要真文件、不需要渲染器、不需要 Electron。
 * 好处：改 spec 的那一刻就能查，不用等 build 出来。
 *
 * ## 判据的强度分级（**不许把弱判据当确定的报**）
 *
 * - `error`：确定违反规范，模型必须改。
 * - `warning`：疑似，需要人看的弱信号。
 *
 * 每一条都标注了它是**强**还是**弱**，以及为什么。
 */

/** spec 里的元素（只取本模块用得到的字段，其余原样忽略）。 */
export interface DeckElement {
  type: string;
  shape?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fill?: string;
  paragraphs?: Array<{ runs?: Array<{ text?: string; sizePt?: number }> }>;
}

export interface DeckPageSpec {
  title?: string;
  type?: string;
  layout?: string;
  background?: string;
  elements?: DeckElement[];
}

export type PatternLevel = "error" | "warning";

export interface PatternFinding {
  /** 判据标识（稳定，供断言与后续按条关闭）。 */
  rule: string;
  level: PatternLevel;
  /** 哪一页（0 基）。跨页判据把首个违规页放在这里。 */
  page: number;
  message: string;
}

export interface PatternReport {
  findings: PatternFinding[];
  /** 本次**实际执行**的判据 → 一句话说明它查什么。
   *  ⚠️ 未实现的判据**不在这里出现**（见文件末的 NOT_IMPLEMENTED）。 */
  applied: Record<string, string>;
}

const CANVAS_W = 1280;
const CANVAS_H = 720;

/** 整块背景/满版底板：它们不算「内容」，判留白时要排除。 */
function isFullBleed(e: DeckElement): boolean {
  return (e.w ?? 0) >= CANVAS_W * 0.95 && (e.h ?? 0) >= CANVAS_H * 0.95;
}

function fillOf(e: DeckElement): string | undefined {
  return typeof e.fill === "string" ? e.fill.toUpperCase() : undefined;
}

/** 近黑/近白/浅中性底色 —— 「彩虹卡片」判据要排除它们。 */
function isNeutral(hex: string | undefined): boolean {
  if (!hex) return true;
  const m = /^#([0-9A-F]{6})/.exec(hex);
  if (!m) return true;
  const r = parseInt(m[1]!.slice(0, 2), 16);
  const g = parseInt(m[1]!.slice(2, 4), 16);
  const b = parseInt(m[1]!.slice(4, 6), 16);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min < 24 || max > 238 || max < 30; // 接近灰 / 极亮 / 极暗
}

/** 卡片 = 有一定面积的形状（不是细条、不是背景）。 */
function cardsOf(page: DeckPageSpec): DeckElement[] {
  return (page.elements ?? []).filter(
    (e) => e.type === "shape" && !isFullBleed(e) && (e.w ?? 0) >= 80 && (e.h ?? 0) >= 80,
  );
}

function textsOf(page: DeckPageSpec): DeckElement[] {
  return (page.elements ?? []).filter((e) => e.type === "text");
}

/**
 * 【判据 1】卡片左侧细竖条 / 顶部色条（规范原文第一条反模式）。
 *
 * **强判据。** 规范明确禁止，形状特征也很确定：
 *   - 细竖条：宽度 < 24px、高度 ≥ 64px；
 *   - 顶部色条：高度 < 24px、宽度 ≥ 64px。
 *
 * ⚠️ 有一个已知误报面：**刻意的分隔线**（水平 rule）。规范自己也说「a horizontal
 * rule is a box with `h: 1`」是合法用法。所以这里只报**竖条**和**贴着卡片边缘的
 * 顶部条**，纯水平线放过 —— 见下面的实现。
 */
function checkAccentBars(page: DeckPageSpec, i: number): PatternFinding[] {
  const out: PatternFinding[] = [];
  const els = page.elements ?? [];
  for (const e of els) {
    if (e.type !== "shape") continue;
    const w = e.w ?? 0, h = e.h ?? 0;
    const verticalBar = w > 0 && w < 24 && h >= 64;
    // 顶部条：扁，且**压在某个卡片的上沿**（宽也接近卡片），才是「卡片顶部色条」。
    const horizontalBar = h > 0 && h < 24 && w >= 64;
    if (verticalBar) {
      out.push({
        rule: "accent-bar.vertical",
        level: "error",
        page: i,
        message: `第 ${i + 1} 页有一根 ${w}×${h} 的细竖条（规范明列的反模式：用底色、字重、字号表达层级，不要左侧色条）。`,
      });
    } else if (horizontalBar) {
      const barTop = e.y ?? 0;
      const sitsOnCard = cardsOf(page).some(
        (c) => Math.abs((c.y ?? 0) - barTop) < 6 && (e.w ?? 0) >= (c.w ?? 0) * 0.6,
      );
      if (sitsOnCard) {
        out.push({
          rule: "accent-bar.top",
          level: "error",
          page: i,
          message: `第 ${i + 1} 页有 ${w}×${h} 的顶部色条压在卡片上沿（规范明列的反模式）。`,
        });
      }
      // 不是压在卡片上的扁条（比如页脚分隔 rule）**不报** —— 见上面的误报说明。
    }
  }
  return out;
}

/**
 * 【判据 2】彩虹卡片：同一页出现 > 2 个不同**非中性**填充色。
 *
 * **强判据。** 规范：「One accent system for the whole deck」。黑白与浅中性底不算。
 * 阈值 2 直接来自规范（「Never more than the two accents」）。
 */
function checkRainbow(page: DeckPageSpec, i: number): PatternFinding[] {
  const colors = new Set<string>();
  for (const e of page.elements ?? []) {
    if (e.type !== "shape") continue;
    const f = fillOf(e);
    if (!f || isNeutral(f) || isFullBleed(e)) continue;
    colors.add(f);
  }
  if (colors.size <= 2) return [];
  return [{
    rule: "palette.rainbow",
    level: "error",
    page: i,
    message: `第 ${i + 1} 页用了 ${colors.size} 个非中性填充色（${[...colors].join(", ")}）；规范要求全 deck 至多两个强调色。`,
  }];
}

/**
 * 【判据 3】留白过度 —— **T62 发现的缺口，上游检查器没有**。
 *
 * ## 为什么不能用「元素面积占画布比」
 *
 * T62 试过：三根空柱子的元素面积 57.3%，比干净封面的 61.8% 还低 —— 判不出来。
 *
 * ## 为什么也不能用「文字占卡片的比例」
 *
 * 本轮实测（T65）：**修复前**（卡片矮、文字挤在上部）的卡片填充率是 **0.787**，
 * **修复后**（卡片高、内容铺开）是 **0.535** —— 卡片矮的时候文字自然占的比例**更高**。
 * 用这个判据会把「好的」判成坏的，把「坏的」判成好的。
 *
 * ## 真正成立的是「内容底边 / 画布高」
 *
 * 实测同一份 deck：
 *
 *   封面        1.000      （满版色块）
 *   内容页 好    0.872
 *   内容页 空柱  0.667  ← 问题所在
 *   KPI 页      0.833
 *   收尾页      0.653  ← **设计意图**，收尾页本来就该留白
 *
 * 所以判据必须**按页型分档**：content/data 用 `tight`、cover/closing 用 `loose`。
 * 两个数值与它们的出处见 {@link WHITESPACE_REFERENCE_LINE}。
 *
 * **强度：强**（同一页型内的比较是客观的）。但阈值是**参考线不是硬指标** —— 消息里
 * 写的是「参考线约 X%」并要求模型「若版面是有意的留白设计可忽略」。原因见下面常量
 * 注释里那段：把 80% 读成硬指标，模型会为了凑数把内容拉长，那本身就是一种丑。
 */

/**
 * 留白判据的**参考线**（不是硬指标 —— 措辞见 `checkWhitespace` 里那句消息）。
 *
 * ## 数值出处
 *
 * 来自 T69 对 T62 那份 deck 的逐页实测（2026-10-23）：
 *
 * ```
 * 封面     cover    1.000  → 不报
 * 内容页好  content  0.872  → 不报（余量 7.2pt）
 * 内容页空  content  0.667  → 报   （余量 13.3pt）
 * KPI 页   data     0.833  → 不报（**余量只有 3.3pt，最脆弱的一条**）
 * 收尾页   closing  0.653  → 不报（收尾页留白是设计意图）
 * ```
 *
 * `tight` 取 0.80：好的内容页不报、空柱子报得出来。
 * `loose` 取 0.55：收尾页 0.653 不报；再紧就会把「收尾页本来该留白」判成缺陷。
 *
 * ## ⚠️ 不要在没有新样本的情况下调这两个数
 *
 * T69 试过把 `tight` 收紧到 0.85 —— **直接误伤 KPI 页**（0.833 < 0.85），那条路被
 * 实测数据否掉。放宽到 0.75 则让空柱子只剩 8.3pt 余量。
 *
 * **样本只有 1 份 deck 的 5 个页面。在 5 个点上调参就是过拟合。**
 * 真要校准，先补样本（T69 的建议：T63 扩夹具，或再手做 2–3 份不同风格的 deck）。
 */
export const WHITESPACE_REFERENCE_LINE: Readonly<Record<"loose" | "tight", number>> = Object.freeze({
  /** cover / closing：收尾页本来就该留白（实测 0.653）。 */
  loose: 0.55,
  /** content / data：空柱子 0.667 必须报，好的内容页 0.872 不能报。 */
  tight: 0.8,
});

function checkWhitespace(page: DeckPageSpec, i: number): PatternFinding[] {
  const els = page.elements ?? [];
  if (els.length === 0) return [];
  const content = els.filter((e) => !isFullBleed(e));
  if (content.length === 0) return []; // 整页只有一个背景块 —— 交给别的判据
  const bottom = Math.max(...content.map((e) => (e.y ?? 0) + (e.h ?? 0)));
  const ratio = bottom / CANVAS_H;
  const type = page.type ?? "content";
  const threshold = type === "cover" || type === "closing"
    ? WHITESPACE_REFERENCE_LINE.loose
    : WHITESPACE_REFERENCE_LINE.tight;
  if (ratio >= threshold) return [];
  return [{
    rule: "layout.whitespace",
    level: "warning",
    page: i,
    // ⚠️ 这句是**给模型看的产品文案**，不是日志。措辞必须让它明白这是参考线：
    // 把它当成硬指标，模型会为了凑数把内容拉长 —— 那是另一种「又烂又丑」。
    // 三个要素：① 明确是参考线 ② 保留两个数字（现在 X% / 参考线 Y%）
    // ③ 不用「期望」「必须」「要求」，并显式允许「有意的留白」。
    message:
      `第 ${i + 1} 页内容底边只到画布高度的 ${(ratio * 100).toFixed(0)}%` +
      `（${type} 页参考线约 ${(threshold * 100).toFixed(0)}%）：下半部分留白较多。` +
      `若版面是有意的留白设计可忽略；否则考虑把内容铺开一些（规范第 3 节「Fill the page」）。`,
  }];
}

/**
 * 【判据 4】连续多页构图雷同（规范：「Vary the composition」）。
 *
 * **弱判据（warning）。** 用「layout 名 + 元素类型序列」做指纹：
 * 两页 layout 相同**且**元素类型序列相同 → 视为雷同。连续 ≥ 2 对（即三页一条线）
 * 才报，避免两页恰好同构就误报。
 */
function fingerprint(page: DeckPageSpec): string {
  const seq = (page.elements ?? []).map((e) => (e.type === "shape" ? `s:${e.shape ?? "rect"}` : e.type));
  return `${page.layout ?? "?"}|${seq.join(",")}`;
}

function checkRepeatedComposition(pages: DeckPageSpec[]): PatternFinding[] {
  const out: PatternFinding[] = [];
  let runStart = 0;
  for (let i = 1; i <= pages.length; i++) {
    const same = i < pages.length && fingerprint(pages[i]!) === fingerprint(pages[runStart]!);
    if (same) continue;
    const runLen = i - runStart;
    if (runLen >= 3) {
      out.push({
        rule: "layout.repeated",
        level: "warning",
        page: runStart,
        message: `第 ${runStart + 1}–${i} 页构图相同（layout 与元素序列都一致），规范要求「Vary the composition」。`,
      });
    }
    runStart = i;
  }
  return out;
}

/**
 * 【判据 5】封面是平标题 + 副标题（规范：「The cover must not be a flat title plus
 * subtitle: give it a visual anchor」）。
 *
 * **强判据。** 「视觉锚点」= 一个面积 ≥ 画布 12% 的元素（大色块 / 大数字 / 大图），
 * 或者一个 ≥ 60pt 的文字。两者都没有 → 报。
 */
function checkFlatCover(page: DeckPageSpec, i: number): PatternFinding[] {
  if ((page.type ?? "") !== "cover") return [];
  const els = page.elements ?? [];
  const bigShape = els.some(
    (e) => e.type === "shape" && ((e.w ?? 0) * (e.h ?? 0)) >= CANVAS_W * CANVAS_H * 0.12,
  );
  const bigNumber = els.some(
    (e) => e.type === "text" &&
      (e.paragraphs ?? []).some((p) => (p.runs ?? []).some((r) => (r.sizePt ?? 0) >= 60)),
  );
  const bigImage = els.some(
    (e) => e.type === "image" && ((e.w ?? 0) * (e.h ?? 0)) >= CANVAS_W * CANVAS_H * 0.12,
  );
  if (bigShape || bigNumber || bigImage) return [];
  return [{
    rule: "cover.flat",
    level: "error",
    page: i,
    message: "封面没有视觉锚点（大色块 / 大数字 / 大图都没有），规范要求封面不能只是平标题加副标题。",
  }];
}

/**
 * 【判据 6】全篇统一页眉条：每页同一位置、同一尺寸的 rect。
 *
 * **强判据。** 规范：「A deck-wide header bar with the page title on every page」。
 * 判法：位置与尺寸（±4px）在**所有页**都出现的扁 rect（h < 80）→ 报。
 * 至少 3 页才算「全篇」，否则两页的巧合会误报。
 */
function checkHeaderBar(pages: DeckPageSpec[]): PatternFinding[] {
  if (pages.length < 3) return [];
  const keyOf = (e: DeckElement) => {
    const g = (n?: number) => Math.round((n ?? 0) / 4) * 4;
    return `${g(e.x)},${g(e.y)},${g(e.w)},${g(e.h)}`;
  };
  const counts = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const e of p.elements ?? []) {
      if (e.type !== "shape" || isFullBleed(e)) continue;
      if ((e.h ?? 0) >= 80) continue; // 只可能是「条」，不是大块
      seen.add(keyOf(e));
    }
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: PatternFinding[] = [];
  for (const [k, n] of counts) {
    if (n === pages.length) {
      out.push({
        rule: "header.bar",
        level: "warning",
        page: 0,
        message: `每一页的同一位置都有同样一块（${k}）—— 规范禁止全篇统一页眉条，要求每页变化构图。`,
      });
    }
  }
  return out;
}

/**
 * 规范第 4 节里**本模块不实现**的判据，以及为什么。
 *
 * ⚠️ **不写假检查**：这些不会出现在 `applied` 里，也不会返回空数组假装"查过了"。
 */
export const NOT_IMPLEMENTED: Readonly<Record<string, string>> = Object.freeze({
  "corner.decoration":
    "装饰性角落方块 —— 无法从结构区分「装饰」与「功能性色块」（比如封面的大色块锚点、强调用的角标）。" +
    "任何保守判据都会误报合法设计，所以不实现。",
  "copy.repetition":
    "两行说同一件事 —— 需要语义理解（副标题是否在复述图表标题、要点是否重复），Mcode 侧做不到。",
  "numbers.mixed_units":
    "同排卡片混用不同量纲 —— 需要知道数字的**单位含义**（市占率 vs 价格 vs 数量）。" +
    "spec 里只有文本字符串，没有单位声明，靠正则猜单位会误报（'452 个方法' 与 '452 元' 无法区分）。",
});

/** 跑全部已实现的判据。 */
export function checkDeckPatterns(pages: DeckPageSpec[]): PatternReport {
  const findings: PatternFinding[] = [];
  const applied: Record<string, string> = {
    "accent-bar.vertical": "细竖条（w<24 且 h≥64）",
    "accent-bar.top": "压在卡片上沿的顶部色条（h<24 且贴卡片顶边）",
    "palette.rainbow": "同一页非中性填充色 > 2",
    // 这行**也是模型会读到的**（`applied` 会原样回给调用方）。`≥` 是硬约束语气，
    // 改成「参考线」，与 `checkWhitespace` 的消息保持一致。
    "layout.whitespace": "内容底边占画布高（content/data 参考线约 80%，cover/closing 约 55%）",
    "layout.repeated": "连续 ≥ 3 页 layout 与元素序列相同",
    "cover.flat": "封面无面积 ≥12% 的锚点、也无 ≥60pt 大字",
    "header.bar": "≥3 页同一位置同尺寸的扁条",
  };

  pages.forEach((p, i) => {
    findings.push(...checkAccentBars(p, i));
    findings.push(...checkRainbow(p, i));
    findings.push(...checkWhitespace(p, i));
    findings.push(...checkFlatCover(p, i));
  });
  findings.push(...checkRepeatedComposition(pages));
  findings.push(...checkHeaderBar(pages));

  return { findings, applied };
}
