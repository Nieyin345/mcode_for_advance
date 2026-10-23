/**
 * T7 —— 六条旅程共用的夹具工厂（跑在**探针主进程**里）。
 *
 * 每个编辑器都需要一份「文件里带着唯一文本」的合法输入；保存断言必须能证明
 * 「盘上的字节真的变了、而且重开后新文本还在」。夹具一律真格式：
 *
 *  - DOCX：vendor `buildBlankDocx()` + JSZip 注入 `<w:t>`（与 `document-view-open-smoke`
 *    同一模板，避免探针自造 zip 结构）。
 *  - XLSX：vendor shell 的 `blank.xlsx` 原样拷贝（真 sidecar 能开；A1 为空）。
 *  - PPTX：vendor `createBlankPptx()` + `addElement` 写入唯一文本。
 *  - PDF：vendor `printHtmlToPdf + buildPrintableHtml`（Chromium 真打印，文本层可选中）。
 *  - Markdown / HTML：纯文本写入（编辑器本身接受）。
 *
 * 唯一文本按编辑器分开（`T7-<KIND>-<token>`），跨旅程证据不会串。
 *
 * ## vendor 用**运行期 require**，不是静态 import
 *
 * 本模块经 `journeys/index.ts` 的惰性 `require()` 进入 bundle。静态 import 会让
 * 这台机器的 `tsc` 去跟随 vendor 的 TS 源码（vendor 不在工程里、JSZip 的全局类型
 * 还会被覆盖 —— 实测）。运行期 require 由 esbuild 的 `vendor-esbuild.mjs` alias
 * 装到 bundle 里（`require("genoffice:docx-engine")` 这类**虚拟名**，由 alias 改写）；
 * 类型面由 `vendor-modules.d.ts` 的全局接口描述。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 每个编辑器一份唯一文本（保存/重开断言用它，不用硬编码字面量）。 */
export const UNIQUE = {
  docs: "T7-DOCS-4f8a1c",
  sheets: "T7-XLSX-9b2e7d",
  slides: "T7-PPTX-6c0d3e",
  pdf: "T7-PDF-1a9f5b",
  markdown: "T7-MD-7e4b2a",
  html: "T7-HTML-2d8c6f",
};

export interface FixturePaths {
  docs: string;
  sheets: string;
  slides: string;
  pdf: string;
  markdown: string;
  html: string;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const docxEngine = require("genoffice:docx-engine") as T7DocxEngine;
const pptxEngine = require("genoffice:pptx-engine") as T7PptxEngine;
const printHtml = require("genoffice:print-html-pdf") as T7PrintHtml;
const JSZip = require("genoffice:jszip") as T7JSZipCtor;
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 生成六份夹具到 `projectDir`。**幂等**：已存在且非空就复用（重开进程时
 * 不能把上一代写过的文件重置回初始内容 —— 那会让「重开断言改动还在」变成假绿）。
 */
export async function ensureFixtures(projectDir: string, repoRoot: string): Promise<FixturePaths> {
  const paths: FixturePaths = {
    docs: join(projectDir, "t7-docs.docx"),
    sheets: join(projectDir, "t7-sheets.xlsx"),
    slides: join(projectDir, "t7-slides.pptx"),
    pdf: join(projectDir, "t7-pdf.pdf"),
    markdown: join(projectDir, "t7-markdown.md"),
    html: join(projectDir, "t7-html.html"),
  };
  const nonEmpty = (p: string): boolean => existsSync(p) && readFileSync(p).length > 0;
  const vendor = join(repoRoot, "genoffice");

  if (!nonEmpty(paths.docs)) {
    const zip = new JSZip();
    await zip.loadAsync(await docxEngine.buildBlankDocx({ paperSize: "A4" }));
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${UNIQUE.docs}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    );
    writeFileSync(paths.docs, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
  }

  if (!nonEmpty(paths.sheets)) {
    // vendor shell 的 blank.xlsx 是真 XLSX（sidecar 能开）。A1 留空 ——
    // 旅程自己写 A1，保存后 A1 的单元格是「真的变了」而不是「本来就是它」。
    const blank = join(vendor, "apps/shell/build/shell-new/blank.xlsx");
    writeFileSync(paths.sheets, readFileSync(blank));
  }

  if (!nonEmpty(paths.slides)) {
    const opened = await pptxEngine.openPptx(await pptxEngine.createBlankPptx());
    const slide = opened.deck.slides[0];
    if (slide === undefined) throw new Error("T7 fixtures: blank pptx has no slide");
    pptxEngine.addElement(slide, {
      kind: "textbox",
      offset: { x: 800000, y: 800000, cx: 8000000, cy: 1200000 },
      paragraphs: [{ runs: [{ text: UNIQUE.slides }] }],
      bodyPr: { wrap: "square" },
    });
    writeFileSync(paths.slides, Buffer.from(await pptxEngine.savePptx(opened)));
  }

  if (!nonEmpty(paths.pdf)) {
    // Chromium 真打印：文本层可被 pdf.js 选中（`T7-PDF-…` 是页面正文里的一句）。
    const bytes = await printHtml.printHtmlToPdf(
      printHtml.buildPrintableHtml("T7 PDF Fixture", `<p>${UNIQUE.pdf}</p>`),
      () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { BrowserWindow } = require("electron") as typeof import("electron");
        return new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
      },
    );
    writeFileSync(paths.pdf, Buffer.from(bytes));
  }

  if (!nonEmpty(paths.markdown)) {
    writeFileSync(paths.markdown, `# T7 Markdown\n\n${UNIQUE.markdown}\n`, "utf8");
  }

  if (!nonEmpty(paths.html)) {
    writeFileSync(
      paths.html,
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>T7 HTML</title></head>\n<body><h1>T7 HTML</h1><p>${UNIQUE.html}</p></body></html>\n`,
      "utf8",
    );
  }

  return paths;
}
