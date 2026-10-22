/**
 * 【T17】**文件类型路由 = 一份判据**的回归网。
 *
 * 卡面（`tasks/T17-unified-file-routing.md`）要求四件事，本套逐条钉住：
 *
 *  1. **契约层表格**：扩展名 → 期望路由，覆盖六类文档（md/pdf/docx/xlsx/pptx/html）、
 *     图片、二进制、无扩展名、**大写扩展名**、**多点文件名（`a.tar.gz`）**，以及
 *     **大小写策略**（契约层的后缀判据一律大小写不敏感；`documentExtension` 同样先小写）。
 *  2. **两条规则各自成立**：`documentKindOf`（"这是什么种类"，点文件没有扩展名）与
 *     `isMarkdown/ImageDocumentPath`（"文件名以某格式结尾吗"，点文件也命中）**不是同一条**。
 *     历史上渲染端"首次打开默认档"用的是后者；把它错并进前者会让 `.md` 这类点文件变行为。
 *  3. **调用方是薄封装**：bundle **生产源码**里的 `sessionStoreHelpers` 三个函数与
 *     `contentTag.isImageFilePath`，把它们与"改造前逐字实现"逐样例对照 —— 每一条必须
 *     相同（这是行为等价证明的常驻版；一次性对照脚本的证据在任务卡回写区）。
 *  4. **Office 家族对账**：`officeAppFamilyOf` 的键集合必须等于 `OFFICE_EDITABLE`，
 *     且与 `ipc/document.ts` 实际分派一致（`readByKind` 是主进程唯一分派点）。
 *
 * 变异验证（`mutate.py`）：把契约层某条判定改错（如 `.pptx` → docs），本套对应断言
 * 必须真红，然后逐字节还原（`cmp`）。
 *
 * Run: scripts/file-routing-contract-smoke/run.sh
 */
import {
  documentExtension,
  documentKindOf,
  documentFormatSuffix,
  hasDocumentFormatSuffix,
  isMarkdownDocumentPath,
  isImageDocumentPath,
  isBinaryPreviewDocumentPath,
  isTextualDocumentKind,
  isOfficeDocumentKind,
  officeAppFamilyOf,
  type DocumentKind,
} from "@contracts/documentKind";
import { isMarkdownPath, isImagePath, isUnsupportedPath } from "@renderer/stores/sessionStoreHelpers.js";
import { isImageFilePath } from "@renderer/lib/contentTag.js";
import { previewLibraryItem } from "@renderer/lib/libraryPreview.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { libraryAudit, sessionAudit } from "./stubs.js";

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

/* ── 0. 改造前实现（逐字快照；本卡开工时 HEAD 的 sessionStoreHelpers / contentTag） ──
 *
 * 这三个函数是"行为等价证明"的**旧侧**。它们必须与生产侧逐样例同判 —— 任何一条
 * 不一致都说明薄封装改变了行为。保持逐字复制，别顺手"改进"它们：它们是标尺，不是实现。
 */
function legacyIsMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}
function legacyIsImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".svg", ".tif", ".tiff", ".avif",
  ].some((ext) => lower.endsWith(ext));
}
function legacyIsUnsupportedPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [
    ".doc", ".rtf", ".xls", ".ppt",
    ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z", ".bz2", ".xz",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar", ".wasm",
    ".mp3", ".mp4", ".webm", ".avi", ".mov", ".ogg", ".flac", ".wav", ".m4a",
    ".db", ".sqlite", ".sqlite3",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pdf",
  ].some((ext) => lower.endsWith(ext));
}
const LEGACY_CONTENT_TAG_IMAGE = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".tif", ".tiff", ".avif",
]);
function legacyIsImageFilePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return LEGACY_CONTENT_TAG_IMAGE.has(path.slice(dot).toLowerCase());
}
/** `libraryPreview.previewLibraryItem` 改造前的 md 判据（`/\.md$/i`，mdPath 或 filePath）。 */
function legacyPreviewIsMd(item: { mdPath?: string; filePath?: string }): boolean {
  return Boolean((item.mdPath && /\.md$/i.test(item.mdPath)) || (item.filePath && /\.md$/i.test(item.filePath)));
}

/* ── 1. 契约层：扩展名 → 种类（卡面要求的九类边界） ── */
section("1. documentKindOf：六类文档 + 图片 + 二进制 + 无扩展名 + 大写 + 多点");
{
  const cases: Array<[string, DocumentKind]> = [
    // markdown（含大写）
    ["a.md", "markdown"], ["a.MD", "markdown"], ["a.Markdown", "markdown"],
    // pdf
    ["a.pdf", "pdf"], ["a.PDF", "pdf"],
    // office 可编辑三家族
    ["a.docx", "office"], ["a.DOCX", "office"],
    ["a.xlsx", "office"], ["a.XLSX", "office"],
    ["a.pptx", "office"], ["a.PPTX", "office"],
    // office 只读
    ["a.doc", "office-readonly"], ["a.rtf", "office-readonly"],
    ["a.xls", "office-readonly"], ["a.ppt", "office-readonly"],
    // html（六类文档之一）
    ["a.html", "html"], ["a.HTML", "html"], ["a.htm", "html"],
    // 图片
    ["a.png", "image"], ["a.PNG", "image"], ["a.svg", "image"], ["a.avif", "image"],
    // 二进制
    ["a.zip", "unsupported"], ["a.EXE", "unsupported"], ["a.mp4", "unsupported"],
    ["a.ttf", "unsupported"], ["a.sqlite", "unsupported"],
    // 文本（认得的代码/数据扩展名）
    ["a.ts", "text"], ["a.json", "text"], ["a.py", "text"],
    // 无扩展名
    ["Makefile", "unknown"], ["LICENSE", "unknown"], ["dir/", "unknown"],
    // 点文件：不是扩展名
    [".env", "unknown"], [".gitignore", "unknown"],
    // 多点文件名：只看最后一段
    ["a.tar.gz", "unsupported"], ["archive.tar.gz", "unsupported"],
    ["a.report.final.docx", "office"], ["a.b.c.md", "markdown"],
    ["report.", "unknown"], ["a.", "unknown"],
  ];
  for (const [name, kind] of cases) eq(`${name} → ${kind}`, documentKindOf(name), kind);

  // 反向正控：大写与小写必须**同判**（卡面的"大小写策略"）。
  const upperLowerPairs: Array<[string, string]> = [
    ["report.DOCX", "report.docx"], ["deck.PPTX", "deck.pptx"], ["sheet.XLSX", "sheet.xlsx"],
    ["paper.PDF", "paper.pdf"], ["notes.MD", "notes.md"], ["page.HTML", "page.html"],
    ["pic.PNG", "pic.png"], ["bundle.ZIP", "bundle.zip"],
  ];
  for (const [upper, lower] of upperLowerPairs) {
    eq(`大小写等价：${upper} 与 ${lower}`, documentKindOf(upper), documentKindOf(lower));
    eq(`${upper} 的后缀（已小写）`, documentExtension(upper), documentExtension(lower));
  }
}

/* ── 2. 两条规则各自成立（种类 vs 格式后缀） ── */
section("2. documentExtension（种类）与 documentFormatSuffix（后缀）是两条规则");
{
  // 点文件：种类说"没有扩展名"，后缀说"以 .md 结尾"。
  eq("种类：.md 没有扩展名", documentExtension(".md"), "");
  eq("种类：.md → unknown", documentKindOf(".md"), "unknown");
  eq("后缀：.md 以 .md 结尾", hasDocumentFormatSuffix(".md", ".md"), true);
  // 隐藏文件带真扩展名：两条都认得。
  eq("种类：.eslintrc.json → text", documentKindOf(".eslintrc.json"), "text");
  eq("后缀：.eslintrc.json 以 .json 结尾", hasDocumentFormatSuffix(".eslintrc.json", "json"), true);
  // 尾随点 / 空串 / 目录。
  eq("后缀：尾随点 → 空", documentFormatSuffix("report."), ".");
  eq("后缀：无点 → 空", documentFormatSuffix("Makefile"), "");
  eq("后缀：路径里的点不算", documentFormatSuffix("/a.dir/file"), "");
  eq("后缀：两种分隔符都认", documentFormatSuffix("C:\\a\\b.MD"), ".md");
  eq("后缀：多点取最后一段", documentFormatSuffix("a.tar.GZ"), ".gz");
  eq("hasSuffix 无扩展名恒 false", hasDocumentFormatSuffix("Makefile", "md"), false);
  eq("hasSuffix 参数带点不带点等价", hasDocumentFormatSuffix("a.MD", "md"), hasDocumentFormatSuffix("a.MD", ".md"));
}

/* ── 3. 契约层的后缀判据：逐格式表 ── */
section("3. Markdown / 图片 / 二进制预览档：后缀判据逐格式");
{
  const mdTrue = ["a.md", "a.MD", "a.Md", "a.markdown", "a.MARKDOWN", ".md", "dir/a.md", "C:\\d\\a.MD", " a.md"];
  // 前导空格不是"扩展名的一部分"——`endsWith(".md")` 与后缀判据都按"**结尾**是 .md"算，
  // 所以 `" a.md"` 为真。尾随空格则不然（结尾是空格）。两条规则在这点上一致。
  const mdFalse = ["a.mdx", "a.markdownx", "a.md ", "a", "a.txt", "a.markdown.txt"];
  for (const p of mdTrue) eq(`isMarkdownDocumentPath(${JSON.stringify(p)})`, isMarkdownDocumentPath(p), true);
  for (const p of mdFalse) eq(`isMarkdownDocumentPath(${JSON.stringify(p)}) 否`, isMarkdownDocumentPath(p), false);

  const imgTrue = ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.bmp", "a.ico", "a.webp", "a.svg", "a.SVG", "a.tif", "a.tiff", "a.avif", ".png"];
  const imgFalse = ["a.png2", "a.pn", "a", "a.txt", "a.pdf"];
  for (const p of imgTrue) eq(`isImageDocumentPath(${JSON.stringify(p)})`, isImageDocumentPath(p), true);
  for (const p of imgFalse) eq(`isImageDocumentPath(${JSON.stringify(p)}) 否`, isImageDocumentPath(p), false);

  // 二进制预览档 = 压缩/可执行/音视频/字体/库 + 老 Office + pdf。
  const binTrue = [
    "a.zip", "a.gz", "a.tar", "a.tgz", "a.rar", "a.7z", "a.bz2", "a.xz",
    "a.exe", "a.dll", "a.so", "a.dylib", "a.bin", "a.class", "a.jar", "a.wasm",
    "a.mp3", "a.mp4", "a.webm", "a.avi", "a.mov", "a.ogg", "a.flac", "a.wav", "a.m4a",
    "a.db", "a.sqlite", "a.sqlite3", "a.woff", "a.woff2", "a.ttf", "a.otf", "a.eot",
    "a.doc", "a.rtf", "a.xls", "a.ppt", "a.pdf", "a.PDF", "a.tar.gz",
  ];
  for (const p of binTrue) eq(`isBinaryPreviewDocumentPath(${JSON.stringify(p)})`, isBinaryPreviewDocumentPath(p), true);
  // 已知差异（本卡不修，见回写区 B2）：`.pps` / `.ppsx` 是 Office 只读档，
  // 但历史"默认预览档"表从未列过它们，契约层原样保留这一行为。
  const binFalse = ["a.docx", "a.xlsx", "a.pptx", "a.md", "a.png", "a.html", "a", "a.pps", "a.ppsx"];
  for (const p of binFalse) eq(`isBinaryPreviewDocumentPath(${JSON.stringify(p)}) 否`, isBinaryPreviewDocumentPath(p), false);
}

/* ── 4. Office 家族：与可编辑档集合逐项对账 ── */
section("4. officeAppFamilyOf：键集合 = OFFICE_EDITABLE，且分家族正确");
{
  const expected: Record<string, "docs" | "sheets" | "slides"> = {
    docx: "docs", docm: "docs", dotx: "docs", odt: "docs",
    xlsx: "sheets", xlsm: "sheets", xltx: "sheets", ods: "sheets",
    pptx: "slides", pptm: "slides", potx: "slides", odp: "slides",
  };
  for (const [ext, family] of Object.entries(expected)) {
    eq(`${ext} → ${family}`, officeAppFamilyOf(`x.${ext}`), family);
    eq(`${ext.toUpperCase()} 同样 → ${family}`, officeAppFamilyOf(`x.${ext.toUpperCase()}`), family);
    // 双向对账：家族认它 ⟺ documentKindOf 认它是 office。
    eq(`${ext}：家族认它 ⟺ kind 是 office`, documentKindOf(`x.${ext}`) === "office", officeAppFamilyOf(`x.${ext}`) !== null);
  }
  // 只读档与其它种类一律 null —— 家族函数只在 `kind === "office"` 的分派点被调用。
  for (const p of ["x.doc", "x.rtf", "x.xls", "x.ppt", "x.pps", "x.ppsx", "x.pdf", "x.md", "x.html", "x", "x.zip"]) {
    eq(`非可编辑 Office：${p} → null`, officeAppFamilyOf(p), null);
  }
  // 反向：OFFICE_EDITABLE 的每一项都必须有家族（防止哪边加了扩展名另一边忘加）。
  const editable = ["docx", "docm", "dotx", "odt", "xlsx", "xlsm", "xltx", "ods", "pptx", "pptm", "potx", "odp"];
  check("可编辑档全部有家族", editable.every((e) => officeAppFamilyOf(`x.${e}`) !== null));
  eq("家族表不多不少", Object.keys(expected).length, editable.length);
}

/* ── 5. 派生判定 ── */
section("5. isTextualDocumentKind / isOfficeDocumentKind");
{
  check("markdown 是文本", isTextualDocumentKind("markdown"));
  check("text 是文本", isTextualDocumentKind("text"));
  check("unknown 当文本试", isTextualDocumentKind("unknown"));
  check("pdf 不是文本", !isTextualDocumentKind("pdf"));
  check("office 不是文本", !isTextualDocumentKind("office"));
  check("office 与 office-readonly 都算 Office", isOfficeDocumentKind("office") && isOfficeDocumentKind("office-readonly"));
  check("markdown 不算 Office", !isOfficeDocumentKind("markdown"));
}

/* ── 6. 行为等价：生产薄封装 vs 改造前逐字实现 ── */
section("6. 生产薄封装（sessionStoreHelpers / contentTag）与旧实现逐样例同判");
{
  // 语料：每种格式 × 大小写 × 路径形态 × 边角。够宽才配叫"等价证明"。
  const exts = [
    "md", "MD", "Md", "markdown", "MARKDOWN",
    "pdf", "PDF", "docx", "DOCX", "docm", "dotx", "odt", "xlsx", "XLSX", "xlsm", "xltx", "ods",
    "pptx", "PPTX", "pptm", "potx", "odp", "doc", "rtf", "xls", "ppt", "pps", "ppsx",
    "html", "HTML", "htm", "HTM",
    "png", "PNG", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "SVG", "tif", "tiff", "avif",
    "zip", "ZIP", "gz", "tar", "tgz", "rar", "7z", "bz2", "xz",
    "exe", "dll", "so", "dylib", "bin", "class", "jar", "wasm",
    "mp3", "mp4", "webm", "avi", "mov", "ogg", "flac", "wav", "m4a",
    "db", "sqlite", "sqlite3", "woff", "woff2", "ttf", "otf", "eot",
    "ts", "py", "json", "txt", "tex", "bib", "csv",
  ];
  const paths: string[] = [];
  for (const e of exts) paths.push(`a.${e}`, `dir/a.${e}`, `C:\\work\\a.${e}`);
  paths.push(
    "Makefile", "LICENSE", ".env", ".gitignore", ".eslintrc.json",
    "a.tar.gz", "archive.tar.gz", "a.report.final.docx", "a.b.c.md",
    "report.", "a.", "..md", ".md", ".png", ".pdf", ".docx", ".markdown",
    "/abs/a.md", "C:\\work/sub/report.PDF", "C:\\a.dir\\file", "/a/b.dir/file",
    "dir.with.dots/a", "a/b/", "a\\b\\", " spaced .md", "a .md", "a.md ", "a.MD ", " a.md",
    "a.pdf.exe", "a.docx.zip", "a.MD.md", "", "dir/", "dir\\name", "a.md/more", "a.md\\more",
  );
  let mismatches = 0;
  const report = (label: string, p: string, oldVal: boolean, newVal: boolean): void => {
    if (oldVal === newVal) return;
    mismatches++;
    console.log(`  FAIL ${label}（${JSON.stringify(p)}）旧=${oldVal} 新=${newVal}`);
  };
  for (const p of paths) {
    report("isMarkdownPath", p, legacyIsMarkdownPath(p), isMarkdownPath(p));
    report("isImagePath", p, legacyIsImagePath(p), isImagePath(p));
    report("isUnsupportedPath", p, legacyIsUnsupportedPath(p), isUnsupportedPath(p));
    report("isImageFilePath", p, legacyIsImageFilePath(p), isImageFilePath(p));
  }
  check(`★ 行为等价：${paths.length} 条路径 × 4 个判据逐条相同`, mismatches === 0, { mismatches });

  // 大小写等价是**独立**的一条（卡面点名）：同一路径大小写翻转后，生产判据不变。
  for (const e of ["md", "png", "pdf", "docx", "zip", "svg", "markdown", "html"]) {
    eq(`大小写不影响分类：a.${e} vs a.${e.toUpperCase()}`, isMarkdownPath(`a.${e.toUpperCase()}`), isMarkdownPath(`a.${e}`));
    eq(`大小写不影响图片：a.${e}`, isImagePath(`a.${e.toUpperCase()}`), isImagePath(`a.${e}`));
    eq(`大小写不影响默认预览：a.${e}`, isUnsupportedPath(`a.${e.toUpperCase()}`), isUnsupportedPath(`a.${e}`));
  }
}

/* ── 7. libraryPreview 委派后与旧判据同判（顺带证明"图标"真的走生产路径） ── */
section("7. libraryPreview.previewLibraryItem：md 判据委派前后同判");
{
  const cases: Array<{ mdPath?: string; filePath?: string }> = [
    { mdPath: "C:/docs/README.MD" },
    { mdPath: "C:/docs/x.md" },
    { mdPath: "C:/docs/x.markdown" }, // ← 旧式只认 .md，这里必须仍是 meta
    { filePath: "C:/docs/x.md" },
    { filePath: "C:/docs/a.pdf" },
    { mdPath: undefined, filePath: undefined },
    { mdPath: "C:/docs/x.md " },
    { mdPath: "C:/docs/notes/x.MD", filePath: "C:/docs/a.pdf" },
    { filePath: "C:/docs/x.MARKDOWN" }, // ← 同上
  ];
  let mismatches = 0;
  for (const item of cases) {
    libraryAudit.length = 0;
    previewLibraryItem({ id: "t17-fixture", ...item });
    // 生产侧把 md 落到 detailTab "edit"，非 md 落 "meta"。
    const newIsMd = libraryAudit.includes("tab:edit");
    const oldIsMd = legacyPreviewIsMd(item);
    if (newIsMd !== oldIsMd) {
      mismatches++;
      console.log(`  FAIL libraryPreview（${JSON.stringify(item)}）旧=${oldIsMd} 新=${newIsMd}`);
    }
    // 顺带证明两个副作用都发生了（避免"空过"：判据对了但根本没跑到）。
    if (!libraryAudit.includes("id:t17-fixture")) mismatches++;
    if (!sessionAudit.some((e) => e === "right:true")) mismatches++;
  }
  check(`★ libraryPreview：${cases.length} 条与旧判据相同且副作用齐全`, mismatches === 0, { mismatches });
}

/* ── 8. 调用方已委托（源码断言，防"迁移一半又写回去"） ── */
section("8. 消费点不再自带扩展名表（源码断言）");
{
  const root = process.env.MCODE_SMOKE_DESKTOP_ROOT ?? process.cwd();
  const read = (p: string): string => readFileSync(join(root, p), "utf8");
  const helpers = read("src/renderer/stores/sessionStoreHelpers.ts");
  check("★ sessionStoreHelpers 走 isMarkdownDocumentPath", helpers.includes("isMarkdownDocumentPath"));
  check("sessionStoreHelpers 走 isImageDocumentPath", helpers.includes("isImageDocumentPath"));
  check("sessionStoreHelpers 走 isBinaryPreviewDocumentPath", helpers.includes("isBinaryPreviewDocumentPath"));
  check("sessionStoreHelpers 不再留本地图片后缀数组", !helpers.includes('".png", ".jpg", ".jpeg"'));
  check("sessionStoreHelpers 不再留本地二进制后缀数组", !helpers.includes('".zip", ".gz", ".tar"'));
  // 只看**代码行**（注释里保留旧写法的说明是允许的 —— 文件头说明了为什么两条规则
  // 不能合并，那句注释里就引用了 `lower.endsWith(".md")`）。
  const helperCode = helpers.split("\n").map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
  check("sessionStoreHelpers 代码行里不再手写 endsWith(\".md\")",
    !helperCode.some((l) => l.includes('endsWith(".md")')));

  const tag = read("src/renderer/lib/contentTag.ts");
  check("★ contentTag 走 isImageDocumentPath", tag.includes("isImageDocumentPath"));
  check("contentTag 不再留本地图片后缀表", !tag.includes("const IMAGE_EXTENSIONS"));

  const preview = read("src/renderer/lib/libraryPreview.ts");
  check("libraryPreview 走契约层后缀判据", preview.includes("hasDocumentFormatSuffix"));
  // 只查代码行：注释里那(有意的)历史说明会引用旧正则，不算残留。
  const previewCode = preview.split("\n").map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
  check("libraryPreview 代码行里不再手写 /\\.md$/i", !previewCode.some((l) => l.includes("/\\.md$/i")));

  const tab = read("src/renderer/components/customUi/CustomTabView.tsx");
  check("CustomTabView 走 isMarkdownDocumentPath", tab.includes("isMarkdownDocumentPath"));
  check("CustomTabView 不再手写 /\\.(md|markdown)$/i", !tab.includes("/\\.(md|markdown)$/i"));

  const docIpc = read("src/main/ipc/document.ts");
  check("★ ipc/document.ts 走 officeAppFamilyOf", docIpc.includes("officeAppFamilyOf"));
  check("ipc/document.ts 不再手写 pptx 字面量链", !docIpc.includes('ext === "pptx" || ext === "pptm"'));
  check("ipc/document.ts 不再手写 xlsx 字面量链", !docIpc.includes('ext === "xlsx" || ext === "xlsm"'));
}

/* ── 9. 已知差异（记录在案；这些**不是**本轮要修的行为） ── */
section("9. 已知既有差异（本卡不修，回写区记录）");
{
  // ItemDetail.tsx 的 isMdOnly 仍是大小写敏感的 .endsWith(".md")：契约层是大小写不敏感，
  // 委派过去会让 *.MD 条目少显示两块 UI。卡面禁止改用户可见行为 → 保留原样，记候选 B1。
  const itemDetail = readFileSync(join(
    process.env.MCODE_SMOKE_DESKTOP_ROOT ?? process.cwd(),
    "src/renderer/components/library/ItemDetail.tsx",
  ), "utf8");
  check("ItemDetail 的 isMdOnly 仍是原判据（未委派 = 有意）", itemDetail.includes('item.mdPath?.endsWith(".md")'));
  check("…且注释里写明了原因（大小学敏感 → 不能委派）", itemDetail.includes("既有 bug"));
}

console.log(`\nfile-routing-contract-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
