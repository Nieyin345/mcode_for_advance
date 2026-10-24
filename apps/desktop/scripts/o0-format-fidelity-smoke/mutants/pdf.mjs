/**
 * O0 变异构造器 —— PDF。
 *
 * PDF 的「删除/挪动」按对象做：用 pdf-lib 载入基线字节，改 `/Outlines` /
 * `/Annots`，再保存。与产品**生成**样本用的是同一份 pdf-lib；读取（指纹）走
 * pdf.js —— 两侧独立。
 *
 *  - `delete-bookmark`：删掉 /Outlines 的 First/Last → 期望 `pdf.outline` 红；
 *  - `relocate-bookmark-dest`：书签目的地从第 1 页改到第 2 页 → 期望 `pdf.outline` 红
 *    （书签还在、标题没变、目的地变了）；
 *  - `delete-annotation`：删掉 sticky note → 期望 `pdf.annotations` 红。
 */
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } from "../../../../../genoffice/node_modules/pdf-lib/cjs/index.js";
import { readFileSync, writeFileSync } from "node:fs";

export async function buildPdfMutants(baselineCopy, outDir) {
  const cases = [];
  const bytes = readFileSync(baselineCopy);

  const save = async (doc, name) => {
    const out = `${outDir}/${name}.pdf`;
    writeFileSync(out, Buffer.from(await doc.save({ useObjectStreams: false })));
    return out;
  };

  // ── delete bookmark ──
  {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const outlinesRef = doc.catalog.get(PDFName.of("Outlines"));
    if (!outlinesRef) throw new Error("pdf 变异：基线没有 /Outlines");
    // 删掉目录树（First/Last/Count），而不是 removeObject：后者会让 pdf.js 直接
    // 报 dangling ref（那是坏文件，不是本变异要模拟的「部件丢失」）。
    doc.catalog.delete(PDFName.of("Outlines"));
    cases.push({
      mutation: "delete-bookmark",
      file: await save(doc, "bookmark-deleted"),
      expect: ["pdf.outline"],
      detail: "从 catalog 删掉 /Outlines",
    });
  }

  // ── relocate bookmark dest（第 1 页 → 第 2 页）──
  {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = doc.context;
    const outlinesRef = doc.catalog.get(PDFName.of("Outlines"));
    if (!outlinesRef) throw new Error("pdf 变异：基线没有 /Outlines");
    const outlines = ctx.lookup(outlinesRef, PDFDict);
    const firstRef = outlines.get(PDFName.of("First"));
    if (!firstRef) throw new Error("pdf 变异：/Outlines 没有 First");
    const item = ctx.lookup(firstRef, PDFDict);
    const page2 = doc.getPage(1); // 0-based → 第 2 页
    item.set(PDFName.of("Dest"), ctx.obj([page2.ref, PDFName.of("Fit")]));
    cases.push({
      mutation: "relocate-bookmark-dest",
      file: await save(doc, "bookmark-moved"),
      expect: ["pdf.outline"],
      detail: "书签标题不变，目的地从第 1 页改到第 2 页",
    });
  }

  // ── delete annotation ──
  {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = doc.context;
    const page1 = doc.getPage(0);
    const annots = page1.node.get(PDFName.of("Annots"));
    if (!annots) throw new Error("pdf 变异：第 1 页没有 /Annots");
    const arr = ctx.lookup(annots, PDFArray);
    // 清空 /Annots（保留空数组 —— 结构合法，只是批注没了）
    while (arr.size() > 0) arr.remove(arr.size() - 1);
    cases.push({
      mutation: "delete-annotation",
      file: await save(doc, "annotation-deleted"),
      expect: ["pdf.annotations"],
      detail: "清空第 1 页 /Annots 数组",
    });
  }

  // ── 内容级：批注内容改一个词（批注还在、文字变了）──
  {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = doc.context;
    const page1 = doc.getPage(0);
    const annots = ctx.lookup(page1.node.get(PDFName.of("Annots")), PDFArray);
    const first = annots.lookup(0, PDFDict);
    const { PDFString } = await import("../../../../../genoffice/node_modules/pdf-lib/cjs/index.js");
    first.set(PDFName.of("Contents"), PDFString.of("O0-NOTE-ALPHA sticky EDITED"));
    cases.push({
      mutation: "annotation-content-changed",
      file: await save(doc, "annotation-reworded"),
      expect: ["pdf.annotations"],
      detail: "sticky note 的内容改一个词（批注仍在原位置）",
    });
  }

  // ── 内容级：书签标题改一个词（层级与目的地都不变）──
  {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ctx = doc.context;
    const { PDFString } = await import("../../../../../genoffice/node_modules/pdf-lib/cjs/index.js");
    const outlines = ctx.lookup(doc.catalog.get(PDFName.of("Outlines")), PDFDict);
    const item = ctx.lookup(outlines.get(PDFName.of("First")), PDFDict);
    item.set(PDFName.of("Title"), PDFString.of("O0-BOOKMARK-ALPHA EDITED"));
    cases.push({
      mutation: "bookmark-title-changed",
      file: await save(doc, "bookmark-reworded"),
      expect: ["pdf.outline"],
      detail: "书签标题改一个词（目的地仍是第 1 页）",
    });
  }

  return cases;
}
