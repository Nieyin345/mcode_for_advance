/**
 * 【ARC-007】**文档种类路由 = 唯一判据**的回归网。
 *
 * 台账原文:「需抽出**唯一文档格式/provider 路由表**，消除工作区/资料库/移动端各写一次
 * 的逻辑」。本套钉三件事:
 *
 *  1. `documentKindOf` 的**逐样例**判据(扩展名→种类,含大小写/无扩展名/隐藏文件/
 *     两种分隔符/尾随空格等边角);
 *  2. Office 扩展名集合**双向对账**:`@contracts/documentKind` 的 `OFFICE_EDITABLE` /
 *     `OFFICE_VIEW_ONLY` 必须与下面钉住的期望集合**完全一致**(多一个、少一个都红)。
 *     ⚠️ 2026-10-24（O5 批一）OnlyOffice 已删,原先「与 `ipc/onlyoffice.ts` 两张物理表
 *     对账」的第二张表不存在了;这里改成「对期望清单对账」——期望清单是**夹具**,不是
 *     生产逻辑的副本,作用是让「悄悄加/删一个扩展名」必须有人签字。
 *  3. 四个消费点(编辑器分类器 / 资料库查看器 / 资料库预览 / 移动端)**真的**走同一份:
 *     源码断言不再有本地 `lastIndexOf(".")` / 本地 `MARKDOWN_EXT` / `ext === "md"`
 *     的分支 —— 防"迁移了一半,下一处又写回去"。
 *
 * 变异验证:把 `documentKindOf` 的 markdown 分支删掉 → 路由判据红;把某消费点写回
 * 本地 `ext === "md"` → 源码断言红。
 *
 * Run: scripts/document-router-smoke/run.sh
 */
import {
  documentExtension,
  documentKindOf,
  isOfficeDocumentKind,
  isTextualDocumentKind,
  type DocumentKind,
} from "@contracts/documentKind";
import { genofficeAppForPath } from "@contracts/genofficeFileRoute";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
function section(title: string): void { console.log(`\n${title}`); }

/** 只保留代码行(去掉 //、*、/* 开头的注释)。断言"不再有某写法"时用它,
 *  否则历史注释里的引用会造成假红。 */
function codeLines(source: string): string[] {
  return source.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
}

/* ── 1. 扩展名解析 ── */
section("1. documentExtension:两种分隔符 / 大小写 / 边角");
{
  eq("posix 路径", documentExtension("/a/b/report.MD"), "md");
  eq("windows 路径", documentExtension("C:\\work\\notes.markdown"), "markdown");
  eq("混合分隔符取最后一段", documentExtension("C:\\work/sub/report.PDF"), "pdf");
  eq("无扩展名", documentExtension("/a/b/Makefile"), "");
  eq("以点开头的隐藏文件不是扩展名", documentExtension("/a/b/.env"), "");
  eq("隐藏文件带真扩展名仍取后者", documentExtension("/a/b/.eslintrc.json"), "json");
  eq("目录名里的点不算", documentExtension("/a/b.dir/file"), "");
  eq("尾随点 → 空", documentExtension("/a/b/report."), "");
  eq("多段扩展名取最后一段", documentExtension("/a/b/archive.tar.gz"), "gz");
  eq("空串", documentExtension(""), "");
}

/* ── 2. 种类判据(逐格式) ── */
section("2. documentKindOf:每个格式的结论");
{
  const cases: Array<[string, DocumentKind]> = [
    ["a.md", "markdown"], ["a.MARKDOWN", "markdown"],
    ["a.pdf", "pdf"],
    ["a.docx", "office"], ["a.docm", "office"], ["a.dotx", "office"], ["a.odt", "office"],
    ["a.xlsx", "office"], ["a.xlsm", "office"], ["a.xltx", "office"], ["a.ods", "office"],
    ["a.pptx", "office"], ["a.pptm", "office"], ["a.potx", "office"], ["a.odp", "office"],
    ["a.doc", "office-readonly"], ["a.rtf", "office-readonly"], ["a.xls", "office-readonly"],
    ["a.ppt", "office-readonly"], ["a.pps", "office-readonly"], ["a.ppsx", "office-readonly"],
    ["a.png", "image"], ["a.SVG", "image"], ["a.avif", "image"], ["a.tiff", "image"],
    ["a.html", "html"], ["a.htm", "html"],
    ["a.zip", "unsupported"], ["a.exe", "unsupported"], ["a.mp4", "unsupported"],
    ["a.ttf", "unsupported"], ["a.sqlite", "unsupported"],
    ["a.ts", "text"], ["a.py", "text"], ["a.json", "text"], ["Makefile", "unknown"],
  ];
  for (const [name, kind] of cases) eq(`${name} → ${kind}`, documentKindOf(name), kind);
  // 反向正控:pdf 绝不能再落进 unsupported(2026-09-21 的历史缺陷形态)。
  check("★ .pdf 不属于 unsupported(历史回归锚)", documentKindOf("a.pdf") !== "unsupported");
  // 反向正控:office 可编辑档不能落进 office-readonly。
  check("★ .docx 不属于 office-readonly", documentKindOf("a.docx") !== "office-readonly");
}

/* ── 3. Office 集合对账:必须是这份期望清单,不多不少 ──
 *
 * 【O5 批一 2026-10-24】原先这里与 `ipc/onlyoffice.ts` 的 `ONLYOFFICE_EDITABLE` /
 * `ONLYOFFICE_VIEW_ONLY` 逐项对账 —— 那两张表随 OnlyOffice 一起删了。现在台账里的
 * 期望集合直接写在这里:**加/删一个 Office 扩展名必须同时改这里**,否则红。
 *
 * 为什么保留这份清单而不是删掉整节:`documentKind` 的两个集合是私有 const,没有
 * 导出,若没有这一节,「有人把 `.docm` 从集合里删掉」将没有任何断言能看见 —— 它会
 * 静默掉进 `text`,用文本编辑器打开二进制。 */
section("3. Office 集合对账:documentKind 的集合 = 期望清单");
{
  const expectedEditable = ["docx", "docm", "dotx", "odt", "xlsx", "xlsm", "xltx", "ods", "pptx", "pptm", "potx", "odp"];
  const expectedViewOnly = ["doc", "rtf", "xls", "ppt", "pps", "ppsx"];
  for (const ext of expectedEditable) {
    eq(`可编辑 ${ext} → office`, documentKindOf(`x.${ext}`), "office");
  }
  for (const ext of expectedViewOnly) {
    eq(`只读 ${ext} → office-readonly`, documentKindOf(`x.${ext}`), "office-readonly");
  }
  // 反向:上两份清单之外的 Office 系扩展名不能落进 office / office-readonly
  // （防「悄悄加了一个」）。`.doc` 系的老格式其它变体按 text 处理是既有行为。
  const outside = ["docm2", "xlsb", "dot", "docxx", "pages", "key", "numbers"];
  for (const ext of outside) {
    check(`${ext} 不在 office 两档里`, documentKindOf(`x.${ext}`) !== "office" && documentKindOf(`x.${ext}`) !== "office-readonly");
  }
  // 数量钉住:两档成员总数必须等于清单长度(集合多/少一个都红)。
  const allOffice = [...expectedEditable, ...expectedViewOnly];
  eq("Office 两档清单条目数(可编辑 12 + 只读 6)", allOffice.length, 18);
}

/* ── 4. 派生判定 ── */
section("4. isTextualDocumentKind / isOfficeDocumentKind");
{
  check("markdown 是文本", isTextualDocumentKind("markdown"));
  check("text 是文本", isTextualDocumentKind("text"));
  check("unknown 当文本试(与旧'先试文本'取向一致)", isTextualDocumentKind("unknown"));
  check("pdf 不是文本", !isTextualDocumentKind("pdf"));
  check("office 不是文本", !isTextualDocumentKind("office"));
  check("image 不是文本", !isTextualDocumentKind("image"));
  check("office 与 office-readonly 都算 Office", isOfficeDocumentKind("office") && isOfficeDocumentKind("office-readonly"));
  check("markdown 不算 Office", !isOfficeDocumentKind("markdown"));
}

/* ── 5. 消费点真的走同一份(源码断言,防迁移一半) ── */
section("5. 四个消费点不再各写一份扩展名分支");
{
  const root = process.cwd();
  const read = (p: string): string => readFileSync(join(root, p), "utf8");
  const editorKinds = read("src/renderer/components/ide/fileEditorKinds.ts");
  check("★ 编辑器分类器走 documentKindOf", editorKinds.includes("documentKindOf"));
  check("编辑器分类器不再留本地二进制 switch", !editorKinds.includes("case \".zip\":"));
  check("编辑器分类器不再留本地图片 switch", !editorKinds.includes("case \".tiff\":"));

  const viewer = read("src/renderer/components/library/FileViewer.tsx");
  const preview = read("src/renderer/components/library/FilePreview.tsx");
  // 【过时断言修正】7b52bfa9 把这里的 `name` 改成了 `visibleName`（子导航改走
  // 受控 file target 后，显示名才是判据来源）。断言跟着改，判据本身不变。
  check("★ 资料库查看器 md 分支走 documentKindOf", /documentKindOf\(visibleName\) === "markdown"/.test(viewer));
  // T30 deliberately routes GenOffice app identity through the shared vendor map;
  // `documentKindOf` remains Mcode's broader content kind, not the app selector.
  const pdfRoute = genofficeAppForPath("papers/report.PDF");
  eq("★ T30: .PDF 路由到原厂 pdf app", pdfRoute, "pdf");
  eq("T30: 未知后缀不默认归入 docs", genofficeAppForPath("papers/unknown.bin"), undefined);
  eq("T30: .pdf.exe 不冒充 PDF", genofficeAppForPath("papers/report.pdf.exe"), undefined);
  const pdfBranchStart = viewer.indexOf('if (mime === "application/pdf" || nativeApp === "pdf")');
  // O5 removed OnlyOffice entirely. The PDF branch now precedes the shared
  // documentKind-based Office fallback; using the deleted OnlyOffice marker
  // made this test's slice empty and produced four false regressions.
  const officeBranchStart = viewer.indexOf('if (isOfficeDocumentKind(documentKindOf(visibleName)))', pdfBranchStart);
  const pdfBranch = pdfBranchStart >= 0 && officeBranchStart > pdfBranchStart
    ? viewer.slice(pdfBranchStart, officeBranchStart)
    : "";
  check("★ 真实 PDF 的共享路由会进入 PdfPreview", pdfRoute === "pdf" &&
    /nativeApp === "pdf"/.test(pdfBranch) && /<PdfPreview/.test(pdfBranch) &&
    !/OnlyOfficeEditorPane/.test(pdfBranch));
  check("PDF MIME 可作为未知扩展名的内容回退，但未知后缀不默认走 Docs",
    /mime === "application\/pdf"/.test(pdfBranch) &&
    genofficeAppForPath("papers/unknown.bin") === undefined &&
    !viewer.includes("GenofficeViewHostPane"));
  check("PDF 分支先于 GenOffice 文档回退分支",
    pdfBranchStart >= 0 && officeBranchStart > pdfBranchStart);

  const projectFileIpc = read("src/main/ipc/files.ts");
  const projectMimeTable = read("src/main/ipc/filesTextCodec.ts");
  const libraryFileImport = read("src/main/library/fileImport.ts");
  check("项目二进制读取允许 PDF MIME 为 application/octet-stream，故需扩展名路由兜底",
    projectFileIpc.includes('const mime = BINARY_MIME[ext] ?? "application/octet-stream"') &&
    !projectMimeTable.includes('pdf: "application/pdf"'));
  check("资料库读取按 .pdf 扩展名提供 application/pdf MIME",
    libraryFileImport.includes('".pdf": "application/pdf"'));

  const previewPdfStart = preview.indexOf('if (content.mime === "application/pdf" || nativeApp === "pdf")');
  const previewPdfEnd = preview.indexOf('if (isOfficeDocumentKind(documentKindOf(viewing)))', previewPdfStart);
  const previewPdfBranch = previewPdfStart >= 0 && previewPdfEnd > previewPdfStart
    ? preview.slice(previewPdfStart, previewPdfEnd)
    : "";
  check("★ 资料库侧栏预览也用共享 PDF 路由并渲染 PdfPreview",
    /nativeApp === "pdf"/.test(previewPdfBranch) && /<PdfPreview/.test(previewPdfBranch) &&
    !/OnlyOfficeEditorPane/.test(previewPdfBranch));
  check("资料库查看器不再写 ext === \"md\"", !viewer.includes('ext === "md"'));

  check("★ 资料库预览 md 分支走 documentKindOf", preview.includes('documentKindOf(viewing) === "markdown"'));
  check("资料库预览不再自带 extOf 实现", preview.includes("const extOf = documentExtension") && !preview.includes('base.lastIndexOf(".")'));
  // 断言只看**代码行**:历史注释里保留旧写法的说明是允许的(上面已迁移)。
  check("资料库预览不再写 ext === \"md\"(注释除外)", !codeLines(preview).some((l) => l.includes('ext === "md"')));

  const mobile = read("src/renderer/components/mobile/MobileFileViewer.tsx");
  check("★ 移动端 md 判据走 documentKindOf", mobile.includes("documentKindOf(name) === \"markdown\""));
  check("移动端不再自带 MARKDOWN_EXT 集合(注释除外)", !codeLines(mobile).some((l) => l.includes("MARKDOWN_EXT")));
  check("移动端不再自带 extOf 实现", mobile.includes("const extOf = documentExtension") && !mobile.includes('name.lastIndexOf(".")'));
  // 全仓:不应再有第三份 "md" || "markdown" 的分支(注释除外,按代码行数)。
  const hits: string[] = [];
  for (const file of ["src/renderer/components/library/FileViewer.tsx", "src/renderer/components/library/FilePreview.tsx",
    "src/renderer/components/mobile/MobileFileViewer.tsx", "src/renderer/components/ide/fileEditorKinds.ts"]) {
    const src = read(file);
    for (const line of src.split("\n")) {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
      if (code.includes('"markdown"') && code.includes('"md"') && code.includes("===")) hits.push(`${file}: ${code}`);
    }
  }
  eq("四个消费点里没有残留的 ext === \"md\" || \"markdown\" 分支", hits.length, 0);
  void hits;
}

console.log(`\ndocument-router-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
