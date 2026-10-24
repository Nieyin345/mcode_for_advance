/**
 * 【T65】deck 反模式检查器 —— **每条判据都配正控 + 负控**。
 *
 * 正控：合规 spec → 该判据**不报**。
 * 负控：故意违反 → 该判据**必须报**。
 *
 * 没有负控的判据等于没验（T24 的 59/59 就是这么绿着漏掉缺陷的）。
 */
import { checkDeckPatterns, NOT_IMPLEMENTED, type DeckPageSpec, type DeckElement } from "@main/document/deckPatternCheck.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 一页合规的内容页：三张卡，内容铺到画布 85%。 */
function goodContentPage(): DeckPageSpec {
  return {
    type: "content", layout: "three_column_cards", background: "#F7F7F5",
    elements: [
      { type: "text", x: 80, y: 60, w: 1120, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 36 }] }] },
      { type: "shape", shape: "roundRect", x: 80, y: 176, w: 352, h: 420, fill: "#FFFFFF" },
      { type: "text", x: 112, y: 212, w: 288, h: 40, paragraphs: [{ runs: [{ text: "卡一", sizePt: 22 }] }] },
      { type: "text", x: 112, y: 268, w: 288, h: 300, paragraphs: [{ runs: [{ text: "正文", sizePt: 14 }] }] },
    ],
  };
}

// ⚠️ 这是**读者真正会看的第一屏** —— 它必须自己说清边界，因为名字说不清。
// 见 T86：`t65-deck-pattern-smoke` 听起来像在验「整个反模式能力」，
// 而它**只验纯函数这一层**。接线（模型能不能真的看到 findings）是另一套的事 ——
// T73 之前那层完全断着，而信了名字的人不会去查。
console.log(
  "\nT65 · 反模式判据的纯函数层\n" +
  "  验：checkDeckPatterns(spec) 是否按规范报出反模式；每条判据都有正控 + 负控。\n" +
  "  不验：接线（模型是否真的看到 findings）→ t73-pattern-wiring-smoke。\n" +
  "  不验：真实 deck 的观感（那要人看渲染图，见 T62 验收）。",
);

/* ── 判据 1：细竖条 ── */
console.log("\n[1] 细竖条 / 顶部色条");
{
  const clean = checkDeckPatterns([goodContentPage()]);
  eq("正控：合规页不报竖条", clean.findings.filter(f => f.rule.startsWith("accent-bar")).length, 0);

  const bad: DeckPageSpec = { ...goodContentPage(), elements: [
    ...goodContentPage().elements!,
    { type: "shape", shape: "rect", x: 90, y: 220, w: 6, h: 200, fill: "#2E6BE6" },
  ]};
  const r = checkDeckPatterns([bad]);
  check("★ 负控：细竖条被报出来", r.findings.some(f => f.rule === "accent-bar.vertical"), r.findings);

  // 误报防护：页脚的分隔 rule（h=1，不贴卡片）不能被当顶部色条
  const rule: DeckPageSpec = { ...goodContentPage(), elements: [
    ...goodContentPage().elements!,
    { type: "shape", shape: "rect", x: 80, y: 690, w: 1120, h: 1, fill: "#DCDDE0" },
  ]};
  eq("误报防护：页脚分隔线不报", checkDeckPatterns([rule]).findings.filter(f => f.rule === "accent-bar.top").length, 0);
}

/* ── 判据 2：彩虹卡片 ── */
console.log("\n[2] 彩虹卡片");
{
  eq("正控：两个强调色不报", checkDeckPatterns([goodContentPage()]).findings.filter(f => f.rule === "palette.rainbow").length, 0);
  const bad: DeckPageSpec = { ...goodContentPage(), elements: [
    { type: "shape", shape: "roundRect", x: 80, y: 200, w: 300, h: 300, fill: "#E23B3B" },
    { type: "shape", shape: "roundRect", x: 420, y: 200, w: 300, h: 300, fill: "#2ECC71" },
    { type: "shape", shape: "roundRect", x: 760, y: 200, w: 300, h: 300, fill: "#9B59B6" },
  ]};
  check("★ 负控：三个非中性色被报", checkDeckPatterns([bad]).findings.some(f => f.rule === "palette.rainbow"));

  /* ── T100：色相聚类 + isNeutral 的「近白」口径 ──
   *
   * 上面那条负控用的是 #E23B3B / #2ECC71 / #9B59B6 —— 它们 max 都 ≤ 238，
   * 所以**旧代码的 `max > 238` 从未被这条断言碰到**。下面补两组。 */
  const sameHue: DeckPageSpec = { ...goodContentPage(), elements: [
    // 同一蓝色的三档明度（数据可视化的标准做法）—— 实测色相跨度 6.2°
    { type: "shape", shape: "roundRect", x: 80, y: 340, w: 90, h: 260, fill: "#1F3A5F" },
    { type: "shape", shape: "roundRect", x: 220, y: 260, w: 90, h: 340, fill: "#3E6E9E" },
    { type: "shape", shape: "roundRect", x: 360, y: 420, w: 90, h: 180, fill: "#6FA3D2" },
    { type: "text", x: 80, y: 80, w: 900, h: 120, paragraphs: [{ runs: [{ text: "图表", sizePt: 40 }] }] },
  ]};
  eq("★ T100 正控：同色相三档明度不算彩虹", checkDeckPatterns([sameHue]).findings.filter(f => f.rule === "palette.rainbow").length, 0);

  const pureRainbow: DeckPageSpec = { ...goodContentPage(), elements: [
    // 纯饱和三色 —— 每个都有一个通道是 255。旧 `max > 238` 会把它们全判成"近白"而放行。
    { type: "shape", shape: "roundRect", x: 80, y: 200, w: 300, h: 300, fill: "#FF3355" },
    { type: "shape", shape: "roundRect", x: 420, y: 200, w: 300, h: 300, fill: "#33FF55" },
    { type: "shape", shape: "roundRect", x: 760, y: 200, w: 300, h: 300, fill: "#3355FF" },
  ]};
  check("★ T100 负控：纯饱和三色仍被报（「近白」不能把鲜艳色排除）",
    checkDeckPatterns([pureRainbow]).findings.some(f => f.rule === "palette.rainbow"));

  const nearlyWhite: DeckPageSpec = { ...goodContentPage(), elements: [
    { type: "shape", shape: "roundRect", x: 80, y: 200, w: 300, h: 300, fill: "#F5F5F5" },
    { type: "shape", shape: "roundRect", x: 420, y: 200, w: 300, h: 300, fill: "#FAFAFA" },
    { type: "shape", shape: "roundRect", x: 760, y: 200, w: 300, h: 300, fill: "#EEEEEE" },
  ]};
  eq("★ T100 正控：三档近白仍是中性，不报", checkDeckPatterns([nearlyWhite]).findings.filter(f => f.rule === "palette.rainbow").length, 0);
}

/* ── 判据 3：留白过度（T62 发现的缺口） ── */
console.log("\n[3] 留白过度");
{
  eq("正控：铺满的内容页不报", checkDeckPatterns([goodContentPage()]).findings.filter(f => f.rule === "layout.whitespace").length, 0);

  // 负控 A：内容只到画布 60%（模拟 T62 的三根空柱子修复前）
  const bad: DeckPageSpec = { type: "content", layout: "three_column_cards", elements: [
    { type: "text", x: 80, y: 60, w: 1120, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 36 }] }] },
    { type: "shape", shape: "roundRect", x: 80, y: 180, w: 352, h: 250, fill: "#FFFFFF" },
  ]};
  check("★ 负控：内容只到 60% 被报", checkDeckPatterns([bad]).findings.some(f => f.rule === "layout.whitespace"));

  // 正控 B：closing 页只有 65% —— 设计意图，不该报
  const closing: DeckPageSpec = { type: "closing", layout: "closing_cta", elements: [
    { type: "text", x: 140, y: 230, w: 1000, h: 160, paragraphs: [{ runs: [{ text: "收尾", sizePt: 40 }] }] },
    { type: "text", x: 140, y: 430, w: 1000, h: 40, paragraphs: [{ runs: [{ text: "署名", sizePt: 15 }] }] },
  ]};
  eq("正控：closing 页 65% 不报（按页型分档）", checkDeckPatterns([closing]).findings.filter(f => f.rule === "layout.whitespace").length, 0);

  // 负控 C：closing 页只到 30% —— 那确实太空
  const tooEmpty: DeckPageSpec = { type: "closing", layout: "closing_cta", elements: [
    { type: "text", x: 140, y: 100, w: 1000, h: 120, paragraphs: [{ runs: [{ text: "收尾", sizePt: 40 }] }] },
  ]};
  check("★ 负控：closing 页只到 30% 被报", checkDeckPatterns([tooEmpty]).findings.some(f => f.rule === "layout.whitespace"));
}

/* ── 判据 4：构图雷同 ── */
console.log("\n[4] 连续构图雷同");
{
  eq("正控：两页同构不报（阈值是 3）", checkDeckPatterns([goodContentPage(), goodContentPage()]).findings.filter(f => f.rule === "layout.repeated").length, 0);
  const three = [goodContentPage(), goodContentPage(), goodContentPage()];
  check("★ 负控：三页同构被报", checkDeckPatterns(three).findings.some(f => f.rule === "layout.repeated"));
}

/* ── 判据 5：平面封面 ── */
console.log("\n[5] 封面无视觉锚点");
{
  const anchored: DeckPageSpec = { type: "cover", layout: "cover_dark_minimal", elements: [
    { type: "shape", shape: "rect", x: 860, y: 0, w: 420, h: 720, fill: "#2E6BE6" },
    { type: "text", x: 80, y: 250, w: 700, h: 170, paragraphs: [{ runs: [{ text: "标题", sizePt: 44 }] }] },
  ]};
  eq("正控：有大色块锚点不报", checkDeckPatterns([anchored]).findings.filter(f => f.rule === "cover.flat").length, 0);

  const flat: DeckPageSpec = { type: "cover", layout: "cover_dark_minimal", elements: [
    { type: "text", x: 80, y: 280, w: 700, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 44 }] }] },
    { type: "text", x: 80, y: 360, w: 700, h: 40, paragraphs: [{ runs: [{ text: "副标题", sizePt: 18 }] }] },
  ]};
  check("★ 负控：平标题+副标题被报", checkDeckPatterns([flat]).findings.some(f => f.rule === "cover.flat"));
}

/* ── 判据 6：全篇页眉条 ── */
console.log("\n[6] 全篇统一页眉条");
{
  eq("正控：各页不同不报", checkDeckPatterns([goodContentPage(), goodContentPage(), goodContentPage()]).findings.filter(f => f.rule === "header.bar").length, 0);

  const header = { type: "shape" as const, shape: "rect", x: 0, y: 0, w: 1280, h: 48, fill: "#1A1D21" };
  const pages = [0, 1, 2].map(() => ({ ...goodContentPage(), elements: [header, ...goodContentPage().elements!] }));
  check("★ 负控：每页同位置页眉条被报", checkDeckPatterns(pages).findings.some(f => f.rule === "header.bar"));
}

/* ── 不假装：做不到的必须列在 NOT_IMPLEMENTED，且不出现在 applied ── */
console.log("\n[7] 不实现的那几条必须显式标注");
{
  const applied = Object.keys(checkDeckPatterns([goodContentPage()]).applied);
  for (const key of Object.keys(NOT_IMPLEMENTED)) {
    check(`未实现「${key}」不在 applied 里（不假装查过）`, !applied.includes(key), { applied });
    check(`未实现「${key}」有说明理由`, (NOT_IMPLEMENTED[key] ?? "").length > 20);
  }
  eq("NOT_IMPLEMENTED 覆盖三条", Object.keys(NOT_IMPLEMENTED).length, 3);
}

/* ── 【T72】留白消息必须是「参考线」语气，不是硬指标 ──
 *
 * 这不是文案洁癖：**模型看到的就是这行字**。把它读成硬指标，它会为了凑数把内容
 * 拉长 —— 那本身就是另一种「又烂又丑」。三个要素各自一条断言。
 */
console.log("\n[T72] 留白消息的措辞");
{
  const thin: DeckPageSpec = { type: "content", layout: "three_column_cards", elements: [
    { type: "text", x: 80, y: 60, w: 1120, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 36 }] }] },
    { type: "shape", shape: "roundRect", x: 80, y: 180, w: 352, h: 250, fill: "#FFFFFF" },
  ]};
  const msg = checkDeckPatterns([thin]).findings.find(f => f.rule === "layout.whitespace")!.message;

  check("★ 消息里出现「参考线」", msg.includes("参考线"), { msg });
  check("★ 消息里没有「期望」", !msg.includes("期望"), { msg });
  check("★ 消息里没有「必须」", !msg.includes("必须"), { msg });
  check("★ 消息里没有「要求」", !msg.includes("要求"), { msg });
  // 可操作信息：两个数字都要在，模型才知道差多少
  check("★ 消息保留了「现在 X%」", /\d+%/.test(msg), { msg });
  check("★ 消息保留了「参考线 Y%」", /参考线约\s*\d+%/.test(msg), { msg });
  // 显式允许有意的留白
  check("★ 消息允许「有意的留白设计可忽略」", msg.includes("可忽略"), { msg });

  // RULE_DESCRIPTIONS 那行也是模型读到的
  const applied = checkDeckPatterns([goodContentPage()]).applied;
  const desc = applied["layout.whitespace"] ?? "";
  check("★ RULE_DESCRIPTIONS 也是参考线语气", desc.includes("参考线"), { desc });
  check("★ RULE_DESCRIPTIONS 不含 ≥", !desc.includes("≥"), { desc });

  /* ── T100：cover 豁免改成几何判断 ──
   *
   * 从前 `const type = page.type ?? "content"` —— 模型写 spec 时通常不填 `type`，
   * 于是封面必报留白。现在改成「有满版底 + 内容 ≤ 4 个元素」的几何判断。 */
  const coverNoType: DeckPageSpec = { elements: [
    { type: "shape", shape: "rect", x: 0, y: 0, w: 1280, h: 720, fill: "#0E1A2B" }, // 满版底
    { type: "text", x: 120, y: 260, w: 900, h: 120, paragraphs: [{ runs: [{ text: "封面标题", sizePt: 54 }] }] },
    { type: "text", x: 120, y: 400, w: 900, h: 60, paragraphs: [{ runs: [{ text: "副标题", sizePt: 24 }] }] },
  ]};
  eq("★ T100 正控：满版底的封面（无 type 字段、有 54pt 大字）不报留白",
    checkDeckPatterns([coverNoType]).findings.filter(f => f.rule === "layout.whitespace").length, 0);

  // 反控 1：同样是两个元素、但**没有满版底** —— 那是一个做得差的内容页，必须报。
  // （这条正是 t65 原先那个 `thin` 用例的形态；它证明几何判据没有把稀疏内容页也放过。）
  eq("★ T100 反控：稀疏内容页（无满版底）仍报留白",
    checkDeckPatterns([thin]).findings.filter(f => f.rule === "layout.whitespace").length, 1);

  // 反控 2（T73 那 8 条的形态）：**有满版底**但字号是正文级的稀疏内容页 ——
  // 只靠「满版底 + 元素少」会把它误判成封面（T73 因此掉 8 条）。必须有 ≥40pt 大字才算封面。
  const sparseWithBackdrop: DeckPageSpec = { elements: [
    { type: "shape", shape: "rect", x: 0, y: 0, w: 1280, h: 720, fill: "#FFFFFF" }, // 满版底
    { type: "text", x: 80, y: 60, w: 1120, h: 90, paragraphs: [{ runs: [{ text: "稀疏内容页", sizePt: 32 }] }] },
    { type: "text", x: 80, y: 200, w: 1120, h: 290, paragraphs: [{ runs: [{ text: "短正文", sizePt: 20 }] }] },
  ]};
  eq("★ T100 反控：有满版底但只有正文级字号 → 仍是内容页，必须报留白",
    checkDeckPatterns([sparseWithBackdrop]).findings.filter(f => f.rule === "layout.whitespace").length, 1);
}


/* ── 【T100】打地鼠联动：缩卡前先说补内容 ── */
console.log("\n[T100] card-whitespace 的联动提示");
{
  // 三张高卡 + 贴顶文字：整页底边 89%（留白判据**不报**），但缩卡后会掉到 31%。
  const emptyColumns: DeckPageSpec = { elements: [
    ...[0, 1, 2].flatMap((i) => {
      const cx = 80 + i * 380;
      return [
        { type: "shape" as const, shape: "roundRect", x: cx, y: 160, w: 320, h: 480, fill: "#1F3A5F" },
        { type: "text" as const, x: cx + 20, y: 180, w: 280, h: 40, paragraphs: [{ runs: [{ text: "标题", sizePt: 24 }] }] },
      ];
    }),
  ]};
  const findings = checkDeckPatterns([emptyColumns]).findings.filter(f => f.rule === "layout.card-whitespace");
  check("★ T100：三张空卡各报一条", findings.length === 3, { n: findings.length });
  check("★ T100：缩卡前先提示「补内容」（不是只让缩卡）",
    findings.every(f => f.message.includes("先补内容再缩卡")), { msgs: findings.map(f => f.message.slice(0, 40)) });
  check("★ T100：提示给出了「缩完会掉到多少」的预测数字",
    findings.every(f => /掉到约\s*\d+%/.test(f.message)), { msgs: findings.map(f => f.message.match(/掉到约\s*\d+%/)?.[0]) });

  // 反控：整页本来就不空时，不该出现「先补内容」这句 —— 否则每个提示都在喊狼来了。
  const wellFilled: DeckPageSpec = { elements: [
    { type: "shape", shape: "roundRect", x: 80, y: 100, w: 500, h: 400, fill: "#1F3A5F" },
    { type: "text", x: 100, y: 120, w: 460, h: 40, paragraphs: [{ runs: [{ text: "标题", sizePt: 24 }] }] },
    { type: "shape", shape: "roundRect", x: 80, y: 540, w: 500, h: 150, fill: "#3E6E9E" }, // 撑住底边
  ]};
  const noLink = checkDeckPatterns([wellFilled]).findings.filter(f => f.rule === "layout.card-whitespace");
  check("★ T100 反控：页面本来就不空时不给「先补内容」提示",
    noLink.every(f => !f.message.includes("先补内容再缩卡")), { n: noLink.length });
}


/* ── 【T75】两种丑法必须各有正控 + 负控 ──
 *
 * T65 交付时只测了第一种（内容只占上半页）。A 在 T70 复核发现第二种「卡片内下半截空着」
 * 完全抓不到 —— 因为卡片本身撑住了整页底边。两页实测整页底边都是 0.872，一个数都分不开。
 */
console.log("\n[T75] 两种丑法各一对正控负控");
{
  // 卡片高 452。好版本：卡内文字填到 600；空柱版本：文字只到 366。
  const mk = (textH: number): DeckPageSpec => ({
    type: "content", layout: "three_column_cards",
    elements: [
      { type: "text", x: 80, y: 60, w: 1120, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 36 }] }] },
      { type: "shape", shape: "roundRect", x: 80, y: 176, w: 352, h: 452, fill: "#FFFFFF" },
      { type: "text", x: 112, y: 212, w: 288, h: 40, paragraphs: [{ runs: [{ text: "卡标题", sizePt: 22 }] }] },
      { type: "text", x: 112, y: 268, w: 288, h: textH, paragraphs: [{ runs: [{ text: "正文", sizePt: 14 }] }] },
      { type: "shape", shape: "roundRect", x: 464, y: 176, w: 352, h: 452, fill: "#FFFFFF" },
      { type: "shape", shape: "roundRect", x: 848, y: 176, w: 352, h: 452, fill: "#FFFFFF" },
    ],
  });
  const full = mk(332);   // 文字底 600，卡底 628 → 留白 28 / 452 = 0.062
  const empty = mk(98);   // 文字底 366，卡底 628 → 留白 262 / 452 = 0.580

  const cardOf = (p: DeckPageSpec) =>
    checkDeckPatterns([p]).findings.filter(f => f.rule === "layout.card-whitespace");

  // ── 第二种丑法：卡片内下半截空着 ──
  eq("★ 正控：卡片填满 → 卡底留白判据不报", cardOf(full).length, 0);
  check("★ 负控：卡片内下半截空着 → 报出来", cardOf(empty).length === 1, cardOf(empty));

  // ── 第一种丑法：内容只占上半页（整页级）──
  const topOnly: DeckPageSpec = {
    type: "content", layout: "three_column_cards",
    elements: [
      { type: "text", x: 80, y: 60, w: 1120, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 36 }] }] },
      { type: "shape", shape: "roundRect", x: 80, y: 180, w: 352, h: 250, fill: "#FFFFFF" },
    ],
  };
  const pageOf = (p: DeckPageSpec) =>
    checkDeckPatterns([p]).findings.filter(f => f.rule === "layout.whitespace");
  eq("★ 正控：铺满的页 → 整页判据不报", pageOf(full).length, 0);
  check("★ 负控：内容只占上半页 → 整页判据报", pageOf(topOnly).length === 1, pageOf(topOnly));

  // ── 关键：两条判据互不替代 ──
  // 空柱子页的整页底边 = 628/720 = 0.872，整页判据**不报**——它抓不到这种丑法。
  eq("★ 空柱子页的整页判据不报（证明它抓不到这种丑法）", pageOf(empty).length, 0);
  // 反过来：内容只占上半页的那页，没有卡片内文字，容器级判据也不该报
  eq("★ 只占上半页的页没有卡片内文字 → 容器级判据不报", cardOf(topOnly).length, 0);

  // ── 措辞：与新判据保持同一条纪律 ──
  const msg = cardOf(empty)[0]!.message;
  check("★ 卡底留白消息用「参考线」", msg.includes("参考线"), { msg });
  check("★ 卡底留白消息不含「期望」「必须」「要求」",
    !msg.includes("期望") && !msg.includes("必须") && !msg.includes("要求"), { msg });
  check("★ 卡底留白消息允许有意留白", msg.includes("可忽略"), { msg });
}


/* ── 【T83 复核】B 接手的三个行为变更必须各有断言 ──
 *
 * 这三条原来一条断言都没有：套件在 B 改前改后都是 40/40 全绿，
 * 说明它根本没在看这三个行为。逐条补上。
 */
console.log("\n[T83] 多卡各报 / x 坐标 / 跨页 page=null");
{
  // 两张卡都超线（58% 与 51%）
  const twoEmpty: DeckPageSpec = {
    type: "content", layout: "three_column_cards",
    elements: [
      { type: "text", x: 80, y: 60, w: 1120, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 36 }] }] },
      { type: "shape", shape: "roundRect", x: 80, y: 176, w: 352, h: 452, fill: "#FFFFFF" },
      { type: "text", x: 112, y: 212, w: 288, h: 40, paragraphs: [{ runs: [{ text: "A", sizePt: 22 }] }] },
      { type: "text", x: 112, y: 268, w: 288, h: 98, paragraphs: [{ runs: [{ text: "a", sizePt: 14 }] }] },
      { type: "shape", shape: "roundRect", x: 464, y: 176, w: 352, h: 452, fill: "#FFFFFF" },
      { type: "text", x: 496, y: 212, w: 288, h: 40, paragraphs: [{ runs: [{ text: "B", sizePt: 22 }] }] },
      { type: "text", x: 496, y: 268, w: 288, h: 130, paragraphs: [{ runs: [{ text: "b", sizePt: 14 }] }] },
    ],
  };
  const found = checkDeckPatterns([twoEmpty]).findings.filter(f => f.rule === "layout.card-whitespace");

  // ① 两张卡各报一条 —— 这条防的是【硬规矩 3】：不许静默吞掉第二张。
  eq("★ 两张卡都超线 → 各报一条（不吞第二张）", found.length, 2);

  // ② 每条都带 x 坐标，模型才知道改哪张
  const xs = found.map(f => /x=(\d+)/.exec(f.message)?.[1]).filter(Boolean);
  check("★ 每条消息都带 x 坐标", xs.length === found.length, { messages: found.map(f => f.message.slice(0, 40)) });
  check("★ 两条的 x 不同（分别指向两张卡）", new Set(xs).size === 2, { xs });

  // ③ 跨页判据的 page 必须是 null，不许谎报「第 1 页」
  const hdr = (): DeckPageSpec => ({
    type: "content", layout: "three_column_cards",
    elements: [
      { type: "text", x: 80, y: 60, w: 1120, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 36 }] }] },
      { type: "shape", shape: "roundRect", x: 80, y: 176, w: 352, h: 420, fill: "#FFFFFF" },
      { type: "shape", shape: "rect", x: 0, y: 0, w: 1280, h: 48, fill: "#1A1D21" },
    ],
  });
  const hb = checkDeckPatterns([hdr(), hdr(), hdr()]).findings.filter(f => f.rule === "header.bar");
  check("★ 全篇页眉条的 page 是 null（不是谎报第 1 页）", hb.length > 0 && hb.every(f => f.page === null), { pages: hb.map(f => f.page) });

  const rep = [hdr(), { ...hdr(), elements: [...hdr().elements!] }, { ...hdr(), elements: [...hdr().elements!] }];
  const rp = checkDeckPatterns(rep).findings.filter(f => f.rule === "layout.repeated");
  check("★ 构图雷同的 page 也是 null", rp.length === 0 || rp.every(f => f.page === null), { pages: rp.map(f => f.page) });

  // ④ 单页判据的 page 仍是数字（别为了跨页把这些也改成 null）
  const one: DeckPageSpec = { type: "content", layout: "x", elements: [
    { type: "text", x: 80, y: 60, w: 1120, h: 60, paragraphs: [{ runs: [{ text: "标题", sizePt: 36 }] }] },
  ]};
  const oneF = checkDeckPatterns([one]).findings.filter(f => f.rule === "layout.whitespace");
  check("★ 单页判据的 page 仍是数字（0）", oneF.length > 0 && oneF.every(f => f.page === 0), { pages: oneF.map(f => f.page) });
}


/* ── 【T100b】卡片自带的标签文字（`shape.paragraphs`） ──
 *
 * 从前判据只扫**独立的 `text` 元素**。但 `genoffice guide slides spec` 说 shape 的
 * `paragraphs` 是 optional label text —— 模型把文字写进卡片里是更自然的写法，而
 * 那样的空卡片**永远不进入判据视野**（上游 `slides audit` 也看不到）。
 *
 * ⚠️ **只有 `valign: "top"` 才该参与**：居中标签的 ratio 恒 ≈ 0.47（与卡高无关），
 * 而「居中标签下面有一半空白」是设计本来如此。 */
console.log("\n[T100b] 卡片自带的标签文字");
{
  const cardWithLabel = (valign?: "top" | "middle" | "bottom"): DeckPageSpec => ({
    elements: [
      { type: "shape", shape: "roundRect", x: 80, y: 160, w: 320, h: 480, fill: "#1F3A5F",
        ...(valign ? { valign } : {}),
        paragraphs: [{ align: "center", runs: [{ text: "标签", sizePt: 24 }] }] },
    ],
  });

  eq("★ T100b 负控：卡片内贴顶标签 + 高卡 → 报（改前完全看不到）",
    checkDeckPatterns([cardWithLabel("top")]).findings.filter(f => f.rule === "layout.card-whitespace").length, 1);

  eq("★ T100b 正控：卡片内**居中**标签（默认 valign）→ 不报（居中不算空）",
    checkDeckPatterns([cardWithLabel(undefined)]).findings.filter(f => f.rule === "layout.card-whitespace").length, 0);

  eq("★ T100b 正控：显式 middle → 不报",
    checkDeckPatterns([cardWithLabel("middle")]).findings.filter(f => f.rule === "layout.card-whitespace").length, 0);

  eq("★ T100b 正控：贴底 → 不报（内容在底部，下沿不空）",
    checkDeckPatterns([cardWithLabel("bottom")]).findings.filter(f => f.rule === "layout.card-whitespace").length, 0);

  // 独立 text 元素仍然优先：卡片里有独立 text 时，即使也有 paragraphs，以独立 text 为准。
  const both: DeckPageSpec = { elements: [
    { type: "shape", shape: "roundRect", x: 80, y: 160, w: 320, h: 480, fill: "#1F3A5F",
      valign: "top", paragraphs: [{ runs: [{ text: "标签", sizePt: 24 }] }] },
    { type: "text", x: 100, y: 600, w: 280, h: 30, paragraphs: [{ runs: [{ text: "底部说明", sizePt: 18 }] }] },
  ]};
  eq("★ T100b：有独立 text 时以它为准（不算空）",
    checkDeckPatterns([both]).findings.filter(f => f.rule === "layout.card-whitespace").length, 0);
}


console.log(`\nt65-deck-pattern-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
