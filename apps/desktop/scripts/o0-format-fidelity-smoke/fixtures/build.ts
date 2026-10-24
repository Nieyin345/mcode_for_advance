/**
 * O0 —— 六格式**复杂样本**的生成本（跑在探针主进程里）。
 *
 * ## 与 t7 的 fixtures.ts 是什么关系
 *
 * `t7-genoffice-u1/fixtures.ts` 造的是「文件里带一条唯一文本」的**最小**样本，
 * 它回答「打开-改-存-重开，改动还在吗」。本模块造的是**复杂部件**样本，回答
 * 另一个问题：**只改了与复杂部件无关的一句话，这些部件还在吗、语义还对吗**。
 * 两份夹具互不覆盖；t7 的六条旅程一个字都没动（本卡不变量）。
 *
 * ## 每个格式的复杂部件（卡 §2.1 的逐条映射）
 *
 *  - DOCX：嵌套表格 / 编号列表 / 页眉页脚 / 脚注 / 东亚字体（中文）
 *  - XLSX：公式（跨 sheet 引用）/ 条件格式 / 合并单元格 / 图表
 *  - PPTX：多页 / 母版占位符 / 动画 / 备注 / 图片
 *  - PDF：文本层 / 书签（outline）/ 批注（sticky note）
 *  - Markdown：表格 / 代码块 / 图片引用 / 嵌套列表
 *  - HTML：样式表（`<style>`）/ 内联 SVG / 脚本标签（`<script>`）
 *
 * ## 每个部件都带一个**唯一标记**
 *
 * 例如 `O0-NEST-INNER-X`、`O0-XL-CF-TOKEN`。指纹比对（`fidelity/`）与变异脚本
 * 都按这些标记定位，不靠「第 3 个元素」这种位置说法 —— 位置会随编辑漂移。
 *
 * ## 用谁造
 *
 * 优先**原厂能力**（t7 fixtures 的同一做法）：DOCX 用 vendor `buildBlankDocx()`
 * 作底再注入部件；XLSX 用 `genoffice sheet apply`（真写出路径）；PPTX 用
 * `pptxEngine` 的公开 API（createBlankPptx/addElement/addPicture/setSlideNotes/
 * setSlideAnimations）；PDF 用 pdf-lib（vendor `save-pdf.ts` 自己就依赖它）。
 * Markdown / HTML 是纯文本，直接写。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const O0 = {
  docx: {
    body: "O0-DOCX-TOKEN body paragraph with plain text.",
    cjk: "O0-DOCX-CJK 中文段落 eastAsia",
    listOne: "O0-LIST-ORDERED-ONE",
    listTwo: "O0-LIST-ORDERED-TWO",
    nestOuterA1: "O0-NEST-OUTER-A1",
    nestOuterB1: "O0-NEST-OUTER-B1",
    nestOuterA2: "O0-NEST-OUTER-A2",
    nestOuterB2: "O0-NEST-OUTER-B2",
    nestInnerX: "O0-NEST-INNER-X",
    nestInnerY: "O0-NEST-INNER-Y",
    noteBody: "O0-NOTE-BODY carries a footnote",
    footnote: "O0-FOOTNOTE-TEXT notes here",
    header: "O0-HEADER-TEXT running head",
    footer: "O0-FOOTER-TEXT footer line",
  },
  xlsx: {
    data: [
      ["O0-XL-ITEM", "O0-XL-QTY", "O0-XL-PRICE", "O0-XL-TOTAL"],
      ["O0-XL-ALPHA", 2, 10.5, "=B2*C2"],
      ["O0-XL-BETA", 3, 4.25, "=B3*C3"],
      ["O0-XL-GAMMA", 4, 2, "=B4*C4"],
    ],
    crossSheetFormula: "=SUM(Data!D2:D4)",
    mergeBanner: "O0-XL-MERGE-BANNER",
    chartTitle: "O0-XL-CHART Totals",
    sheetData: "Data",
    sheetSummary: "Summary",
  },
  pptx: {
    title: "O0-PPTX-TITLE cover slide",
    body: "O0-PPTX-BODY second slide text",
    third: "O0-PPTX-THIRD third slide",
    notes: "O0-PPTX-NOTES speaker note on slide one",
    imageAlt: "O0-PPTX-IMAGE-ALT",
  },
  pdf: {
    page1: "O0-PDF-TEXT-ALPHA line one",
    page2: "O0-PDF-TEXT-BETA line two",
    bookmark: "O0-BOOKMARK-ALPHA",
    note: "O0-NOTE-ALPHA sticky",
  },
  markdown: {
    heading: "# O0 Markdown Fixture",
    tableHeader: "| O0-MD-C1 | O0-MD-C2 |",
    tableRow: "| O0-MD-R1A | O0-MD-R1B |",
    code: '```js\nconsole.log("O0-MD-CODE");\n```',
    image: "![O0-MD-IMG](./o0-asset.png)",
    listOuter: "- O0-MD-OUTER",
    listInner: "  - O0-MD-INNER",
    tail: "O0-MD-TAIL closing paragraph.",
  },
  html: {
    title: "O0 HTML Fixture",
    token: "O0-HTML-TOKEN visible paragraph",
    styleMarker: "O0-HTML-STYLE",
    svgMarker: "O0-HTML-SVG",
    scriptMarker: "O0-HTML-SCRIPT",
    tail: "O0-HTML-TAIL closing paragraph.",
  },
} as const;

export interface O0FixturePaths {
  docx: string;
  xlsx: string;
  pptx: string;
  pdf: string;
  markdown: string;
  html: string;
}

/**
 * 造六份夹具。**幂等**（与非 O0 的 t7 夹具同一个理由：relaunch 之后不能把
 * 上一代样本重置回初始内容，否则「重开后复杂部件还在」会变成对原始文件的
 * 断言，而不是对「保存后文件」的断言）。已经存在就复用。
 */
export async function ensureO0Fixtures(projectDir: string, repoRoot: string): Promise<O0FixturePaths> {
  const paths: O0FixturePaths = {
    docx: join(projectDir, "o0-fidelity.docx"),
    xlsx: join(projectDir, "o0-fidelity.xlsx"),
    pptx: join(projectDir, "o0-fidelity.pptx"),
    pdf: join(projectDir, "o0-fidelity.pdf"),
    markdown: join(projectDir, "o0-fidelity.md"),
    html: join(projectDir, "o0-fidelity.html"),
  };
  mkdirSync(projectDir, { recursive: true });
  const nonEmpty = (p: string): boolean => existsSync(p) && readFileSync(p).length > 0;

  if (!nonEmpty(paths.docx)) await buildDocxFixture(paths.docx, repoRoot);
  if (!nonEmpty(paths.xlsx)) buildXlsxFixture(paths.xlsx, repoRoot, projectDir);
  if (!nonEmpty(paths.pptx)) await buildPptxFixture(paths.pptx);
  if (!nonEmpty(paths.pdf)) await buildPdfFixture(paths.pdf);
  if (!nonEmpty(paths.markdown)) buildMarkdownFixture(paths.markdown);
  if (!nonEmpty(paths.html)) buildHtmlFixture(paths.html);
  return paths;
}

/* ───────────────────────────────── DOCX ───────────────────────────────── */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function wP(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/**
 * DOCX 样本：vendor `buildBlankDocx()` 作底（真 styles.xml / numbering.xml，
 * 编辑器只引用已存在的 style 就能重建），再把**复杂部件**注入 `word/document.xml`：
 * 嵌套表格、编号列表、页眉/页脚引用、脚注引用、东亚字体 run。
 *
 * 为什么不用 `docs apply` 造：原厂的 table ops 明确不做嵌套表（`TableModel.
 * nestedTables` 是「显示只读、字节由外层表保留」），`insert_footnote` 只能
 * 往已有段落上挂、不能做「这个段落别动」的初始样本。所以这里按 OOXML 直接写，
 * 再让**原厂解析器**读回来作证（build 完立即自检，见 `assertDocxParses`）。
 */
async function buildDocxFixture(out: string, repoRoot: string): Promise<void> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const docxEngine = require("genoffice:docx-engine") as {
    buildBlankDocx(options?: { paperSize?: "A4" | "Letter"; eastAsiaFont?: string }): Promise<Uint8Array>;
  };
  const JSZip = require("genoffice:jszip") as {
    new (): O0JSZipInstance;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  const base = await docxEngine.buildBlankDocx({ paperSize: "A4", eastAsiaFont: "SimSun" });
  const zip = new JSZip();
  const archive = await zip.loadAsync(base);

  const nestedTable =
    `<w:tbl>` +
    `<w:tblPr><w:tblW w:w="7000" w:type="dxa"/><w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("") +
    `</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="3500"/><w:gridCol w:w="3500"/></w:tblGrid>` +
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="3500" w:type="dxa"/></w:tcPr>${wP(O0.docx.nestOuterA1)}</w:tc>` +
    `<w:tc><w:tcPr><w:tcW w:w="3500" w:type="dxa"/></w:tcPr>${wP(O0.docx.nestOuterB1)}</w:tc></w:tr>` +
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="3500" w:type="dxa"/></w:tcPr>` +
    wP(O0.docx.nestOuterA2) +
    `<w:tbl><w:tblPr><w:tblW w:w="3000" w:type="dxa"/><w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("") +
    `</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="1500"/></w:tblGrid>` +
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="1500" w:type="dxa"/></w:tcPr>${wP(O0.docx.nestInnerX)}</w:tc>` +
    `<w:tc><w:tcPr><w:tcW w:w="1500" w:type="dxa"/></w:tcPr>${wP(O0.docx.nestInnerY)}</w:tc></w:tr>` +
    `</w:tbl>` +
    `</w:tc>` +
    `<w:tc><w:tcPr><w:tcW w:w="3500" w:type="dxa"/></w:tcPr>${wP(O0.docx.nestOuterB2)}</w:tc></w:tr>` +
    `</w:tbl>`;

  const listP = (text: string): string =>
    `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>` +
    `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

  const cjkP =
    `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun"/><w:sz w:val="24"/></w:rPr>` +
    `<w:t xml:space="preserve">${O0.docx.cjk}</w:t></w:r></w:p>`;

  const footnoteP =
    `<w:p><w:r><w:t xml:space="preserve">${O0.docx.noteBody}</w:t></w:r>` +
    `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>`;

  const documentXml =
    XML_DECL +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ` +
    `xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>` +
    wP(O0.docx.body) +
    cjkP +
    listP(O0.docx.listOne) +
    listP(O0.docx.listTwo) +
    nestedTable +
    footnoteP +
    `<w:sectPr>` +
    `<w:headerReference w:type="default" r:id="rId10"/>` +
    `<w:footerReference w:type="default" r:id="rId11"/>` +
    `<w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`;

  zip.file("word/document.xml", documentXml);
  zip.file("word/header1.xml", XML_DECL + `<w:hdr xmlns:w="${W_NS}" xmlns:r="${R_NS}">${wP(O0.docx.header)}</w:hdr>`);
  zip.file("word/footer1.xml", XML_DECL + `<w:ftr xmlns:w="${W_NS}" xmlns:r="${R_NS}">${wP(O0.docx.footer)}</w:ftr>`);
  zip.file(
    "word/footnotes.xml",
    XML_DECL + `<w:footnotes xmlns:w="${W_NS}">` +
      `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
      `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
      `<w:footnote w:id="1">${wP(O0.docx.footnote)}</w:footnote>` +
      `</w:footnotes>`,
  );

  const relsEntry = archive.file("word/_rels/document.xml.rels");
  if (!relsEntry) throw new Error("O0 fixtures: blank docx has no word/_rels/document.xml.rels");
  let rels = await relsEntry.async("string");
  rels = rels.replace(
    "</Relationships>",
    `<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` +
      `<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>` +
      `<Relationship Id="rId12" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>` +
      `</Relationships>`,
  );
  zip.file("word/_rels/document.xml.rels", rels);

  const ctEntry = archive.file("[Content_Types].xml");
  if (!ctEntry) throw new Error("O0 fixtures: blank docx has no [Content_Types].xml");
  let ct = await ctEntry.async("string");
  ct = ct.replace(
    "</Types>",
    `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
      `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
      `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>` +
      `</Types>`,
  );
  zip.file("[Content_Types].xml", ct);

  writeFileSync(out, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
  await assertDocxParses(out, repoRoot);
}

/** 造完立即让**原厂解析器**（`docs read`）读一遍：样本本身不合法就不该进比对。 */
async function assertDocxParses(file: string, repoRoot: string): Promise<void> {
  const r = runCli(repoRoot, ["docs", "read", file, "--full", "--notes", "--header-footer", "--json"]);
  if (r.status !== 0) throw new Error(`O0 fixtures: docx 样本 vendor 解析失败：${r.stdout.slice(0, 400)}`);
  const env = JSON.parse(r.stdout) as { status?: string; detail?: { notes?: unknown[]; headerFooter?: { header?: string } } };
  if (env.status !== "ok") throw new Error(`O0 fixtures: docx 样本 vendor 解析非 ok：${r.stdout.slice(0, 400)}`);
  if (!(env.detail?.notes ?? []).length) throw new Error("O0 fixtures: docx 样本没有脚注（vendor 读不到）");
  if (!String(env.detail?.headerFooter?.header ?? "").includes(O0.docx.header)) {
    throw new Error("O0 fixtures: docx 样本页眉没有读回");
  }
}

/* ───────────────────────────────── XLSX ───────────────────────────────── */

/**
 * XLSX 样本：`sheet apply` 走 vendor 自己的写路径（与 App 的保存同源，
 * 见 `xlsx-package-io.ts` 的 `saveWorkbookViaSidecar` 注释）。
 *
 * 分两批是**实测要求**：`add_chart` 在 batch 内会针对**批前**的表格数据校验，
 * 同批写入的单元格它看不到（实测 `The chart dataRange needs at least one
 * numeric column`）。第一批建表与公式，第二批在已落盘的数据上建图表。
 */
function buildXlsxFixture(out: string, repoRoot: string, workDir: string): void {
  const blank = join(repoRoot, "genoffice/apps/shell/build/shell-new/blank.xlsx");
  if (!existsSync(blank)) throw new Error(`O0 fixtures: 缺 vendor blank.xlsx（${blank}）`);
  writeFileSync(out, readFileSync(blank));

  const [header, ...rows] = O0.xlsx.data;
  const opsA = [
    { op: "rename_sheet", sheet: "Sheet1", name: O0.xlsx.sheetData },
    { op: "add_sheet", name: O0.xlsx.sheetSummary },
    { op: "set_range", sheet: O0.xlsx.sheetData, start: "A1", values: [header, ...rows] },
    { op: "set_cell", sheet: O0.xlsx.sheetSummary, address: "A1", value: "O0-XL-SUMMARY" },
    { op: "set_formula", sheet: O0.xlsx.sheetSummary, address: "B2", formula: O0.xlsx.crossSheetFormula },
    // 条件格式：TOTAL 列 > 20 加红底 —— 静默丢失的重灾区之一
    { op: "add_conditional_format", sheet: O0.xlsx.sheetData, range: "D2:D4", rule: { kind: "number", operator: "greaterThan", value: 20, format: { fillColor: "#FFC7CE", fontColor: "#9C0006" } } },
    // 合并单元格
    { op: "merge_cells", sheet: O0.xlsx.sheetSummary, range: "A3:C3" },
    { op: "set_cell", sheet: O0.xlsx.sheetSummary, address: "A3", value: O0.xlsx.mergeBanner },
  ];
  const opsB = [
    { op: "add_chart", sheet: O0.xlsx.sheetData, chartType: "column", dataRange: "A1:C4", title: O0.xlsx.chartTitle, anchorCell: "E2" },
  ];
  const opsFileA = join(workDir, ".o0-xl-ops-a.json");
  const opsFileB = join(workDir, ".o0-xl-ops-b.json");
  writeFileSync(opsFileA, JSON.stringify(opsA));
  writeFileSync(opsFileB, JSON.stringify(opsB));
  for (const opsFile of [opsFileA, opsFileB]) {
    const r = runCli(repoRoot, ["sheet", "apply", out, "--ops", opsFile, "--json"]);
    if (r.status !== 0) throw new Error(`O0 fixtures: xlsx 样本 apply 失败：${r.stdout.slice(0, 600)}`);
  }
  const check = runCli(repoRoot, ["sheet", "read", out, "--stats", "--json"]);
  if (check.status !== 0) throw new Error(`O0 fixtures: xlsx 样本 vendor 解析失败：${check.stdout.slice(0, 400)}`);
  const env = JSON.parse(check.stdout) as { detail?: { stats?: { formulas?: number; sheets?: unknown[] }; features?: { charts?: unknown[]; conditionalFormats?: number } } };
  const sheets = env.detail?.stats?.sheets?.length ?? 0;
  if (sheets < 2) throw new Error(`O0 fixtures: xlsx 样本只有 ${sheets} 个 sheet`);
  if ((env.detail?.features?.charts ?? []).length < 1) throw new Error("O0 fixtures: xlsx 样本没有图表");
  if ((env.detail?.features?.conditionalFormats ?? 0) < 1) throw new Error("O0 fixtures: xlsx 样本没有条件格式");
}

/* ───────────────────────────────── PPTX ───────────────────────────────── */

/**
 * PPTX 样本：`pptxEngine` 的公开 API 直接造 —— 三页（母版占位符来自 blank 模板
 * 的那一条 layout，另有独立文本框）、一页带图片（真实 PNG 字节）、一张备注、
 * 一条 PowerPoint 原生动画（`setSlideAnimations` 写 `<p:timing>`）。
 *
 * 动画用引擎自己的写读对（`setSlideAnimations` / `getSlideAnimations`），
 * 不手写 `<p:timing>` —— 手写的部分只证明「我写的字节还在」，不证明「引擎
 * 重新序列化后仍认这个部件」。
 */
async function buildPptxFixture(out: string): Promise<void> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const engine = require("genoffice:pptx-engine") as PptxEngineShape;
  /* eslint-enable @typescript-eslint/no-require-imports */
  const opened = await engine.openPptx(await engine.createBlankPptx());
  const s0 = opened.deck.slides[0];
  if (!s0) throw new Error("O0 fixtures: blank pptx has no slide");

  // slide 1: 标题文本框（母版外独立元素）+ 图片
  engine.addElement(s0, {
    kind: "textbox",
    offset: { x: 800000, y: 500000, cx: 9000000, cy: 1300000 },
    paragraphs: [{ runs: [{ text: O0.pptx.title }] }],
    bodyPr: { wrap: "square" },
  });
  const png = makeTinyPng();
  engine.addPicture(opened, s0, {
    bytes: png,
    ext: "png",
    offset: { x: 500000, y: 2200000, cx: 1600000, cy: 1000000 },
    name: "O0 picture",
    descr: O0.pptx.imageAlt,
  });

  // slide 2: 第二页正文
  const s1 = engine.insertBlankSlide(opened, 0);
  if (!s1) throw new Error("O0 fixtures: insertBlankSlide failed");
  engine.addElement(s1, {
    kind: "textbox",
    offset: { x: 800000, y: 800000, cx: 8000000, cy: 1200000 },
    paragraphs: [{ runs: [{ text: O0.pptx.body }] }],
  });

  // slide 3: 第三页
  const s2 = engine.insertBlankSlide(opened, 1);
  if (!s2) throw new Error("O0 fixtures: second insertBlankSlide failed");
  engine.addElement(s2, {
    kind: "textbox",
    offset: { x: 800000, y: 800000, cx: 8000000, cy: 1200000 },
    paragraphs: [{ runs: [{ text: O0.pptx.third }] }],
  });

  // 备注：写在第一页
  if (!engine.setSlideNotes(opened, 0, O0.pptx.notes)) {
    throw new Error("O0 fixtures: setSlideNotes 返回 false");
  }

  // 动画：第一页那个标题文本框，入场 fade
  const target = s0.elements.find((el) => el.type === "text");
  if (!target) throw new Error("O0 fixtures: 第一页没有 text 元素可挂动画");
  const spid = engine.elementSpid(target);
  if (spid === null) throw new Error("O0 fixtures: 目标元素没有 cNvPr id");
  engine.setSlideAnimations(s0, [
    { spid, effect: "fade", trigger: "onClick", durationMs: 700, delayMs: 0 },
  ]);

  // ── 母版占位符 ──
  // vendor 的 blank 模板里 layout 是 `type="blank"`、不带任何 `p:ph`，所以「母版
  // 占位符」这条判据在**原始 blank 上无事可做**。为了让样本真的带着占位符走一遍
  // 保存链，这里在 master 与 layout 的 spTree 里插入两个真实占位符（title / body），
  // 并给第一页插一个从 layout 继承的 title 占位符 `p:sp`。
  //
  // ⚠️ 为什么分两步：`savePptx` 对**脏页**（`structureDirty`，addElement/addPicture
  // 会置位）走 `patchSlideXml` 重建 —— 它从解析模型重新拼 slide XML，**不读**我们
  // 对 `archive.entries` 的原始补丁。master/layout 不是 slide，不受 rebuild 影响；
  // 第一页的插桩必须落在一次**已提交**的保存之后（`commitSaved` 清掉脏位），
  // 再经 `openPptx` 重新解析 —— 新解析出的 slide1 就是带占位符的那一版，之后的
  // 保存或用户编辑都以它为原字节。
  //
  // 这不是手搓 zip：改动写进引擎自己的 `archive.entries`，落盘仍由 `savePptx`
  // 的 buildZip 完成。
  patchPlaceholderParts(opened);
  const firstSave = await engine.savePptx(opened);

  // 第二轮：重新打开刚才的字节，把 slide1 的 title 占位符补进这份已干净的档案，
  // 再保存一次。
  const reopenedForSlide = await engine.openPptx(firstSave);
  patchSlide1TitlePlaceholder(reopenedForSlide);
  writeFileSync(out, Buffer.from(await engine.savePptx(reopenedForSlide)));

  // 自检：原厂解析器要能把四件复杂部件读回来
  const reopened = await engine.openPptx(new Uint8Array(readFileSync(out)));
  if (reopened.deck.slides.length !== 3) throw new Error(`O0 fixtures: pptx 重开后有 ${reopened.deck.slides.length} 页（期望 3）`);
  const anims = engine.getSlideAnimations(reopened.deck.slides[0]!);
  if (anims.length !== 1) throw new Error(`O0 fixtures: pptx 重开后动画 ${anims.length} 条（期望 1）`);
  const notes = engine.getSlideNotes(reopened.archive, reopened.deck.slides[0]!.path);
  if (notes !== O0.pptx.notes) throw new Error(`O0 fixtures: pptx 备注读回是 ${JSON.stringify(notes)}`);
  const layoutXml = readArchiveText(reopened, "ppt/slideLayouts/slideLayout1.xml");
  if (!layoutXml.includes('type="title"') || !layoutXml.includes('type="body"')) {
    throw new Error("O0 fixtures: pptx layout 重开后没有 title/body 占位符");
  }
  const slide1Xml = readArchiveText(reopened, "ppt/slides/slide1.xml");
  if (!slide1Xml.includes('type="title"')) {
    throw new Error("O0 fixtures: pptx slide1 重开后没有从 layout 继承的 title 占位符");
  }
}

interface PptxEngineShape {
  openPptx(bytes: Uint8Array): Promise<PptxOpenedShape>;
  createBlankPptx(): Promise<Uint8Array>;
  savePptx(opened: PptxOpenedShape): Promise<Uint8Array>;
  addElement(slide: PptxSlideShape, opts: unknown): unknown;
  addPicture(opened: PptxOpenedShape, slide: PptxSlideShape, opts: { bytes: Uint8Array; ext: string; offset: { x: number; y: number; cx: number; cy: number }; name?: string; descr?: string }): unknown;
  insertBlankSlide(opened: PptxOpenedShape, sourceIndex: number): PptxSlideShape | null;
  setSlideNotes(opened: PptxOpenedShape, slideIndex: number, text: string): boolean;
  getSlideNotes(archive: unknown, slidePath: string): string;
  setSlideAnimations(slide: PptxSlideShape, anims: unknown[]): void;
  getSlideAnimations(slide: PptxSlideShape): unknown[];
  elementSpid(el: { anchor: { originalXml: string } }): number | null;
}

/**
 * 往 master 与 layout 的 spTree 里插 title/body 占位符（两件都不是 slide，
 * `savePptx` 不会重建它们，原始补丁直接落盘）。
 *
 * 占位符 XML 的 `p:ph` 与 `a:xfrm` 是引擎解析器认的字段（见 `parsePlaceholderMap`）。
 */
function patchPlaceholderParts(opened: PptxOpenedShape): void {
  const archive = opened.archive as { entries: Map<string, Uint8Array>; readText(p: string): string | null };
  const replaceSpTree = (path: string, extraSp: string): void => {
    const xml = archive.readText(path);
    if (xml === null) throw new Error(`O0 fixtures: 缺 ${path}`);
    const next = xml.replace("</p:spTree>", `${extraSp}</p:spTree>`);
    if (next === xml) throw new Error(`O0 fixtures: ${path} 没有 </p:spTree>`);
    archive.entries.set(path, new Uint8Array(Buffer.from(next, "utf8")));
  };
  for (const path of ["ppt/slideMasters/slideMaster1.xml", "ppt/slideLayouts/slideLayout1.xml"]) {
    replaceSpTree(
      path,
      phSp(9001, "O0 Title Placeholder", "title", "0", { x: 685800, y: 274638, cx: 10814040, cy: 1143000 }) +
      phSp(9002, "O0 Body Placeholder", "body", "1", { x: 685800, y: 1600200, cx: 10814040, cy: 4525963 }),
    );
  }
}

/** 第一页：一个真正**继承 layout** 的 title 占位符（无自己的 xfrm —— 继承 layout 的几何）。 */
function patchSlide1TitlePlaceholder(opened: PptxOpenedShape): void {
  const archive = opened.archive as { entries: Map<string, Uint8Array>; readText(p: string): string | null };
  const xml = archive.readText("ppt/slides/slide1.xml");
  if (xml === null) throw new Error("O0 fixtures: 缺 ppt/slides/slide1.xml");
  const sp =
    `<p:sp><p:nvSpPr><p:cNvPr id="9101" name="O0 Slide Title"/><p:cNvSpPr/>` +
    `<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${O0.pptx.title}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const next = xml.replace("</p:spTree>", `${sp}</p:spTree>`);
  if (next === xml) throw new Error("O0 fixtures: slide1.xml 没有 </p:spTree>");
  archive.entries.set("ppt/slides/slide1.xml", new Uint8Array(Buffer.from(next, "utf8")));
}

function phSp(id: number, name: string, phType: string, idx: string, offset: XmlBox): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="${phType}"${phType === "title" ? "" : ` idx="${idx}"`}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${offset.x}" y="${offset.y}"/><a:ext cx="${offset.cx}" cy="${offset.cy}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`;
}

interface XmlBox { x: number; y: number; cx: number; cy: number }

function readArchiveText(opened: PptxOpenedShape, path: string): string {
  const archive = opened.archive as { readText(p: string): string | null };
  return archive.readText(path) ?? "";
}
interface PptxOpenedShape {
  deck: { slides: PptxSlideShape[] };
  archive: unknown;
}
interface PptxSlideShape {
  path: string;
  elements: Array<{ type: string; anchor: { originalXml: string } }>;
}

interface O0JSZipEntry {
  async(type: "string"): Promise<string>;
  async(type: "uint8array"): Promise<Uint8Array>;
}
interface O0JSZipInstance {
  loadAsync(bytes: Uint8Array | Buffer): Promise<O0JSZipInstance>;
  file(path: string): O0JSZipEntry | null;
  file(path: string, data: string): void;
  generateAsync(options: { type: "uint8array"; compression: "DEFLATE" }): Promise<Uint8Array>;
}

/** 一张 2×2 的合法 PNG（深色像素），给 PPTX 图片部件用；不依赖任何外部资产。 */
function makeTinyPng(): Uint8Array {
  // 手工最小的 RGBA PNG：IHDR + IDAT(zlib "stored" 块) + IEND
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const chunk = (type: string, data: number[]): number[] => {
    const body = [...type].map((c) => c.charCodeAt(0)).concat(data);
    return [...be32(data.length), ...body, ...be32(crc32(Uint8Array.from(body)))];
  };
  const width = 2;
  const height = 2;
  const ihdr = [...be32(width), ...be32(height), 8, 6, 0, 0, 0]; // 8-bit RGBA
  // 两行，每行前导 filter byte 0；像素为深灰
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(0x40, 0x40, 0x40, 0xff);
  }
  // zlib: 头 + stored deflate 块 + adler32
  const adler = (() => {
    let a = 1;
    let b = 0;
    for (const byte of raw) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  })();
  const deflate = [0x78, 0x01, 0x01, raw.length & 0xff, (raw.length >>> 8) & 0xff, ~raw.length & 0xff, (~raw.length >>> 8) & 0xff, ...raw, ...be32(adler)];
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", deflate),
    ...chunk("IEND", []),
  ];
  return Uint8Array.from(bytes);
}

/* ───────────────────────────────── PDF ───────────────────────────────── */

/**
 * PDF 样本：pdf-lib 造两页文本 + 书签（`/Outlines`）+ 一条 sticky note
 * （`/Annots` Text）。pdf-lib 正是 vendor `save-pdf.ts` 的依赖 —— 与「用我的
 * 解析器验我的解析器」不同，这里生成与读取分属两个独立实现（pdf-lib 写、
 * pdfium 读）。
 */
async function buildPdfFixture(out: string): Promise<void> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pdfLib = require("genoffice:pdf-lib") as {
    PDFDocument: {
      create(): Promise<PdfDocShape>;
    };
    StandardFonts: { Helvetica: string };
    PDFName: { of(name: string): unknown };
    PDFString: { of(text: string): unknown };
    PDFArray: { withContext(ctx: unknown): { push(v: unknown): void } };
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  const doc = await pdfLib.PDFDocument.create();
  const font = await (doc as unknown as { embedFont(f: string): Promise<unknown> }).embedFont(pdfLib.StandardFonts.Helvetica);
  const p1 = (doc as unknown as { addPage(size: [number, number]): PdfPageShape }).addPage([595, 842]);
  p1.drawText(O0.pdf.page1, { x: 60, y: 760, size: 14, font });
  const p2 = (doc as unknown as { addPage(size: [number, number]): PdfPageShape }).addPage([595, 842]);
  p2.drawText(O0.pdf.page2, { x: 60, y: 760, size: 14, font });

  const ctx = (doc as unknown as { context: PdfCtxShape }).context;
  const catalog = (doc as unknown as { catalog: { set(k: unknown, v: unknown): void } }).catalog;
  const outlinesRef = ctx.nextRef();
  const itemRef = ctx.nextRef();
  ctx.assign(outlinesRef, ctx.obj({ Type: "Outlines", First: itemRef, Last: itemRef, Count: 1 }));
  ctx.assign(itemRef, ctx.obj({ Title: pdfLib.PDFString.of(O0.pdf.bookmark), Parent: outlinesRef, Dest: [p1.ref, pdfLib.PDFName.of("Fit")] }));
  catalog.set(pdfLib.PDFName.of("Outlines"), outlinesRef);

  const annotRef = ctx.nextRef();
  ctx.assign(annotRef, ctx.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [520, 760, 540, 780],
    Contents: pdfLib.PDFString.of(O0.pdf.note),
    T: pdfLib.PDFString.of("O0"),
    Name: "Comment",
    F: 4,
  }));
  const annots = pdfLib.PDFArray.withContext(ctx);
  annots.push(annotRef);
  (p1.node as { set(k: unknown, v: unknown): void }).set(pdfLib.PDFName.of("Annots"), annots);

  const bytes = await (doc as unknown as { save(o: { useObjectStreams: boolean }): Promise<Uint8Array> }).save({ useObjectStreams: false });
  writeFileSync(out, Buffer.from(bytes));
}

interface PdfDocShape { [k: string]: unknown }
interface PdfPageShape {
  ref: unknown;
  node: { set(k: unknown, v: unknown): void };
  drawText(text: string, o: { x: number; y: number; size: number; font: unknown }): void;
}
interface PdfCtxShape {
  nextRef(): unknown;
  obj(o: Record<string, unknown>): unknown;
  assign(ref: unknown, obj: unknown): void;
}

/* ───────────────────────────────── Markdown ───────────────────────────────── */

function buildMarkdownFixture(out: string): void {
  const md = [
    O0.markdown.heading,
    "",
    O0.markdown.tail,
    "",
    O0.markdown.tableHeader,
    "| --- | --- |",
    O0.markdown.tableRow,
    "",
    O0.markdown.code,
    "",
    O0.markdown.image,
    "",
    O0.markdown.listOuter,
    O0.markdown.listInner,
    "",
  ].join("\n");
  writeFileSync(out, md, "utf8");
}

/* ───────────────────────────────── HTML ───────────────────────────────── */

function buildHtmlFixture(out: string): void {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${O0.html.title}</title>
<style>
  /* ${O0.html.styleMarker}: a stylesheet the fidelity check must find intact */
  .o0-card { border: 1px solid #336699; padding: 8px; }
  .o0-card h2 { color: #336699; }
</style>
</head>
<body>
<h1>${O0.html.title}</h1>
<p>${O0.html.token}</p>
<div class="o0-card"><h2>Styled card</h2><p>card body</p></div>
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">
  <title>${O0.html.svgMarker}</title>
  <rect x="2" y="2" width="116" height="56" fill="#eef" stroke="#336699"/>
  <circle cx="30" cy="30" r="18" fill="#336699"/>
</svg>
<script>
  // ${O0.html.scriptMarker}: an inline script the fidelity check must find intact
  window.__o0 = function () { return "o0-script-alive"; };
</script>
<p>${O0.html.tail}</p>
</body>
</html>
`;
  writeFileSync(out, html, "utf8");
}

/* ───────────────────────────────── CLI ───────────────────────────────── */

/**
 * 调 vendor CLI。**必须带 `ELECTRON_RUN_AS_NODE=1`**：本函数在探针主进程（Electron）
 * 里跑，`process.execPath` 是 Electron 二进制；不带这个环境变量，子进程会把它当
 * 一个 Electron app 启动而不是 Node（生产 `genofficeCli.ts` 的 `invoke()` 给的是
 * 同一组最小环境，见其文件头第 2 条）。
 */
function runCli(repoRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const cli = join(repoRoot, "genoffice/packages/cli/dist/genoffice.cjs");
  const path = process.env.PATH ?? process.env.Path ?? "";
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ELECTRON_RUN_AS_NODE: "1", ...(path ? { PATH: path } : {}) },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
