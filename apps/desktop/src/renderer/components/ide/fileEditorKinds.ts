/**
 * `FileEditor.tsx` 尾部的**文件类型分类器**（从 `FileEditor.tsx` 拆出）。
 *
 * 一小组「这个路径该用哪个面板 / 哪个语言」的纯判定：`isPdfFile` /
 * `isMarkdown` / `isImage` / `isUnsupported` / `languageForExt`。它们只吃一个
 * 路径字符串，与编辑器的挂载逻辑、Monaco 实例、store 都没有往来 —— 放在一起读
 * 「一个扩展名会被当成什么」，比埋在一个 2600 行的组件文件末尾里清楚。
 *
 * ⚠️ 这些名字是**被 `FileEditor` 与 `EditPane` 直接调用的**（原文件里 `languageForExt`
 * 一处就有 9 处引用），所以主文件加一段 import 引回来，行为一个字没动。
 *
 * **纯搬迁，函数体逐字节一致。**
 */
import { documentKindOf } from "@contracts/documentKind";
import { genofficeAppForPath, type GenofficeApp } from "@contracts/genofficeFileRoute";
import { isPathWithin, resolveRelativePath } from "@renderer/lib/path.js";

/**
 * 【T101 → O5 批三】「这个文件能不能落 GenOffice 原生视图」—— office 的**默认档**判据。
 *
 * 这是 `notConfigured` 分支那个出口按钮的**唯一判据** —— 判 true 才画按钮。
 * 抽到这里是为了**可被套件直接执行**（`GenofficeViewHostPane` 那边动辄几百行，
 * `FileEditor` 又是 2600 行的组件，套件 import 不动；一份纯判定就没有这个问题）。
 *
 * ## 为什么不能直接用 `nativeViewReady`
 *
 * `nativeViewReady` 对 office 文件只判 `office || …`（`office` =
 * 契约的 Office 种类判据），**不判 `hosts.*`**，两个面因此对不上：
 *
 *  1. **扩展名**：Office 种类表含 `.docm/.dotx/.xltx/.pptm/.potx`，GenOffice 只认
 *     `docx|odt|ott` 等（`@contracts/genofficeFileRoute` 是唯一路由表）。不查 →
 *     按钮出现、点了没反应；
 *  2. **能力**：`hosts.sheets` / `hosts.slidesNative` 在 Rust sidecar 或 vendor
 *     构建产物缺失时为 false。不查 → 切过去是一张降级说明面板。
 *
 * **两种都是「看起来是条路、实际不是」—— 比没有按钮更糟。**
 *
 * ## `docs` 为什么不查 hosts
 *
 * `ipc/document.ts:453` 里 `hosts.docs` 恒为 `true`（docs 走独立通道，不经过
 * `NativeKind`），查它等于查一个常量。
 */
export function isGenofficeViewAvailableFor(input: {
  /** `isOfficeDocumentKind(documentKindOf(filePath))` —— 这个文件是不是 Office 文档。 */
  office: boolean;
  /** GenOffice CLI 就绪 **且** 该类文件有宿主对端（`FileEditor` 的 `nativeViewReady`）。 */
  nativeViewReady: boolean;
  /** `genofficeAppForPath(filePath)` —— 扩展名的 GenOffice 路由。 */
  host: GenofficeApp | undefined;
  /** `document.capabilities().hosts`（可能尚未加载）。 */
  hosts: Partial<Record<"docs" | "pdf" | "markdown" | "html" | "sheets" | "slides" | "slidesNative", boolean>> | undefined;
}): boolean {
  const { office, nativeViewReady, host, hosts } = input;
  if (!office || !nativeViewReady || host === undefined) return false;
  // 这条出口只服务 Office 文档；pdf/markdown/html 走它们自己的默认档，不在这里。
  if (host === "pdf" || host === "markdown" || host === "html") return false;
  if (host === "docs") return true;
  if (host === "sheets") return hosts?.sheets === true;
  // slides：`slidesNative` 是 T28 的原生视图位，`slides` 是早先的 vendor 执行器位。
  // 任一为真都能开（两条路都在，见 T94）。
  return hosts?.slidesNative === true || hosts?.slides === true;
}

/* ── 【ARC-005】HTML 本地预览入口的接受判据 ──
 *
 * 参考矩阵「能立即做 4」：文件树右键已有「在浏览器中打开」，但编辑器/预览面
 * 没有入口。这里只回答「这个文件现在能不能交给浏览器面板预览」，不做 I/O。
 *
 * 为什么复用浏览器面板而不是新开视图：Mcode 的本地网页预览已有唯一通路
 * `sessionStore.openUrlInBrowser` → 右栏 BrowserPanel → BrowserManager 的
 * WebContentsView。新建「预览专用视图」会多一份创建/销毁/边界/遮挡生命周期，
 * 与现有面板重复。本切片只补入口 + 围栏，加载仍走既有通路。
 *
 * 安全边界（不新增特权）：① 只接受项目根内的路径（`isPathWithin`，与主进程
 * `pathGuard.pathWithin` 同一判据的渲染端镜像）；② 只接受
 * `documentKindOf === "html"`；③ 页面在浏览器面板里加载，沿用该面板既有的
 * 加载/导航策略，不注入脚本、不放开权限。 */

export type HtmlPreviewRejection = "not-html" | "outside-workspace";
export type HtmlPreviewDecision = { ok: true } | { ok: false; reason: HtmlPreviewRejection };

/**
 * 这个文件能否用浏览器面板预览。顺序刻意是「种类 → 围栏」：非 html 的文件
 * 不管在不在工作区里都不该进这个入口（防空过 —— 把 `.pdf` 送进浏览器面板会
 * 绕过 `PdfPreview` 的读取与报错）。
 */
export function htmlPreviewDecision(filePath: string, projectPath: string): HtmlPreviewDecision {
  if (genofficeAppForPath(filePath) !== "html") return { ok: false, reason: "not-html" };
  // 先折叠 `.` / `..`（`isPathWithin` 是**词法**段比较，不做规范化）—— 否则
  // `proj/../other/x.html` 会以 `proj` 前缀混过去。绝对路径在 resolveRelativePath
  // 里原地规范化，不会被 baseDir 拼接。
  if (!projectPath) return { ok: false, reason: "outside-workspace" };
  const normFile = resolveRelativePath("", filePath);
  if (!isPathWithin(projectPath, normFile)) {
    return { ok: false, reason: "outside-workspace" };
  }
  return { ok: true };
}

/** 便捷判据：入口按钮是否显示。 */
export function canPreviewHtml(filePath: string, projectPath: string): boolean {
  return htmlPreviewDecision(filePath, projectPath).ok;
}


/** `.md` / `.markdown` —— 决定编辑器默认进预览还是源码模式。 */
/** True for `.pdf` —— 默认走预览、渲染分支走 `PdfPreviewPane`。
 *
 *  单独一个函数而不是在两处各写一遍 `extname(...) === ".pdf"`：默认档和渲染分支
 *  必须认**同一个**判据,不然会出现"默认进了预览、预览分支却不认它、掉进 markdown
 *  那一支"。 */
export function isPdfFile(filePath: string): boolean {
  // 【ARC-007】判据收口到 `@contracts/documentKind` —— 与资料库/移动端同一份。
  return genofficeAppForPath(filePath) === "pdf";
}

/** True for `.md` / `.markdown` files - gates Milkdown/source and adapts legacy preview preferences. */
export function isMarkdown(filePath: string): boolean {
  // Vendor also handles txt/json in its Markdown app; those stay source text
  // in the IDE, not Milkdown. UI kind and vendor routing are separate policies.
  return genofficeAppForPath(filePath) === "markdown" && documentKindOf(filePath) === "markdown";
}

/** True for image files the editor can preview via the `app-resource://`
 *  protocol (binary files served from the main process). SVG is text but also
 *  renders as an image, so it's included. */
export function isImage(filePath: string): boolean {
  return documentKindOf(filePath) === "image";
}

/** True for binary file types the editor can neither edit (Monaco is text-only)
 *  nor meaningfully preview (no built-in renderer). These get a friendly
 *  "can't preview" pane instead of garbled Monaco content. Covers Office docs,
 *  archives, binaries, audio/video, and databases. */
export function isUnsupported(filePath: string): boolean {
  // 【ARC-007】集合收进契约包（`UNSUPPORTED`），本函数只做翻译。
  return documentKindOf(filePath) === "unsupported";
}

/**
 * 历史上这里是 24 行 switch 的二进制扩展名表（压缩包/可执行/音视频/字体/数据库）——
 * 【ARC-007】集合已收进 `@contracts/documentKind` 的 `UNSUPPORTED`，本文件只留翻译。
 * 那条「`.pdf` 从这张表里拿掉（2026-09-21）」的决定也随集合迁移，见该文件注释。
 */

/** Map a file extension to a Monaco language id. Covers the common cases;
 *  unknown extensions fall back to plaintext (Monaco's default). */
export function languageForExt(ext: string): string {
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".css":
      return "css";
    case ".scss":
      return "scss";
    case ".less":
      return "less";
    case ".html":
    case ".htm":
      return "html";
    case ".xml":
    case ".svg":
      return "xml";
    case ".py":
      return "python";
    case ".rb":
      return "ruby";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".kt":
      return "kotlin";
    case ".swift":
      return "swift";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
    case ".cc":
    case ".cxx":
    case ".hpp":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".php":
      return "php";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "shell";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "ini";
    case ".ini":
    case ".cfg":
    case ".conf":
      return "ini";
    case ".sql":
      return "sql";
    case ".dockerfile":
      return "dockerfile";
    case ".vue":
      return "html";
    default:
      return "plaintext";
  }
}
