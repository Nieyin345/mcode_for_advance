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
 * ## 与 Office 引擎的关系（2026-10-24 起）
 *
 * **OnlyOffice 已从产品中移除**（用户裁决：「OnlyOffice删掉，不要了」「现在的 office
 * 还有 md 全部走 genoffice 这一条线」）。Office 文档的唯一 provider 是 **GenOffice**；
 * 本文件的 `"office"` 种类**没有改名**，理由是：
 *
 *  - 这个轴回答的是「这是什么**种类**的文档」，不是「用哪个引擎打开」。引擎/应用
 *    的选择在 `genofficeFileRoute.ts` 的 `genofficeAppForPath`（`GenofficeApp` 轴）
 *    与 `isGenofficeViewAvailableFor`（能力轴）——把引擎名烧进种类值会混淆三条轴。
 *  - `"office"` 一词从未指 OnlyOffice，它指 OOXML/ODF Office 文档；`"office-readonly"`
 *    同理（老版 doc/xls/ppt/rtf 等）。ONLYOFFICE_EDITABLE 只是**当时**那张扩展名表的
 *    来源，不是这个名字的含义。
 *
 * **语义变更（必须记住的差异）**：`"office"` 集合**不再**承诺「装个引擎就能编辑」——
 * 它只回答「这是 Office 格式」。能不能真的打开由上层路由 + 能力位决定，能力不齐时
 * 上层必须**明确报不支持**（不许静默降级）。删除 OnlyOffice 后集合**保持不变**：
 * 收窄会让 `.docm/.dotx/.xltx/.pptm/.potx` 掉进 `text`，用文本编辑器打开二进制。
 */

/** 文档种类 —— 渲染端各入口据此选面板；与具体引擎解耦。 */
export type DocumentKind =
  /** `.md` / `.markdown` —— 可编辑的 Markdown 文档。 */
  | "markdown"
  /** `.pdf` —— 预览/阅读器。 */
  | "pdf"
  /** Office 文档（可结构化读写的 OOXML/ODF，见本文件 `OFFICE_EDITABLE`）。 */
  | "office"
  /** 老版 Office（只能转换后查看，见本文件 `OFFICE_VIEW_ONLY`）。 */
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

/** Office 可编辑扩展名 → 文档类型。**这张表是 (2026-10-24 OnlyOffice 移除后) 契约层
 *  唯一的 Office 扩展名集合**，此前与 `ipc/onlyoffice.ts` 的 `ONLYOFFICE_EDITABLE`
 *  同源对账（那个文件已删）。
 *
 *  ⚠️ **集合刻意保持原样，没有收窄到 `genofficeFileRoute.ts` 的路由集合**：
 *  `genoffice` 的路由更窄（`.docm/.dotx/.xltx/.pptm/.potx` 不在其中），但收窄会让这
 *  五种掉进 `text` → 打开时用文本编辑器读二进制。**「是 Office 格式」与「GenOffice
 *  能不能打开」是两件事**，后者由 `genofficeAppForPath` + 能力位回答，不能打开时
 *  上层明确报不支持（而不是退回文本编辑器读二进制）。 */
const OFFICE_EDITABLE: ReadonlySet<string> = new Set([
  "docx", "docm", "dotx", "odt",
  "xlsx", "xlsm", "xltx", "ods",
  "pptx", "pptm", "potx", "odp",
]);

/** Office 只读（需转换后才能查看）扩展名。理由同 `OFFICE_EDITABLE` 的说明。 */
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

/** 这个种类是否属于 Office 文档（含只读档）。 */
export function isOfficeDocumentKind(kind: DocumentKind): boolean {
  return kind === "office" || kind === "office-readonly";
}

/**
 * 路径最后一段的**格式后缀**：含点、小写；没有点返回空串。
 *
 * ## 与 {@link documentExtension} 的分工（两者只差一个边角，别合并）
 *
 * | 问题 | 用哪个 | `.env` | `.md`（文件名就叫这个） |
 * |---|---|---|---|
 * | 这是一份**什么种类**的文档？ | `documentExtension` / `documentKindOf` | 无扩展名 → unknown | 无扩展名 → unknown |
 * | 这个文件名**以某格式结尾吗**？ | `documentFormatSuffix` / `hasDocumentFormatSuffix` | `.env` | `.md` |
 *
 * 前者按"点文件没有扩展名"的 POSIX/Windows 惯例判（`dot > 0`）；后者回答的是
 * 字面的"结尾是不是这个格式标记"，点文件**也**会命中。渲染端"首次打开默认进哪个视图"
 * 这类判据（历史实现全是 `lower.endsWith(".md")`）属于后者 —— 用前者统一会改变
 * 文件名恰好叫 `.md` / `.png` / `.pdf` 的点文件行为，见 `file-routing-contract-smoke`
 * 的「两条规则各自成立」一节。
 */
export function documentFormatSuffix(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * 路径是否以某个格式后缀结尾（大小写不敏感）。
 *
 * `suffix` 可写 `"md"` 或 `".md"`；与旧实现 `lower.endsWith(".md")` 逐字等价
 * （含点文件名、混合分隔符、多点名），由 `file-routing-contract-smoke` 逐样例对账。
 *
 * 无扩展名的路径返回 `false`（旧 `endsWith` 对空扩展名的路径也恒 false）。
 */
export function hasDocumentFormatSuffix(path: string, suffix: string): boolean {
  const wanted = suffix.startsWith(".") ? suffix : `.${suffix}`;
  return documentFormatSuffix(path) === wanted.toLowerCase();
}

/** Markdown 格式后缀集合（含点）。由 {@link MARKDOWN} 派生 —— 单一来源。 */
const MARKDOWN_SUFFIXES: ReadonlySet<string> = new Set([...MARKDOWN].map((e) => `.${e}`));

/** 图片格式后缀集合（含点）。由 {@link IMAGE} 派生 —— 单一来源。 */
const IMAGE_SUFFIXES: ReadonlySet<string> = new Set([...IMAGE].map((e) => `.${e}`));

/**
 * 「首次打开默认进预览」的二进制文档后缀（含点）。
 *
 * = {@link UNSUPPORTED} ∪ 老版 Office（doc/rtf/xls/ppt）∪ pdf。
 *
 * ⚠️ **与 `documentKindOf` 的种类刻意不同**，两条判据服务两件事（见
 * `sessionStoreHelpers.isUnsupportedPath` 的长注释）：
 * - 这里回答"打开时该不该直接给 Monaco"—— 老 Office 与 PDF 都不该；
 * - `documentKindOf` 回答"这是什么"—— pdf 自成一种、老 Office 是 office-readonly。
 *
 * ⚠️ `.pps` / `.ppsx` 在这张表里**故意缺席**：它们属于 Office 只读档，但历史默认档
 * 表从未列过它们。这是既有行为，本卡不修（见 `file-routing-contract-smoke` 的
 * 已知差异段）。
 */
const BINARY_PREVIEW_SUFFIXES: ReadonlySet<string> = new Set([
  ...[...UNSUPPORTED].map((e) => `.${e}`),
  ".doc", ".rtf", ".xls", ".ppt",
  ".pdf",
]);

function suffixIn(path: string, suffixes: ReadonlySet<string>): boolean {
  const suffix = documentFormatSuffix(path);
  return suffix !== "" && suffixes.has(suffix);
}

/**
 * 路径是否是一份 **Markdown 文档**（`.md` / `.markdown`，大小写不敏感）。
 *
 * 与旧 `isMarkdownPath`（`lower.endsWith(".md") || lower.endsWith(".markdown")`）
 * **逐条等价**，包含文件名恰好是 `.md` 的点文件这个边角（见
 * {@link documentFormatSuffix} 的分工表）。
 */
export function isMarkdownDocumentPath(path: string): boolean {
  return suffixIn(path, MARKDOWN_SUFFIXES);
}

/** 路径是否是一份**图片**（集合与 {@link IMAGE} 同源，大小写不敏感）。 */
export function isImageDocumentPath(path: string): boolean {
  return suffixIn(path, IMAGE_SUFFIXES);
}

/**
 * 路径是否是"首次打开应默认进预览档"的二进制文档 —— 见
 * {@link BINARY_PREVIEW_SUFFIXES} 的集合说明与两处 ⚠️。
 *
 * 旧实现在 `sessionStoreHelpers.isUnsupportedPath` 里有一份逐字相同的后缀数组；
 * 收进契约后集合只有一处，调用方只做翻译。
 */
export function isBinaryPreviewDocumentPath(path: string): boolean {
  return suffixIn(path, BINARY_PREVIEW_SUFFIXES);
}

/**
 * Office 文档的**引擎家族**（docs / sheets / slides），或 `null`（不是 Office 文档）。
 *
 * `documentKindOf` 只回答"是不是 Office"；主进程的结构化读写（`ipc/document.ts` 的
 * `readByKind` / `editByKind`）还要分一层：pptx 不能喂给 docx 解析器。这条分家族
 * 判据原先在两处各抄了一份 `ext === "pptx" || …` 的字面量链 —— 两边漂了的表现是
 * "读走 slides、写走 docs"。
 *
 * 调用方只在 `documentKindOf(path) === "office"`（可编辑档）时才用它分派 ——
 * 只读档（doc/xls/ppt…）根本进不到分派点。因此这里**只列可编辑档**，键集合必须
 * 等于 `OFFICE_EDITABLE`（由 `file-routing-contract-smoke` 逐项对账）。
 */
export type OfficeAppFamily = "docs" | "sheets" | "slides";

/** 可编辑档 → 家族。键集合必须等于 `OFFICE_EDITABLE`（对账见套件）。 */
const OFFICE_FAMILY: Readonly<Record<string, OfficeAppFamily>> = {
  docx: "docs", docm: "docs", dotx: "docs", odt: "docs",
  xlsx: "sheets", xlsm: "sheets", xltx: "sheets", ods: "sheets",
  pptx: "slides", pptm: "slides", potx: "slides", odp: "slides",
};

/** 扩展名 → Office 引擎家族；不是可编辑 Office 文档返回 `null`。 */
export function officeAppFamilyOf(path: string): OfficeAppFamily | null {
  return OFFICE_FAMILY[documentExtension(path)] ?? null;
}
