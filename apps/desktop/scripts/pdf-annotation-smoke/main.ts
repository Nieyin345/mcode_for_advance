/**
 * PDF 高亮的回归网 —— **坐标换算** + **pdf.js 批注形状** + **落盘**。
 *
 * ## 为什么这一套必须存在
 *
 * 这一层的错误有个很坏的性质：**它不报错**。批注照样写进文件、照样能在 Acrobat
 * 批注面板里列出来，只是**位置跑到别处**。用户在 Acrobat 里打开才发现，那时已经
 * 过了好几道手续，"哪里算错的"根本无从查起。
 *
 * 所以判据要立在**具体的数字**上，不是"跑通了"：
 *
 *  - 归一化 (0,0)-(1,1) 必须映射到整页四角，**左上角**在 PDF 坐标里 y = 页面高
 *  - 翻 y 只能翻一次（`usePdfCoordinates` 那一档翻两次 = 批注跑到页外）
 *  - `QuadPoints` 的点序必须是 (左上)(右上)(左下)(右下) —— 顺序错了高亮会歪
 *  - `outlines` 必须是**扁平数字数组**（pdf.js 拿 `outline[0]` 去 `toFixed`，
 *    给它对象就是那个看不出原因的 UnknownErrorException）
 *  - 写回：别人的高亮一个不少、跳过的要报出来、不留临时文件
 *
 * 跑：scripts/pdf-annotation-smoke/run.sh
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import type { PdfHighlight } from "@contracts/library";

const TMP = mkdtempSync(join(tmpdir(), "mcode-annot-"));
let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function near(name: string, actual: number, expected: number, eps = 0.001): void {
  check(name, Math.abs(actual - expected) < eps, { actual, expected });
}

const {
  toPdfQuad,
  toPdfQuads,
  toQuadPoints,
  quadToQuadPoints,
  unionRect,
  validatePdfHighlight: validateHighlight,
  groupByPage,
  hexToPdfRgb,
  toPdfjsAnnotation: toEditorAnnotation,
  PDFJS_EDITOR_KEY_PREFIX: EDITOR_KEY_PREFIX,
} = await import("@contracts/pdfHighlight");
const {
  readHighlights,
  writeHighlights,
  highlightsPathFor,
  writeBackToFile,
} = await import("@main/library/pdfHighlightsStore.js");

/** 把高亮塞进 pdf.js 的 annotationStorage —— 用的是**共用的**组装函数。 */
function seedAnnotationStorage(
  storage: { setValue: (k: string, v: unknown) => void },
  highlights: Array<import("@contracts/library").PdfHighlight>,
  sizeOf: (page1Based: number) => { width: number; height: number } | null,
): number {
  let n = 0;
  for (const h of highlights) {
    const page = sizeOf(h.position.boundingRect.pageNumber);
    if (!page) continue;
    storage.setValue(`${EDITOR_KEY_PREFIX}${h.id}`, toEditorAnnotation(h, page));
    n += 1;
  }
  return n;
}

const PAGE = { width: 612, height: 792 };

/** 造一条高亮。`page` 是 1 基。 */
function mkHl(over: Partial<PdfHighlight> = {}): PdfHighlight {
  const r = { x1: 0.1, y1: 0.09, x2: 0.6, y2: 0.11, width: 0.5, height: 0.02, pageNumber: 1 };
  return {
    id: "h1",
    position: { boundingRect: { ...r }, rects: [{ ...r }] },
    text: "A Sample Paper",
    comment: "第一条批注",
    color: "#ffe28f",
    createdAt: 1,
    ...over,
  } as PdfHighlight;
}

/* ════════════ 1. 归一化 → 点值，方向不能反 ════════════ */

console.log("\n1. 归一化 → PDF 坐标（左上原点 → 左下原点）");

{
  const q = toPdfQuad({ x1: 0, y1: 0, x2: 1, y2: 1, width: 1, height: 1, pageNumber: 1 }, PAGE);
  eq("整页左边界", q.x1, 0);
  eq("整页右边界", q.x2, 612);
  eq("★ 整页顶边 y = 页面高（y 轴翻过来了）", q.y2, 792);
  eq("整页底边 y", q.y1, 0);
}

{
  // 页面**顶部**那条带（网页意义的上）：y 从 0 到 0.1。
  // 在 PDF 里应该落在 y = 712.8 ~ 792 —— **接近页面高**，不是接近 0。
  // 这一条是"翻反了"的探针：翻反了会得到 0~79.2，两个数字差一个数量级。
  const q = toPdfQuad(
    { x1: 0.1, y1: 0, x2: 0.5, y2: 0.1, width: 0.4, height: 0.1, pageNumber: 1 },
    PAGE,
  );
  near("★ 顶部的带落在 PDF 的高 y 处（不是低 y）", q.y2, 792);
  near("★ 底边也高", q.y1, 712.8);
  near("x 起点", q.x1, 61.2);
  near("x 终点", q.x2, 306);
}

{
  // 乱序输入（从上往下划 / 从下往上划）结果必须一样
  const a = toPdfQuad({ x1: 0.2, y1: 0.8, x2: 0.6, y2: 0.9, width: 0.4, height: 0.1, pageNumber: 1 }, PAGE);
  const b = toPdfQuad({ x1: 0.6, y1: 0.9, x2: 0.2, y2: 0.8, width: 0.4, height: 0.1, pageNumber: 1 }, PAGE);
  eq("★ 反过来划，结果一样", JSON.stringify(a), JSON.stringify(b));
}

{
  // usePdfCoordinates：**绝对不能翻 y、也不能乘尺寸**
  const q = toPdfQuad(
    { x1: 100, y1: 200, x2: 300, y2: 220, width: 200, height: 20, pageNumber: 1 },
    PAGE,
    { pdfCoordinates: true },
  );
  eq("★ PDF 坐标那一档不乘页面宽", q.x1, 100);
  eq("★ PDF 坐标那一档不翻 y（原样 220 在上）", q.y2, 220);
  eq("PDF 坐标那一档底边原样", q.y1, 200);
}

/* ════════════ 2. QuadPoints 的点序 ════════════ */

console.log("\n2. QuadPoints 的点序");

{
  const q = toPdfQuad({ x1: 0.1, y1: 0.1, x2: 0.6, y2: 0.2, width: 0.5, height: 0.1, pageNumber: 1 }, PAGE);
  const p = quadToQuadPoints(q);
  eq("一共 8 个数", p.length, 8);
  // 规范顺序：(左上) (右上) (左下) (右下)
  eq("★ 第 1 点是左上 x", p[0], q.x1);
  eq("★ 第 1 点是左上 y", p[1], q.y2);
  eq("★ 第 2 点是右上 x", p[2], q.x2);
  eq("★ 第 2 点是右上 y", p[3], q.y2);
  eq("★ 第 3 点是左下 x", p[4], q.x1);
  eq("★ 第 3 点是左下 y", p[5], q.y1);
  eq("★ 第 4 点是右下 x", p[6], q.x2);
  eq("★ 第 4 点是右下 y", p[7], q.y1);
}

/* ════════════ 3. 跨行：一条高亮多个四边形 ════════════ */

console.log("\n3. 跨行选区");

{
  const r1 = { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.12, width: 0.8, height: 0.02, pageNumber: 1 };
  const r2 = { x1: 0.1, y1: 0.13, x2: 0.4, y2: 0.15, width: 0.3, height: 0.02, pageNumber: 1 };
  const h = mkHl({ position: { boundingRect: { ...r1 }, rects: [r1, r2] } });
  const quads = toPdfQuads(h, PAGE);
  eq("两行 → 两个四边形", quads.length, 2);
  eq("★ 摊平成 QuadPoints 是 16 个数（不是拆成两个批注）", toQuadPoints(quads).length, 16);

  const u = unionRect(quads);
  near("外接矩形左边界", u[0], 61.2);
  near("★ 外接矩形右边界取最宽那行", u[2], 550.8);
  check("★ 高度是两行合起来（不是一行的）", u[3] - u[1] > 20, u);
}

/* ════════════ 4. pdf.js 的批注形状 ════════════ */

console.log("\n4. pdf.js 的批注形状（这三个字段错了会炸得莫名其妙）");

{
  const ann = toEditorAnnotation(mkHl(), PAGE);
  eq("annotationType 是 HIGHLIGHT(9)", ann.annotationType, 9);
  eq("★ pageIndex 是 0 基（库里是 1 基）", ann.pageIndex, 0);

  // ★ color 必须是 0~255 —— pdf.js 内部自己 /255。给 0~1 会得到全黑。
  check(
    "★ color 是 0~255 的整数（不是 0~1）",
    ann.color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255),
    ann.color,
  );

  // ★ outlines 必须是扁平数字数组 —— pdf.js 拿 outline[0] 去 numberToString，
  //   给对象就是 "Cannot read properties of undefined (reading 'toFixed')"。
  check("★ outlines 是数组的数组", Array.isArray(ann.outlines) && Array.isArray(ann.outlines[0]), ann.outlines);
  // ⚠️ 这里**不能写成 `ann.outlines.every(o => o.every(...))`** —— 形状一旦退回
  //    对象数组，内层 `o.every` 本身就是 undefined，断言会**抛异常把整个套件打断**
  //    （变异验证时正是这样：报的是 `TypeError: o.every is not a function`，
  //    而不是一条 FAIL）。测试要能**报红**，不该自己崩。
  const allNumbers = Array.isArray(ann.outlines)
    ? ann.outlines.every((o) => Array.isArray(o) && o.every((n) => typeof n === "number" && Number.isFinite(n)))
    : false;
  check("★ outlines 的每个数是 number（不是 {x,y,...} 对象）", allNumbers, ann.outlines);
  check("★ 一个矩形路径是 8 个数", Array.isArray(ann.outlines[0]) && ann.outlines[0].length === 8, ann.outlines[0]);

  eq("quadPoints 8 个数", ann.quadPoints.length, 8);
  eq("rect 是 4 个数", ann.rect.length, 4);
  check("rotation 是 0", ann.rotation === 0);
  check("opacity 在 0~1 之间", ann.opacity > 0 && ann.opacity <= 1, ann.opacity);
}

{
  // 跨行 → outlines 里两条路径，且都在同一个批注里
  const r1 = { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.12, width: 0.8, height: 0.02, pageNumber: 1 };
  const r2 = { x1: 0.1, y1: 0.13, x2: 0.4, y2: 0.15, width: 0.3, height: 0.02, pageNumber: 1 };
  const ann = toEditorAnnotation(mkHl({ position: { boundingRect: { ...r1 }, rects: [r1, r2] } }), PAGE);
  eq("★ 跨行 = 两条路径，一个批注", ann.outlines.length, 2);
  eq("QuadPoints 也变成 16 个数", ann.quadPoints.length, 16);
}

/* ════════════ 5. 坏数据显式报错 ════════════ */

console.log("\n5. 坏数据：逐条说清是哪一种");

{
  eq("好数据 → 没问题", validateHighlight(mkHl()), null);
  const badPage = mkHl();
  badPage.position.boundingRect.pageNumber = 0;
  check("页号 0 → 报出来", (validateHighlight(badPage) ?? "").includes("页码"), validateHighlight(badPage));
  const badNum = mkHl();
  badNum.position.boundingRect.x1 = NaN;
  check("坐标是 NaN → 报出来", (validateHighlight(badNum) ?? "").includes("非数字"), validateHighlight(badNum));
  const noRects = mkHl();
  noRects.position.rects = [];
  check("rects 是空数组 → 报出来", (validateHighlight(noRects) ?? "").includes("空选区"), validateHighlight(noRects));
  const noId = mkHl({ id: "" });
  check("缺 id → 报出来", (validateHighlight(noId) ?? "").includes("id"), validateHighlight(noId));
  const badRect = mkHl();
  badRect.position.rects = [{ x1: 0, y1: 0, x2: NaN, y2: 1, width: 1, height: 1, pageNumber: 1 }];
  check("rects 里有 NaN → 报出来", (validateHighlight(badRect) ?? "").includes("rects"), validateHighlight(badRect));
}

/* ════════════ 6. 分组与颜色 ════════════ */

console.log("\n6. 分组与颜色");

{
  const a = mkHl({ id: "a" });
  const b = mkHl({ id: "b" });
  b.position.boundingRect.pageNumber = 3;
  b.position.rects[0]!.pageNumber = 3;
  const g = groupByPage([a, b, mkHl({ id: "c" })]);
  eq("第 1 页两条", g.get(1)?.length, 2);
  eq("第 3 页一条", g.get(3)?.length, 1);
  eq("组数", g.size, 2);
}

{
  eq("#ff0000 → [1,0,0]", JSON.stringify(hexToPdfRgb("#ff0000")), "[1,0,0]");
  eq("不带 # 也认", JSON.stringify(hexToPdfRgb("00ff00")), "[0,1,0]");
  const d = hexToPdfRgb("不是颜色");
  check("★ 坏颜色退回黄（不是黑 —— 黑看起来像把字涂掉了）", d[0] === 1 && d[1] > 0.8 && d[2] < 0.7, d);
  check("undefined 也退回黄", hexToPdfRgb(undefined)[0] === 1, hexToPdfRgb(undefined));
}

/* ════════════ 7. 落盘：索引文件 ════════════ */

console.log("\n7. 索引文件（跟着 PDF 走的那份）");

const pdfPath = join(TMP, "paper.pdf");
writeFileSync(pdfPath, "%PDF-1.7 fake");

{
  eq("没划过 → 空数组（不是报错）", readHighlights(pdfPath).length, 0);

  writeHighlights(pdfPath, [mkHl()]);
  const back = readHighlights(pdfPath);
  eq("★ 写了一条，读回来一条", back.length, 1);
  eq("正文还在", back[0]?.comment, "第一条批注");

  const sc = highlightsPathFor(pdfPath);
  check("★ 索引文件就在 PDF 旁边（点开头、带原名）", existsSync(sc) && sc.includes("paper.pdf"));
  check("索引文件在同一个目录里", sc.startsWith(TMP), sc);
}

{
  // 坏数据在读进来那一刻就被滤掉 —— 别让它流到写回那层去算 NaN 坐标
  const bad = mkHl({ id: "bad" });
  bad.position.boundingRect.pageNumber = -5;
  writeHighlights(pdfPath, [mkHl(), bad]);
  const back = readHighlights(pdfPath);
  eq("★ 坏的那条读回来时被滤掉", back.length, 1);
  eq("好的那条还在", back[0]?.id, "h1");
}

{
  // 索引文件坏了 → 当空处理，**但不覆盖它**
  const sc = highlightsPathFor(pdfPath);
  writeFileSync(sc, "{ 这不是 json");
  eq("★ 坏索引 → 当空处理（不抛）", readHighlights(pdfPath).length, 0);
  check("★ 坏索引不被覆盖（用户还能捞内容）", readFileSync(sc, "utf8") === "{ 这不是 json");
  writeHighlights(pdfPath, [mkHl()]); // 恢复
}

/* ════════════ 8. 塞进 pdf.js 的 storage ════════════ */

console.log("\n8. 塞进 pdf.js 的 annotationStorage");

{
  const stored = new Map<string, unknown>();
  const n = seedAnnotationStorage({ setValue: (k, v) => stored.set(k, v) }, [mkHl(), mkHl({ id: "h2" })], () => PAGE);
  eq("塞进去两条", n, 2);
  const keys = [...stored.keys()];
  // ★ 这个前缀是 pdf.js 的硬要求：worker 里 `if (!key.startsWith(PREFIX)) continue;`
  //   少了它**静默跳过**，saveDocument() 出来还是原文件。
  check("★ key 带 pdfjs_internal_editor_ 前缀", keys.every((k) => k.startsWith(EDITOR_KEY_PREFIX)), keys);
  eq("前缀值就是 pdf.js 那个常量", EDITOR_KEY_PREFIX, "pdfjs_internal_editor_");
  check("★ 每条 key 用高亮自己的 id（可去重、可覆盖）", keys.includes(`${EDITOR_KEY_PREFIX}h1`), keys);
}

{
  // 页号越界 → 跳过，不抛（一条坏数据不该让整次保存失败）
  const stored = new Map<string, unknown>();
  const h = mkHl();
  h.position.boundingRect.pageNumber = 99;
  const n = seedAnnotationStorage({ setValue: (k, v) => stored.set(k, v) }, [h], (p) => (p > 1 ? null : PAGE));
  eq("★ 页号越界的那条被跳过", n, 0);
  eq("storage 里没塞进坏的", stored.size, 0);
}

/* ════════════ 9. 写回文件（真字节 + 原子性） ════════════ */

console.log("\n9. 写回文件");

const target = join(TMP, "writeback.pdf");
writeFileSync(target, "%PDF-1.7 原始内容");

{
  let sawHighlights: PdfHighlight[] = [];
  const r = await writeBackToFile(target, [mkHl()], async (hs) => {
    sawHighlights = hs;
    return new TextEncoder().encode("%PDF-1.7 写回之后的内容");
  });
  eq("写回 1 条", r.written, 1);
  eq("没有跳过的", r.skipped.length, 0);
  eq("交给 save 的就是那条", sawHighlights.length, 1);
  check("★ 文件内容真的被替换了", readFileSync(target, "utf8").includes("写回之后"), readFileSync(target, "utf8"));
  check("报告里有字节数", (r.bytes ?? 0) > 0, r.bytes);
}

{
  // 坏数据：好的照写，坏的报出来
  // ⚠️ 变异验证提醒过：**别让断言裸抛**。实现改成"遇到坏数据直接 throw"时，
  //    这里会抛异常把后面所有断言全打断（报的是 TypeError 而不是一条 FAIL），
  //    套件看起来"崩了"而不是"红了" —— 测试要能报红，不该自己崩。
  const bad = mkHl({ id: "bad" });
  bad.position.rects = [];
  let r: { written: number; skipped: Array<{ id: string; reason: string }> } | null = null;
  let threw: string | null = null;
  try {
    r = await writeBackToFile(target, [mkHl({ id: "ok" }), bad], async () =>
      new TextEncoder().encode("%PDF-1.7 x"),
    );
  } catch (e) {
    threw = (e as Error).message;
  }
  check("★ 坏数据不抛出（要报进 skipped）", threw === null, threw);
  eq("★ 好的照样写", r?.written, 1);
  eq("★ 坏的被报出来", r?.skipped.length, 1);
  eq("说得出是哪条", r?.skipped[0]?.id, "bad");
}

{
  // save 抛了 → 原文件一个字节都不能动
  const before = readFileSync(target, "utf8");
  let threw = false;
  try {
    await writeBackToFile(target, [mkHl()], async () => {
      throw new Error("模拟保存失败");
    });
  } catch {
    threw = true;
  }
  check("★ save 失败时抛出", threw);
  eq("★ 原文件一个字节没动", readFileSync(target, "utf8"), before);
}

{
  /**
   * 原子写回的顺序与清理。
   *
   * ## ⚠️ 这一条**没有**验到最关键的部分，如实记在这里
   *
   * 变异验证时把实现改成"直接 `writeFileSync` 到原路径"（不写临时文件、不 rename），
   * **套件仍然 90/90 全绿** —— 所以下面这几条断言**不足以证明原子性**。
   *
   * 真正要保的是这件事：**写到一半崩了（磁盘满 / 进程被杀），原文件不能被毁**。
   * 那个崩**没法在本进程里可靠模拟**（要注入 ENOSPC 或真去杀进程），所以没验。
   *
   * 能验的只有"顺序"和"清理"两件次要的事，就在这里验掉。**别把这一段
   * 读成"原子性已验证"。**
   */
  writeFileSync(target, "%PDF-1.7 原子性测试的原内容");

  let targetDuringSave = "";
  let saveCalled = false;
  const r = await writeBackToFile(target, [mkHl()], async () => {
    saveCalled = true;
    // save 跑的时候，原文件应该**还是旧内容** —— 说明是先算完再落盘
    targetDuringSave = readFileSync(target, "utf8");
    return new TextEncoder().encode("%PDF-1.7 新的");
  });

  eq("原子写回成功", r.written, 1);
  check("★ save 在写盘前被调用（先算完再落盘）", saveCalled);
  check("★ save 执行时原文件还是旧内容", targetDuringSave.includes("原内容"), targetDuringSave);
  check("★ 落盘之后内容换成新的", readFileSync(target, "utf8").includes("新的"));
}

{
  // 临时文件不能留下来
  const files = (await import("node:fs")).readdirSync(TMP);
  eq("★ 目录里没留下临时文件", files.filter((f) => f.includes(".tmp")).length, 0);
}

/* ════════════ 10. 端到端：我算的形状，pdf.js 认不认 ════════════ */

/**
 * ## 为什么这一段不能省
 *
 * 前面 9 段都在验**我自己这层**（换算对不对、字段类型对不对），
 * 而 pdf.js 的 `saveDocument()` 是另一层。两半各自绿着、**接起来是坏的**，
 * 是完全可能的 —— 而且那正是这一个功能真正交付的东西。
 *
 * 所以这里让真 pdf.js 加载真 PDF、吃我算出来的形状、走 `saveDocument()`，
 * 再验证**产出的字节里真的有一条 `/Subtype /Highlight` 批注**。
 */
console.log("\n10. 端到端：toEditorAnnotation → pdf.js saveDocument()");

/**
 * ⚠️ **整段包 try/catch。** 形状给错时 pdf.js 会从 `saveDocument()` 抛出来
 * （比如 `pageIndex` 不是 0 基 → `Page index 1 not found.`，包成
 * `UnknownErrorException`）。不接住的话套件**当场崩掉**，后面的断言一条都不跑，
 * 而且报出来是 Node 的栈、不是一条 FAIL —— 变异验证时这个区分很重要：
 * "崩了"和"红了"是两回事。
 */
try {
  const { pathToFileURL } = await import("node:url");
  const desk = join(process.cwd());
  // ⚠️ Windows 上动态 import 绝对路径必须转成 file:// URL —— 直接给 `D:\...`
  //    会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（协议被当成 `d:`）。
  const pdfjs = await import(
    pathToFileURL(join(desk, "node_modules/pdfjs-dist/build/pdf.mjs")).href
  );

  const src = new Uint8Array(readFileSync(join(desk, "scripts/fixtures/sample-paper.pdf")));
  const doc = await pdfjs.getDocument({ data: src.slice() }).promise;
  eq("载入真 PDF", doc.numPages, 1);

  const page1 = await doc.getPage(1);
  const vp = page1.getViewport({ scale: 1 });
  const realPage = { width: vp.width, height: vp.height };
  console.log(`  真页面尺寸 ${realPage.width} × ${realPage.height}`);

  // 把高亮塞进 storage —— 走的就是应用里那条路（seedAnnotationStorage）
  const n = seedAnnotationStorage(
    doc.annotationStorage,
    [mkHl(), mkHl({ id: "h2", comment: "第二条" })],
    () => realPage,
  );
  eq("塞进去 2 条", n, 2);

  const out = await doc.saveDocument();
  check("★ saveDocument 产出字节", out?.length > 0, out?.length);
  writeFileSync(join(TMP, "e2e.pdf"), out);

  // 解压对象流再找 —— pdf.js 也把新对象写进压缩的对象流
  const raw = Buffer.from(out).toString("latin1");
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const s = raw.indexOf("stream", i);
    if (s === -1) break;
    let a = s + 6;
    if (raw[a] === "\r") a++;
    if (raw[a] === "\n") a++;
    const e = raw.indexOf("endstream", a);
    if (e === -1) break;
    try {
      parts.push(zlib.inflateSync(Buffer.from(raw.slice(a, e), "latin1")).toString("latin1"));
    } catch {
      /* 非 zlib 流 */
    }
    i = e + 9;
  }
  const flat = raw + "\n" + parts.join("\n");

  check("★ 产出里有 /Annots", /\/Annots/.test(flat));
  check("★ 产出里有 /Subtype /Highlight（真批注，不是烧进内容流的）", /\/Subtype\s*\/Highlight/.test(flat));
  check("产出还是有效 PDF", raw.startsWith("%PDF-"));
  check("产出有 %%EOF", raw.includes("%%EOF"));
  check("★ 产出比原文件大（真加了东西）", out.length > src.length, { src: src.length, out: out.length });

  await doc.destroy();
} catch (err) {
  check("★ 端到端跑通（形状给错时 pdf.js 会抛）", false, (err as Error).message);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\npdf-annotation-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
