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
 *  资料库 (path reference to its generated manifest - same mechanism as
 *  "file", see makeLibraryTag), "quote" for a passage the user selected and
 *  quoted in (carries its own origin header - see makeQuoteTag).
 *  ("template" —— 独立模版库的 tag —— 随 2026-09-27 模版库退役一起删除;模版现在
 *  是资料库里的普通分类,走 "library"。) */
export type ContentTagKind = "paste" | "file" | "element" | "library" | "quote";

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
   * 四种形态(与主进程 `library/manifest.ts` 的解析逐字对应):
   *   `c:<分类 id>` —— 挂一个分类(整库清单)
   *   `i:<条目 id>` —— 挂单独一篇(单条清单)
   *   `k:<库>`      —— 挂整个库(「全部文献 / 全部教材 / 全部笔记」那一行)
   *   `g:<大类 id>` —— 挂整个大类(左栏那一段,含段下所有小类)
   * 键里带前缀是因为分类和条目是两张表,id 谁也不能保证不撞;`k` 那一路的值域更小
   * (只有三个库名),混在一起同样会撞。
   *
   * 这个字段存的是**原文**,不解析 —— 去重就是比字符串,所以加一级只改上面这份
   * 词汇表,这个类型本身不必动。
   */
  collectionId?: string;
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

/**
 * 一段引用**是从哪来的** —— 决定提示词里那句"这是从哪儿摘的"。
 *
 * 三种来源对应界面上的三个出发地（见 `SelectionQuoteMenu` 的目标列表）：
 * 对话里选中的一段、文件里选中的一段、以及"整条别的对话"（那一条不摘正文，
 * 只给标题 + id，让模型自己去 `session_read_log` 读）。
 */
export type QuoteOrigin =
  /** 当前对话的历史消息里选的一段。 */
  | { kind: "chat"; sessionTitle: string }
  /** 某个文件里选的一段。`filePath` 是绝对路径 —— 用户明确要求"说清楚文件在哪"。 */
  | { kind: "file"; filePath: string; name: string }
  /** **别的对话**（整条引用）。不给正文，只给标题 + id —— 用户明确要求
   *  "不要把其他对话的全部内容直接插入进去，让模型自己查"。 */
  | { kind: "otherSession"; sessionTitle: string; sessionId: string };

/** 每种来源在引用块抬头上的说法。刻意短 —— 用户要求"很简短的解释"。
 *
 * **模型面向的文本不翻译**（同 `makeElementTag` 那条注释的规矩：整个提示词里的
 * 分隔符语法必须是一套 —— 那边特意把中文「来源:」改成了英文 `source:`，这里
 * 照做，别再混出第二种语法）。 */
const QUOTE_ORIGIN_LABEL: Record<QuoteOrigin["kind"], string> = {
  chat: "current conversation history",
  file: "a passage from a file",
  otherSession: "another conversation",
};

/**
 * 把用户引用的一段内容做成 tag。
 *
 * ⚠️ **这个块的抬头是必须的**，不是装饰。用户的原话：「提示词的话就是告诉模型这是
 * 引用的内容，是**用户的引用，不是用户的输入**……还有就是说这个引用是什么类型的……
 * 让模型知道这个引用是哪里过来的，哪个文件过来的，不用写很长」。
 *
 * 没有抬头时，引用的正文和用户自己打的字在模型眼里**长得一模一样** —— 它分不清
 * "这是用户说的话"还是"用户从某处摘来的材料"，而这两件事该怎么对待完全不同。
 *
 * 形态与 {@link makeElementTag} 的 `--- page element (...) ---` 一致：正文原文
 * **不压缩**（用户摘了一段就是要那段原文），只在外面套一层来源。
 *
 * `otherSession`（整条别的对话）**只给标题 + id、不给正文** —— 见 {@link QuoteOrigin}。
 * 那条的说明也**不点名工具名**：目的地引擎的工具表不归这里管（网页模型那条路的表里
 * 就没有 session_read_log —— 见 `webToolHost`），点名一个不存在的工具只会让模型
 * 幻觉调用。只说"若你有按 id 读对话记录的工具就用它"，没有就请用户贴。
 */
export function makeQuoteTag(params: { text: string; origin: QuoteOrigin }): ContentTag {
  const { origin } = params;
  const body = params.text.trim();
  const head = `--- user's quote (${QUOTE_ORIGIN_LABEL[origin.kind]}) ---`;
  let sourceLine: string;
  if (origin.kind === "file") {
    // 文件：带上绝对路径 —— 用户明确要求"说清楚文件在哪里"。
    sourceLine = `source: ${origin.filePath}`;
  } else if (origin.kind === "otherSession") {
    // 别的对话：给 id，模型手边有读对话记录的工具时才能用上。
    sourceLine = `source: conversation "${origin.sessionTitle}" (id ${origin.sessionId})`;
    return {
      id: cryptoRandomId(),
      kind: "quote",
      preview: `${origin.sessionTitle} (${QUOTE_ORIGIN_LABEL.otherSession})`,
      content: [
        head,
        sourceLine,
        "(Only the title and id are given here — if you have a tool that reads",
        "conversation logs by id, use it (it may support summary/user/result modes);",
        "otherwise ask the user to paste the relevant part.)",
        "--- end ---",
      ].join("\n"),
    };
  } else {
    sourceLine = `source: conversation "${origin.sessionTitle}"`;
  }
  // 展示名：文件用文件名，对话用标题；太长就按 chip 的规矩截。
  const name = origin.kind === "file" ? origin.name : origin.sessionTitle;
  const preview =
    name.length > TAG_PREVIEW_CHARS ? name.slice(0, TAG_PREVIEW_CHARS) + "…" : name;
  return {
    id: cryptoRandomId(),
    kind: "quote",
    preview,
    content: `${head}\n${sourceLine}\n${body}\n--- end ---`,
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
  //
  // Model-facing text: never translated (same rule as the `--- pasted content
  // N ---` marker just below and `buildPlanKickoffPrompt` in the store). The
  // `来源:` line used to be Chinese while its sibling markers were English,
  // which read as two different conventions in one block.
  const content = `--- page element (${el.selector}) ---\nsource: ${el.url}\n${el.outerHTML}\n--- end ---`;
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
 *  - Quote tags likewise emit their pre-formatted block verbatim: it already
 *    carries the "user's quote (…) + source" header from makeQuoteTag.
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
    } else if (tag.kind === "library") {
      // 与 file 同款:只放一行 `@清单路径`,内容由 agent 自己读。
      parts.push(tag.content);
    } else if (tag.kind === "element") {
      // Element content is already a fully-formatted delimited block.
      parts.push(tag.content);
    } else if (tag.kind === "quote") {
      // 引用同理 —— `content` 已经自带「user's quote（…）+ source」那段抬头，
      // 原样发出即可（见 makeQuoteTag）。**不要再包一层 pasted content**：
      // 那会让模型以为这是用户粘贴的正文，而它其实是用户从别处摘来的一段。
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
