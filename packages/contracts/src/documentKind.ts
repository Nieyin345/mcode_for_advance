/**
 * **文档种类的唯一判据**（ARC-007「消除工作区/资料库/移动端各写一次」）。
 *
 * ## 它补的洞
 *
 * 在引入本文件之前，同一件事在四处各写了一遍：
 *
 * | 位置 | 判据 |
 * |---|---|
 * | `renderer/components/ide/fileEditorKinds.ts` | `isMarkdown` / `isPdfFile` / `isImage` |
 * | `renderer/components/library/FilePreview.tsx` | 自带 `extOf` + `ext === "md"` |
 * | `renderer/components/library/FileViewer.tsx` | `extOf`（store 版）+ `ext === "md"` |
 * | `renderer/components/mobile/MobileFileViewer.tsx` | 自带 `extOf` + `MARKDOWN_EXT` |
 *
 * 它们当时"恰好一致"，但没有任何机制保证下一次改一处时另外三处会跟上 —— 这正是
 * 台账点名的「同一格式在三个入口各判一次」缺陷。现在格式 → 种类只有一个函数
 * （{@link documentKindOf}），渲染端各入口只**消费**它的结论。
 *
 * ## 为什么不放在 `node:path` 之上
 *
 * 契约包同时被渲染端（浏览器环境）与主进程消费，不能 import `node:path`。扩展名解析
 * 在这里是纯字符串操作（两种分隔符都认，与 Windows 原生路径兼容）。
 *
 * ## 与 OnlyOffice 的关系（过渡期）
 *
 * `office` 种类目前由 OnlyOffice 承载；ARC-007 的 GenOffice 迁移会逐格式换上新的
 * provider，但**种类判据不变** —— 调用方问的是"这是什么种类的文档"，而不是"用哪个引擎"。
 * 引擎选择属于 `documentKindOf` 之上的 provider 路由（后续切片），不混进这个纯函数。
 */

/** 文档种类 —— 渲染端各入口据此选面板；与具体引擎解耦。 */
export type DocumentKind =
  /** `.md` / `.markdown` —— 可编辑的 Markdown 文档。 */
  | "markdown"
  /** `.pdf` —— 预览/阅读器。 */
  | "pdf"
  /** Office 文档（DS 可编辑的 OOXML/ODF，见 `ONLYOFFICE_EDITABLE`）。 */
  | "office"
  /** 老版 Office（DS 只能转换后查看，见 `ONLYOFFICE_VIEW_ONLY`）。 */
  | "office-readonly"
  /** 图片（编辑器可经 `app-resource://` 预览）。 */
  | "image"
  /** 浏览器可直接渲染的网页文档。 */
  | "html"
  /** `LANG_BY_EXT` 认识的纯文本/代码。 */
  | "text"
  /** 明确不支持预览的二进制（压缩包/可执行/音视频/字体/数据库）。 */
  | "unsupported"
  /** 未知扩展名 —— 调用方按"先试文本、失败再二进制"处理。 */
  | "unknown";

/**
 * 取路径的扩展名：小写、不含点；无扩展名返回空串。
 *
 * 规则与四处旧实现逐字对齐：只看最后一个路径段；`".env"` 这类**以点开头且没有
 * 其它点**的文件返回空串（旧实现的 `dot > 0` 判据；`dot === 0` 是隐藏文件名，
 * 不是扩展名）。
 */
export function documentExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Office 可编辑扩展名 → 文档类型。与 `ipc/onlyoffice.ts` 的 `ONLYOFFICE_EDITABLE`
 *  **同源**：那张表是 DS 的引擎契约，这里只把它翻译成"种类"。为避免循环 import
 *  把表在契约包里再写一遍 —— 两份表**必须**一起改，故由 `document-router-smoke`
 *  逐项对账（两边不一致即红）。 */
const OFFICE_EDITABLE: ReadonlySet<string> = new Set([
  "docx", "docm", "dotx", "odt",
  "xlsx", "xlsm", "xltx", "ods",
  "pptx", "pptm", "potx", "odp",
]);

/** Office 只读（DS 转换后查看）扩展名，同源上面的说明。 */
const OFFICE_VIEW_ONLY: ReadonlySet<string> = new Set(["doc", "rtf", "xls", "ppt", "pps", "ppsx"]);

/** 图片扩展名 —— 与 `fileEditorKinds.isImage` 的集合逐项一致（含 svg/tif/tiff/avif）。 */
const IMAGE: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg", "tif", "tiff", "avif",
]);

/** 明确不支持预览的二进制 —— 与 `fileEditorKinds.isUnsupported` 的集合逐项一致。
 *  ⚠️ 刻意**不含** `.pdf`（2026-09-21 起归 `pdf` 种类）与 Office 扩展名。 */
const UNSUPPORTED: ReadonlySet<string> = new Set([
  "zip", "gz", "tar", "tgz", "rar", "7z", "bz2", "xz",
  "exe", "dll", "so", "dylib", "bin", "class", "jar", "wasm",
  "mp3", "mp4", "webm", "avi", "mov", "ogg", "flac", "wav", "m4a",
  "db", "sqlite", "sqlite3",
  "woff", "woff2", "ttf", "otf", "eot",
]);

/** 浏览器可渲染的网页文档。 */
const HTML: ReadonlySet<string> = new Set(["html", "htm"]);

/** Markdown。 */
const MARKDOWN: ReadonlySet<string> = new Set(["md", "markdown"]);

/**
 * **路径 → 文档种类**。所有入口（工作区编辑器、资料库预览/查看器、移动端、聊天文件卡）
 * 都必须经它判断，不再各自写扩展名分支。
 *
 * 优先级（先命中先返回）：markdown → pdf → office-readonly → office → image → html →
 * unsupported → text → unknown。`office-readonly` 排在 `office` 之前只是因为两集合
 * 不相交，顺序不影响结果（保留顺序是为了读起来与 DS 的编辑/只读分档一致）。
 *
 * 注意 `.md` 同时是 Markdown 和文本 —— 这里**先**判 markdown，调用方若只是"能不能当
 * 文本读"应看 `kind === "markdown" || kind === "text" || kind === "unknown"`。
 */
export function documentKindOf(path: string): DocumentKind {
  const ext = documentExtension(path);
  if (ext === "") return "unknown";
  if (MARKDOWN.has(ext)) return "markdown";
  if (ext === "pdf") return "pdf";
  if (OFFICE_VIEW_ONLY.has(ext)) return "office-readonly";
  if (OFFICE_EDITABLE.has(ext)) return "office";
  if (IMAGE.has(ext)) return "image";
  if (HTML.has(ext)) return "html";
  if (UNSUPPORTED.has(ext)) return "unsupported";
  return "text";
}

/** 这个种类能否作为普通文本读（编辑器源码模式、资料库 `<pre>`、移动端高亮）。
 *  `unknown` 返回 true —— 与旧实现"先试文本、抛了再二进制"的取向一致。 */
export function isTextualDocumentKind(kind: DocumentKind): boolean {
  return kind === "markdown" || kind === "text" || kind === "unknown";
}

/** 这个种类是否由 Office 引擎承载（含只读档）。 */
export function isOfficeDocumentKind(kind: DocumentKind): boolean {
  return kind === "office" || kind === "office-readonly";
}
