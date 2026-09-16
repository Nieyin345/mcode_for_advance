/**
 * Content-tag model - a pasted chunk that's been promoted from "inline text"
 * to a small chip displayed above the textarea.
 *
 * Why: long pastes (logs, stack traces, file contents) bury the input area
 * and crowd out the visible message stream. Promoting them to tags keeps the
 * composer compact and lets the user click a chip to inspect or remove the
 * payload before sending.
 *
 * State is owned by the composer (ChatPane); it is intentionally not in the
 * Zustand store because it's ephemeral per-turn UI state, not session data.
 */
import type { PickedElement } from "@contracts/ipc";
import {
  TEMPLATE_KEY_PREFIX,
  isTemplateKind,
  templateAttachKey,
  type TemplateKind,
} from "@contracts/templates";
import { browserUuid } from "@renderer/lib/uuid.js";

/** Display char count for a tag's preview text. Single line, whitespace
 *  collapsed; an ellipsis is appended if the original was longer. */
export const TAG_PREVIEW_CHARS = 24;

/** Custom DataTransfer MIME type used by the file-tree → composer drag.
 *  Using a custom type (instead of text/plain) ensures only OUR file nodes
 *  trigger a drop — external text/image drags are ignored by the composer. */
export const FILE_DRAG_MIME = "application/x-file-path";

/** Pasting a single-line shorter than this is left inline in the textarea
 *  (no chip). Anything over this OR a paste with more than
 *  {@link TAG_THRESHOLD_LINES} lines becomes a tag. */
export const TAG_THRESHOLD_CHARS = 200;

/** Image file extensions we can preview as a data-URL `<img>` in the popover /
 *  chip. Mirrors the editor's `isImage()` set (FileEditor.tsx) so composer
 *  chips, message attachment cards, and the IDE editor all agree on what
 *  counts as an image. */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".tif",
  ".tiff",
  ".avif",
]);

/** True if `path` has a previewable image extension (case-insensitive). */
export function isImageFilePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** A paste spanning more than this many lines is promoted to a tag even if
 *  it's short — long logs / stack traces get chipped regardless of char
 *  count. A 2-3 line snippet stays inline so the user isn't interrupted
 *  for ordinary multi-line pastes. */
export const TAG_THRESHOLD_LINES = 3;

/** Source of the tag: "paste" for bulky clipboard content, "file" for a
 *  file dragged in from the file tree (path reference only - no content
 *  is read), "element" for a DOM element picked from the embedded browser
 *  (selector + outerHTML inlined so the model can see it), "library" for a
 *  文献库 (path reference to its generated manifest - same mechanism as
 *  "file", see makeLibraryTag), "template" for a 模版库条目 (same mechanism
 *  again - see makeTemplateTag). */
export type ContentTagKind = "paste" | "file" | "element" | "library" | "template";

/** One content tag. `id` is the React key + removal handle. `content` is the
 *  full pasted text (for paste) or the `@path` reference string (for file /
 *  library / template), sent verbatim on Send. `preview` is for chip display.
 *  `filePath` is only set for file tags (the absolute path of the dragged
 *  file). */
export interface ContentTag {
  id: string;
  kind: ContentTagKind;
  preview: string;
  content: string;
  /** Absolute path of the dragged file. Only set when kind === "file". */
  filePath?: string;
  /**
   * **附件键**。kind === "library" 时用它去重、排除已添加、以及 picker 里的选中态。
   * 三种形态(与主进程 `library/manifest.ts` 的解析逐字对应):
   *   `c:<分类 id>` —— 挂一个分类(整库清单)
   *   `i:<条目 id>` —— 挂单独一篇(单条清单)
   *   `k:<库>`      —— 挂整个库(「全部文献 / 全部教材 / 全部笔记」那一行)
   * 键里带前缀是因为分类和条目是两张表,id 谁也不能保证不撞;`k` 那一路的值域更小
   * (只有三个库名),混在一起同样会撞。
   */
  collectionId?: string;
  /** 模版条目的唯一键。kind === "template" 时设置,用于去重 —— 不同类目下同名是
   *  两条不同的模版,所以键里必须带类目。两种形态:`t:<类目>`(整个类目)、
   *  `t:<类目>/<目录名>`(一条模版),与主进程的 `templateAttachKey` 同构。 */
  templateKey?: string;
}

/** Decide whether a pasted string should become a tag rather than be
 *  inserted into the textarea. Empty / whitespace-only is never a tag.
 *  Promote only when the paste is genuinely bulky: over the char threshold
 *  OR spanning more than the line threshold. Short multi-line snippets
 *  (2-3 lines) stay inline so ordinary pastes aren't interrupted. */
export function shouldPromoteToTag(text: string, thresholdChars: number = TAG_THRESHOLD_CHARS): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > thresholdChars) return true;
  // Count lines: a string with N newlines has N+1 lines, but a trailing
  // newline (already trimmed away) shouldn't inflate the count.
  const lineCount = t.split("\n").length;
  return lineCount > TAG_THRESHOLD_LINES;
}

/** Build a ContentTag from a raw pasted string. Trims and collapses
 *  whitespace for the preview; the full content is preserved untouched. */
export function makeContentTag(text: string): ContentTag {
  const trimmed = text.trim();
  // Collapse internal whitespace so the preview fits on one chip line and
  // the chip width stays bounded. The full content is kept verbatim — that
  // is what gets sent to the SDK.
  const collapsed = trimmed.replace(/\s+/g, " ");
  const preview =
    collapsed.length > TAG_PREVIEW_CHARS
      ? collapsed.slice(0, TAG_PREVIEW_CHARS) + "…"
      : collapsed;
  return {
    id: cryptoRandomId(),
    kind: "paste",
    preview,
    content: trimmed,
  };
}

/** Build a ContentTag for a file dragged in from the file tree. Unlike paste
 *  tags, a file tag carries only a PATH reference (the agent reads the file
 *  itself via its tools) - no file content is loaded. `preview` is the base
 *  file name; `content` is the `@path` reference injected into the prompt.
 *
 *  `displayName` overrides the preview when the path's basename isn't
 *  user-meaningful — clipboard-pasted external files are materialized to a
 *  random temp path by main, so the card must show the ORIGINAL file name. */
export function makeFileTag(filePath: string, displayName?: string): ContentTag {
  // Derive a short display name from the last path segment (handles both /
  // and \ separators for cross-platform paths).
  const segs = (displayName ?? filePath).split(/[/\\]/);
  const name = segs[segs.length - 1] || filePath;
  const preview =
    name.length > TAG_PREVIEW_CHARS ? name.slice(0, TAG_PREVIEW_CHARS) + "…" : name;
  return {
    id: cryptoRandomId(),
    kind: "file",
    preview,
    content: `@${filePath}`,
    filePath,
  };
}

/** True for a file tag whose path is a previewable image. Used by TagPopover
 *  to render an `<img>` instead of the raw `@path` text, and by the chip to
 *  swap in a photo icon. */
export function isImageFile(tag: ContentTag): boolean {
  return tag.kind === "file" && !!tag.filePath && isImageFilePath(tag.filePath);
}

/**
 * 把「文献库」加成 tag。
 *
 * 机制**刻意与 file tag 完全一致**:content 是一行 `@<清单文件路径>`,不内联任何
 * 正文 —— agent 用 Read 工具自己去读那份清单(清单里列了这个库有哪些文献、
 * 各自的 PDF 绝对路径)。这样加十个库进上下文也不会把提示词撑爆。
 *
 * `manifestPath` 由主进程的 `library.manifest` 生成(每次调用重写,保证不过期)。
 */
export function makeLibraryTag(params: {
  collectionId: string;
  name: string;
  /** 主进程生成的清单文件绝对路径。 */
  manifestPath: string;
}): ContentTag {
  const preview =
    params.name.length > TAG_PREVIEW_CHARS
      ? params.name.slice(0, TAG_PREVIEW_CHARS) + "…"
      : params.name;
  return {
    id: cryptoRandomId(),
    kind: "library",
    preview,
    content: `@${params.manifestPath}`,
    collectionId: params.collectionId,
  };
}

/** 追加文献库 tag,跳过已存在的(按 collectionId 去重)。 */
export function appendUniqueLibraryTags(
  prev: ReadonlyArray<ContentTag>,
  additions: ReadonlyArray<{ collectionId: string; name: string; manifestPath: string }>,
): ContentTag[] {
  const seen = new Set(
    prev.filter((t) => t.kind === "library" && t.collectionId).map((t) => t.collectionId as string),
  );
  const next = [...prev];
  for (const a of additions) {
    if (!a.collectionId || seen.has(a.collectionId)) continue;
    seen.add(a.collectionId);
    next.push(makeLibraryTag(a));
  }
  return next;
}

/**
 * 把「模版库」里的一条模版加成 tag —— **机制与文献库逐字相同**。
 *
 * content 是一行 `@<清单文件路径>`,不内联正文。清单由主进程的
 * `templates.manifest` 生成,里面列了这条模版的全部文件、绝对路径、以及 40KB 以内
 * 文本文件的**正文**(`main/templates/store.ts` 的 `writeTemplateManifest`)。
 *
 * 为什么不直接把模版文件摊成多个 file tag:一条模版是一**包**文件(LaTeX 常常是
 * `.cls` + `.tex` + 图),拆开加进去会丢掉"它们是一套"这件事 —— 而模版的意义恰恰
 * 就是照着这一套抄。清单里已经把这一套连同正文一起给全了。
 */
export function makeTemplateTag(params: {
  /** 类目 —— 只用来算去重键和 tooltip,展示名走 dirName。 */
  kind: TemplateKind;
  /** 一条模版的目录名。**省略 = 整个类目**(清单是"这个类目下有哪些模版"的索引)。 */
  dirName?: string;
  /** chip 上的字。整个类目时由调用方给(那一层没有 i18n,而类目名在界面上有)。 */
  label?: string;
  /** 清单文件绝对路径,由主进程生成。 */
  manifestPath: string;
}): ContentTag {
  // 展示名就是磁盘上的目录名(模版库的设计:目录名即显示名);整个类目时用 label
  const name = params.dirName ? params.dirName : (params.label ?? params.kind);
  const preview =
    name.length > TAG_PREVIEW_CHARS ? name.slice(0, TAG_PREVIEW_CHARS) + "…" : name;
  return {
    id: cryptoRandomId(),
    kind: "template",
    preview,
    content: `@${params.manifestPath}`,
    templateKey: templateAttachKey(params.kind, params.dirName),
  };
}

/** 追加模版 tag,跳过已存在的(按 `t:<类目>[/<目录名>]` 去重)。 */
export function appendUniqueTemplateTags(
  prev: ReadonlyArray<ContentTag>,
  additions: ReadonlyArray<{
    kind: TemplateKind;
    dirName?: string;
    label?: string;
    manifestPath: string;
  }>,
): ContentTag[] {
  const seen = new Set(
    prev.filter((t) => t.kind === "template" && t.templateKey).map((t) => t.templateKey as string),
  );
  const next = [...prev];
  for (const a of additions) {
    const key = templateAttachKey(a.kind, a.dirName);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(makeTemplateTag(a));
  }
  return next;
}

/**
 * 按**附件键**追加一条模版 tag —— 主进程 `composer:attach` 的渲染端落点。
 *
 * 键是 `t:<类目>`(整个类目)或 `t:<类目>/<目录名>`(一条模版),见 `templateAttachKey`(contracts)。
 * 前缀不对、或类目为空,就当没收到 —— 宁可什么都不加,也不要落一个怪 chip。
 *
 * `label` 是主进程随消息一起发过来的显示名(整个类目时是"论文 LaTeX"这种),只在
 * 整个类目那条路上用得到:一条模版的显示名就是目录名,主进程给的一样。
 */
export function appendTemplateTagByKey(
  prev: ReadonlyArray<ContentTag>,
  key: string,
  manifestPath: string,
  label?: string,
): ContentTag[] {
  if (!key.startsWith(TEMPLATE_KEY_PREFIX)) return [...prev];
  const rest = key.slice(TEMPLATE_KEY_PREFIX.length);
  const slash = rest.indexOf("/");
  // 类目必须是五个之一 —— 键是跨进程来的,不能拿它当可信输入(认不出来就什么都不加)
  const rawKind = slash < 0 ? rest : rest.slice(0, slash);
  if (!isTemplateKind(rawKind)) return [...prev];
  const kind: TemplateKind = rawKind;
  const dirName = slash < 0 ? undefined : rest.slice(slash + 1);
  return appendUniqueTemplateTags(prev, [
    { kind, dirName: dirName || undefined, label, manifestPath },
  ]);
}

/** Build a ContentTag for a DOM element picked from the embedded browser. The
 *  selector + outerHTML + source URL are inlined into the prompt (delimited
 *  block, like paste) so the model can reason about the element directly.
 *  `preview` is a short selector + tag hint for the chip. */
export function makeElementTag(el: PickedElement): ContentTag {
  const preview =
    el.preview.length > TAG_PREVIEW_CHARS
      ? el.preview.slice(0, TAG_PREVIEW_CHARS) + "…"
      : el.preview;
  // Delimited block mirroring the paste format, but labeled as a page element
  // with its selector + source URL so the model knows exactly what it's seeing.
  const content = `--- 页面元素 (${el.selector}) ---\n来源: ${el.url}\n${el.outerHTML}\n--- end ---`;
  return {
    id: cryptoRandomId(),
    kind: "element",
    preview,
    content,
  };
}

/** Browser-safe UUID — delegates to the shared {@link browserUuid} helper. */
function cryptoRandomId(): string {
  return browserUuid();
}

/** Compose the final prompt string from the textarea text + all tags.
 *  Tags are appended so the model can clearly see "user typed X, plus these
 *  N attachments". Order: typed text first, then tags in array order.
 *
 *  - Paste tags become delimited content blocks (full text wrapped in
 *    `--- pasted content N ---` / `--- end ---` markers).
 *  - Element tags become delimited blocks too, but labeled as page elements
 *    (the content is already pre-formatted by makeElementTag - we emit it
 *    verbatim so the selector + URL + outerHTML stay together).
 *  - File tags become bare `@path` reference lines (one per line) - the
 *    agent reads the file itself via its tools, so no content is inlined. */
export function composePromptWithTags(
  text: string,
  tags: ReadonlyArray<ContentTag>,
): string {
  const textTrimmed = text.trim();
  if (tags.length === 0) return textTrimmed;
  // Separate paste blocks (delimited) from file refs (bare @path lines).
  // We preserve the original tag order by walking the array and emitting
  // each tag's contribution in sequence, joined by blank lines.
  const parts: string[] = [];
  let pasteIdx = 0;
  for (const tag of tags) {
    if (tag.kind === "file") {
      parts.push(tag.content); // already "@path"
    } else if (tag.kind === "library" || tag.kind === "template") {
      // 与 file 同款:只放一行 `@清单路径`,内容由 agent 自己读。
      parts.push(tag.content);
    } else if (tag.kind === "element") {
      // Element content is already a fully-formatted delimited block.
      parts.push(tag.content);
    } else {
      pasteIdx += 1;
      parts.push(
        `--- pasted content ${pasteIdx} (${tag.content.length} chars) ---\n${tag.content}\n--- end ---`,
      );
    }
  }
  const tagBlock = parts.join("\n\n");
  return textTrimmed ? `${textTrimmed}\n\n${tagBlock}` : tagBlock;
}

/** Append file tags, skipping paths already present (by absolute filePath). */
export function appendUniqueFileTags(
  prev: ReadonlyArray<ContentTag>,
  filePaths: ReadonlyArray<string>,
): ContentTag[] {
  const seen = new Set(
    prev.filter((t) => t.kind === "file" && t.filePath).map((t) => t.filePath as string),
  );
  const next = [...prev];
  for (const p of filePaths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    next.push(makeFileTag(p));
  }
  return next;
}
