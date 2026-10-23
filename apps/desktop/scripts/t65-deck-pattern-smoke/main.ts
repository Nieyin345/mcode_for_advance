/**
 * 【T65】deck 反模式检查器 —— **每条判据都配正控 + 负控**。
 *
 * 正控：合规 spec → 该判据**不报**。
 * 负控：故意违反 → 该判据**必须报**。
 *
 * 没有负控的判据等于没验（T24 的 59/59 就是这么绿着漏掉缺陷的）。
 */
import { checkDeckPatterns, NOT_IMPLEMENTED, type DeckPageSpec } from "@main/document/deckPatternCheck.js";

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

console.log("\nT65 · deck 反模式检查器");

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
}


console.log(`\nt65-deck-pattern-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
