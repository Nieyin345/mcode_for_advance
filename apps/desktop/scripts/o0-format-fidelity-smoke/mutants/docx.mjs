/**
 * O0 变异构造器 —— DOCX。
 *
 * 两个变异体（卡 §4）：
 *  - `docx-inner-table-delete`：删掉内层嵌套表 → 期望 `docx.nested-table.inner` 红；
 *  - `docx-inner-table-relocate`：把内层嵌套表挪到外层 B2 格 → 期望同一项红
 *    （内容没变、位置变了 —— 证明判据比的是语义位置不是存在性）。
 *
 * 直接改 `word/document.xml` 字节（不经过任何编辑器），产出仍是合法 zip。
 */
import JSZip from "../../../../../genoffice/node_modules/jszip/lib/index.js";
import { readFileSync, writeFileSync } from "node:fs";

function tableSpans(xml) {
  const spans = [];
  const stack = [];
  const re = /<w:tbl\b[^>]*>|<\/w:tbl>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[0][1] !== "/") stack.push(m.index);
    else {
      const start = stack.pop();
      spans.push({ start, end: re.lastIndex, depth: stack.length });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

export async function buildDocxMutants(baselineCopy, outDir) {
  const cases = [];

  // ── delete 内层表 ──
  {
    const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
    let xml = await zip.file("word/document.xml").async("string");
    const nested = tableSpans(xml).filter((s) => s.depth > 0);
    if (nested.length !== 1) throw new Error(`docx 变异：预期 1 张内层表，实际 ${nested.length}`);
    xml = xml.slice(0, nested[0].start) + xml.slice(nested[0].end);
    zip.file("word/document.xml", xml);
    const out = `${outDir}/inner-table-deleted.docx`;
    writeFileSync(out, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
    cases.push({
      mutation: "delete-inner-table",
      file: out,
      expect: ["docx.nested-table.inner"],
      detail: "删掉外层第 2 行第 1 格里的内层 w:tbl",
    });
  }

  // ── relocate 内层表到 B2 格 ──
  {
    const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
    let xml = await zip.file("word/document.xml").async("string");
    const nested = tableSpans(xml).filter((s) => s.depth > 0);
    if (nested.length !== 1) throw new Error(`docx 变异：预期 1 张内层表，实际 ${nested.length}`);
    const inner = xml.slice(nested[0].start, nested[0].end);
    xml = xml.slice(0, nested[0].start) + xml.slice(nested[0].end);
    const at = xml.indexOf("O0-NEST-OUTER-B2");
    if (at < 0) throw new Error("docx 变异：找不到外层 B2 标记");
    const pEnd = xml.indexOf("</w:p>", at) + "</w:p>".length;
    xml = xml.slice(0, pEnd) + inner + xml.slice(pEnd);
    zip.file("word/document.xml", xml);
    const out = `${outDir}/inner-table-relocated.docx`;
    writeFileSync(out, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
    cases.push({
      mutation: "relocate-inner-table",
      file: out,
      expect: ["docx.nested-table.inner"],
      detail: "内层表内容不变，从 A2 格挪到 B2 格",
    });
  }

  // ── relocate 编号列表（整段挪到文末，内容不变）──
  {
    const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
    let xml = await zip.file("word/document.xml").async("string");
    const paras = listParagraphSpans(xml);
    if (paras.length < 2) throw new Error(`docx 变异：预期 ≥2 个编号段落，实际 ${paras.length}`);
    // 把第一个编号段落整段剪下，插到 sectPr 之前（文末）
    const first = paras[0];
    const cut = xml.slice(first.start, first.end);
    xml = xml.slice(0, first.start) + xml.slice(first.end);
    const sect = xml.indexOf("<w:sectPr");
    if (sect < 0) throw new Error("docx 变异：找不到 w:sectPr");
    xml = xml.slice(0, sect) + cut + xml.slice(sect);
    zip.file("word/document.xml", xml);
    const out = `${outDir}/list-relocated.docx`;
    writeFileSync(out, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
    cases.push({
      mutation: "relocate-list-item",
      file: out,
      expect: ["docx.numbered-list"],
      detail: "第一个编号列表段落内容不变，从原位挪到文末（body 位置变了）",
    });
  }

  // ── 内容级变异：证明每一条断言比的是**内容**，不只是存在 ──
  const contentMutant = async (name, mutate, expect, detail) => {
    const zip = await JSZip.loadAsync(readFileSync(baselineCopy));
    const ok = await mutate(zip);
    if (!ok) throw new Error(`docx 变异 ${name}：目标片段不存在`);
    const out = `${outDir}/${name}.docx`;
    writeFileSync(out, Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })));
    cases.push({ mutation: name, file: out, expect, detail });
  };

  await contentMutant(
    "header-text-changed",
    async (zip) => {
      const p = "word/header1.xml";
      const x = await zip.file(p).async("string");
      const next = x.replace("O0-HEADER-TEXT running head", "O0-HEADER-TEXT running HEADS");
      if (next === x) return false;
      zip.file(p, next);
      return true;
    },
    ["docx.hf-part:word/header1.xml"],
    "页眉文本改一个词（部件仍在）",
  );

  await contentMutant(
    "footnote-text-changed",
    async (zip) => {
      const p = "word/footnotes.xml";
      const x = await zip.file(p).async("string");
      const next = x.replace("O0-FOOTNOTE-TEXT notes here", "O0-FOOTNOTE-TEXT notes HERE");
      if (next === x) return false;
      zip.file(p, next);
      return true;
    },
    ["docx.footnote-parts"],
    "脚注文本改一个词（引用标记与部件都还在）",
  );

  await contentMutant(
    "eastasia-font-changed",
    async (zip) => {
      const p = "word/document.xml";
      const x = await zip.file(p).async("string");
      const next = x.replace('w:eastAsia="SimSun"', 'w:eastAsia="KaiTi"');
      if (next === x) return false;
      zip.file(p, next);
      return true;
    },
    ["docx.eastAsia-runs"],
    "中文 run 的 w:eastAsia 从 SimSun 改成 KaiTi（文案不变）",
  );

  await contentMutant(
    "list-numbering-removed",
    async (zip) => {
      const p = "word/document.xml";
      const x = await zip.file(p).async("string");
      const next = x.replace(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="2"\/><\/w:numPr>/, "");
      if (next === x) return false;
      zip.file(p, next);
      return true;
    },
    ["docx.numbered-list"],
    "第一个有序列表段落丢掉 w:numPr（文字还在，不再编号）",
  );

  return cases;
}

/** 顶层 `<w:p>` 中带 `<w:pPr><w:numPr>` 的段落的字节区间。 */
function listParagraphSpans(xml) {
  const spans = [];
  const stack = [];
  const re = /<w:p\b[^>]*>|<\/w:p>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[0][1] !== "/") stack.push(m.index);
    else {
      const start = stack.pop();
      const body = xml.slice(start, re.lastIndex);
      if (body.includes("<w:numPr>")) spans.push({ start, end: re.lastIndex });
    }
  }
  return spans;
}
