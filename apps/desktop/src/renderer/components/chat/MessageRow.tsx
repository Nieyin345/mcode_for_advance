/**
 * One row of the chat stream (MessageRow) plus the small pieces it shares with
 * ChatPane (turn stat row, time formatting, the user-message inline editor).
 *
 * Split out of ChatPane.tsx to keep that file manageable. Behaviour is
 * unchanged — this is a verbatim move; ChatPane re-exports `MessageRow`.
 */
import { useState, useRef, useEffect, useMemo, memo } from "react";
import { cn } from "@renderer/lib/cn.js";
import { MessageCustomMenu } from "@renderer/components/customUi/CustomSlotHosts.js";
import { IconSend2, IconCopy, IconCheck, IconPaperclip, IconX, IconPencil, IconRefresh } from "@renderer/lib/icons.js";
import type { Block, ChatMessage, TurnMeta, PromptImage } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useNow } from "@renderer/hooks/useNow.js";
import { MessageBlocks, type BeforeContentMap, type ToolUseBlock } from "./MessageBlocks.js";
import { CurrentOpTicker } from "./CurrentOpTicker.js";
import { ModelBadge } from "./ModelAvatar.js";

/** Preserve a user-typed message's single line breaks when rendering through
 *  Markdown: a lone "\n" is a soft break that markdown collapses to a space,
 *  so every newline that is NOT part of a blank-line gap ("\n\n") becomes a
 *  hard break ("  \n"). Purely a display transform — the stored text and the
 *  copy/edit flows keep the raw "\n". */
function preserveUserLineBreaks(text: string): string {
  return text.replace(/\n(?!\n)/g, "  \n");
}


/** Format a wall-clock ms timestamp as HH:MM:SS (local time). */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a wall-clock ms timestamp as a full local date-time string
 *  "YYYY-MM-DD HH:MM:SS". Used for the user-bubble hover tooltip so the user
 *  can see exactly when a prompt was sent. */
function fmtFullDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a duration (ms) as a compact human string:
 *  < 1s → "<1s", < 60s → "12.3s", < 60m → "1m 23s", else → "1h 05m". */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}

/** Per-turn stat row shown ABOVE the first assistant message of a turn:
 *  "14:32:05 · 12.3s". While the turn is still streaming
 *  (turnMeta.endedAt undefined) the duration ticks live; once the turn ends it
 *  freezes at its final value.
 *
 *  IMPORTANT: the live duration is driven by `useNow` (a single app-wide
 *  1s interval shared via useSyncExternalStore), NOT a component-local
 *  setInterval. This component renders inside a LegendList virtualized item,
 *  and during streaming the list recycles/remounts its containers on nearly
 *  every delta flush. A local setInterval would be torn down by each remount's
 *  cleanup before its first 1000ms tick ever fires - leaving the duration
 *  stuck at "<1s" for the whole turn. The global clock survives remounts.
 *
 *  方案A「脉络」: a slim LEFT-ALIGNED row hugging where the turn's spine
 *  will settle (no more centered pill + flanking rules). While the turn is
 *  live it leads with the equalizer glyph (.live-eq); when the turn ends the
 *  row reads as the quiet meta line above the reply. Used for the pure-text /
 *  pending / live-opener turn shapes — turns WITH a process surface render
 *  TurnPanel's own header instead (same visual language, collapsible). */
export function TurnStatRow({
  meta,
  op,
}: {
  meta: TurnMeta;
  /** Newest RUNNING tool of this turn — drives the live current-operation
   *  ticker. Null/undefined shows the equalizer alone (waiting for the model,
   *  or between commands). */
  op?: ToolUseBlock | null;
}) {
  const { t } = useI18n();
  // Only subscribe to the global ticker while the turn is still running -
  // frozen turns compute a static duration and pay nothing.
  const now = useNow();
  const end = meta.endedAt ?? now;
  const duration = Math.max(0, end - meta.startedAt);
  const live = meta.endedAt === undefined;

  return (
    <div className="-ml-[7px] flex min-w-0 items-center gap-1.5 rounded-lg px-[7px] py-1 text-content-subtle [font-size:var(--chat-fs-xs)]">
      {/* Which model is running THIS turn — avatar + name on the left, matching
          TurnPanel's header. Absent for turns with no recorded model. */}
      <ModelBadge model={meta.model} />
      {live && (
        <span className="live-eq shrink-0" data-tempo={op ? undefined : "slow"} aria-hidden>
          <span />
          <span />
          <span />
        </span>
      )}
      <span className="shrink-0 tabular-nums">{fmtClock(meta.startedAt)}</span>
      <span className="shrink-0 opacity-60">·</span>
      <span className="shrink-0 tabular-nums">{fmtDuration(duration)}</span>
      {/* Live current-operation ticker — rolls like a slot machine as the agent
          moves between commands. This is the ONE surface carrying live progress
          in the flat streaming layout, so the ticker belongs here (not only
          inside the process card). Between commands (and before the first one)
          the ticker renders nothing, so a placeholder keeps the row from
          looking like it dropped a field. Phrasing content only, inline. */}
      {live &&
        (op ? (
          <CurrentOpTicker op={op} turnActive />
        ) : (
          <span className="min-w-0 truncate border-l border-edge pl-2 text-content-subtle">
            {t("chatStream.waitingModel")}
          </span>
        ))}
    </div>
  );
}



/** One row in the stream, with role styling. The "You"/"Claude" labels
 *  were removed per design - alignment (user right, assistant left) and
 *  bubble styling carry the role signal. A copy button sits BELOW the
 *  message content - outside the user bubble's border so it doesn't read
 *  as part of the copied text and stays visually separate from the
 *  content area.
 *
 *  For assistant messages: the FIRST message of a turn shows a per-turn
 *  "开始 HH:MM:SS · 用时 12.3s" stat row ABOVE the content. The streaming
 *  tail (the last assistant message while a turn is running) shows a
 *  spinning loader at the bottom of the content.
 *
 *  User messages also get an edit button (pencil icon) next to copy when
 *  the session is idle. Clicking it swaps the bubble for an inline editor
 *  (see UserMessageEditor); submitting the editor truncates the session's
 *  history at this message and resends the edited prompt. */
export const MessageRow = memo(function MessageRow({
  msg,
  isStreamingTail,
  isTurnTail,
  beforeMap,
  canEdit,
  isEditing,
  onStartEdit,
  onRegenerate,
  onSubmitEdit,
  onCancelEdit,
  onOpenPlan,
  hideTurnStat,
  tightTop,
  projectPath,
}: {
  msg: ChatMessage;
  isStreamingTail?: boolean;
  isTurnTail?: boolean;
  beforeMap?: BeforeContentMap;
  /** Whether the edit affordance should be shown (user message + idle). */
  canEdit?: boolean;
  /** Whether THIS row is currently in inline-edit mode. */
  isEditing?: boolean;
  onStartEdit?: (msg: ChatMessage) => void;
  /** 重新生成:原样重发这条(最后一条)用户消息,丢掉它之后的回复。 */
  onRegenerate?: (msg: ChatMessage) => void;
  onSubmitEdit?: (msg: ChatMessage, newText: string, images: PromptImage[]) => void;
  onCancelEdit?: () => void;
  /** Called when the user clicks an inline plan block - opens the plan in
   *  the editor column via openPlanDrawer. */
  onOpenPlan?: (plan: string) => void;
  /** Suppress the per-turn "开始 · 用时" stat row. Set when this row is a
   *  textMsg inside a turnGroup AND a TurnPanel is rendered for that turn
   *  (i.e. the turn had tool calls) - the panel header already shows the
   *  turn's timing, so a second stat line above the reply would be
   *  redundant. Left false for pure-text turns (no panel) so the first reply
   *  message still shows its own stat row. Defaults to false (standalone
   *  single items keep their own). */
  hideTurnStat?: boolean;
  /** Tighten the row's top margin to the block-gap tier. Set on live-turn
   *  flat rows after the turn's first: the seam between a tool card and the
   *  next narration message then equals the intra-row text→card gap instead
   *  of reading one tier larger every other row. */
  tightTop?: boolean;
  /** Project root for resolving file paths mentioned in the message text /
   *  shown on tool cards. Session-scoped so backgrounded tabs resolve to
   *  their own project. */
  projectPath?: string | null;
}) {
  const { t } = useI18n();
  const isUser = msg.role === "user";
  // 方案A: only a JUST-SENT user bubble plays the slide-in-from-right
  // entrance. The freshness gate keeps the animation off history hydration
  // and LegendList scroll remounts (an old bubble re-mounting mid-scroll
  // must not flash); it is evaluated once per mount, which is exactly the
  // lifetime of the DOM node the animation runs on.
  const freshBubble = isUser && Date.now() - msg.createdAt < 2500;
  const copyText = useMemo(() => blocksToText(msg.blocks), [msg.blocks]);
  // User-typed text renders through Markdown, which collapses single "\n"
  // soft breaks into spaces. Map the blocks so user text keeps its typed
  // line breaks visually (see preserveUserLineBreaks); assistant/tool text
  // keeps normal markdown semantics. Identity-stable when nothing changes,
  // so MessageBlocks' memoization still works.
  const renderBlocks = useMemo(() => {
    if (!isUser) return msg.blocks;
    let changed = false;
    const next = msg.blocks.map((b) => {
      if (b.kind !== "text") return b;
      const text = preserveUserLineBreaks(b.text);
      if (text === b.text) return b;
      changed = true;
      return { ...b, text };
    });
    return changed ? next : msg.blocks;
  }, [msg.blocks, isUser]);
  // Only show the copy button on messages with real text content - i.e. the
  // model's substantive answer to the user. A single turn often produces
  // several assistant messages (pure thinking, pure tool_use, then the text
  // reply); copying is only meaningful for the text reply, so we gate on
  // the presence of a non-empty `text` block. Pure-tool / pure-thinking
  // messages have no copy button.
  const hasTextContent = msg.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0);
  // User prompts always get a copy button (on hover). Assistant replies get one
  // ONLY on the turn's final assistant message (isTurnTail) - i.e. after the
  // turn has ended - so intermediate procedural messages stay clean and only
  // one copy affordance appears per completed turn. The button itself is
  // opacity-0 until the row is hovered (group-hover in CopyRow).
  const showCopy = isUser
    ? hasTextContent && !!copyText
    : hasTextContent && !!copyText && isTurnTail;
  // The edit button is only for user messages, only when idle, and only on
  // rows NOT currently being edited (the editor replaces the row).
  const showEdit = isUser && canEdit && !isEditing;

  // ── Inline edit mode ──
  // When editing, the normal bubble is replaced by an editor with a textarea
  // prefilled with the original typed text (attachment blocks are preserved
  // as-is; only the text portion is editable). Enter submits, Escape cancels.
  if (isUser && isEditing) {
    return (
      <div className="mt-5 mb-4 flex justify-end">
        <div className="max-w-[85%] w-full">
          <UserMessageEditor
            msg={msg}
            onSubmit={(newText, images) => onSubmitEdit?.(msg, newText, images)}
            onCancel={() => onCancelEdit?.()}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      // Bookmark anchor: the selection toolbar resolves the message a text
      // selection belongs to by walking up from the selection's anchor node
      // to this attribute; jump-to-bookmark uses it to flash the row after
      // scrolling. Static per row — no effect on the memo shallow-compare.
      data-message-id={msg.id}
      className={cn(
        "group",
        // Vertical rhythm is driven by the chat-density CSS vars (see
        // styles.css). User rows get a larger gap than assistant rows so a
        // new user prompt still reads as a distinct input even in compact
        // mode. mt-[...] preserves the old margin-top semantics.
        isUser
          ? "mt-[var(--chat-row-gap-user)] flex justify-end"
          : tightTop
            ? "mt-[var(--chat-block-gap)]"
            : "mt-[var(--chat-row-gap-assistant)]",
      )}
    >
      <div className={isUser ? "max-w-[85%] min-w-0" : "w-full min-w-0"}>
        {/* Per-turn stat row - only on the first assistant message of a
            turn (the one carrying turnMeta), and not suppressed by a parent
            TurnPanel (hideTurnStat). Sits above the content. */}
        {!isUser && msg.turnMeta && !hideTurnStat && <TurnStatRow meta={msg.turnMeta} />}
        <div
          // User messages get a native tooltip showing the full send date-time
          // on hover (assistant messages have no createdAt tooltip - the
          // per-turn stat row already shows timing).
          // .user-bubble-fill (not bg-userBubble/<alpha>): the tint strength
          // must differ per theme — 15% over white is visible, over the
          // near-black dark surface it isn't (see --user-bubble-alpha).
          // 方案A: directional corner radii (tight bottom-right corner points
          // at the sender) + the freshness-gated slide-in above.
          title={isUser ? fmtFullDateTime(msg.createdAt) : undefined}
          className={
            isUser
              ? "user-bubble-fill overflow-hidden rounded-[13px_13px_5px_13px] px-3 py-2 text-content [font-size:var(--chat-font-size)]" +
                (freshBubble ? " chat-bubble-in" : "")
              : "text-content [font-size:var(--chat-font-size)]"
          }
        >
          <MessageBlocks blocks={renderBlocks} beforeMap={beforeMap} isStreamingTail={isStreamingTail} onOpenPlan={onOpenPlan} projectPath={projectPath} />
          {/* Streaming caret at the bottom of the content while this message
              is still receiving deltas — 方案A replaces the spinner glyph
              with a blinking caret (the reply is being typed). */}
          {isStreamingTail && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="chat-caret" aria-hidden />
            </div>
          )}
        </div>
        {/* Action row BELOW the content bubble - outside its border.
            Icon-only, revealed on row hover. User messages right-align the
            buttons (under the right-aligned bubble); assistant messages
            left-align. For user messages the copy + edit buttons sit
            side-by-side; for assistant messages only copy is shown. */}
        {(showCopy || showEdit) && (
          <div
            className={cn(
              "mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100",
              isUser ? "justify-end" : "justify-start",
            )}
          >
            {showCopy && <CopyButton text={copyText} />}
            {/* 自定义 UI「消息」挂载位(R39):有自定义项才出现一个「⋯」。 */}
            {showCopy && <MessageCustomMenu id={msg.id} role={isUser ? "user" : "assistant"} text={copyText} />}
            {showEdit && (
              <button
                type="button"
                onClick={() => onStartEdit?.(msg)}
                title={t("common.edit")}
                aria-label={t("common.edit")}
                className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
              >
                <IconPencil size={12} />
              </button>
            )}
            {showEdit && onRegenerate && (
              <button
                type="button"
                onClick={() => onRegenerate(msg)}
                title={t("chatStream.regenerate")}
                aria-label={t("chatStream.regenerate")}
                className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
              >
                <IconRefresh size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/** Flatten a message's blocks into the plain-text payload that the copy
 *  button yields. text→text, thinking→quoted, tool_use→summary, errors
 *  skipped. Keeps copy output predictable for both user prompts and
 *  assistant replies. */
function blocksToText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      out.push(b.text);
    } else if (b.kind === "thinking") {
      const t = b.text.trim();
      if (t) out.push(`> ${t.replace(/\n/g, "\n> ")}`);
    } else if (b.kind === "attachment") {
      // Mirror the composer's delimited format so copied output matches
      // what was actually sent to the model.
      out.push(`--- pasted content (${b.content.length} chars) ---\n${b.content}\n--- end ---`);
    }
    // tool_use and error blocks are intentionally omitted — they're
    // procedural UI, not part of the conversational payload to copy.
  }
  return out.join("\n\n").trim();
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable (sandbox); silently no-op so the
      // message stream stays usable.
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={t("common.copy")}
      aria-label={t("common.copy")}
      className="inline-flex items-center rounded px-1 py-0.5 text-[10px] text-content-subtle transition-colors hover:bg-surface-hover hover:text-content-muted"
    >
      {copied ? <IconCheck size={12} className="text-accent" /> : <IconCopy size={12} />}
    </button>
  );
}

/** Extract just the typed text from a user message's blocks (the `text`
 *  block content). Attachment blocks are skipped - they're edited as
 *  preserved attachments, not as editable text. Used to prefill the inline
 *  editor with the user's original wording. */
function userMessageText(blocks: Block[]): string {
  for (const b of blocks) {
    if (b.kind === "text") return b.text;
  }
  return "";
}

/** Narrow the inline editor's editable image list down to the shape the store
 *  re-sends (same mimeType cast the store applies when preserving blocks). */
function toPromptImages(
  images: { id: string; data: string; mimeType: string }[],
): PromptImage[] {
  return images.map(({ data, mimeType }) => ({
    data,
    mimeType: mimeType as PromptImage["mimeType"],
  }));
}

/** Inline editor that replaces a user message bubble when the user clicks
 *  the edit pencil. Renders a textarea prefilled with the original typed
 *  text (attachment blocks are shown as read-only chips above it, matching
 *  the composer's chip-above-textarea layout). The message's image blocks
 *  are shown as composer-style thumbnails with hover-remove buttons so the
 *  user can see and delete them before resending. Enter submits the edit
 *  (truncating the session history at this message and resending), Escape
 *  cancels back to the read-only view. */
function UserMessageEditor({
  msg,
  onSubmit,
  onCancel,
}: {
  msg: ChatMessage;
  onSubmit: (newText: string, images: PromptImage[]) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const initialText = useMemo(() => userMessageText(msg.blocks), [msg.blocks]);
  const [text, setText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentBlocks = msg.blocks.filter((b) => b.kind === "attachment");
  // Local editable copy of the message's image blocks — the surviving list is
  // re-sent verbatim on submit (an emptied list drops the images from the
  // resent turn). Ids exist only to give the thumbnails stable React keys.
  const [images, setImages] = useState<{ id: string; data: string; mimeType: string }[]>(() =>
    msg.blocks
      .filter((b): b is Extract<Block, { kind: "image" }> => b.kind === "image")
      .map((b, i) => ({
        id: `edit-img-${msg.id}-${i}`,
        data: b.data,
        mimeType: b.mimeType,
      })),
  );

  // Focus + auto-resize on mount.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    // Place the cursor at the end so the user can immediately append/correct.
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 输入法选词时的回车不是「发送」(同 ComposerEditor / QuestionPrompt 的判据)。
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) onSubmit(trimmed, toPromptImages(images));
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const canSubmit = text.trim().length > 0;

  return (
    <div className="user-bubble-fill rounded-lg border border-accent/40 px-3 py-2 [font-size:var(--chat-font-size)]">
      {/* Attachment chips (read-only) - mirror the composer's chip-above-textarea
          layout. Only shown if the original message had attachments. These are
          non-interactive previews (the attachments are preserved as-is on
          resend); editing only touches the text portion. */}
      {attachmentBlocks.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachmentBlocks.map((b, i) =>
            b.kind === "attachment" ? (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent"
                title={b.filePath ?? b.preview}
              >
                {b.attachmentKind === "file" ? (
                  <IconPaperclip size={12} className="opacity-80" />
                ) : null}
                <span className="max-w-[12rem] truncate">{b.preview}</span>
              </span>
            ) : null,
          )}
        </div>
      )}
      {/* Image thumbnails - same visual treatment as the composer's pending
          image strip (h-14 squares, hover-revealed X to remove). */}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <div
              key={img.id}
              className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-edge bg-surface"
              title={t("chat.imageN", { n: i + 1 })}
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={t("chat.imageN", { n: i + 1 })}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((p) => p.id !== img.id))}
                aria-label={t("chat.removeImageN", { n: i + 1 })}
                className="absolute right-0.5 top-0.5 hidden h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80 group-hover:flex"
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
        className="w-full resize-none border-0 bg-transparent text-content outline-none placeholder:text-content-subtle"
        style={{ minHeight: "1.5em" }}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-[11px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={() => canSubmit && onSubmit(text.trim(), toPromptImages(images))}
          disabled={!canSubmit}
          className={cn(
            "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors",
            canSubmit
              ? "bg-accent text-white hover:bg-accent/90"
              : "cursor-not-allowed bg-surface-hover text-content-subtle",
          )}
        >
          <IconSend2 size={12} />
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}
