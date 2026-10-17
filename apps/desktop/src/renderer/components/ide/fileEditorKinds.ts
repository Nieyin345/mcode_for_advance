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

/** `.md` / `.markdown` —— 决定编辑器默认进预览还是源码模式。 */
/** True for `.pdf` —— 默认走预览、渲染分支走 `PdfPreviewPane`。
 *
 *  单独一个函数而不是在两处各写一遍 `extname(...) === ".pdf"`：默认档和渲染分支
 *  必须认**同一个**判据,不然会出现"默认进了预览、预览分支却不认它、掉进 markdown
 *  那一支"。 */
export function isPdfFile(filePath: string): boolean {
  // 【ARC-007】判据收口到 `@contracts/documentKind` —— 与资料库/移动端同一份。
  return documentKindOf(filePath) === "pdf";
}

/** True for `.md` / `.markdown` files - gates Milkdown/source and adapts legacy preview preferences. */
export function isMarkdown(filePath: string): boolean {
  return documentKindOf(filePath) === "markdown";
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
