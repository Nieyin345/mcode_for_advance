/**
 * O3 —— 六格式夹具（**用产物里的 CLI 生成**，不是套件自造二进制）。
 *
 * 为什么用 `resources/genoffice/cli/genoffice.cjs` 造夹具：
 *
 *  - 它是**本次要验的那份产物**：夹具如果出自源码树 CLI，至少"产物 CLI 能不能跑"
 *    这条就已经和被测对象脱钩；
 *  - docx/xlsx/pptx 都由 vendor 自己的序列化器写出，格式合法性不依赖本套件的假设；
 *  - PDF 例外：产物 CLI 的 `create --type pdf` 需要 GenOffice 应用（实测
 *    `app_unavailable`），所以 PDF 用**手写的最小合法 PDF**（Helvetica + 一行文本，
 *    xref 手算）。判据侧用 pdf.js 文本层验证它被真的渲染出来 —— 手写的 PDF 若不合
 *    法，会在文本层断言上暴露，而不是被套件自己"认证"。
 *
 * 每份夹具带一个唯一文本（`O3-<KIND>-<hex>`），DOM/渲染树断言用它，
 * 避免"页面上有字"冒充"我们的文件被打开了"。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const TOKENS = {
  docs: "O3-DOCS-4f8a1c",
  sheets: "O3-XLSX-9b2e7d",
  slides: "O3-PPTX-6c0d3e",
  pdf: "O3-PDF-1a9f5b",
  markdown: "O3-MD-7e4b2a",
  html: "O3-HTML-2d8c6f",
};

export function sha256FileOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 最小合法 PDF：1 页、Helvetica、一行文本。作用只是给 pdf.js 一个真文件。 */
function minimalPdf(text) {
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/**
 * 生成六份夹具到 projectDir。返回路径表与**生成记录**（每条 CLI 的退出码/信封），
 * 生成失败直接抛 —— 夹具都造不出来，"打开失败"的结论就没有意义。
 *
 * 额外多造 docs 的 b/c 两份：负控（改名）与恢复各用一份，避免同一路径的会话
 * 归属在"打开失败 → 再打开"之间互相牵扯。
 */
export function createFixtures({ cliPath, projectDir }) {
  const cli = (args) => {
    const r = spawnSync(process.execPath, [cliPath, ...args, "--json"], { encoding: "utf8", timeout: 180_000 });
    let envelope = null;
    try { envelope = JSON.parse(r.stdout); } catch { /* 留 null */ }
    return { status: r.status, envelope, stderr: (r.stderr ?? "").slice(0, 800) };
  };
  const must = (label, result) => {
    if (result.status !== 0 || result.envelope?.status !== "ok") {
      throw new Error(`夹具生成失败（${label}）：exit=${result.status} ${JSON.stringify(result.envelope)?.slice(0, 500)} ${result.stderr}`);
    }
    return { label, exit: result.status };
  };

  const paths = {
    docs: join(projectDir, "o3-docs.docx"),
    docsB: join(projectDir, "o3-docs-b.docx"),
    docsC: join(projectDir, "o3-docs-c.docx"),
    sheets: join(projectDir, "o3-sheets.xlsx"),
    slides: join(projectDir, "o3-slides.pptx"),
    pdf: join(projectDir, "o3-pdf.pdf"),
    markdown: join(projectDir, "o3-markdown.md"),
    html: join(projectDir, "o3-html.html"),
  };
  const records = [];

  const docxFrom = (mdFile, mdText, outPath) => {
    writeFileSync(mdFile, mdText, "utf8");
    records.push(must(outPath, cli(["create", "--type", "docx", "--from", mdFile, "--out", outPath, "--force"])));
  };
  docxFrom(join(projectDir, "o3-docs.md"), `# O3 Docs\n\n${TOKENS.docs}\n`, paths.docs);
  docxFrom(join(projectDir, "o3-docs-b.md"), `# O3 Docs B\n\n${TOKENS.docs}-B\n`, paths.docsB);
  docxFrom(join(projectDir, "o3-docs-c.md"), `# O3 Docs C\n\n${TOKENS.docs}-C\n`, paths.docsC);

  writeFileSync(join(projectDir, "o3-sheets.csv"), `${TOKENS.sheets},2\n3,4\n`, "utf8");
  records.push(must("xlsx", cli(["create", "--type", "xlsx", "--from", join(projectDir, "o3-sheets.csv"), "--out", paths.sheets, "--force"])));

  writeFileSync(join(projectDir, "o3-slides-ops.json"), JSON.stringify([{
    op: "addElement", target: { slide: 0 }, kind: "textbox",
    offset: { x: 800000, y: 800000, cx: 8000000, cy: 1200000 },
    paragraphs: [{ runs: [{ text: TOKENS.slides }] }],
  }]), "utf8");
  records.push(must("pptx", cli(["create", "--type", "pptx", "--ops", join(projectDir, "o3-slides-ops.json"), "--out", paths.slides, "--force"])));

  writeFileSync(paths.pdf, minimalPdf(TOKENS.pdf));

  writeFileSync(paths.markdown, `# O3 Markdown\n\n${TOKENS.markdown}\n`, "utf8");
  writeFileSync(paths.html,
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>O3 HTML</title></head>\n<body><h1>O3 HTML</h1><p>${TOKENS.html}</p></body></html>\n`,
    "utf8");

  return { paths, records };
}
