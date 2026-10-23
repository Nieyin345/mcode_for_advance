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
// ⚠️ 目前 `level` 只是一个文本前缀（见 documentToolRuntime 的 patternFindingsText），
// 不驱动任何行为：不阻断、不排序、不过滤。等哪天有第二条判据也拿到规范原文
// （现在只有 palette.rainbow 有），或真实 deck 把某条阈值校准到可信，
// 再让它驱动行为。在那之前别把 [error] 读成「有后果」。

export interface PatternFinding {
  /** 判据标识（稳定，供断言与后续按条关闭）。 */
  rule: string;
  level: PatternLevel;
  /**
   * 哪一页（0 基）；**`null` = 这条讲的是「全篇」，不指向某一页**。
   *
   * 跨页判据（`header.bar` / `layout.repeated`）返回 `null` 而不是「首个违规页」：
   * 它们的问题本身就是「每一页都有」「连续三页都一样」，塞一个单页索引会让渲染层
   * 写成「第 1 页：每一页都…」——**字段说一页、文字说全部**，模型会去改那一页，
   * 重建后问题还在。具体页号写在 `message` 里（那边可以列全）。
   */
  page: number | null;
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
        // ⚠️ warning 不是 error：判据本身（w<24 且 h≥64）能命中真实色条，但**阈值是拍的** ——
        // 规范原文只说「thin vertical accent bar on the left of every card / a colored bar on
        // top of cards / a small bar left of titles」，没给像素。7 条判据里只有
        // `palette.rainbow` 有规范原文（"Never more than the two accents"），其余全是经验阈值。
        // 拍的阈值不该以 error 身份打断模型。
        level: "warning",
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
          level: "warning",   // 理由同 `accent-bar.vertical`：阈值是拍的。
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
 * ⚠️ **80% 这条线落在真实设计的高频区**（A 的 T70 实测）：T62 的 KPI 页是 0.8333，
 * 卡片减 32px（约一个行高）就掉到 78.9% 被误报。**这是已知的、可接受的误报面** ——
 * 改它是调参，不是修 bug（见上面「不要在没有新样本的情况下调」）。
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

/**
 * 【判据 3b】**容器级**留白：卡片内部，文字底边到卡底的空白占卡片高度的比例。
 *
 * ## 为什么整页级判据抓不到这种丑法（【T75】2026-10-23 A 复核发现）
 *
 * 整页级量的是「内容底边 / 画布高」。而**卡片本身就是元素**——卡片越高，底边越靠下，
 * 比例越大。实测同一页的两种版本：
 *
 * ```
 *                        整页底边    本判据（卡底留白）
 * 空柱子(卡片 452 高，文字只占上部)  0.872        0.580   ← 整页判据判它「合格」
 * 好(同样卡片 452 高，文字填满)      0.872        0.062
 * ```
 *
 * **整页级在两页上给出完全相同的 0.872** —— 一个数都分不开。因为卡片高度一样，
 * 底边自然一样。**两种丑法不是一回事**：整页级抓「内容只占上半页」，本判据抓
 * 「卡片内下半截空着」。
 *
 * ## 方向：**越大越空**（与整页级相反）
 *
 * ## ⚠️ 样本量 = 2
 *
 * 一个空柱子（0.580）、一个填满（0.062）。`0.45` 是**这两个数的区间中点**，
 * 不是校准值 —— 它离两边各有 0.13 / 0.39 的余量，足够区分这两个已知形态，
 * 但**没有任何证据说明 0.45 对其它设计是对的**。
 *
 * T69 的教训在这里同样成立：不要在少量样本上精调。等真实 deck 攒到 10 页以上
 * （或 T63 扩出更多夹具）再回来校准。
 */
export const CARD_WHITESPACE_REFERENCE_LINE = 0.45;

/** 卡片内的文字底边到卡底的留白 / 卡片高。**每张卡各自算**，调用方逐张判线。 */
function cardBottomGapRatios(page: DeckPageSpec): Array<{ ratio: number; card: DeckElement }> {
  const out: Array<{ ratio: number; card: DeckElement }> = [];
  for (const c of cardsOf(page)) {
    const inside = textsOf(page).filter(
      (t) => (t.x ?? 0) >= (c.x ?? 0) && (t.y ?? 0) >= (c.y ?? 0) &&
        (t.y ?? 0) < (c.y ?? 0) + (c.h ?? 0) && (t.x ?? 0) < (c.x ?? 0) + (c.w ?? 0),
    );
    if (inside.length === 0) continue;
    const textBottom = Math.max(...inside.map((t) => (t.y ?? 0) + (t.h ?? 0)));
    const cardBottom = (c.y ?? 0) + (c.h ?? 0);
    out.push({ ratio: (cardBottom - textBottom) / (c.h ?? 1), card: c });
  }
  return out;
}

/**
 * 【判据 4b】卡片内下半截空着。**每张超线的卡各报一条。**
 *
 * ⚠️ 早先这里取 `max`（只报最空的那一张），于是同一页里第二张、第三张空卡被
 * **静默吞掉** —— 模型改完第一张、重新 build 才看到第二张，白跑一轮渲染。
 * 违反 CLAUDE.md 硬规矩 3「坏东西显式报出来，不静默跳过」。
 *
 * **用 x 坐标定位，不用序号**：x 在 spec 里本来就有，模型不用自己数「什么算一张
 * 卡」，也不会随判据规则改变而错位。
 *
 * ⚠️ **【T75 记录，未处理】** 卡内文字溢出到卡底以下时 `ratio` 变负 → 本判据不报
 * （实测 2026-10-23：卡 y=176 h=300、文字 y=268 h=400 → ratio=-0.64，七条判据
 * 全部空过）。那属于「文字溢出容器」，与「容器内留白」是两种形态，且上游
 * `audit` 会报 `out_of_bounds` / `Text overflow` —— **不要在 Mcode 侧再加一条重复
 * 判据**（判据只有一份，硬规矩 2）。若将来上游不报了再补，那时用独立规则名
 * （如 `layout.card-overflow`），不要塞进本判据。
 */
function checkCardWhitespace(page: DeckPageSpec, i: number): PatternFinding[] {
  const findings: PatternFinding[] = [];
  for (const { ratio, card } of cardBottomGapRatios(page)) {
    if (ratio < CARD_WHITESPACE_REFERENCE_LINE) continue;
    findings.push({
      rule: "layout.card-whitespace",
      level: "warning",
      page: i,
      // 措辞与整页级同一条纪律：参考线、给两个数字、允许有意留白。
      message:
        `第 ${i + 1} 页 x=${Math.round(card.x ?? 0)} 处的卡片内部下半截空着：` +
        `文字底边离卡底还有 ${(ratio * 100).toFixed(0)}% 的卡高` +
        `（参考线约 ${(CARD_WHITESPACE_REFERENCE_LINE * 100).toFixed(0)}%）：通常是卡片被拉高但内容没跟上。` +
        `若这是有意的留白可忽略；否则考虑缩短卡片或补足卡内内容。`,
    });
  }
  return findings;
}

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
        // `null`：这条讲的是「第 N–M 页这一串」，不是某一页。具体页号在 message 里。
        page: null,
        message:
          `第 ${runStart + 1}–${i} 页构图相同（layout 与元素序列都一致，共 ${runLen} 页），` +
          `规范要求「Vary the composition」——请把这几页改成不同构图。`,
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
    // ⚠️ warning：判据（面积 ≥12% 的锚点）是经验值，规范只说「give it a visual anchor」，
    // 没定义多大算锚点。只有 `palette.rainbow` 有规范原文，保持 error。
    level: "warning",
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
  /** 每个 key 命中了**哪些页**（0 基）—— message 要列全，不能只说「每一页」。 */
  const pagesOf = new Map<string, number[]>();
  for (const [i, p] of pages.entries()) {
    const seen = new Set<string>();
    for (const e of p.elements ?? []) {
      if (e.type !== "shape" || isFullBleed(e)) continue;
      if ((e.h ?? 0) >= 80) continue; // 只可能是「条」，不是大块
      seen.add(keyOf(e));
    }
    for (const k of seen) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      const list = pagesOf.get(k) ?? [];
      list.push(i);
      pagesOf.set(k, list);
    }
  }
  const out: PatternFinding[] = [];
  for (const [k, n] of counts) {
    if (n === pages.length) {
      // 页号 1 基、用「、」分隔；3 页以上时压缩成「第 1–N 页」更短但不丢信息。
      const list = pagesOf.get(k) ?? [];
      const contiguous = list.every((v, idx) => idx === 0 || v === list[idx - 1]! + 1);
      const where = contiguous && list.length > 3
        ? `第 ${list[0]! + 1}–${list[list.length - 1]! + 1} 页`
        : `第 ${list.map((v) => v + 1).join("、")} 页`;
      out.push({
        rule: "header.bar",
        level: "warning",
        // `null`：问题在「全篇统一」，不是某一页。只改一页不可能修好它。
        page: null,
        message:
          `${where}的 (${k}) 位置都有同样一块扁条 —— 规范禁止全篇统一页眉条，要求每页变化构图。` +
          `**这条要全篇一起改**，只改其中一页不会消失。`,
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
    "layout.card-whitespace": "卡片内文字底边到卡底的留白占卡高（参考线约 45%，越大越空）",
    "layout.repeated": "连续 ≥ 3 页 layout 与元素序列相同",
    "cover.flat": "封面无面积 ≥12% 的锚点、也无 ≥60pt 大字",
    "header.bar": "≥3 页同一位置同尺寸的扁条",
  };

  pages.forEach((p, i) => {
    findings.push(...checkAccentBars(p, i));
    findings.push(...checkRainbow(p, i));
    findings.push(...checkWhitespace(p, i));
    findings.push(...checkCardWhitespace(p, i));
    findings.push(...checkFlatCover(p, i));
  });
  findings.push(...checkRepeatedComposition(pages));
  findings.push(...checkHeaderBar(pages));

  return { findings, applied };
}
