/**
 * Pure helpers used by the session store — split out of sessionStore.ts
 * (perf backlog #7: the store file was ~600KB, past Babel's 500KB
 * "deoptimised styling" threshold, and slow to typecheck/HMR).
 *
 * Everything here is a verbatim move of top-level declarations that do NOT
 * touch the store instance or module-level mutable state (selected by a
 * TypeScript-AST pass, see docs/perf-slimming-20260928.md). sessionStore.ts
 * imports what it uses and re-exports the previously exported names, so
 * every existing `from "@renderer/stores/sessionStore.js"` import keeps
 * working unchanged. Type-only imports from ./sessionStore.js are erased at
 * build time, so there is no runtime import cycle.
 */
import { CUSTOM_UI_SETTING_KEY } from "@contracts/customUi";
import type { Project, Session, MessageRecord, SessionBookmark } from "@contracts/session";
import type { SettingChangedEvent, ProjectsChangedEvent, UserMessageEvent, TodoUpdateEvent, GitChangedEvent, SessionChangedEvent, SessionDeletedEvent, RequestResolvedEvent, ModeChangeEvent, UpstreamIssueEvent, SubagentUpdateEvent, SubagentTranscriptEvent, WorkflowNodeTranscriptEvent, ContextUsageEvent, AskUserQuestionEvent, WorkflowNodeProgressEvent, WorkflowNodeUsageEvent, WorkflowNodeChoiceEvent, RuntimeEvent, PermissionMode, EffortLevel, ApprovalRequestEvent, PlanApprovalRequestEvent, PlanUpdateEvent, WorkflowNodeResultEvent, SubagentSnapshot, TurnUsageRecord, SessionListEntry } from "@contracts/runtime";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import { isValidSnapshot } from "@renderer/lib/contextWindow.js";
import { getLastCursor, type NavEntry } from "@renderer/lib/editorNav.js";
import type { CustomModelPublic } from "@contracts/customModel";
import { api } from "@renderer/lib/api.js";
import { normWorktreeKey } from "@renderer/lib/worktree.js";
import { translate } from "@renderer/lib/i18n/core.js";
import { createProviderHealthRequestGate } from "@renderer/lib/providerHealthRequestGate.js";
import { isPathWithin } from "@renderer/lib/path.js";
import { parseEditorThemeChoice } from "@renderer/lib/editorThemes.js";
import { THEME_STYLE_SETTING_KEY, UI_LOCALE_SETTING_KEY, DEFAULT_PROVIDER_ID, UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY, WORKFLOW_MAX_PARALLEL_SETTING_KEY, WORKFLOW_MAX_PARALLEL_MIN, WORKFLOW_MAX_PARALLEL_MAX, UI_USER_MSG_COLOR_SETTING_KEY, UI_ACCENT_COLOR_SETTING_KEY, UI_COMMIT_GEN_MODEL_SETTING_KEY, UI_COMMIT_GEN_PROMPT_SETTING_KEY, UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY, UI_COMPOSER_MODEL_SETTING_KEY, UI_TITLE_GEN_ENABLED_SETTING_KEY, UI_TITLE_GEN_MODEL_SETTING_KEY, AGENT_OUTPUT_STYLE_SETTING_KEY, UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY, UI_PROJECT_VIEW_SETTING_KEY, UI_PROJECT_GROUPS_SETTING_KEY, UI_LAST_PROJECT_SETTING_KEY, UI_LAST_SESSION_SETTING_KEY, UI_SHORTCUTS_SETTING_KEY, UI_GESTURES_SETTING_KEY, UI_EDITOR_THEME_SETTING_KEY, AUTO_ARCHIVE_SETTING_KEY, parseAutoArchiveConfig, SESSION_WORKTREE_DEFAULT_SETTING_KEY, WORKTREE_NAMES_SETTING_KEY, PROJECT_COLORS_SETTING_KEY, ShortcutBindingsSchema, GestureSettingsSchema, type ProjectGroupsMeta, type CustomCommand, type SkillInfo, type ProviderInfo, type PickedElement } from "@contracts/ipc";
import type { BuiltinModelOption } from "@contracts/provider";
import { useFileViewStore } from "./fileViewStore.js";
import type { Block, ChatMessage, DeltaEntry, IngestCtx, PlanDraft, QueuedPrompt, SessionState, TodoItem, TurnMeta } from "./sessionStore.js";

/** True for `.md` / `.markdown` files - used to default the editor into preview
 *  mode on first open. Kept here (not in lib/path) because it's a content-type
 *  decision, not a pure path operation. */
export function isMarkdownPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** True for image files the editor previews via the `app-resource://` protocol.
 *  Mirrors `isImage()` in FileEditor.tsx - kept here so `openFileInIde` can
 *  default images into preview mode without importing the component. SVG is
 *  text but renders as an image, so it's included. */
export function isImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
    ".svg", ".tif", ".tiff", ".avif",
  ].some((ext) => lower.endsWith(ext));
}

/** True for file types that should **default to preview mode** on first open:
 *  binary/archival/audio-video/fonts, plus Office 老格式与 PDF —— 这些都不该直接丢进
 *  Monaco 变成乱码。
 *
 *  ⚠️ **不是 `FileEditor.isUnsupported()` 的镜像。** 从前这句注释写着 "Mirrors
 *  `isUnsupported()` in FileEditor.tsx",而两份早就不同了:FileEditor 那份**刻意**拿掉了
 *  `.pdf`(归 `PdfPreviewPane`,见它那里的注释),也从来没有 Office 老格式(归 OnlyOffice)。
 *  两份判据服务的是**两件事**:这份决定"首次打开默认用哪个视图",那份决定"Monaco 能不能
 *  编辑"。服务不同目的的两份清单本来就不该是同一份 —— 别再照"镜像"去对齐(对齐会把 PDF
 *  从"默认预览"里踢出去,反而错)。 */
export function isUnsupportedPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [
    // Office 老格式。OOXML / ODF（docx xlsx pptx odt ods odp…）**不在**这里 ——
    // 它们走 OnlyOffice 可视化编辑，默认档由 FileEditor 的 `defaultMode` 定（wysiwyg）。
    ".doc", ".rtf", ".xls", ".ppt",
    ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z", ".bz2", ".xz",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".class", ".jar", ".wasm",
    ".mp3", ".mp4", ".webm", ".avi", ".mov", ".ogg", ".flac", ".wav", ".m4a",
    ".db", ".sqlite", ".sqlite3",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".pdf",
  ].some((ext) => lower.endsWith(ext));
}

/**
 * **中间栏现在是不是已经在显示一份文档**（可编辑文件 / 只读预览）。
 *
 * 「打开文件 = 中间显示它 + 侧边展开主对话」这条规矩的**例外**判据（2026-09-27，
 * 用户：「如果本身主页面就已经是文档页面了，再打开其他的文档，主页面就不用在侧边栏
 * 弹出来了，右边栏保持现状」）。两个入口（`openFileInIde` 和 `fileViewStore.open`）
 * 共用这一个函数 —— 判据只能有一份（硬规矩 2）。
 *
 * 与 `App.tsx` 里 `showEditor` / `showFileView` 的算法保持一致：
 *   - `tabs` 模式：焦点在 editor 且有活动文件或有预览目标；
 *   - `single` 模式：编辑列只要有活动文件就在屏幕上（它和对话并排）。
 *
 * ⚠️ 调用方必须在自己那次 `set` **之前**取值 —— 落地之后中间永远"已是文档页"。
 */
export function isCenterShowingDocument(
  s: Pick<SessionState, "displayMode" | "centerTabFocus" | "activeProjectId" | "ideActiveFileByProject">,
): boolean {
  const activeFile = s.activeProjectId ? s.ideActiveFileByProject[s.activeProjectId] ?? null : null;
  if (s.displayMode === "single") return activeFile != null;
  if (s.centerTabFocus !== "editor") return false;
  return activeFile != null || useFileViewStore.getState().target != null;
}

/* ───────────────────── editor navigation history ───────────────────── */
/* Alt+← / Alt+→ back/forward across editor jumps (goto-definition, file
 * switches). The stacks live in store state (per project, ephemeral); the
 * helpers below are shared by the actions. */

/** Max entries per stack (matches VS Code's navigation-history cap). */
export const NAV_HISTORY_CAP = 50;

/** Workflow-node transcripts kept in memory (`workflowNodeTranscripts`).
 *  **用不着和主进程那条线对齐** —— 它只影响"回头看时还能查到多旧的",而超出的那些
 *  卡片本来就滚出屏幕了。真正的上限在主进程那边(它同时管着渲染端收不到的那部分)。 */
const NODE_TRANSCRIPT_KEEP = 64;

/** 已经收场的那一步,过程**留一份在卡片上**(`NODE_ARCHIVE_KEEP`)。
 *
 *  两件事一起决定要有它:
 *
 *  1. `workflowNodeTranscripts` 只按会话 id 索引,而**过程是活的**——主进程那边超过
 *     `NODE_TRANSCRIPT_LIMIT` 会把最早的丢掉,渲染端这边也按 `NODE_TRANSCRIPT_KEEP` 裁。
 *     用户在几十步之后回头看第五步,`nodeSessionId` 还在卡片上,过程却查不到了 ——
 *     卡片上摆着一个点开空空的入口。
 *  2. 卡片**落盘**(见 `reduceWorkflowNodeResult` 上面那段),会话重开之后
 *     `workflowNodeTranscripts` 是空的,不落盘的话"每一步的过程"重开一次就全没了。
 *
 *  所以收场那一刻把过程**拷进卡片**(见 `reduceWorkflowNodeResult`)。代价是每步几十 KB
 *  的卡片数据,上限 `NODE_ARCHIVE_KEEP` 条,超了按块数从大到小丢 —— 那是"最占地方的那些"
 *  (一张几百条 transcript 的卡),用户往回翻多半是要看最近那几步。 */
const NODE_ARCHIVE_KEEP = 200;

/** True when two history entries point at the same spot (path + 1-based
 *  line/column). Used to dedup consecutive pushes and to skip snapshotting a
 *  "current" location that equals the reveal target. */
export function sameNavEntry(a: NavEntry, b: NavEntry): boolean {
  return a.filePath === b.filePath && a.line === b.line && a.column === b.column;
}

/** Snapshot the ACTIVE project's current location (active file + its
 *  last-known cursor) as a history entry, or null when no file is active.
 *  The cursor comes from lib/editorNav (module state, see its docs). A
 *  pending not-yet-consumed reveal targeting the active file wins: during a
 *  rapid Alt+← Alt+← sequence the EditPane hasn't mounted/consumed the first
 *  reveal yet, and that reveal target is the location being left. */
export function currentNavEntryFor(get: () => SessionState): NavEntry | null {
  const pid = get().activeProjectId;
  if (!pid) return null;
  const file = get().ideActiveFileByProject[pid] ?? null;
  if (!file) return null;
  const pending = get().idePendingReveal;
  if (pending && pending.filePath === file) {
    return { filePath: file, line: pending.line, column: pending.column };
  }
  const cursor = getLastCursor(file) ?? { line: 1, column: 1 };
  return { filePath: file, ...cursor };
}

/** Whether `sid`'s chat counts as "on screen" for unread-badge / toast
 *  gating in ingestEvent: non-active sessions are never on screen; the
 *  active one is — UNLESS the unified center bar (tabs displayMode, not in
 *  wide-panel mode where ChatColumn still shows the chat) has handed the
 *  center to the editor, hiding the active session's pane behind it. In
 *  that state noteworthy events (turn done / approval needed) must badge
 *  and toast again, or they'd be silently missed. */
export function isSessionChatOnScreen(
  sid: string,
  s: Pick<SessionState, "activeSessionId" | "displayMode" | "centerTabFocus" | "widePanelOpen">,
): boolean {
  if (sid !== s.activeSessionId) return false;
  return !(s.displayMode === "tabs" && s.centerTabFocus === "editor" && !s.widePanelOpen);
}

/** True when `sid` belongs to a loaded side chat (any parent's bucket in
 *  sideChatsByParent). Side chats live outside the left-bar lists, so the
 *  unread-badge / global-toast machinery must skip them entirely: the ask
 *  tab is their only surface. */
export function isSideChatSession(sid: string, s: Pick<SessionState, "sideChatsByParent">): boolean {
  for (const list of Object.values(s.sideChatsByParent)) {
    if (list?.some((x) => x.id === sid)) return true;
  }
  return false;
}

/**
 * Extract ALL images (base64 + mimeType) from a tool_result's content. A single
 * tool result may carry multiple image blocks (e.g. a multi-screenshot capture
 * session). Handles all shapes that can reach the store:
 *  - MCP format (Pi extension tools + Claude in-process MCP handlers):
 *      `{ type: "image", data, mimeType }`
 *  - Anthropic API format (claude binary round-trips tool_result content
 *    through the Messages API, which represents images as):
 *      `{ type: "image", source: { type: "base64", media_type, data } }`
 *  - The content array itself may be nested one level: Anthropic wraps the
 *    tool_result content blocks inside an outer array —
 *    `[{ type: "tool_result", content: [{ type: "image", ... }] }]`. We peek
 *    one level into any `tool_result` block's `content` too.
 *  - Pi wrapper: the Pi adapter forwards the tool execute() return value
 *    verbatim as `event.result`, which is `{ content: [...], details: {} }`
 *    (the AgentToolResult shape), NOT the bare content array. We unwrap a
 *    top-level `.content` array when the payload itself isn't an array.
 *
 * Returns every image found (as base64 + mimeType), in document order. Empty
 * array if none. Used by the `tool.result` reducer to attach inline image
 * blocks (the Claude path); the Pi path emits a dedicated `browser.image`
 * event per screenshot instead.
 */
export function extractImagesFromToolResult(content: unknown): { data: string; mimeType: "image/png" }[] {
  const out: { data: string; mimeType: "image/png" }[] = [];
  const scan = (blocks: unknown[]): void => {
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "image") {
        // MCP format: top-level data + mimeType.
        if (typeof b.data === "string" && typeof b.mimeType === "string") {
          out.push({ data: b.data, mimeType: "image/png" });
          continue;
        }
        // Anthropic format: nested source.{media_type, data}.
        const src = b.source as Record<string, unknown> | undefined;
        if (
          src &&
          typeof src === "object" &&
          typeof src.data === "string" &&
          typeof src.media_type === "string"
        ) {
          out.push({ data: src.data as string, mimeType: "image/png" });
        }
        continue;
      }
      // Anthropic may wrap the image inside a tool_result block's content.
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        scan(b.content);
      }
    }
  };
  // Claude path: content is the bare content-block array.
  if (Array.isArray(content)) {
    scan(content);
  } else if (content && typeof content === "object") {
    // Pi path: content is the AgentToolResult wrapper { content: [...], details }.
    const inner = (content as { content?: unknown }).content;
    if (Array.isArray(inner)) scan(inner);
  }
  return out;
}

/** Compose the kickoff prompt that hands an approved plan to a (possibly
 *  different) executor. The plan text is embedded verbatim (the staged editor
 *  draft when one exists) because the receiving agent may have no transcript
 *  access to it — for the new-session path this prompt is the ONLY context
 *  that carries. Model-facing prompt text, deliberately NOT in the i18n
 *  dictionaries (AGENTS.md: only UI chrome is translated). */
export function buildPlanKickoffPrompt(plan: string, feedback: string | undefined, sameThread: boolean): string {
  const lead = sameThread
    ? "下面的计划已经用户审批通过（可能经过编辑）。请在当前会话直接执行它，无需再次规划或征求确认："
    : "下面的计划来自另一个会话，已经用户审批通过（可能经过编辑）。请在本会话执行它：先按计划中列出的文件快速核对现状，再按步骤执行，无需再次规划或征求确认。";
  const parts = [lead, "", "<approved-plan>", plan, "</approved-plan>"];
  if (feedback) parts.push("", `执行时注意：${feedback}`);
  return parts.join("\n");
}

/** Map of messageId → msg for fast delta accumulation. */
export function findMsg(list: ChatMessage[], messageId: string): ChatMessage | undefined {
  return list.find((m) => m.id === messageId);
}

/* ─── ChatMessage ↔ MessageRecord ───
 * The DB stores `content` as JSON. New rows store an object
 * `{ blocks, turnMeta? }`; legacy rows stored just the `blocks` array, which
 * we detect with Array.isArray for backward compatibility. Reloading a
 * session round-trips the exact blocks (and turn timing) the renderer built. */
export function toRecords(sessionId: string, messages: ChatMessage[]): MessageRecord[] {
  return messages.map((m) => {
    // Whitespace-only text blocks are stream artifacts (see
    // pruneBlankTextBlocks) — assistant rows persist without them. User rows
    // persist verbatim: edit-resend round-trips their blocks as-is.
    const blocks = m.role === "assistant" ? pruneBlankTextBlocks(m.blocks) : m.blocks;
    return {
      id: m.id,
      sessionId,
      role: m.role,
      content: m.turnMeta ? { blocks, turnMeta: m.turnMeta } : blocks,
      createdAt: m.createdAt,
    };
  });
}

/** Drop whitespace-only text blocks — blank lines that stream into the
 *  transcript when a model emits bare newlines around a reasoning section
 *  (the bridge's <think> segmenter forwards them, and each run isolated by a
 *  flush-window boundary became a standalone text block). Pruned on save AND
 *  at hydration (rows persisted before this fix carry them). Returns the
 *  input untouched when there is nothing to prune (cheap common path).
 *  Mirrors pruneUnchangedTurnFileBlocks. */
function pruneBlankTextBlocks(blocks: Block[]): Block[] {
  let changed = false;
  const next: Block[] = [];
  for (const b of blocks) {
    if (b.kind === "text" && b.text.trim() === "") {
      changed = true;
      continue;
    }
    next.push(b);
  }
  return changed ? next : blocks;
}

/** Drop net-zero entries (`adds === 0 && dels === 0`) from `turn-files`
 *  blocks, and the block itself when nothing remains. Such entries are noise:
 *  a byte-identical rewrite, or a created file that was deleted again before
 *  the turn ended. FileSnapshot.freeze() filters them at the source now, but
 *  blocks persisted BEFORE that fix still carry them — prune at hydration so
 *  historical cards read the same as newly recorded ones. Returns the input
 *  array untouched when there is nothing to prune (cheap path for the common
 *  case). */
function pruneUnchangedTurnFileBlocks(blocks: Block[]): Block[] {
  let changed = false;
  const next: Block[] = [];
  for (const b of blocks) {
    if (b.kind !== "turn-files") {
      next.push(b);
      continue;
    }
    const files = b.files.filter((f) => f.adds > 0 || f.dels > 0);
    if (files.length === b.files.length) {
      next.push(b);
      continue;
    }
    changed = true;
    if (files.length > 0) next.push({ ...b, files });
    // files.length === 0 → the whole card was noise; drop the block.
  }
  return changed ? next : blocks;
}

export function fromRecords(records: MessageRecord[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of records) {
    // Legacy rows: content is the blocks array. New rows: content is
    // { blocks, turnMeta? }. Degrade gracefully on unknown shapes.
    let blocks: Block[] = [];
    let turnMeta: TurnMeta | undefined;
    if (Array.isArray(r.content)) {
      blocks = r.content as Block[];
    } else if (r.content && typeof r.content === "object") {
      const obj = r.content as { blocks?: Block[]; turnMeta?: TurnMeta };
      if (Array.isArray(obj.blocks)) blocks = obj.blocks;
      if (obj.turnMeta) turnMeta = obj.turnMeta;
    }
    let pruned = pruneUnchangedTurnFileBlocks(blocks);
    // Historical assistant rows may carry whitespace-only text blocks (blank
    // lines the pre-fix stream persisted) — prune them like the turn-files
    // noise above. User rows keep their blocks verbatim.
    if (r.role !== "user") {
      const noBlank = pruneBlankTextBlocks(pruned);
      if (noBlank !== pruned) pruned = noBlank;
    }
    // A message that consisted ONLY of pruned-to-nothing turn-files card(s)
    // would linger as a blank row — drop it (mirrors the plan-block pruning
    // in freezeOrPrunePlanBlocks). Messages that were already empty stay as
    // they were (pre-existing shape, rendering handles them).
    if (pruned.length === 0 && blocks.length > 0) continue;
    out.push({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role === "user" ? "user" : "assistant",
      blocks: pruned,
      createdAt: r.createdAt,
      ...(turnMeta ? { turnMeta } : {}),
    });
  }
  return out;
}

/** Stable empty arrays so selectors never return a fresh [] (Zustand Object.is). */
export const EMPTY_MESSAGES: ChatMessage[] = [];
export const EMPTY_TODOS: TodoItem[] = [];
export const EMPTY_TURN_FILES: TurnFileEntry[] = [];
/** Stable empty chat-file queue reference (selector must return a stable array). */
export const EMPTY_CHAT_QUEUE: string[] = [];
/** Stable empty chat-element queue reference (selector must return a stable array). */
export const EMPTY_ELEMENT_QUEUE: PickedElement[] = [];
/** Stable empty prompt-queue reference (selector must return a stable array). */
export const EMPTY_PROMPT_QUEUE: QueuedPrompt[] = [];
export const EMPTY_CUSTOM_MODELS: CustomModelPublic[] = [];
/** Stable empty map for lastModelByProvider (selector-stability rule). */
export const EMPTY_LAST_MODEL_BY_PROVIDER: Record<string, { model: string; customModelId: string | null }> = {};
export const EMPTY_PROVIDERS: ProviderInfo[] = [];
export const EMPTY_PI_MODELS: BuiltinModelOption[] = [];
export const EMPTY_CODEX_MODELS: BuiltinModelOption[] = [];
export const PROVIDER_HEALTH_STALE_MS = 30_000;
/** Stale async health completions must not overwrite a newer same-provider probe. */
export const providerHealthRequestGate = createProviderHealthRequestGate();
export const EMPTY_SKILLS: SkillInfo[] = [];
export const EMPTY_SESSIONS: Session[] = [];
export const EMPTY_SUBAGENTS: SubagentSnapshot[] = [];
/** Stable empty usage-history reference (selector must return a stable array). */
export const EMPTY_USAGE: TurnUsageRecord[] = [];
/** Stable empty bookmark-list reference (selector-stability rule). */
export const EMPTY_BOOKMARKS: SessionBookmark[] = [];
/** Stable cleared-plan reference — used both as the initial state and as
 *  the "not in plan mode" placeholder returned by selectors. */
export const EMPTY_PLAN: PlanDraft = { plan: "", phase: "cleared" };

/* ─── upstream-issue hint decay ──────────────────────────────────────
 * The bridge's retry statuses are transient by nature, but the happy-path
 * "ok" clear can be missed (the retried request belongs to a different
 * session sharing the bridge, or the SDK gave up before it). Each retry
 * (re)arms a decay timer so the hint can never linger forever. */
const upstreamIssueDecayTimers = new Map<string, ReturnType<typeof setTimeout>>();
const UPSTREAM_ISSUE_DECAY_MS = 30_000;

/** Drop a session's upstream-issue hint + its decay timer. Safe to call when
 *  neither exists. `set` is the store's setter — the helper builds the
 *  reference-preserving no-op patch when the bucket has nothing to clear. */
export function clearUpstreamIssue(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  sid: string,
): void {
  const t = upstreamIssueDecayTimers.get(sid);
  if (t) {
    clearTimeout(t);
    upstreamIssueDecayTimers.delete(sid);
  }
  set((s) => {
    if (!(sid in s.upstreamIssueBySession)) return {};
    const bucket = { ...s.upstreamIssueBySession };
    delete bucket[sid];
    return { upstreamIssueBySession: bucket };
  });
}

/**
 * Persist the per-project IDE buckets (open files / active file / expanded
 * dirs) to the settings table. Each is stored as a JSON object keyed by
 * projectId. `viewMode` is NOT persisted here (it's ephemeral — see the field
 * doc).
 *
 * Every IDE action used to fire all THREE writes even when only one bucket
 * changed (a dir toggle also re-serialized openFiles + activeFile). Two fixes:
 * the flush is debounced (same pattern as the pane-width persist — bursts like
 * the reveal effect expanding several ancestor dirs coalesce), and each bucket
 * is diffed against the last value actually written so only changed buckets
 * hit the DB. Trailing debounce reads state at flush time, so the `get`
 * accessor is stashed rather than a snapshot.
 */
export const IDE_BUCKETS_PERSIST_DEBOUNCE_MS = 400;

/** Min/max chat content font size (px). The slider in Settings uses the
 *  same bounds; setChatFontSize clamps to this range defensively. */
export const CHAT_FONT_SIZE_MIN = 12;
export const CHAT_FONT_SIZE_MAX = 20;

/** Clamp a font-size value to the allowed slider range. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return 14;
  return Math.min(CHAT_FONT_SIZE_MAX, Math.max(CHAT_FONT_SIZE_MIN, Math.round(px)));
}

/** Min/max right-panel (files / git / terminal) base font size (px). The
 *  slider in Settings uses the same bounds; setRightPanelFontSize clamps to
 *  this range defensively. */
export const RIGHT_PANEL_FONT_SIZE_MIN = 10;
export const RIGHT_PANEL_FONT_SIZE_MAX = 22;

/** Clamp a right-panel font-size value to the allowed slider range. */
export function clampRightPanelFontSize(px: number): number {
  if (!Number.isFinite(px)) return 14;
  return Math.min(
    RIGHT_PANEL_FONT_SIZE_MAX,
    Math.max(RIGHT_PANEL_FONT_SIZE_MIN, Math.round(px)),
  );
}

/** Min/max paste-to-card promotion threshold (characters). Pasting more than
 *  this many chars (or spanning more than the hardcoded 3-line threshold)
 *  promotes the content to a chip above the composer. The Settings "常规"
 *  panel uses the same bounds; setPasteTagThresholdChars clamps to this
 *  range defensively. */
export const PASTE_TAG_THRESHOLD_CHARS_MIN = 50;
export const PASTE_TAG_THRESHOLD_CHARS_MAX = 5000;

/** Clamp a paste-tag threshold value to the allowed range. */
export function clampPasteTagThresholdChars(n: number): number {
  if (!Number.isFinite(n)) return 200;
  return Math.min(
    PASTE_TAG_THRESHOLD_CHARS_MAX,
    Math.max(PASTE_TAG_THRESHOLD_CHARS_MIN, Math.round(n)),
  );
}

/** Clamp the workflow node-concurrency cap to the allowed range. **Same bounds the
 *  scheduler's own guard uses** (`@contracts/ipc`) — the renderer clamps what it
 *  writes, and the main process still defends against a hand-edited value. */
export function clampWorkflowMaxParallel(n: number): number {
  if (!Number.isFinite(n)) return WORKFLOW_MAX_PARALLEL_DEFAULT_RENDERER;
  return Math.min(
    WORKFLOW_MAX_PARALLEL_MAX,
    Math.max(WORKFLOW_MAX_PARALLEL_MIN, Math.round(n)),
  );
}

/**
 * 默认值。**和主进程那份必须是同一个数**(`runner.ts` 的
 * `WORKFLOW_MAX_PARALLEL_DEFAULT`)—— 渲染端拿它当"读不到设置时的兜底"。
 *
 * 两处各写一份是有意的:主进程那份是**真正生效**的那一个(调度器读的是它),
 * 这一份只是界面上显示什么。真要改默认值,两处一起改 —— 不一致的表现是"设置页写着
 * 4、实际跑的是别的数",而那种错没人会发现。
 */
export const WORKFLOW_MAX_PARALLEL_DEFAULT_RENDERER = 4;

/* ─── Draggable pane-width bounds + clamps ───
 * Each pane's width is persisted (UI_PANE_WIDTHS_SETTING_KEY) and re-clamped
 * on hydrate so a corrupted/out-of-range stored value can't collapse a pane
 * below its usable minimum or stretch it past the screen. */

/** Min 12 ≈ 259px on a 2160px window — the user-tuned compact floor. The
 *  default (20%) is the fresh-window starting width; users can drag it down
 *  to the floor and it persists. */
export const LEFT_WIDTH_PCT_MIN = 12;
export const LEFT_WIDTH_PCT_MAX = 40;
export const LEFT_WIDTH_PCT_DEFAULT = 20;
export const RIGHT_WIDTH_MIN = 240;
/** Absolute fallback cap for contexts without a measurable window (never in
 *  practice — both call sites pass the live row width). */
const RIGHT_WIDTH_ABS_MAX = 640;
/** Drag cap as a share of the center|right row: 2:8 — dragging the right
 *  divider fully left leaves the center pane 20% of the row. */
export const RIGHT_SHARE_MAX = 0.8;
export const BOTTOM_TERMINAL_HEIGHT_MIN = 80;
export const BOTTOM_TERMINAL_HEIGHT_MAX = 600;
export const EDITOR_WIDTH_PCT_MIN = 20;
export const EDITOR_WIDTH_PCT_MAX = 80;

/** Clamp helper for the four persisted pane sizes. Falls back to defaults on
 *  any non-finite value so the layout never breaks. */
/** NOTE: the pct clamps deliberately do NOT round — percentage shares must
 *  stay fractional. A per-mousemove drag delta is a fraction of a percent
 *  (1px on a 2900px window ≈ 0.034%); rounding to integers turned every
 *  small delta into 0 (dead handle) until one big move jumped a whole
 *  percent (~29px) — the classic janky resizable. Fractional values keep
 *  the handle tracking the cursor pixel-for-pixel. */
export function clampLeftWidthPct(pct: number): number {
  if (!Number.isFinite(pct)) return LEFT_WIDTH_PCT_DEFAULT;
  return Math.min(
    LEFT_WIDTH_PCT_MAX,
    Math.max(LEFT_WIDTH_PCT_MIN, pct),
  );
}
export function clampRightWidth(px: number, availablePx?: number): number {
  if (!Number.isFinite(px)) return 360;
  const max =
    availablePx != null && availablePx > 0
      ? Math.max(RIGHT_WIDTH_MIN, Math.round(availablePx * RIGHT_SHARE_MAX))
      : RIGHT_WIDTH_ABS_MAX;
  return Math.min(max, Math.max(RIGHT_WIDTH_MIN, Math.round(px)));
}
export function clampBottomTerminalHeight(px: number): number {
  if (!Number.isFinite(px)) return 280;
  return Math.min(
    BOTTOM_TERMINAL_HEIGHT_MAX,
    Math.max(BOTTOM_TERMINAL_HEIGHT_MIN, Math.round(px)),
  );
}
export function clampEditorWidthPct(pct: number): number {
  // No rounding — see clampLeftWidthPct for why fractional pcts matter.
  if (!Number.isFinite(pct)) return 50;
  return Math.min(EDITOR_WIDTH_PCT_MAX, Math.max(EDITOR_WIDTH_PCT_MIN, pct));
}
/** Width the center|right pair shares: the window minus the left sidebar's
 *  percentage share (the sidebar is hidden in wide-panel mode, where this
 *  pair spans the full window). Feeds the right panel's 2:8 drag cap. */
export function centerRightRowWidth(leftOpen: boolean, leftWidthPct: number): number {
  if (typeof window === "undefined") return 0;
  const win = window.innerWidth;
  const leftPx = leftOpen ? win * (leftWidthPct / 100) : 0;
  return Math.max(0, win - leftPx);
}
/** Wide-panel split bounds. widePanelPct is the right panel's share of the
 *  chat|right split; DEFAULT 70 gives the requested 3:7. The bounds keep the
 *  chat column usable (min 20% at the 2:8 drag cap) and the right panel
 *  dominant. In-memory (not persisted). */
export const WIDE_PANEL_PCT_MIN = 40;
export const WIDE_PANEL_PCT_MAX = 80;
export const WIDE_PANEL_PCT_DEFAULT = 70;

/** Clamp helper for the wide-panel percentage. Falls back to the default on
 *  any non-finite value. */
export function clampWidePanelPct(pct: number): number {
  // No rounding — see clampLeftWidthPct for why fractional pcts matter.
  if (!Number.isFinite(pct)) return WIDE_PANEL_PCT_DEFAULT;
  return Math.min(WIDE_PANEL_PCT_MAX, Math.max(WIDE_PANEL_PCT_MIN, pct));
}

/** Matches a well-formed space-separated "R G B" triplet (0–255 each),
 *  e.g. "124 58 237". Used to validate the user-message color setting
 *  (which feeds the --user-bubble CSS var). */
export const RGB_TRIPLET_RE = /^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*$/;

/** True if `abs` is inside `root` (prefix match on path SEGMENTS, not a raw
 *  string prefix — so "/foo/bar" doesn't match root "/foo/ba"). Renderer-side
 *  mirror of main's `pathGuard.pathWithin`: used to filter persisted IDE paths
 *  at hydration time. Handles the root === abs case (a file/dir AT the root).
 *
 *  The implementation is **the one shared pure helper** (`lib/path.ts`'s
 *  {@link isPathWithin}); this used to be a local copy that only appended a
 *  `/` to the root and `startsWith`-ed, so a Windows backslash root
 *  (`D:\proj`, what the OS directory picker returns) failed to contain its own
 *  files → every persisted IDE tab / expanded dir was dropped at hydration
 *  ("reopen the app and the editor forgot everything"). Keeping one copy
 *  prevents the two from drifting again. */
export function isPathWithinRoot(root: string, abs: string): boolean {
  return isPathWithin(root, abs);
}

/** Page size for the left-bar thread list. The first page is fetched on
 *  init / project expand; further pages are appended on "加载更多". The list
 *  counts LOCAL threads only — worktree threads are fetched separately so a
 *  worktree-heavy project never eats into these 5 rows. */
export const SESSION_PAGE_SIZE = 5;

/** Hard cap for a project's full worktree-section fetch. A worktree
 *  directory holds few threads by design, so this is not pagination — just a
 *  sanity bound far beyond realistic use. */
export const WORKTREE_SESSIONS_FETCH_LIMIT = 500;

/** Page size for the stream sidebar's cross-project aggregate (rich cards
 *  are ~3x taller than tree rows, so the page is only 2x). */
export const STREAM_PAGE_SIZE = 10;

/** Per-project in-flight guard for loadWorktreeSessions — only the latest
 *  fetch for a project may apply, so a slow response can't clobber a newer
 *  one (expand → collapse → expand fires overlapping fetches). */
export const worktreeFetchSeq: Record<string, number> = {};

/** Resolve the stream sidebar's scope into `session.listAll` filter params.
 *  Applies the same staleness validation the sidebar renders with (a deleted
 *  / archived project or a dissolved group degrades to the unfiltered view),
 *  so the fetched pages always match what the scope chip says it's showing.
 *  Group scopes resolve to their member ids here — the server filters by
 *  project_id; worktree scopes pass their normalized key through for the
 *  main-side normPathKey comparison. */
export function streamScopeQuery(
  scope: string | null,
  projects: Project[],
): { projectIds?: string[]; worktreeKey?: string } {
  if (scope == null) return {};
  if (scope.startsWith("g:")) {
    const name = scope.slice(2);
    const ids = projects.filter((p) => !p.archived && p.group === name).map((p) => p.id);
    return ids.length > 0 ? { projectIds: ids } : {};
  }
  if (scope.startsWith("wt:")) return { worktreeKey: scope.slice(3) };
  const project = projects.find((p) => p.id === scope);
  return project && !project.archived ? { projectIds: [scope] } : {};
}

/** Messages per page when lazily loading session history. Large enough that a
 *  typical conversation fills the viewport in one fetch, small enough that
 *  very long threads (thousands of rows) stay snappy on first open. */
export const MESSAGE_PAGE_SIZE = 200;

/** Find a session across the active per-project caches, the archived bin,
 *  the global pinned bucket, and the stream sidebar's cross-project
 *  aggregate by id. The archived cache is consulted so that config
 *  hydration still finds a session a user just restored (and so
 *  deleted/restored fallbacks don't miss rows that were moved between
 *  caches); the pinned bucket because pinned rows LEAVE their project's
 *  active list and live in the global pinned section instead; the stream
 *  aggregate because the stream view pages through `session.listAll`, so a
 *  page-2+ row exists ONLY there — without this fallback its tab renders
 *  "(unknown)" and config hydration silently no-ops. */
export function findSession(
  sessionsByProject: Record<string, Session[]>,
  archivedByProject: Record<string, Session[]>,
  pinnedSessions: Session[],
  streamSessions: Session[],
  id: string,
): Session | undefined {
  for (const list of Object.values(sessionsByProject)) {
    const hit = list?.find((s) => s.id === id);
    if (hit) return hit;
  }
  const pinnedHit = pinnedSessions.find((s) => s.id === id);
  if (pinnedHit) return pinnedHit;
  for (const list of Object.values(archivedByProject)) {
    const hit = list?.find((s) => s.id === id);
    if (hit) return hit;
  }
  return streamSessions.find((s) => s.id === id);
}

/** The per-project thread cache is a TWO-SECTION array: local threads first
 *  (the paginated, worktree-excluding list — the only section the pagination
 *  math counts), worktree-bound threads after (fetched in full, ordered among
 *  themselves, never part of the local list's page math). Every incremental
 *  write to the cache must preserve this invariant — these two helpers are
 *  the canonical split / reassemble. */
export function splitSessionSections(list: Session[]): { local: Session[]; worktree: Session[] } {
  const local: Session[] = [];
  const worktree: Session[] = [];
  for (const s of list) (s.worktreePath ? worktree : local).push(s);
  return { local, worktree };
}

/** Immutably patch a single cached session row (looked up by id across both
 *  the active and archived per-project caches) with a partial update, and
 *  return a new `sessionsByProject` (or archived) map reflecting the change.
 *
 *  Used to keep the in-memory session cache in sync with live updates that
 *  arrive via events (e.g. `token-usage.updated` refreshing a row's
 *  `contextSnapshot`) without reloading the whole list. Returns the original
 *  map reference when the session isn't cached (no-op), so callers can spread
 *  it unconditionally. */
export function patchSessionInCache(
  byProject: Record<string, Session[]>,
  projectId: string,
  sessionId: string,
  patchFields: Partial<Session>,
): Record<string, Session[]> {
  const list = byProject[projectId];
  if (!list) return byProject;
  const idx = list.findIndex((s) => s.id === sessionId);
  if (idx === -1) return byProject;
  const nextList = list.slice();
  nextList[idx] = { ...nextList[idx], ...patchFields };
  return { ...byProject, [projectId]: nextList };
}

/** Keep the global pinned bucket ordered by pin recency (most recent pin
 *  first). The server already returns this order (`listPinned` orders by
 *  pinned_at DESC), so this only matters after local mutations. */
export function sortPinnedByRecency(list: Session[]): Session[] {
  return list.slice().sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
}

/** Insert a session into an unpinned active list at its `updated_at` position
 *  (server order is updated_at DESC, ties created_at DESC). Used when a
 *  session returns from the pinned section to its project's loaded window. */
function insertByActivity(list: Session[], session: Session): Session[] {
  const i = list.findIndex((x) => x.updatedAt < session.updatedAt);
  return i === -1 ? [...list, session] : [...list.slice(0, i), session, ...list.slice(i)];
}

/** In-memory move for a pin toggle (shared by the local action and — via the
 *  `session.changed` reducer's idempotent echo — other clients' pin toggles):
 *  the server-fresh row moves between the owning project's active window and
 *  the global pinned bucket. Pinning takes the row OUT of sessionsByProject
 *  (totals shrink accordingly); unpinning re-inserts it at its updated_at
 *  position. If the owning project's window isn't loaded, the active list is
 *  untouched — loadSessions will fetch the row with the right filters. */
export function applySessionPinnedState(s: SessionState, session: Session): Partial<SessionState> {
  const patch: Partial<SessionState> = {};
  const projectId = session.projectId;
  const isPinned = !session.archived && session.pinnedAt != null;

  // Global pinned bucket — upsert or evict, kept sorted by pin recency.
  const withoutPinned = s.pinnedSessions.filter((x) => x.id !== session.id);
  patch.pinnedSessions = isPinned
    ? sortPinnedByRecency([session, ...withoutPinned])
    : withoutPinned;

  // Project active window (if loaded) — a TWO-SECTION array (see
  // splitSessionSections): local threads (the paginated list, the only one
  // the totals count) then worktree-bound threads.
  const activeList = s.sessionsByProject[projectId];
  if (activeList) {
    const { local, worktree } = splitSessionSections(activeList);
    let next: Session[];
    let totalDelta = 0;
    if (isPinned || session.archived) {
      // Leaving the active window — pinned rows render in the global pinned
      // section, archived rows in the bin. A worktree-bound row leaves the
      // worktree section, which the LOCAL total never counted.
      const wasLocal = local.some((x) => x.id === session.id);
      next = [
        ...local.filter((x) => x.id !== session.id),
        ...worktree.filter((x) => x.id !== session.id),
      ];
      if (wasLocal) totalDelta = -1;
    } else if (session.worktreePath) {
      // A worktree-bound row returns into the worktree section (newest-first
      // within it) — never into the paginated local list.
      next = [
        ...local.filter((x) => x.id !== session.id),
        ...(worktree.some((x) => x.id === session.id)
          ? worktree.map((x) => (x.id === session.id ? { ...x, ...session } : x))
          : insertByActivity(worktree, session)),
      ];
    } else if (local.some((x) => x.id === session.id)) {
      next = [...local.map((x) => (x.id === session.id ? { ...x, ...session } : x)), ...worktree];
    } else {
      next = [...insertByActivity(local, session), ...worktree];
      totalDelta = 1;
    }
    patch.sessionsByProject = { ...s.sessionsByProject, [projectId]: next };
    if (totalDelta !== 0) {
      const total = Math.max((s.sessionsTotalByProject[projectId] ?? 0) + totalDelta, 0);
      patch.sessionsTotalByProject = { ...s.sessionsTotalByProject, [projectId]: total };
      patch.sessionsHasMoreByProject = {
        ...s.sessionsHasMoreByProject,
        [projectId]: total > next.filter((x) => !x.worktreePath).length,
      };
    }
  }

  // Archived bin row (a pinned-then-archived row still lives there) — keep
  // the cached copy fresh.
  const archivedList = s.archivedSessionsByProject[projectId];
  if (archivedList && archivedList.some((x) => x.id === session.id)) {
    patch.archivedSessionsByProject = {
      ...s.archivedSessionsByProject,
      [projectId]: archivedList.map((x) => (x.id === session.id ? { ...x, ...session } : x)),
    };
  }

  if (s.activeProjectId === projectId && patch.sessionsByProject) {
    patch.sessions = patch.sessionsByProject[projectId] ?? s.sessions;
  }
  return patch;
}

/** Materialize a full {@link Session} row from a slim list-sync entry. Heavy
 *  per-session payloads are null on a fresh row — a freshly-created session
 *  has them null anyway; updates merge the entry OVER the cached row instead
 *  (see the `session.changed` reducer). */
function materializeSessionEntry(entry: SessionListEntry): Session {
  return {
    ...entry,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
  };
}

/** Per-session buckets + queues to drop when ANY session is hard-deleted —
 *  shared verbatim by the main-session and side-chat paths of
 *  applySessionDeletedState. Pure: copies every touched bucket, removes the
 *  id's entry (and any timers / queue rows keyed by it), returns the patch
 *  fragment. Runs synchronously inside set() callbacks. */
function dropSessionBuckets(s: SessionState, id: string) {
  const messagesBySession = { ...s.messagesBySession };
  delete messagesBySession[id];
  const hasMoreMessagesBySession = { ...s.hasMoreMessagesBySession };
  delete hasMoreMessagesBySession[id];
  const loadingMessagesBySession = { ...s.loadingMessagesBySession };
  delete loadingMessagesBySession[id];
  const loadingOlderBySession = { ...s.loadingOlderBySession };
  delete loadingOlderBySession[id];
  const historyLoadedBySession = { ...s.historyLoadedBySession };
  delete historyLoadedBySession[id];
  const runningBySession = { ...s.runningBySession };
  delete runningBySession[id];
  const runningTurnStartedAt = { ...s.runningTurnStartedAt };
  delete runningTurnStartedAt[id];
  const waitingBranchesBySession = { ...s.waitingBranchesBySession };
  delete waitingBranchesBySession[id];
  const runningTurnModelBySession = { ...s.runningTurnModelBySession };
  delete runningTurnModelBySession[id];
  const turnErrorBySession = { ...s.turnErrorBySession };
  delete turnErrorBySession[id];
  const interruptedBySession = { ...s.interruptedBySession };
  delete interruptedBySession[id];
  const upstreamIssueBySession = { ...s.upstreamIssueBySession };
  delete upstreamIssueBySession[id];
  // Also drop the hint's decay timer (module-level side effect — idempotent).
  const issueTimer = upstreamIssueDecayTimers.get(id);
  if (issueTimer) {
    clearTimeout(issueTimer);
    upstreamIssueDecayTimers.delete(id);
  }
  const unreadBySession = { ...s.unreadBySession };
  delete unreadBySession[id];
  const todosBySession = { ...s.todosBySession };
  delete todosBySession[id];
  const planBySession = { ...s.planBySession };
  delete planBySession[id];
  const subagentsBySession = { ...s.subagentsBySession };
  delete subagentsBySession[id];
  const subagentTranscriptsBySession = { ...s.subagentTranscriptsBySession };
  delete subagentTranscriptsBySession[id];
  const pendingQuestionBySession = { ...s.pendingQuestionBySession };
  delete pendingQuestionBySession[id];
  const turnFilesBySession = { ...s.turnFilesBySession };
  delete turnFilesBySession[id];
  const bookmarksBySession = { ...s.bookmarksBySession };
  delete bookmarksBySession[id];
  const chatFileQueueBySession = { ...s.chatFileQueueBySession };
  delete chatFileQueueBySession[id];
  const chatElementQueueBySession = { ...s.chatElementQueueBySession };
  delete chatElementQueueBySession[id];
  const contextSnapshotBySession = { ...s.contextSnapshotBySession };
  delete contextSnapshotBySession[id];
  const usageHistoryBySession = { ...s.usageHistoryBySession };
  delete usageHistoryBySession[id];
  const pendingPlanApprovalBySession = { ...s.pendingPlanApprovalBySession };
  delete pendingPlanApprovalBySession[id];
  const planDrawerPlanBySession = { ...s.planDrawerPlanBySession };
  delete planDrawerPlanBySession[id];
  const planTabActiveBySession = { ...s.planTabActiveBySession };
  delete planTabActiveBySession[id];
  const planApprovalDraftBySession = { ...s.planApprovalDraftBySession };
  delete planApprovalDraftBySession[id];
  const composerDraftBySession = { ...s.composerDraftBySession };
  delete composerDraftBySession[id];
  const sideChatSeedBySession = { ...s.sideChatSeedBySession };
  delete sideChatSeedBySession[id];
  const composerDraftTouchBySession = { ...s.composerDraftTouchBySession };
  delete composerDraftTouchBySession[id];
  // 排队待发的提示词(见 `QueuedPrompt`)。漏删的话,一条**删掉/归档**的会话在
  // `promptQueue` 里留下的那一队(连同它拖着的附件、图片 data URL)**整个进程生命期
  // 都留着** —— 而这条清理本来就是"把这一行有关的东西全收掉"。
  const promptQueueBySession = { ...s.promptQueueBySession };
  delete promptQueueBySession[id];
  // 「这一轮没说完」那条提示的旗标(见 `turn.incomplete` 的处理)。与上面的队列桶
  // 同一类:它也是按会话 id 累积的 per-session 桶,漏删的话删掉的会话永远留着一条。
  const turnIncompleteBySession = { ...s.turnIncompleteBySession };
  delete turnIncompleteBySession[id];
  const pendingApprovals = s.pendingApprovals.filter((p) => p.sessionId !== id);
  return {
    messagesBySession,
    hasMoreMessagesBySession,
    loadingMessagesBySession,
    loadingOlderBySession,
    historyLoadedBySession,
    runningBySession,
    runningTurnStartedAt,
    waitingBranchesBySession,
    runningTurnModelBySession,
    turnErrorBySession,
    interruptedBySession,
    upstreamIssueBySession,
    unreadBySession,
    todosBySession,
    planBySession,
    subagentsBySession,
    subagentTranscriptsBySession,
    pendingQuestionBySession,
    turnFilesBySession,
    bookmarksBySession,
    chatFileQueueBySession,
    chatElementQueueBySession,
    contextSnapshotBySession,
    usageHistoryBySession,
    pendingPlanApprovalBySession,
    planDrawerPlanBySession,
    planTabActiveBySession,
    planApprovalDraftBySession,
    composerDraftBySession,
    sideChatSeedBySession,
    composerDraftTouchBySession,
    promptQueueBySession,
    turnIncompleteBySession,
    pendingApprovals,
  };
}

/** In-memory cleanup for a hard-deleted session — shared by the local
 *  `deleteSession` action and the remote `session.deleted` event reducer, so a
 *  phone deleting a thread cleans the desktop's lists/tabs/buckets exactly
 *  like a local delete. Covers side chats too: kind="side" rows live outside
 *  the left-bar caches, in their parent's sideChatsByParent bucket. Pure:
 *  takes the current state, returns the patch. */
export function applySessionDeletedState(s: SessionState, id: string): Partial<SessionState> {
  // Find which project + cache owns this session.
  let projectId: string | undefined;
  let inArchived = false;
  let inPinned = false;
  // True when the deleted row sat in the cache's worktree SECTION — the
  // LOCAL total (which the worktree section never counts) must stay put.
  let deletedWasWorktree = false;
  for (const [pid, list] of Object.entries(s.sessionsByProject)) {
    const hit = list?.find((sess) => sess.id === id);
    if (hit) {
      projectId = pid;
      inArchived = false;
      deletedWasWorktree = !!hit.worktreePath;
      break;
    }
  }
  // Pinned rows aren't in the per-project caches — they live in the global
  // pinned bucket, so look there before the archived bin.
  if (!projectId) {
    const pinnedRow = s.pinnedSessions.find((sess) => sess.id === id);
    if (pinnedRow) { projectId = pinnedRow.projectId; inPinned = true; }
  }
  if (!projectId) {
    for (const [pid, list] of Object.entries(s.archivedSessionsByProject)) {
      if (list?.some((sess) => sess.id === id)) { projectId = pid; inArchived = true; break; }
    }
  }
  if (!projectId) {
    // Not in the left-bar caches — check the ask-tab buckets. Side chats
    // (kind="side") hang off their parent under sideChatsByParent and are
    // invisible everywhere else. Hard-deleting one removes it from that
    // list; if it was open, the panel falls back to the list view (the
    // derived view switch needs no explicit reset beyond clearing the id).
    const parent = Object.keys(s.sideChatsByParent).find((key) =>
      s.sideChatsByParent[key]?.some((x) => x.id === id),
    );
    if (!parent) return {};
    const list = s.sideChatsByParent[parent] ?? [];
    return {
      sideChatsByParent: { ...s.sideChatsByParent, [parent]: list.filter((x) => x.id !== id) },
      ...dropSessionBuckets(s, id),
      ...(s.activeSideChatId === id ? { activeSideChatId: null } : {}),
    };
  }
  const prevList = inPinned
    ? s.pinnedSessions
    : (inArchived ? s.archivedSessionsByProject : s.sessionsByProject)[projectId] ?? [];
  const nextList = prevList.filter((sess) => sess.id !== id);
  // For a pinned row the project's active window is untouched; all
  // total/hasMore math below must reference it rather than the pinned bucket.
  const activeWindowLen = inPinned
    ? (s.sessionsByProject[projectId]?.length ?? 0)
    : nextList.length;
  const sessionsByProject = { ...s.sessionsByProject };
  const archivedByProject = { ...s.archivedSessionsByProject };
  // Replace the touched cache. Empty archived cache entries are dropped
  // so the "已归档" bin doesn't render empty project groups.
  if (inPinned) {
    // Row leaves the pinned bucket only; project caches are untouched.
  } else if (inArchived) {
    if (nextList.length > 0) archivedByProject[projectId] = nextList;
    else delete archivedByProject[projectId];
  } else {
    sessionsByProject[projectId] = nextList;
  }
  // Active-thread totals only move when an active (non-archived, non-pinned,
  // non-worktree-section) row is deleted; archived / pinned / worktree rows
  // aren't part of the active count.
  const totalActive = inArchived || inPinned || deletedWasWorktree
    ? (s.sessionsTotalByProject[projectId] ?? 0)
    : Math.max((s.sessionsTotalByProject[projectId] ?? 0) - 1, 0);
  const hasMoreActive = inPinned || deletedWasWorktree
    ? (s.sessionsHasMoreByProject[projectId] ?? false)
    : totalActive > activeWindowLen;
  // Drop all per-session buckets for this id (helper above). The session is
  // gone for good; no point keeping its messages / running flag / question
  // / approval queue / files in memory. The ask-tab list goes too: deleting
  // a main session orphans its side chats in the DB (delete() nulls their
  // parent_session_id), so the in-memory bucket would only go stale — and
  // an open side chat of the deleted parent falls back to the list view.
  const dropped = dropSessionBuckets(s, id);
  const hadSideChats = id in s.sideChatsByParent;
  const sideChatsByParent = { ...s.sideChatsByParent };
  let activeSideChatId = s.activeSideChatId;
  if (hadSideChats) {
    if ((sideChatsByParent[id] ?? []).some((x) => x.id === activeSideChatId)) {
      activeSideChatId = null;
    }
    delete sideChatsByParent[id];
  }
  // Drop the session from the tab strip too. If it was the active tab,
  // the focus jumps to the previous tab (openTab logic replicated
  // inline since we're already inside a `set` callback).
  const idx = s.openTabs.indexOf(id);
  const openTabs = idx === -1 ? s.openTabs : s.openTabs.filter((sid) => sid !== id);
  const wasActive = s.activeSessionId === id;
  if (!wasActive) {
    return {
      sessionsByProject,
      archivedSessionsByProject: archivedByProject,
      ...(inPinned ? { pinnedSessions: nextList } : {}),
      sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: totalActive },
      sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
      ...dropped,
      ...(hadSideChats ? { sideChatsByParent } : {}),
      ...(activeSideChatId !== s.activeSideChatId ? { activeSideChatId } : {}),
      openTabs,
      streamDirty: true,
    };
  }
  // Was the active tab. Land on the previous tab if any, otherwise the
  // new tail, otherwise null (empty-state placeholder).
  let nextActive: string | null = null;
  if (openTabs.length > 0) {
    nextActive = idx > 0 ? openTabs[idx - 1] : openTabs[0];
  }
  const isActiveProject = projectId === s.activeProjectId;
  // For a pinned row the fallback candidate comes from the project's active
  // window (unchanged by this delete), not from the pinned bucket.
  const nextInProject = isActiveProject
    ? (inPinned ? (s.sessionsByProject[projectId] ?? []) : nextList).find((sess) => !sess.archived)
    : null;
  // If the new active session is the fallback one, sync its config
  // into the global slots so the composer chips show the right
  // model/effort/permission.
  const finalActive = nextActive ?? nextInProject?.id ?? null;
  const sess = finalActive
    ? findSession(sessionsByProject, archivedByProject, inPinned ? nextList : s.pinnedSessions, s.streamSessions, finalActive)
    : undefined;
  // Clear the new active session's unread badge - it's now visible.
  if (finalActive) delete dropped.unreadBySession[finalActive];
  return {
    sessionsByProject,
    archivedSessionsByProject: archivedByProject,
    ...(inPinned ? { pinnedSessions: nextList } : {}),
    sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: totalActive },
    sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
    ...dropped,
    ...(hadSideChats ? { sideChatsByParent } : {}),
    ...(activeSideChatId !== s.activeSideChatId ? { activeSideChatId } : {}),
    openTabs,
    // ⚠️ `sessions` 是**当前项目的活跃窗口**的别名(见 SessionState.sessions 的注释)——
    // 删的若是**已固定**的一行,`nextList` 是 pinned 桶,不能拿它当项目列表:否则
    // `s.sessions.find(activeId)` 找不到刚接上的那条,标题栏的会话名 chip 消失、
    // EmptyThreadWelcome 的「接着聊」列出别的项目的行。pinned 桶在
    // `pinnedSessions` 那一格已经更新过了,这里项目窗口原样(它本就没动)。
    sessions: isActiveProject ? (inPinned ? s.sessions : nextList) : s.sessions,
    activeSessionId: finalActive,
    model: sess?.model ?? s.model,
    effort: sess?.effort ?? s.effort,
    permissionMode: sess?.permissionMode ?? s.permissionMode,
    customModelId: sess?.customModelId ?? s.customModelId,
    streamDirty: true,
  };
}

/** Coerce the composer's effort / permissionMode view slots onto a provider's
 *  declared option lists. Level/mode ids are provider-namespaced exactly like
 *  model ids — claude's acceptEdits/plan/bypassPermissions are not codex
 *  modes, pi's "off" is not a claude level — so a value left over from the
 *  outgoing provider renders as a raw id in the chip and gets sent to an SDK
 *  that can't interpret it. Values the target provider doesn't declare snap
 *  to "default" (the neutral slot every provider declares for both lists);
 *  values valid for both providers pass through untouched. Callers apply this
 *  on every provider switch (setProvider) and on re-syncs that can surface a
 *  stale persisted value (syncConfigFromSession, reloadProviders). */
export function coerceSlotsForProvider(
  s: Pick<SessionState, "providers" | "effort" | "permissionMode">,
  providerId: string,
): { effort: SessionState["effort"]; permissionMode: SessionState["permissionMode"] } {
  const provider = s.providers.find((p) => p.id === providerId);
  const levels = provider?.capabilities.thinkingLevels;
  const modes = provider?.capabilities.permissionModes;
  return {
    effort:
      levels && levels.length > 0 && !levels.some((l) => l.value === s.effort)
        ? "default"
        : s.effort,
    permissionMode:
      modes && modes.length > 0 && !modes.some((m) => m.value === s.permissionMode)
        ? "default"
        : s.permissionMode,
  };
}

/** Read a session's persisted config (model / effort / permissionMode /
 *  customModelId) into the global view slots so the composer renders the
 *  active thread's choices. If the session can't be found (not yet loaded,
 *  or unknown id), leaves the slot untouched — better to keep a previous
 *  valid value than to flash a placeholder while the cache is filling. */
export function syncConfigFromSession(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, get().streamSessions, sessionId);
  if (!sess) return;
  // Keep activeProjectId in lockstep with the active session's owning project.
  // Without this, switching to a thread in project B while activeProjectId
  // still points at project A would leave the IDE file tree (and any
  // project-scoped UI) showing the wrong project. Every entry point that
  // activates a session (selectSession / openTab / rewindTurn) routes through
  // this helper, so this single sync covers all of them.
  const prevPid = get().activeProjectId;
  // effort / permissionMode are provider-namespaced (see coerceSlotsForProvider):
  // a row persisted before a provider switch — or before this coercion existed —
  // can carry a value its own provider doesn't declare; snap it to "default"
  // here so the composer never renders a raw foreign id.
  const coerced = coerceSlotsForProvider(get(), sess.providerId);
  const patch: Partial<SessionState> = {
    providerId: sess.providerId,
    model: sess.model,
    effort: coerced.effort,
    permissionMode: coerced.permissionMode,
    // Not provider-namespaced, so nothing to coerce — but a row written before
    // the column existed reads back undefined, so fall back to "default".
    workflowId: sess.workflowId ?? "default",
    customModelId: sess.customModelId,
    activeProjectId: sess.projectId,
  };
  // The `sessions` field is a derived view of the ACTIVE project's session
  // list (see its field doc). selectProject refreshes it, but selectSession /
  // openTab do NOT - so activating a thread in a different project left
  // `sessions` pointing at the old project's list. Titlebar resolves the
  // active thread's title via `sessions.find(activeSessionId)`, which then
  // missed (the thread isn't in the old list) and the title chip vanished.
  // Refresh the alias whenever the owning project changes.
  if (prevPid !== sess.projectId) {
    patch.sessions = get().sessionsByProject[sess.projectId] ?? EMPTY_SESSIONS;
  }
  // Auto-expand the session's owning project whenever a session is activated.
  // selectSession (tab click) and openTab (left-bar click) both route through
  // here; without this, switching to a thread in a collapsed project leaves the
  // left bar showing the project row but not the thread under it, so the user
  // can't see which thread became active. Other projects' expand state is
  // preserved.
  if (!get().expandedProjects[sess.projectId]) {
    patch.expandedProjects = { ...get().expandedProjects, [sess.projectId]: true };
  }
  // Same idea for the session's worktree group: activating a thread bound to
  // an isolated checkout must reveal the group node it buckets under,
  // otherwise the newly-active row stays invisible inside a collapsed group.
  // Groups are COLLAPSED by default, so this reveal is the "where am I" cue —
  // it opens only the group the user just landed in, never the others.
  if (sess.worktreePath && !get().expandedWorktrees[normWorktreeKey(sess.worktreePath)]) {
    patch.expandedWorktrees = {
      ...get().expandedWorktrees,
      [normWorktreeKey(sess.worktreePath)]: true,
    };
  }
  // ...and the project's left-bar VIEW must show the side the active thread
  // lives on: a worktree thread while the project shows local-only would be
  // invisible. Only flips toward worktrees — activating a local thread never
  // yanks the user out of a worktree view they opened deliberately.
  if (sess.worktreePath && !get().worktreeViewByProject[sess.projectId]) {
    patch.worktreeViewByProject = { ...get().worktreeViewByProject, [sess.projectId]: true };
  }
  set(patch);

  // Remember the last-activated project + session so the next launch can
  // restore the user's landing spot instead of always opening the first
  // project. Fire-and-forget: a failed write just falls back to the default
  // selection on next boot. Both session-activation entry points (selectSession
  // / openTab) route through here, so this single write covers them.
  //
  // ⚠️ **必须带 catch。** 从前是裸 `void`,IPC 一 reject(401/断网/超时)就变成**未处理的
  // rejection**(渲染端没有 unhandledrejection 监听)。这里不能 import sessionStore 的
  // `saveSetting`(会成环),就地吞掉、只记一行 —— 丢一次"上次打开的项目"不值得打扰用户,
  // 但不能留下未处理的 rejection。
  void api.setting.set({ key: UI_LAST_SESSION_SETTING_KEY, value: sessionId })
    .catch((err: unknown) => console.error("setting.set(ui.lastSession) failed:", err));
  void api.setting.set({ key: UI_LAST_PROJECT_SETTING_KEY, value: sess.projectId })
    .catch((err: unknown) => console.error("setting.set(ui.lastProject) failed:", err));
}

/** 只在最近一条用户消息之后找错;重试同一份坏配置仍要重新显示失败。 */
export function hasErrorInCurrentTurn(messages: readonly ChatMessage[], text: string): boolean {
  let found = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") return found;
    if (message?.blocks.some((block) => block.kind === "error" && block.message === text)) found = true;
  }
  return false;
}

/** 手机 SSE 掉线时 RPC 仍会拒绝;桌面 IPC 也可能比事件先抵达。
 *  自定义配置错误原样显示(主进程同时会推同一句 error 事件,按文本去重)。
 *
 *  其他拒绝原先只进 console:用户看到自己的气泡后面什么也没有 —— 而主进程有好几处
 *  是**专门写给用户看**才抛的(「这个工作流还在跑」「上一轮还在运行」、worktree 建不
 *  出来……)。所以一律补一个错误气泡:原因是面向用户的中文短句就附上,否则(英文异常 /
 *  多行堆栈)只给通用说明,不把内部细节摆到界面上。 */
export function surfaceRejectedCustomModelSend(get: () => SessionState, sessionId: string, err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron 给 IPC 异常加的前缀不是失败原因;手机 RPC 返回的则是原文。
  const message = raw.replace(/^Error invoking remote method ['"][^'"]+['"]: Error: /, "");
  if (raw.includes("本次未发送到默认端点")) {
    if (hasErrorInCurrentTurn(get().messagesBySession[sessionId] ?? [], message)) return;
    get().ingestEvent({ type: "error", sessionId, message, code: "custom_model_unavailable" });
    return;
  }
  const locale = get().locale;
  const userFacing = /[\u4e00-\u9fff]/.test(message) && message.length <= 300 && !message.includes("\n");
  const text = userFacing
    ? translate(locale, "store.toast.sendFailed", { reason: message })
    : translate(locale, "store.toast.sendFailedGeneric");
  if (hasErrorInCurrentTurn(get().messagesBySession[sessionId] ?? [], text)) return;
  get().ingestEvent({ type: "error", sessionId, message: text, code: "send_rejected" });
}

/**
 * Resolve the model a send should actually use.
 *
 * Only an EXPLICIT selection passes through: `model !== "default"` and still
 * resolvable against the active provider's model surface (claude and pi have
 * no default model — the user must pick one). For pi the id must resolve
 * against `piAvailableModels` (the picker's only surface): a stale id
 * (provider deleted mid-session, or a builtin-catalog id like "anthropic/…"
 * picked before the list was filtered to user-configured providers) is not
 * sent — it was never actually configured.
 *
 * "default" (nothing picked — the chip shows "选择模型") returns null, as
 * does a provider with nothing selectable at all. The caller then blocks the
 * send: it toasts a "select a model" nudge when the provider HAS selectable
 * models (`hasSelectableModel`), or opens the config dialog when it has
 * none — never silently falls back to a first/implicit model.
 */
export function resolveSendModel(
  s: Pick<SessionState, "model" | "customModelId" | "providerId" | "providers" | "customModels" | "piAvailableModels" | "codexAvailableModels">,
): { model: string; customModelId: string | null } | null {
  const provider = s.providers.find((p) => p.id === s.providerId);
  if (provider?.id === "pi-sdk") {
    if (s.model !== "default" && s.piAvailableModels.some((m) => m.id === s.model)) {
      return { model: s.model, customModelId: null };
    }
    return null;
  }
  if (provider?.id === "codex-sdk") {
    if (s.model !== "default" && s.codexAvailableModels.some((m) => m.id === s.model)) {
      return { model: s.model, customModelId: null };
    }
    return null;
  }
  if (s.model !== "default") return { model: s.model, customModelId: s.customModelId };
  if (!provider || provider.id === "claude-sdk") return null;
  // Other providers may declare usable built-ins (Auto placeholder skipped):
  // "default" keeps resolving to the first concrete entry for them.
  const builtins = provider.capabilities.builtinModels ?? [];
  const first = builtins.find((b) => b.id !== "default") ?? builtins[0];
  return first ? { model: first.id, customModelId: null } : null;
}

/** Whether the active provider has ANY selectable model (regardless of
 *  whether one is picked) — mirrors the ModelDropdown's selectable surface
 *  per provider. Distinguishes the send-guard outcomes: nothing selectable →
 *  the config dialog is the only way out; selectable-but-unpicked → a light
 *  toast nudge to pick one. */
export function hasSelectableModel(
  s: Pick<SessionState, "providerId" | "providers" | "customModels" | "piAvailableModels" | "codexAvailableModels">,
): boolean {
  const provider = s.providers.find((p) => p.id === s.providerId);
  if (provider?.id === "pi-sdk") return s.piAvailableModels.length > 0;
  if (provider?.id === "codex-sdk") return s.codexAvailableModels.length > 0;
  if (provider?.id === "claude-sdk") {
    return s.customModels.some((cfg) => cfg.models.some((m) => m.id.trim()));
  }
  return (provider?.capabilities.builtinModels?.length ?? 0) > 0;
}

/** Snapshot of the composer's per-provider remembered config — the value
 *  shape of `lastModelByProvider`. Every writer (setModel / setCustomModel /
 *  setEffort / setPermissionMode / setProvider's outgoing stash) records the
 *  FULL current config so the entry is always a complete restore point. */
export function rememberedEntryOf(
  s: Pick<SessionState, "model" | "customModelId" | "effort" | "permissionMode">,
): { model: string; customModelId: string | null; effort: EffortLevel; permissionMode: PermissionMode } {
  return {
    model: s.model,
    customModelId: s.customModelId,
    effort: s.effort,
    permissionMode: s.permissionMode,
  };
}

/** Persist the composer's current provider/model choice — the "next session"
 *  defaults — so the next launch pre-selects the same SDK + model the user
 *  last picked (setProvider / setModel / setCustomModel call this). Fire-and-
 *  forget, like the other setting.set callers. */
export function persistComposerSelection(
  s: Pick<SessionState, "providerId" | "model" | "customModelId" | "lastModelByProvider">,
): void {
  void api.setting
    .set({
      key: UI_COMPOSER_MODEL_SETTING_KEY,
      value: JSON.stringify({
        providerId: s.providerId,
        model: s.model,
        customModelId: s.customModelId,
        lastModelByProvider: s.lastModelByProvider,
      }),
    })
    .catch((err) => {
      console.error("setting.set(composerModel) failed:", err);
    });
}

/** Validate a remembered {model, customModelId} pair against the CURRENT
 *  provider + model lists — same rules as validateComposerSelection. Returns
 *  the entry when still valid, null when the model was deleted (caller then
 *  falls back to "default"). */
export function isValidRememberedModel(
  s: Pick<SessionState, "providers" | "customModels" | "piAvailableModels" | "codexAvailableModels">,
  providerId: string,
  entry: { model: string; customModelId: string | null } | undefined,
): entry is { model: string; customModelId: string | null } {
  if (!entry || entry.model === "default") return !!entry;
  const provider = s.providers.find((p) => p.id === providerId);
  if (!provider) return false;
  if (provider.id === "pi-sdk") {
    return s.piAvailableModels.some((m) => m.id === entry.model);
  }
  if (provider.id === "codex-sdk") {
    return s.codexAvailableModels.some((m) => m.id === entry.model);
  }
  if (provider.id === "claude-sdk") {
    const cfg = s.customModels.find((m) => m.id === entry.customModelId);
    return (
      !!cfg &&
      !!entry.customModelId &&
      cfg.models.some((m) => m.id === entry.model && m.id.trim())
    );
  }
  return (provider.capabilities.builtinModels ?? []).some((b) => b.id === entry.model);
}

/**
 * Drop a stale persisted composer choice back to auto. Runs after the model
 * lists reload (providers / custom endpoints / pi models): if the persisted
 * provider no longer exists, or the chosen model was deleted (custom config
 * removed / pi model gone), the selection falls back to the default provider
 * + "default" (auto) — and the reset is persisted so it doesn't reapply a
 * stale choice on the next launch. Sessions that already have messages are
 * skipped: their config is row-authoritative and re-synced on select.
 */
export function validateComposerSelection(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
): void {
  const s = get();
  const activeId = s.activeSessionId;
  if (activeId) {
    const bucket = s.messagesBySession[activeId];
    if (bucket && bucket.length > 0) return;
  }
  // Already auto with no custom config → nothing to validate.
  if (s.model === "default" && !s.customModelId) return;

  const provider = s.providers.find((p) => p.id === s.providerId);
  let patch: Partial<SessionState> | null = null;
  if (!provider) {
    // The SDK itself is gone (unregistered) — reset to the default provider.
    patch = { providerId: DEFAULT_PROVIDER_ID, model: "default", customModelId: null };
  } else if (provider.id === "pi-sdk") {
    const ok = s.piAvailableModels.some((m) => m.id === s.model);
    if (!ok) patch = { model: "default", customModelId: null };
  } else if (provider.id === "codex-sdk") {
    const ok = s.codexAvailableModels.some((m) => m.id === s.model);
    if (!ok) patch = { model: "default", customModelId: null };
  } else if (provider.id === "claude-sdk") {
    // Valid only when the custom config still exists AND the selected model
    // is still configured on it.
    const cfg = s.customModels.find((m) => m.id === s.customModelId);
    const ok =
      !!cfg &&
      !!s.customModelId &&
      cfg.models.some((m) => m.id === s.model && m.id.trim());
    if (!ok) patch = { model: "default", customModelId: null };
  } else {
    const ok = (provider.capabilities.builtinModels ?? []).some((b) => b.id === s.model);
    if (!ok) patch = { model: "default", customModelId: null };
  }
  if (!patch) return;
  // Also drop the stale remembered model for the current provider so a later
  // SDK switch back doesn't restore a deleted model.
  if (s.providerId in s.lastModelByProvider) {
    const { [s.providerId]: _drop, ...rest } = s.lastModelByProvider;
    patch = { ...patch, lastModelByProvider: rest };
  }
  set(patch);
  persistComposerSelection(get());
}

/** Hydrate the per-session context-window snapshot from the session row.
 *  The snapshot is persisted by main on every `token-usage.updated` event
 *  (RuntimeManager.emit), so on select/open-tab we can restore the last
 *  known occupancy without waiting for the next event. Pre-refactor rows
 *  may hold a stale raw-usage object (no `usedTokens` / `pct` / …) -
 *  `isValidSnapshot` guards against those so the chip doesn't render NaN.
 *
 *  When the row carries no valid snapshot we leave any existing
 *  `contextSnapshotBySession[sid]` slot untouched rather than clearing it.
 *  The slot may already hold a fresher value pushed by a live
 *  `token-usage.updated` event (e.g. re-entering a still-running thread),
 *  and clobbering it with `delete` here is what made the context ring
 *  disappear on re-entry until the next event happened to arrive. An empty
 *  row genuinely never had a snapshot, in which case the slot is already
 *  undefined and the ring correctly stays hidden until the first event. */
export function hydrateContextSnapshot(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, get().streamSessions, sessionId);
  const snapshot = sess?.contextSnapshot;
  if (!snapshot || !isValidSnapshot(snapshot)) {
    // No usable snapshot on the row - leave any existing slot as-is so we
    // don't wipe a fresher live value. (Switching to a session that truly
    // has no snapshot still shows no ring, since the slot is undefined.)
    return;
  }
  set((s) => {
    const prev = s.contextSnapshotBySession[sessionId];
    // Skip the write if the cached row's snapshot is the same reference we
    // already have - avoids a spurious new-object allocation on every tab
    // switch and the re-render it would trigger in ComposerToolbar.
    if (prev === snapshot) return {};
    return {
      contextSnapshotBySession: { ...s.contextSnapshotBySession, [sessionId]: snapshot },
    };
  });
}

/** Hydrate the capsule state slices (todos / subagents / plan draft) from
 *  the session row. Each slice is restored independently — a session may
 *  have todos but no subagents, etc. Slices absent on the row are cleared
 *  so switching FROM a session with data TO one without doesn't leave the
 *  previous capsule stale. Mirrors hydrateContextSnapshot's pattern. */

/** Drop legacy non-agent entries from a persisted subagent roster. Rosters
 *  written before the adapter's NON_AGENT_TASK_TYPES filter could contain
 *  CLI bash tasks (`sleep` waits etc.) stuck on "running" — the CLI doesn't
 *  emit a closing task_updated for them mid-turn, so they poisoned both the
 *  capsule and the busy/queue gate. A non-backgrounded "running" entry
 *  cannot exist at rest in clean data (flushFinal completes them at turn
 *  end), so dropping is safe. Memoized per raw-array reference so the
 *  "already matches" guard in hydrateCapsule stays reference-stable. */
const sanitizeSubagentRoster = (() => {
  const cache = new WeakMap<SubagentSnapshot[], SubagentSnapshot[]>();
  return (list: SubagentSnapshot[]): SubagentSnapshot[] => {
    const hit = cache.get(list);
    if (hit) return hit;
    const dirty = list.some((a) => a.status === "running" && !a.isBackgrounded);
    const out = dirty ? list.filter((a) => !(a.status === "running" && !a.isBackgrounded)) : list;
    cache.set(list, out);
    return out;
  };
})();

export function hydrateCapsule(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, get().streamSessions, sessionId);
  const todos = sess?.todos ?? null;
  const subagents = sess?.subagents ?? null;
  const planDraft = sess?.planDraft ?? null;
  set((s) => {
    // Sanitize before the has/same checks: a legacy roster whose entries
    // are ALL stale running bash tasks sanitizes to empty and must clear
    // the capsule slice, not keep the raw array.
    const cleanSubagents =
      subagents && Array.isArray(subagents) && subagents.length > 0
        ? sanitizeSubagentRoster(subagents)
        : null;
    // A RUNNING turn owns the roster — its event stream is fresher than the
    // cached row (which predates the turn), so hydrating from it would clobber
    // live subagents. The turn.done row-patch syncs the terminal state; only
    // an at-rest session hydrates from the row.
    const running = s.runningBySession[sessionId] === true;
    const hasTodos = !!(todos && Array.isArray(todos) && todos.length > 0);
    const hasSubagents = !!cleanSubagents;
    const hasPlan = !!(planDraft && planDraft.phase !== "cleared" && planDraft.plan);
    // If this session was manually interrupted, the persisted roster may
    // still carry `running` subagents (the abort's flushFinal runs async and
    // can race this hydration). Demote any `running` entry to `killed` so
    // re-entering the thread can't resurrect "运行中" subagents the user
    // already stopped. Mirrors the late-event guard in the subagent.update
    // handler below. The rewrite always yields a fresh array, so an
    // interrupted session is treated as always-changed (rare edge).
    const interrupted = !!s.interruptedBySession[sessionId];
    // Per-slice "already matches" guards — re-switching to an already-loaded
    // tab used to clone all three maps unconditionally, tripping subscriber
    // re-renders even when nothing changed.
    const todosSame = hasTodos
      ? s.todosBySession[sessionId] === todos
      : !(sessionId in s.todosBySession);
    // Running turn: skip the roster slice entirely (see `running` above).
    const subagentsSame = running
      ? true
      : interrupted
        ? false
        : hasSubagents
          ? s.subagentsBySession[sessionId] === cleanSubagents
          : !(sessionId in s.subagentsBySession);
    const planSame = hasPlan
      ? s.planBySession[sessionId] === planDraft
      : !(sessionId in s.planBySession);
    if (todosSame && subagentsSame && planSame) return {};

    // Clone + patch only the slices that actually changed.
    const patch: Partial<
      Pick<SessionState, "todosBySession" | "subagentsBySession" | "planBySession">
    > = {};
    if (!todosSame) {
      const todosBySession = { ...s.todosBySession };
      if (hasTodos) todosBySession[sessionId] = todos as TodoItem[];
      else delete todosBySession[sessionId];
      patch.todosBySession = todosBySession;
    }
    if (!subagentsSame) {
      const subagentsBySession = { ...s.subagentsBySession };
      if (cleanSubagents) {
        subagentsBySession[sessionId] = interrupted
          ? cleanSubagents.map((a) =>
              a.status === "running" ? { ...a, status: "killed" as const } : a,
            )
          : cleanSubagents;
      } else {
        delete subagentsBySession[sessionId];
      }
      patch.subagentsBySession = subagentsBySession;
    }
    if (!planSame) {
      const planBySession = { ...s.planBySession };
      if (planDraft && planDraft.phase !== "cleared" && planDraft.plan) {
        planBySession[sessionId] = planDraft as PlanDraft;
      } else {
        delete planBySession[sessionId];
      }
      patch.planBySession = planBySession;
    }
    return patch;
  });
}

/** Hydrate the per-turn modified-files card from the session row. The card is
 *  persisted so it survives a session reopen. An absent/empty turnFiles on the
 *  row is cleared so switching FROM a session with a card TO one without
 *  doesn't leave the old card up. Mirrors hydrateCapsule's pattern. */
export function hydrateTurnFiles(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, get().streamSessions, sessionId);
  const turnFiles = sess?.turnFiles ?? null;
  set((s) => {
    const hasValue = !!(turnFiles && Array.isArray(turnFiles) && turnFiles.length > 0);
    const hadValue = sessionId in s.turnFilesBySession;
    // Skip the write when the cached row's value is already the reference we
    // have, or both sides are empty — otherwise re-switching to an
    // already-loaded tab clones the map and trips a subscriber re-render for
    // nothing. Mirrors hydrateContextSnapshot's prev===snapshot guard.
    if (hasValue ? s.turnFilesBySession[sessionId] === turnFiles : !hadValue) return {};
    const next = { ...s.turnFilesBySession };
    if (turnFiles && Array.isArray(turnFiles) && turnFiles.length > 0) {
      next[sessionId] = turnFiles;
    } else {
      delete next[sessionId];
    }
    return { turnFilesBySession: next };
  });
}

/** Hydrate the per-session bookmark list from the session row. Persisted on
 *  the row so the capsule segment + timeline markers survive a reopen. An
 *  absent/empty list on the row clears the bucket so switching sessions
 *  doesn't leave the previous thread's bookmarks up. Mirrors
 *  hydrateTurnFiles's pattern (including the reference-equality guard). */
export function hydrateBookmarks(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, get().streamSessions, sessionId);
  const bookmarks = sess?.bookmarks ?? null;
  set((s) => {
    const hasValue = !!(bookmarks && Array.isArray(bookmarks) && bookmarks.length > 0);
    const hadValue = sessionId in s.bookmarksBySession;
    // Same skip-write guard as hydrateTurnFiles: avoid cloning the map (and
    // tripping subscribers) when nothing actually changed.
    if (hasValue ? s.bookmarksBySession[sessionId] === bookmarks : !hadValue) return {};
    const next = { ...s.bookmarksBySession };
    if (bookmarks && Array.isArray(bookmarks) && bookmarks.length > 0) {
      next[sessionId] = bookmarks;
    } else {
      delete next[sessionId];
    }
    return { bookmarksBySession: next };
  });
}

/** Hydrate the per-session subagent transcripts from the session row (the
 *  side-panel subagent viewer's data source). Persisted by main after every
 *  transcript update; absent/empty on the row clears the bucket so switching
 *  sessions doesn't leave the previous thread's transcripts up. Mirrors
 *  hydrateBookmarks's pattern (including the reference-equality guard). */
export function hydrateSubagentTranscripts(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, get().streamSessions, sessionId);
  const transcripts = sess?.subagentTranscripts ?? null;
  set((s) => {
    // A running turn owns the transcripts — its event stream is fresher than
    // the cached row (which predates the turn); hydrating from it would
    // clobber live subagent content. turn.done's row-patch syncs the final
    // state; only an at-rest session hydrates from the row.
    if (s.runningBySession[sessionId] === true) return {};
    const hasValue = !!(transcripts && Object.keys(transcripts).length > 0);
    const hadValue = sessionId in s.subagentTranscriptsBySession;
    if (hasValue ? s.subagentTranscriptsBySession[sessionId] === transcripts : !hadValue) return {};
    const next = { ...s.subagentTranscriptsBySession };
    if (hasValue) next[sessionId] = transcripts;
    else delete next[sessionId];
    return { subagentTranscriptsBySession: next };
  });
}

/** Patch ONLY the bookmarks field on the cached session row(s), keeping the
 *  caller's array reference so a follow-up hydrateBookmarks hits its
 *  reference-equality guard and skips the write. Unlike
 *  applySessionPinnedState this must NOT re-sort or move the row — a bookmark
 *  write must not re-order the session list. No-op when no cache holds the
 *  row (e.g. a side chat, which the caches don't track). */
export function patchSessionRowBookmarks(
  s: SessionState,
  sessionId: string,
  projectId: string,
  bookmarks: SessionBookmark[],
): Partial<SessionState> {
  const patch: Partial<SessionState> = {};
  const mapRow = (x: Session) => (x.id === sessionId ? { ...x, bookmarks } : x);
  const activeList = s.sessionsByProject[projectId];
  if (activeList?.some((x) => x.id === sessionId)) {
    patch.sessionsByProject = { ...s.sessionsByProject, [projectId]: activeList.map(mapRow) };
  }
  const archivedList = s.archivedSessionsByProject[projectId];
  if (archivedList?.some((x) => x.id === sessionId)) {
    patch.archivedSessionsByProject = {
      ...s.archivedSessionsByProject,
      [projectId]: archivedList.map(mapRow),
    };
  }
  if (s.pinnedSessions.some((x) => x.id === sessionId)) {
    patch.pinnedSessions = s.pinnedSessions.map(mapRow);
  }
  return patch;
}

/** Hydrate the per-turn usage history from the session row. The history is
 *  persisted at each turn-end (main process), so it survives restart. Absent
 *  history on the row is cleared so switching FROM a session with history TO
 *  one without doesn't leave the previous thread's rows up. */
export function hydrateUsageHistory(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  sessionId: string,
): void {
  const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, get().streamSessions, sessionId);
  const history = sess?.usageHistory ?? null;
  set((s) => {
    const hasValue = !!(history && Array.isArray(history) && history.length > 0);
    const hadValue = sessionId in s.usageHistoryBySession;
    // Skip the write when the cached row's history is already the reference we
    // have, or both sides are empty — otherwise re-switching to an
    // already-loaded tab clones the map and trips a subscriber re-render.
    if (hasValue ? s.usageHistoryBySession[sessionId] === history : !hadValue) return {};
    // Defensive: a live bucket can be AHEAD of the row cache — the turn.done
    // append mirrors into the row, but that mirror is best-effort (archived
    // rows aren't patched; any future append path that misses it would
    // regress the same way). Hydration reads the ROW; it must never shrink a
    // bucket that holds strictly more records than the row knows about.
    const live = s.usageHistoryBySession[sessionId];
    if (live && live.length > (history?.length ?? 0)) return {};
    const next = { ...s.usageHistoryBySession };
    if (history && Array.isArray(history) && history.length > 0) {
      next[sessionId] = history;
    } else {
      delete next[sessionId];
    }
    return { usageHistoryBySession: next };
  });
}

/* ──────────────── Plan block helpers (inline plan in the message stream) ────────────────
 *
 * The plan is rendered as a `kind: "plan"` block attached to the CURRENT
 * turn's trailing assistant message, rather than a session-global footer card.
 * This keeps each turn's plan frozen in its place in history — different turns
 * produce different plans, none overwriting another.
 *
 * All four plan-aware code paths (plan.update, plan.approval_request,
 * turn.done, submitPlanApproval) funnel through `upsertLivePlanBlock` /
 * `freezeOrPrunePlanBlocks` so the message-array surgery stays in one place.
 */

/** Find the index of the trailing assistant message of the currently-open
 *  turn (the LAST assistant message whose turnMeta has no endedAt), or -1 if
 *  no open-turn assistant message exists. Used to locate where the live plan
 *  block should be attached / removed.
 *
 *  NOTE: only a turn's OPENER carries turnMeta, so this actually resolves to
 *  the opener — the right anchor for plan/turn-files cards (the render layer
 *  re-pins those footers to the turn's end regardless of host message). For
 *  append-order-sensitive content (tool_use fallback) use
 *  {@link findOpenTurnLastAssistant} instead, which returns the turn's
 *  chronologically-LAST assistant message. */
function findOpenTurnTrailingAssistant(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      return i;
    }
  }
  return -1;
}

/** Find the chronologically-LAST assistant message of the currently-open
 *  turn, or -1 if the turn has no assistant messages yet. Only the opener
 *  carries turnMeta (later messages of the same turn don't), so this walks
 *  forward from the opener to the end of the list — appending here keeps the
 *  flattened message timeline in ARRIVAL order. The tool.use fallback MUST
 *  use this, not the opener: appending a tool to the opener while later
 *  narration messages exist places the tool BEFORE text that had already
 *  streamed, and the renderer's completed-turn split ("everything up to the
 *  last tool call is process") then misclassifies that narration as the
 *  final reply — the "process data leaks below the panel" bug. */
export function findOpenTurnLastAssistant(messages: ChatMessage[]): number {
  const openerIdx = findOpenTurnTrailingAssistant(messages);
  if (openerIdx === -1) return -1;
  for (let i = messages.length - 1; i > openerIdx; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return i;
  }
  return openerIdx;
}

/** The planId used for the single "live" plan block within the current turn.
 *  There is at most one live plan per turn at a time (the model calls
 *  EnterPlanMode once, drafts, then ExitPlanMode). Frozen historical blocks
 *  retain this same id — it only needs to be unique within a message, and a
 *  frozen turn's trailing assistant message carries at most one plan block. */
export const LIVE_PLAN_ID = "current";

/** Upsert (or remove) the live plan block on the current turn's trailing
 *  assistant message. Used while the turn is streaming:
 *  - phase "cleared" → remove any live plan block (plan mode exited / denied).
 *  - empty plan text → same as cleared: the EnterPlanMode placeholder has no
 *    content yet, and a blank plan card is noise — only once real plan text
 *    exists does the card appear (see the guard below).
 *  - otherwise → insert-or-replace the live plan block with the given text /
 *    phase / hasApproval.
 *
 *  If the current turn has no assistant message yet (plan.update often
 *  arrives before any text/tool block), a new trailing assistant message is
 *  created and stamped with the current turn's `turnMeta` — mirroring the
 *  tool.use branch's "new turn" detection so we don't double-open a turn.
 *
 *  Returns the new messages array; pure (no store mutation). */
export function upsertLivePlanBlock(
  messages: ChatMessage[],
  plan: string,
  phase: PlanUpdateEvent["phase"],
  hasApproval: boolean,
  /** Send-time anchor (runningTurnStartedAt) to stamp on a newly-opened
   *  turn's turnMeta, so the real row continues the synthesized pendingTurn
   *  row's timing seamlessly. Omitted on the cleared-phase path. */
  startedAtAnchor?: number,
  /** Send-time model anchor (runningTurnModelBySession) stamped alongside the
   *  timing, so a plan-first turn still records which model ran it. */
  modelAnchor?: string,
): ChatMessage[] {
  if (phase === "cleared") {
    // Remove any live plan block from the current turn's trailing assistant
    // message. Frozen blocks (on closed turns) are untouched.
    return removeLivePlanBlock(messages);
  }
  // No real plan content yet — EnterPlanMode emits a placeholder `plan: ""`
  // in phase "drafting", and an empty plan card (0 字 / "计划为空") is noise.
  // The plan panel only appears once the model has actually produced plan
  // text: the final payload arrives on ExitPlanMode ("ready") and the
  // approval_request re-syncs it. So treat an empty draft like "cleared":
  // drop any live block instead of rendering a blank card.
  if (plan.trim().length === 0) {
    return removeLivePlanBlock(messages);
  }
  const block: Block = {
    kind: "plan",
    planId: LIVE_PLAN_ID,
    plan,
    phase,
    hasApproval,
  };
  let next = messages;
  const targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) {
    // No open-turn assistant message exists yet. Plan events commonly arrive
    // before any text/tool block, so we open the turn here - same heuristic
    // as the tool.use branch: a turn is "open" while any assistant message
    // has turnMeta.endedAt === undefined; if none, this starts a new turn.
    const isNewTurn = !next.some(
      (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
    );
    const msg: ChatMessage = {
      id: `plan_${Date.now()}`,
      sessionId: "",
      role: "assistant",
      blocks: [block],
      createdAt: Date.now(),
      // Prefer the send-time anchor so timing is continuous with the
      // synthesized pendingTurn row; fall back to now if none was passed.
      ...(isNewTurn
        ? { turnMeta: { startedAt: startedAtAnchor ?? Date.now(), model: modelAnchor } }
        : {}),
    };
    next = [...next, msg];
    // A new plan-mode turn is opening → demote any prior latest turn-files
    // card to read-only (mirrors upsertLiveTurnFilesBlock's new-turn branch).
    if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
    return next;
  }
  const target = next[targetIndex];
  const existingIdx = target.blocks.findIndex(
    (b) => b.kind === "plan" && b.planId === LIVE_PLAN_ID,
  );
  let blocks: Block[];
  if (existingIdx >= 0) {
    blocks = target.blocks.map((b, i) => (i === existingIdx ? block : b));
  } else {
    // Insert the plan block BEFORE any existing turn-files block so the plan
    // card always renders above the "本轮修改文件" card in the stream,
    // regardless of event arrival order (turn.files can land first when a
    // plan.update arrives after turn.done in edge cases).
    const turnFilesIdx = target.blocks.findIndex((b) => b.kind === "turn-files");
    if (turnFilesIdx >= 0) {
      blocks = [
        ...target.blocks.slice(0, turnFilesIdx),
        block,
        ...target.blocks.slice(turnFilesIdx),
      ];
    } else {
      blocks = [...target.blocks, block];
    }
  }
  next = next.map((m, i) => (i === targetIndex ? { ...m, blocks } : m));
  return next;
}

/** Remove the live plan block from the current turn's trailing assistant
 *  message. Drops the assistant message too if it would end up empty (no
 *  other blocks), so a plan-only message doesn't linger as a blank row. */
function removeLivePlanBlock(messages: ChatMessage[]): ChatMessage[] {
  let next = messages;
  const targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) return next;
  const target = next[targetIndex];
  const filtered = target.blocks.filter(
    (b) => !(b.kind === "plan" && b.planId === LIVE_PLAN_ID),
  );
  if (filtered.length === target.blocks.length) return next; // nothing to remove
  if (filtered.length === 0) {
    // Drop the now-empty assistant message entirely.
    next = next.filter((_, i) => i !== targetIndex);
  } else {
    next = next.map((m, i) => (i === targetIndex ? { ...m, blocks: filtered } : m));
  }
  return next;
}

/** Called from turn.done: freeze or prune plan blocks on the JUST-cLOSED turn.
 *  The closing turn's assistant messages were just stamped with endedAt, so we
 *  can't use the "open turn" heuristic — we key off messages whose turnMeta
 *  endedAt matches `endedAt`.
 *
 *  - A plan block with phase "ready" and non-empty text is KEPT (frozen as a
 *    historical card) — the user approved this plan; it stays in the stream.
 *  - Any other plan block (drafting / cleared / empty) is REMOVED — these are
 *    in-progress or rejected drafts that shouldn't leave a trace.
 *  - An assistant message left with zero blocks after pruning is dropped. */
export function freezeOrPrunePlanBlocks(messages: ChatMessage[], endedAt: number): ChatMessage[] {
  let next = messages.map((m) => {
    if (!m.turnMeta || m.turnMeta.endedAt !== endedAt) return m;
    if (!m.blocks.some((b) => b.kind === "plan")) return m;
    const kept = m.blocks.filter((b) => {
      if (b.kind !== "plan") return true;
      return b.phase === "ready" && b.plan.trim().length > 0;
    });
    return { ...m, blocks: kept };
  });
  // Drop any assistant messages that became empty (a plan-only message whose
  // plan was pruned). Keep user / non-empty messages untouched.
  next = next.filter(
    (m) => m.role !== "assistant" || m.blocks.length > 0,
  );
  return next;
}

/* ──────────────── Turn-files block helpers (inline "本轮修改" card) ────────────────
 *
 * Mirrors the plan-block pattern: the per-turn modified-files card renders as
 * a `kind: "turn-files"` block attached to its turn's trailing assistant
 * message, frozen in place when the turn ends. Each turn that touched files
 * keeps its own card in history — new turns add new cards, old cards are
 * never deleted (only demoted to read-only once a newer turn supersedes them
 * as "the latest rewindable turn").
 *
 * Only the LATEST turn's card is rewindable (`isLatestTurn === true`); the
 * rewind itself still goes through the in-memory FileSnapshot (cleared per
 * turn), so older turns are display-only snapshots. Historical cards persist
 * to the messages table via the normal blocks round-trip (toRecords /
 * fromRecords) — no DB schema change.
 */

/** The filesId used for the single "live" turn-files block within the current
 *  turn. Same rationale as LIVE_PLAN_ID: at most one live block per turn. */
const LIVE_FILES_ID = "current";

/** Upsert the live turn-files block on the current turn's trailing assistant
 *  message. Called from the turn.files handler.
 *
 *  Attach target resolution (in priority order):
 *  1. The trailing assistant message of the currently-OPEN turn (turnMeta with
 *     no endedAt) - the normal end-of-turn case: flushFinal emits turn.files
 *     BEFORE its turn.done, so the turn is still open when the card lands.
 *  2. The most recent assistant message - the interrupted-turn case. After a
 *     user stop, interrupt() stamps endedAt on every open turn locally, and
 *     the aborted turn's flushFinal (running while the SDK generator unwinds)
 *     emits its turn.files only afterwards - the turn is closed by then and
 *     (1) finds nothing. The file list still belongs to that just-stopped
 *     turn, so we attach it to the most recent assistant message WITHOUT
 *     opening a new turn. Opening a new turn here would spawn a phantom
 *     "开始 · 用时 <1s" stat row that never finalizes.
 *  3. A brand-new assistant message (no turnMeta) - defensive fallback when no
 *     assistant message exists at all.
 *
 *  In every case the block becomes the latest rewindable card
 *  (isLatestTurn=true) and every other turn's card is demoted to read-only.
 *
 *  Returns the new messages array; pure (no store mutation). */
export function upsertLiveTurnFilesBlock(messages: ChatMessage[], files: TurnFileEntry[]): ChatMessage[] {
  // Defensive mirror of FileSnapshot.freeze's net-zero filter: entries with
  // no actual change are pure noise on the card, and filtering them at RENDER
  // time instead would break the path-set equality the `turn.rewound` matcher
  // relies on (card files vs echoed targetFiles). No-op for events emitted by
  // the fixed freeze(); keeps the card honest for any other source.
  const visible = files.filter((f) => f.adds > 0 || f.dels > 0);
  if (visible.length === 0) return messages;
  const block: Block = {
    kind: "turn-files",
    filesId: LIVE_FILES_ID,
    files: visible,
    isLatestTurn: true,
  };
  let next = messages;
  let targetIndex = findOpenTurnTrailingAssistant(next);
  if (targetIndex === -1) {
    // Normal end-of-turn arrival finds the turn still open (flushFinal emits
    // turn.files BEFORE its turn.done). Reaching here means the turn was
    // closed locally already - the interrupted-turn path, where interrupt()
    // stamped endedAt on every open turn while the aborted turn's
    // flushFinal() was still unwinding. The file list still belongs to THAT
    // turn, so fall back to the most recent assistant message and attach the
    // block there - WITHOUT opening a new turn (a phantom "开始 · 用时" stat
    // row would never finalize).
    for (let i = next.length - 1; i >= 0; i--) {
      const m = next[i];
      if (m && m.role === "assistant") {
        targetIndex = i;
        break;
      }
    }
  }
  if (targetIndex === -1) {
    // Truly no assistant message at all (shouldn't happen for a turn that
    // touched files, but stay defensive): create one WITHOUT a turnMeta so we
    // don't spawn a phantom "开始 · 用时" stat row for an already-ended turn.
    const msg: ChatMessage = {
      id: `files_${Date.now()}`,
      sessionId: "",
      role: "assistant",
      blocks: [block],
      createdAt: Date.now(),
    };
    next = [...next, msg];
    next = demotePreviousLatestTurnFiles(next);
    return next;
  }
  const target = next[targetIndex];
  const existingIdx = target.blocks.findIndex(
    (b) => b.kind === "turn-files" && b.filesId === LIVE_FILES_ID,
  );
  let blocks: Block[];
  if (existingIdx >= 0) {
    blocks = target.blocks.map((b, i) => (i === existingIdx ? block : b));
  } else {
    // Always insert the turn-files block at the VERY END of the blocks array
    // so the "本轮修改了 N 个文件" card renders below all text/plan content.
    blocks = [...target.blocks, block];
  }
  next = next.map((m, i) => (i === targetIndex ? { ...m, blocks } : m));
  // This turn's card is now the latest → demote every OTHER turn's card to
  // read-only. (Without this, a brief window between turn.files and turn.done
  // would show two cards with the rewind button: the previous turn's frozen
  // card and this turn's new one.) The current turn's block stays true because
  // demotePreviousLatestTurnFiles runs BEFORE we re-stamped it above — but to
  // be safe we re-stamp the target's own block as true after demoting.
  next = demotePreviousLatestTurnFiles(next);
  next = next.map((m, i) => {
    if (i !== targetIndex) return m;
    if (!m.blocks.some((b) => b.kind === "turn-files")) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" ? { ...b, isLatestTurn: true } : b,
      ),
    };
  });
  return next;
}

/** Append a turn-scoped CARD block (compact summary, workflow node result) to the
 *  current turn's trailing assistant message. If no open-turn assistant message
 *  exists yet (the event arrives before any model text), create one WITH a
 *  turnMeta so it opens a proper turn in the stream - mirroring how tool.use
 *  creates a turn opener. Without the turnMeta the card would either attach to
 *  the PREVIOUS turn's message (wrong position) or float as an orphan (no stat
 *  row). */
/**
 * 把某个岔路口那张卡**在原地**换成新的。找不到返回 `null`(由调用方去追加)。
 *
 * 原地而不是"替换最后一张":用户可能在它之后又收到了别的卡片(同一次运行里另一个
 * 分支节点也在问),而那张旧卡还在上面 —— 只动最后一张会把别的卡改掉。
 *
 * 认的是 **`runId + nodeId + attempt`**。只看 `nodeId` 的话,同一张图跑第二轮时会把
 * **上一轮那张旧卡**的内容改掉,而用户看到的是"一张早就点过的卡突然变了"。
 * `attempt` 那一位同理,只是它拦的是**同一次运行里的下一个来回**(回头,见
 * `Block` 里那个字段)。
 */
function patchBranchChoiceBlock(
  messages: ChatMessage[],
  runId: string,
  nodeId: string,
  attempt: number,
  next: Block,
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const at = m.blocks.findIndex(
      (b) =>
        b.kind === "workflow-branch-choice" &&
        b.runId === runId &&
        b.nodeId === nodeId &&
        b.attempt === attempt,
    );
    if (at < 0) continue;
    const out = messages.slice();
    const blocks = m.blocks.slice();
    blocks[at] = next;
    out[i] = { ...m, blocks };
    return out;
  }
  return null;
}

/**
 * **同一格回头绕第二圈:把上一轮那张卡换成这一轮的。**
 *
 * 环回的图(写稿 → 审稿 → 回去改)会让同一个节点反复收场,每张卡都带一大段产出 ——
 * 三圈下来对话里就是三张大差不多的卡,用户要往下滚很久才看得见流程走到哪。留下的是
 * **最后一版**(环回的意义就是"改完之后那一版")。
 *
 * ## 认卡按 `runId + nodeId`
 *
 * **轮次不进认卡的身份**,它是被换上去的内容之一。第一轮先插一张,第二轮换了它,
 * 第三轮再换 —— 三圈下来从头到尾只有一张,带的是最后一轮的轮次。
 *
 * 轮次**不能**当身份:拿它去匹配等于"找一张标着第 N 轮的卡",而每次来的都是 N+1,
 * 于是永远找不着自己上一轮那张,一圈插一张,叠卡这个毛病等于没修。
 *
 * ⚠️ 同一格在同一轮里收场两次(续跑、补花费)会命中同一张卡、原地覆盖一遍 —— 无害,
 * 内容本来就是要覆盖的那个。
 *
 * **找不到返回 `null`**,调用方据此走"插一张新的"。
 */
function patchWorkflowNodeResultBlock(
  messages: ChatMessage[],
  next: Extract<Block, { kind: "workflow-node-result" }>,
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const at = m.blocks.findIndex(
      (b) =>
        b.kind === "workflow-node-result" &&
        b.runId === next.runId &&
        b.nodeId === next.nodeId,
    );
    if (at < 0) continue;
    const out = messages.slice();
    const blocks = m.blocks.slice();
    blocks[at] = next;
    out[i] = { ...m, blocks };
    return out;
  }
  return null;
}

/**
 * **给一张已经画出来的步骤卡补上花费,别的什么都不动。**
 *
 * 按 `runId + nodeId` 找 —— 和结果卡认卡用的是同一对(见 `workflow-node-result` 里那
 * 两个字段的注释)。**找不到返回 `null`**(调用方据此原样返回 state,不触发重渲染)。
 *
 * 返回**新的数组**(而不是就地改):store 的订阅者比的是引用,就地改的话卡片不会重画。
 */
function removeWorkflowNodeProgressBlock(
  messages: ChatMessage[],
  runId: string,
  nodeId: string,
): ChatMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    const blocks = m.blocks.filter(
      (b) => !(b.kind === "workflow-node-progress" && b.runId === runId && b.nodeId === nodeId),
    );
    if (blocks.length !== m.blocks.length) {
      changed = true;
      return { ...m, blocks };
    }
    return m;
  });
  return changed ? out : messages;
}

function patchWorkflowNodeProgressBlock(
  messages: ChatMessage[],
  next: Extract<Block, { kind: "workflow-node-progress" }>,
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const at = m.blocks.findIndex(
      (b) => b.kind === "workflow-node-progress" && b.runId === next.runId && b.nodeId === next.nodeId,
    );
    if (at < 0) continue;
    const blocks = m.blocks.slice();
    blocks[at] = next;
    const out = messages.slice();
    out[i] = { ...m, blocks };
    return out;
  }
  return null;
}

function patchNodeUsageBlock(
  messages: ChatMessage[],
  runId: string,
  nodeId: string,
  usage: { totalTokens: number; outputTokens: number; costUsd?: number },
): ChatMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const at = m.blocks.findIndex(
      (b) => b.kind === "workflow-node-result" && b.runId === runId && b.nodeId === nodeId,
    );
    if (at < 0) continue;
    const out = messages.slice();
    const blocks = m.blocks.slice();
    const prev = blocks[at];
    if (!prev || prev.kind !== "workflow-node-result") continue;
    // **只改 `usage` 那一项。** 其他字段一个都不碰 —— 这条事件的全部意思就是"补一个数",
    // 顺手用事件里的别的东西覆盖卡片,等于给"补花费"开了一条能改卡片的暗路。
    blocks[at] = { ...prev, usage };
    out[i] = { ...m, blocks };
    return out;
  }
  return null;
}

export function appendTurnCardBlock(
  messages: ChatMessage[],
  block: Block,
  startedAt: number,
  /** Send-time model anchor (see upsertLivePlanBlock.modelAnchor). */
  model?: string,
  /** Prefix for the synthesized opener's id - keeps the card kinds apart in
   *  devtools, and makes a reloaded stream readable. */
  idPrefix = "card",
): ChatMessage[] {
  // Look for an OPEN turn's trailing assistant message (turnMeta present,
  // endedAt undefined = turn.done hasn't landed). This is the correct target
  // - the card belongs to the CURRENT turn, not a previous one.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined) {
      const next = messages.slice();
      next[i] = { ...m, blocks: [...m.blocks, block] };
      return next;
    }
  }
  // No open-turn assistant message yet - create a turn-opener assistant message
  // carrying the card, stamped with turnMeta so it renders as the start of the
  // current turn (with its own stat row, correct grouping, etc.).
  const opener: ChatMessage = {
    id: `${idPrefix}_${Date.now()}`,
    sessionId: "",
    role: "assistant",
    blocks: [block],
    createdAt: Date.now(),
    turnMeta: { startedAt, model },
  };
  return [...messages, opener];
}

/**
 * 给"已经收场的那一步"的过程快照封顶(见 `NODE_ARCHIVE_KEEP`)。
 *
 * 数的是**块数**不是字节数:块的大小差好几个量级(一条 `text` 几百字,一条 `tool_use`
 * 里的 `input` 可以是一整份文件),而这里要挡的是"一张图跑了一整天之后,消息表被这些
 * 快照撑大"。块数是个够用的代理量,而且**不用把数据序列化一遍去数** —— 这个函数在每次
 * 节点收场时都会跑。
 *
 * 超了就丢**块数最多的那些**,保留原本的顺序(`NODE_ARCHIVE_KEEP` 那条注释说了
 * 为什么是按大小而不是按新旧)。
 *
 * 没超的时候返回**原数组**(引用相等)—— 调用方靠它跳过重渲染。
 */
function capNodeArchives(messages: ChatMessage[]): ChatMessage[] {
  let total = 0;
  const holders: Array<{ messageAt: number; blockAt: number; size: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    for (let j = 0; j < m.blocks.length; j++) {
      const b = m.blocks[j];
      if (b?.kind !== "workflow-node-result" || !b.nodeTranscript) continue;
      total += b.nodeTranscript.length;
      holders.push({ messageAt: i, blockAt: j, size: b.nodeTranscript.length });
    }
  }
  if (total <= NODE_ARCHIVE_KEEP) return messages;

  holders.sort((a, b) => b.size - a.size);
  const drop = new Set<string>();
  let left = total;
  for (const h of holders) {
    if (left <= NODE_ARCHIVE_KEEP) break;
    drop.add(`${h.messageAt}:${h.blockAt}`);
    left -= h.size;
  }
  if (drop.size === 0) return messages;

  return messages.map((m, i) => {
    if (!m.blocks.some((_b, j) => drop.has(`${i}:${j}`))) return m;
    return {
      ...m,
      blocks: m.blocks.map((b, j) =>
        drop.has(`${i}:${j}`) && b.kind === "workflow-node-result"
          ? { ...b, nodeTranscript: undefined }
          : b,
      ),
    };
  });
}

/** Demote EVERY turn-files block's `isLatestTurn` to false. Called when a new
 *  turn opens (the previous "latest" card is no longer the latest — only the
 *  most recent completed turn is rewindable). The new turn's own card, once it
 *  arrives via turn.files, sets isLatestTurn=true on insert. */
export function demotePreviousLatestTurnFiles(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!m.blocks.some((b) => b.kind === "turn-files" && b.isLatestTurn)) return m;
    changed = true;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" && b.isLatestTurn ? { ...b, isLatestTurn: false } : b,
      ),
    };
  });
  return changed ? next : messages;
}

/** Called from turn.done: finalize the just-closed turn's turn-files block.
 *  The block is already attached (turn.files arrived just before turn.done);
 *  here we only need to ensure it's marked isLatestTurn=true (it IS the latest
 *  completed turn now) and demote all earlier turns' cards to read-only.
 *
 *  Unlike plan blocks, turn-files blocks are NEVER pruned — every turn that
 *  touched files keeps its card in history. (Empty turns never produced a
 *  block in the first place, so there's nothing to clean up.) Keyed off
 *  endedAt so we only touch THIS turn's messages. */
export function freezeLatestTurnFilesBlock(messages: ChatMessage[], endedAt: number): ChatMessage[] {
  // First demote all older turn-files cards to read-only.
  let next = demotePreviousLatestTurnFiles(messages);
  // Then mark this turn's turn-files block(s) as the latest (rewindable).
  // There is at most one live block per turn; a turn's assistant messages all
  // share the same endedAt stamp, so keying off endedAt catches them all.
  next = next.map((m) => {
    if (!m.turnMeta || m.turnMeta.endedAt !== endedAt) return m;
    if (!m.blocks.some((b) => b.kind === "turn-files")) return m;
    return {
      ...m,
      blocks: m.blocks.map((b) =>
        b.kind === "turn-files" ? { ...b, isLatestTurn: true } : b,
      ),
    };
  });
  return next;
}

/** Append one delta to an entry, preserving order: consecutive chunks of the
 *  same kind merge into the trailing segment; a kind switch opens a new one. */
export function appendDelta(entry: DeltaEntry, k: "text" | "thinking", text: string): void {
  if (!text) return;
  const last = entry.segs[entry.segs.length - 1];
  if (last && last.k === k) last.text += text;
  else entry.segs.push({ k, text });
}

export const deltaBuf = new Map<string, DeltaEntry>();

/**
 * 把一个会话的**已缓冲 delta 条目**应用到它的消息列表上,返回新列表(未变则返回**原引用**)。
 *
 * ## 为什么是纯函数
 *
 * 这段逻辑从前整个内联在 `sessionStore.flushDeltas` 的 `setState` 回调里 —— 那是**每帧
 * (~60Hz)都跑**的最烫热路径,却因此**一套测试都碰不到**(回调要真 store + 真 rAF)。
 * 抽出来之后,分段合并、建新回合、丢弃已收尾回合的迟到 delta、最新回合卡的降级
 * 这些规则都能在无头里直接钉住。
 *
 * ## 复杂度:每帧 O(N) 而不是 O(段落数 × N)
 *
 * 原实现在**分段循环里**对每个分段都 `findMsg`(线性扫全表)再 `next.map`(整表重建)——
 * 一个跨文本/思考边界的冲刷窗口带很多分段时,成本是 O(segments × N),N=转录长度。
 * 这里改成:每个条目只 `findIndex` **一次**拿到下标,分段循环里按下标原地更新
 * (列表只 **copy-on-write 一次**)。长对话里这是数量级的差别(几百条消息 × 多个分段)。
 *
 * ## 保真的几处细节
 *
 * - **`next !== list` 才算变**:整条转录都停在终态(全是迟到 delta)时返回原引用,
 *   调用方据此跳过写回 —— 与从前一致,别让每帧都换一次列表身份触发无谓重渲染。
 * - **建新回合**:只有当前没有"未收尾的 assistant 消息"时才算新回合,并从
 *   `runningTurnStartedAt` 取锚点(与 `sendPrompt` 对时,避免时长跳变)。
 * - **收尾过的不再追加**:`turnMeta.endedAt` 已设的消息,迟到 delta 一律丢
 *   (stop→resend 竞态下转录必须冻在用户停下的地方)。
 */
export function applyDeltaEntries(
  list: ChatMessage[],
  sessionEntries: readonly DeltaEntry[],
  opts: {
    /** 当前回合的发送时刻锚点(sendPrompt 落的时间戳),新回合取它当 startedAt。 */
    runningTurnStartedAt?: number;
    /** 当前回合的模型(新回合写进 turnMeta.model,供"开始时间·工作时长"那行)。 */
    runningTurnModel?: string;
    /** 注入的"现在"(省得测试要控制时钟)。 */
    now?: number;
  },
): ChatMessage[] {
  const now = opts.now ?? Date.now();
  let next: ChatMessage[] = list;

  for (const e of sessionEntries) {
    // 一个条目就是一个 messageId(缓冲表按 `sid:messageId` 建键),所以每个条目只
    // 查一次下标即可;下面的分段循环按下标原地改,不再重扫。
    let idx = -1;
    for (let i = 0; i < next.length; i++) {
      if (next[i].id === e.messageId) { idx = i; break; }
    }
    const found = idx === -1 ? undefined : next[idx];
    // 已经收尾的回合:迟到 delta 丢弃,转录冻在收尾那刻。
    if (found && found.turnMeta && found.turnMeta.endedAt !== undefined) continue;

    if (!found) {
      // 当前没有被打开的回合(assistant 消息且未设 endedAt)才算"新回合"。
      const isNewTurn = !next.some(
        (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
      );
      // 新回合优先用发送时刻的锚点,让 turnMeta 接着那句"待定回合"的时间走,时长不跳变。
      const startedAt = (isNewTurn && opts.runningTurnStartedAt) || now;
      const created: ChatMessage = {
        id: e.messageId,
        sessionId: e.sessionId,
        role: "assistant",
        blocks: [],
        createdAt: now,
        ...(isNewTurn
          ? { turnMeta: { startedAt, model: opts.runningTurnModel } }
          : {}),
      };
      if (next === list) next = list.slice();
      next.push(created);
      idx = next.length - 1;
      // 新回合开启 → 上一个"最新"回合的文件卡降为只读(它不再是可撤回的最近一轮)。
      if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
    }

    // 按到达顺序应用分段(跨文本↔思考边界的窗口不能颠倒)。
    for (const seg of e.segs) {
      const cur = next[idx];
      if (!cur || cur.id !== e.messageId) break;
      const blocks = cur.blocks;
      const lastBlock = blocks[blocks.length - 1];
      let updatedMsg: ChatMessage;
      if (seg.k === "text") {
        updatedMsg =
          lastBlock && lastBlock.kind === "text"
            ? { ...cur, blocks: [...blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + seg.text }] }
            : { ...cur, blocks: [...blocks, { kind: "text", text: seg.text } as Block] };
      } else {
        updatedMsg =
          lastBlock && lastBlock.kind === "thinking"
            ? { ...cur, blocks: [...blocks.slice(0, -1), { ...lastBlock, text: lastBlock.text + seg.text }] }
            : { ...cur, blocks: [...blocks, { kind: "thinking", text: seg.text } as Block] };
      }
      if (next === list) next = list.slice(); // 只在真要改时才复制(只此一次/每帧)
      next[idx] = updatedMsg;
    }
  }

  return next;
}

/* ─── Adaptive throttling ───
 *
 * Instead of a fixed rAF cadence, we track the inter-arrival time of deltas
 * via a sliding window and pick a flush strategy that balances throughput
 * (batched during bursts) vs. responsiveness (near-immediate when sparse).
 *
 * Strategy matrix:
 *   avg interval    method         delay
 *   < 16ms          rAF            ~16ms (60 Hz batch)
 *   16-100ms        timer + rAF    ~50ms (moderate batch)
 *   > 100ms         microtask      0ms (flush on next tick)
 *
 * The sliding window keeps the last 5 deltas (by wall-clock ms). The window is
 * module-scoped and never triggers React renders, exactly like deltaBuf itself.
 */
export const deltaArrivals: number[] = [];
const MAX_WINDOW = 5;

export function avgIntervalMs(): number {
  if (deltaArrivals.length < 2) return 0;
  const min = deltaArrivals[0];
  const max = deltaArrivals[deltaArrivals.length - 1];
  return (max - min) / (deltaArrivals.length - 1);
}

export function recordDeltaArrival(): void {
  const now = performance.now();
  deltaArrivals.push(now);
  if (deltaArrivals.length > MAX_WINDOW) deltaArrivals.shift();
}

/** Drop all buffered deltas for a session. Called on interrupt so the aborted
 *  turn's straggler deltas (flushFinal emits them while the SDK generator
 *  unwinds) never reach the transcript — the user asked to STOP, so content
 *  freezes exactly where it was. */
export function clearSessionDeltas(sessionId: string): void {
  if (deltaBuf.size === 0) return;
  for (const [key, entry] of deltaBuf) {
    if (entry.sessionId === sessionId) deltaBuf.delete(key);
  }
}

/** 本端按了停止、但那一轮的 `turn.done{reason:"interrupted"}` 还没到 —— 「欠着一条中断
 *  收口」的会话。`interrupt()` 登记,任何一条 `turn.done` 到达即销账。
 *
 *  ingestEvent 里那条「陈旧 turn.done 守卫」靠它判断:只有**本端**停过、收口还没来、
 *  用户已经重发开了新一轮,late 的 interrupted 收口才是陈旧的、该丢。以前那条守卫只看
 *  `interruptedBySession` 哨兵 —— 哨兵没立就丢,结果**不是本端发起的中断**(主进程轮预算
 *  触顶 `enforceBudget`、手机端点停 `mobileRpc`、工作流取消)发来的收口也被整条丢掉:
 *  `runningBySession` 永远为 true,输入框锁死、「开始·用时」一直在跳、这一轮不落库、
 *  排队的提问不出发。模块级而非 store 状态:它不驱动任何渲染。 */
export const pendingInterruptDone = new Set<string>();

/** Event types that append visible content to the transcript. While a session
 *  is interrupted these are ignored so the aborted turn's late events can't
 *  keep rendering text / tools / images after the Stop click. Status events
 *  (turn.done / error / subagent.update / turn.files ...) are NOT in this set
 *  — they still flow so state cleanup proceeds normally. */
export const CONTENT_FROZEN_EVENTS = new Set<RuntimeEvent["type"]>([
  "text.delta",
  "thinking",
  "tool.use",
  "tool.result",
  "browser.image",
]);

/** The effective working-environment root of the ACTIVE session: the thread's
 *  materialized worktree when it runs isolated, the project root otherwise.
 *  Drives the IDE surfaces (file tree / git panel / terminal / LSP
 *  workspace) so they follow the session's environment instead of always
 *  showing the project checkout. Returns a stable string|null. */
export function selectActiveEnvPath(s: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  sessions: Session[];
  pinnedSessions: Session[];
  sessionsByProject: Record<string, Session[]>;
  projects: { id: string; path: string }[];
}): string | null {
  const pid = s.activeProjectId;
  if (!pid) return null;
  const sid = s.activeSessionId;
  if (sid) {
    let sess = s.sessions.find((x) => x.id === sid);
    if (!sess) sess = s.pinnedSessions.find((x) => x.id === sid);
    if (!sess) {
      for (const list of Object.values(s.sessionsByProject)) {
        const hit = list?.find((x) => x.id === sid);
        if (hit) { sess = hit; break; }
      }
    }
    if (sess?.worktreePath) return sess.worktreePath;
  }
  return s.projects.find((p) => p.id === pid)?.path ?? null;
}

/** 重连时正在跑的会话:等它这一轮的 turn.done 到了再从库里重拉(见
 *  `resyncAfterReconnect`)。等一小会儿,给桌面把这一轮写进库的时间。 */
export const resyncAfterTurn = new Set<string>();
export const RESYNC_AFTER_TURN_DELAY_MS = 1500;

/** `ui.customCommandsByProject` 的 JSON → 校验过的桶。坏条目丢掉,坏 JSON 当空。 */
export function parseCustomCommandsByProject(raw: string | null): Record<string, CustomCommand[]> {
  if (!raw) return {};
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const validated: Record<string, CustomCommand[]> = {};
  for (const [pid, rawList] of Object.entries(obj as Record<string, unknown>)) {
    if (!Array.isArray(rawList)) continue;
    validated[pid] = rawList.filter(
      (c): c is CustomCommand =>
        !!c &&
        typeof c === "object" &&
        typeof c.id === "string" &&
        typeof c.name === "string" &&
        typeof c.command === "string",
    );
  }
  return validated;
}

/** JSON 对象(字符串值)→ Record;坏 JSON / 非对象 → null(调用方保持原值)。 */
function parseStringRecord(raw: string): Record<string, string> | null {
  const obj: unknown = JSON.parse(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * 另一端改了一个「跟着人走」的设置(`setting.changed`,键表见
 * `@contracts/ipc/settingsSync` 的 `SYNCED_SETTING_KEYS`),在这里套用。
 *
 * 只动 store,**不再写回设置表**(库里已经是这个值了)。解析 / 夹取规则与
 * `init` / `initDeferred` 读库时一致 —— 两边任何一处改了规则,另一处也要改。
 */
function applySyncedSetting(set: IngestCtx["set"], key: string, value: string): void {
  if (key === CUSTOM_UI_SETTING_KEY) {
    // Lazy import: customUiStore subscribes to sessionStore at module initialization.
    // A static import here would create a startup temporal-dead-zone cycle.
    void import("@renderer/stores/customUiStore.js")
      .then(({ useCustomUiStore }) => useCustomUiStore.getState().refresh())
      .catch((error: unknown) => console.error("custom UI refresh failed; retaining previous configuration", error));
    return;
  }
  try {
    switch (key) {
      case UI_LOCALE_SETTING_KEY:
        if (value === "zh" || value === "en") {
          set({ locale: value });
          if (typeof document !== "undefined") {
            document.documentElement.lang = value === "en" ? "en" : "zh-CN";
          }
        }
        return;
      case THEME_STYLE_SETTING_KEY:
        if (value === "classic" || value === "sketch") set({ themeStyle: value });
        return;
      case UI_ACCENT_COLOR_SETTING_KEY:
        set({ accentColor: RGB_TRIPLET_RE.test(value) ? value : null });
        return;
      case UI_USER_MSG_COLOR_SETTING_KEY:
        set({ userMessageColor: RGB_TRIPLET_RE.test(value) ? value : null });
        return;
      case UI_EDITOR_THEME_SETTING_KEY:
        set({ editorTheme: parseEditorThemeChoice(value) });
        return;
      case AGENT_OUTPUT_STYLE_SETTING_KEY:
        set({ outputStyle: value || null });
        return;
      case UI_TITLE_GEN_ENABLED_SETTING_KEY:
        set({ titleGenEnabled: value === "on" });
        return;
      case UI_TITLE_GEN_MODEL_SETTING_KEY:
        set({ titleGenModel: value || null });
        return;
      case UI_COMMIT_GEN_MODEL_SETTING_KEY:
        set({ commitGenModel: value || null });
        return;
      case UI_COMMIT_GEN_PROMPT_SETTING_KEY:
        set({ commitGenPrompt: value });
        return;
      case UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY:
        set({ conflictResolveModel: value || null });
        return;
      case WORKFLOW_MAX_PARALLEL_SETTING_KEY: {
        const n = Number(value);
        if (value !== "" && Number.isFinite(n)) set({ workflowMaxParallel: clampWorkflowMaxParallel(n) });
        return;
      }
      case UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY: {
        const n = Number(value);
        if (value !== "" && Number.isFinite(n)) set({ pasteTagThresholdChars: clampPasteTagThresholdChars(n) });
        return;
      }
      case PROJECT_COLORS_SETTING_KEY: {
        const rec = value ? parseStringRecord(value) : {};
        if (rec) set({ projectColors: rec });
        return;
      }
      case WORKTREE_NAMES_SETTING_KEY: {
        const rec = value ? parseStringRecord(value) : {};
        if (rec) set({ worktreeNames: rec });
        return;
      }
      case UI_PROJECT_GROUPS_SETTING_KEY: {
        const parsed: unknown = value ? JSON.parse(value) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          set({ groupMeta: parsed as ProjectGroupsMeta });
        }
        return;
      }
      case UI_PROJECT_VIEW_SETTING_KEY:
        if (value === "flat" || value === "grouped") set({ projectView: value });
        return;
      case UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY:
        set({ customCommandsByProject: parseCustomCommandsByProject(value) });
        return;
      case AUTO_ARCHIVE_SETTING_KEY:
        if (value) set({ autoArchiveConfig: parseAutoArchiveConfig(value) });
        return;
      case UI_SHORTCUTS_SETTING_KEY: {
        if (!value) {
          set({ shortcutOverrides: {} });
          return;
        }
        const parsed = ShortcutBindingsSchema.safeParse(JSON.parse(value));
        if (parsed.success) set({ shortcutOverrides: parsed.data });
        return;
      }
      case UI_GESTURES_SETTING_KEY: {
        if (!value) return;
        const parsed = GestureSettingsSchema.safeParse(JSON.parse(value));
        if (parsed.success) set({ gestureSettings: parsed.data });
        return;
      }
      case SESSION_WORKTREE_DEFAULT_SETTING_KEY:
        if (value === "local" || value === "wt-detached" || value === "wt-branch") {
          set({ envChoice: value });
        }
        return;
      default:
        // 不在同步表里的键主进程根本不会广播;真收到了(新旧版本错配)就忽略。
        return;
    }
  } catch (err) {
    console.error(`apply(setting.changed ${key}) failed:`, err);
  }
}

/**
 * 从本地状态里摘掉一个项目:它的会话桶 / 归档桶 / 分页计数、IDE 编辑器桶、
 * git diff、前进后退历史、属于它的标签;它是当前项目时换到下一个项目和它最新的
 * 会话。本地 `deleteProject` 与「别的端删了项目」(`refreshProjects`)共用。
 * 幂等:项目已经不在时各处 filter / delete 都是空操作。
 */
export function removeProjectFromState(s: SessionState, id: string): Partial<SessionState> {
  const projects = s.projects.filter((p) => p.id !== id);
  const sessionsByProject = { ...s.sessionsByProject };
  const archivedByProject = { ...s.archivedSessionsByProject };
  const totalByProject = { ...s.sessionsTotalByProject };
  const hasMoreByProject = { ...s.sessionsHasMoreByProject };
  // Capture the deleted project's sessionIds BEFORE dropping the entries
  // so we can scrub them from the tab strip — both caches may hold rows.
  const removedSessionIds = new Set([
    ...(sessionsByProject[id] ?? []).map((sess) => sess.id),
    ...(archivedByProject[id] ?? []).map((sess) => sess.id),
  ]);
  delete sessionsByProject[id];
  delete archivedByProject[id];
  delete totalByProject[id];
  delete hasMoreByProject[id];
  // Scrub the deleted project's IDE editor buckets (open files / active
  // file / view mode / expanded dirs) so they don't linger as orphans.
  const ideOpenFilesByProject = { ...s.ideOpenFilesByProject };
  const ideActiveFileByProject = { ...s.ideActiveFileByProject };
  const ideFileViewModeByProject = { ...s.ideFileViewModeByProject };
  const ideExpandedDirsByProject = { ...s.ideExpandedDirsByProject };
  const gitDiffByProject = { ...s.gitDiffByProject };
  const navBackByProject = { ...s.navBackByProject };
  const navForwardByProject = { ...s.navForwardByProject };
  delete ideOpenFilesByProject[id];
  delete ideActiveFileByProject[id];
  delete ideFileViewModeByProject[id];
  delete ideExpandedDirsByProject[id];
  delete gitDiffByProject[id];
  delete navBackByProject[id];
  delete navForwardByProject[id];
  const wasActive = s.activeProjectId === id;
  if (!wasActive) {
    // Still need to scrub any open tabs that belonged to the deleted
    // project (tabs the user may have opened earlier in a different
    // active project).
    const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
    const activeSessionId = openTabs.includes(s.activeSessionId ?? "")
      ? s.activeSessionId
      : (openTabs[0] ?? null);
    return {
      projects, sessionsByProject, archivedSessionsByProject: archivedByProject,
      sessionsTotalByProject: totalByProject, sessionsHasMoreByProject: hasMoreByProject,
      ideOpenFilesByProject, ideActiveFileByProject, ideFileViewModeByProject, ideExpandedDirsByProject, gitDiffByProject,
      navBackByProject, navForwardByProject,
      openTabs, activeSessionId,
    };
  }
  // Pick a new active project + its latest session.
  const next = projects.find((p) => !p.archived) ?? projects[0];
  const nextSessions = next ? (sessionsByProject[next.id] ?? []) : [];
  const nextSession = nextSessions.find((sess) => !sess.archived);
  // Tabs that belonged to other (still-living) projects survive; tabs
  // for the deleted project are gone.
  const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
  return {
    projects,
    sessionsByProject,
    archivedSessionsByProject: archivedByProject,
    sessionsTotalByProject: totalByProject,
    sessionsHasMoreByProject: hasMoreByProject,
    ideOpenFilesByProject, ideActiveFileByProject, ideFileViewModeByProject, ideExpandedDirsByProject, gitDiffByProject,
    navBackByProject, navForwardByProject,
    activeProjectId: next?.id ?? null,
    sessions: nextSessions,
    activeSessionId: nextSession?.id ?? null,
    openTabs: nextSession ? [nextSession.id] : openTabs,
  };
}

/** 一批项目的会话列表首屏(活动页 + worktree 页 + 归档桶)—— `init` 与跨端同步
 *  共用。单个项目失败不影响别的项目(它的桶留空,下次选中时再拉)。 */
export async function fetchProjectSessionBuckets(projects: readonly Project[]): Promise<{
  byProject: Record<string, Session[]>;
  hasMoreByProject: Record<string, boolean>;
  totalByProject: Record<string, number>;
  archivedByProject: Record<string, Session[]>;
}> {
  const byProject: Record<string, Session[]> = {};
  const hasMoreByProject: Record<string, boolean> = {};
  const totalByProject: Record<string, number> = {};
  const archivedByProject: Record<string, Session[]> = {};
  await Promise.all(
    projects.map(async (p) => {
      try {
        const [active, worktreePage] = await Promise.all([
          api.project.sessions({
            projectId: p.id,
            limit: SESSION_PAGE_SIZE,
            offset: 0,
            archived: false,
            worktree: "exclude",
          }),
          api.project.sessions({
            projectId: p.id,
            archived: false,
            worktree: "only",
            limit: WORKTREE_SESSIONS_FETCH_LIMIT,
          }),
        ]);
        // 防御:工作树那一段只收真带 worktreePath 的、且不与本地段重复的行 —— 后端漏了
        // `worktree` 过滤时(手机端 RPC 出过),两次请求会拿回同一批会话,列表里每条出现两遍。
        const localIds = new Set(active.sessions.map((x) => x.id));
        const worktreeOnly = worktreePage.sessions.filter((x) => x.worktreePath && !localIds.has(x.id));
        byProject[p.id] = [...active.sessions, ...worktreeOnly];
        hasMoreByProject[p.id] = active.hasMore;
        totalByProject[p.id] = active.total;
        const archived = await api.project.sessions({ projectId: p.id, archived: true });
        if (archived.sessions.length > 0) archivedByProject[p.id] = archived.sessions;
      } catch (err) {
        console.error(`project.sessions(${p.id}) failed:`, err);
      }
    }),
  );
  return { byProject, hasMoreByProject, totalByProject, archivedByProject };
}

/** `e.type === "setting.changed"` */
export function reduceSettingChanged(ctx: IngestCtx, e: SettingChangedEvent): void {
  applySyncedSetting(ctx.set, e.key, e.value);
}

/** `e.type === "projects.changed"` */
export function reduceProjectsChanged(ctx: IngestCtx, _e: ProjectsChangedEvent): void {
  void ctx.get().refreshProjects();
}

/** `e.type === "session.runningSnapshot"` */
/**
 * 本地命令输出的**命令名**怎么来的（2026-09-21）。
 *
 * 引擎回传 `local_command.output` 时只给内容、不给命令名（见 `@contracts/runtime`
 * 那个事件的说明）。但命令名**就在同一个列表里** —— 用户刚发的那条
 * `user.message` 正是 `/usage` 这几个字。所以往回找最后一条用户消息、取它的第一个
 * 词即可，不必让主进程再带一份过来（多一个字段就多一处能对不上的地方）。
 *
 * 找不到就返回空串 —— 卡片标题位置会退化成「命令输出」这种通用说法，而不是把
 * `/` 或半截路径当名字显示出来。
 */
export function commandNameForLocalOutput(list: ChatMessage[]): string {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== "user") continue;
    const text = m.blocks
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join(" ")
      .trim();
    if (!text.startsWith("/")) return "";
    const name = text.slice(1).split(/\s+/)[0] ?? "";
    return /^[A-Za-z0-9_:-]+$/.test(name) ? name : "";
  }
  return "";
}

/** `e.type === "user.message"` */
export function reduceUserMessage(ctx: IngestCtx, e: UserMessageEvent): void {
ctx.bumpUnread();
      ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        // Originator's own echo (id already present) — nothing to append (the
        // originator already truncated + optimistically appended at edit time).
        // ⚠️ **但仍要把冻结哨兵撤掉** —— 见下面那段说明。
        if (list.some((m) => m.id === e.messageId)) {
          return s.interruptedBySession[ctx.sid]
            ? { interruptedBySession: { ...s.interruptedBySession, [ctx.sid]: false } }
            : s;
        }
        // Cross-client EDIT (e.g. edited on the phone, echoed here): drop the
        // stale pre-edit tail — the message being replaced and everything
        // after it — BEFORE appending the re-sent bubble. Without this, a
        // second connected device keeps the old message + its old reply in
        // memory, shows them live, and at its own turn.done re-persists that
        // stale tail into the DB, resurrecting rows the originator truncated
        // away (a later re-open then shows duplicates). Receivers that don't
        // have the edited message (already truncated / not loaded) fall back
        // to a plain append.
        let base = list;
        if (e.editedMessageId) {
          const idx = base.findIndex((m) => m.id === e.editedMessageId);
          if (idx !== -1) base = base.slice(0, idx);
        }
        const msg: ChatMessage = {
          id: e.messageId,
          sessionId: ctx.sid,
          role: "user",
          // Trusted payload from our own renderer/mobile peer, same as the
          // persisted message content trusted by fromRecords on reload.
          blocks: e.blocks as Block[],
          createdAt: e.createdAt,
        };
        return {
          messagesBySession: { ...s.messagesBySession, [ctx.sid]: [...base, msg] },
          // **新的一轮开始了 → 撤掉"停过"的冻结哨兵。**
          //
          // `interruptedBySession` 是给本端 `interrupt()` 之后那段**迟到的**
          // `text.delta` / `thinking`(SDK 生成器 unwind 时 flushFinal 补发的)设的闸。
          // 但它以前**只有本端的 sendPrompt / editAndResend 会清** —— 于是另一条路起的
          // 新一轮(手机发来的、自动化起的、别的客户端起的)在这台机器上**永远收不到内容**:
          // `turn.done` / `user.message` 都不清它,这个会话所有 `text.delta` 都被那条闸丢掉。
          // 用户看到的是"手机上发出来了,这台只显示我那句、没有回复"。
          //
          // 清在这里是安全的:`user.message` 由主进程**在 provider 回合之前**广播
          // (见 `RuntimeManager` 的跨端回声),所以此刻能到的迟到内容只可能属于**上一轮那次
          // 停**,而这一轮的内容全在它之后 —— 撤闸不会把上一轮的残渣放进来。
          ...(s.interruptedBySession[ctx.sid]
            ? { interruptedBySession: { ...s.interruptedBySession, [ctx.sid]: false } }
            : {}),
        };
      });
      return;
    
}

/** `e.type === "todo.update"` */
export function reduceTodoUpdate(ctx: IngestCtx, e: TodoUpdateEvent): void {
ctx.set((s) => ({ todosBySession: { ...s.todosBySession, [ctx.sid]: e.todos } }));
      return;
    
}

/** `e.type === "git.changed"` */
export function reduceGitChanged(ctx: IngestCtx, e: GitChangedEvent): void {
ctx.set((s) => ({
        gitChangeVersionByRepo: {
          ...s.gitChangeVersionByRepo,
          [e.repoPath]: (s.gitChangeVersionByRepo[e.repoPath] ?? 0) + 1,
        },
      }));
      return;
    
}

/** `e.type === "session.changed"` */
export function reduceSessionChanged(ctx: IngestCtx, e: SessionChangedEvent): void {
const entry = e.session;
      // Side chats never belong in the left-bar caches. Main-side creation
      // and title rewrites don't broadcast for them, but a patch arriving
      // through some other path must not leak a side row into the lists —
      // route it to the ask tab's per-parent bucket instead.
      if (entry.kind === "side") {
        ctx.set((s) => {
          const parent = entry.parentSessionId;
          const list = parent ? s.sideChatsByParent[parent] : undefined;
          if (!parent || !list) return {};
          return {
            sideChatsByParent: {
              ...s.sideChatsByParent,
              [parent]: list.some((x) => x.id === entry.id)
                ? list.map((x) => (x.id === entry.id ? { ...x, ...entry } : x))
                : [materializeSessionEntry(entry), ...list],
            },
          };
        });
        return;
      }
      // 工作流节点会话(`kind: "node"`)同理,但**直接丢掉**:它没有对应的面板,
      // 而下面那个 upsert 会把它物化进左栏(= 用户突然多出一个自己没建过的会话)。
      //
      // 正常情况下它根本走不到这里 —— 建节点会话的路径(`orchestration/runner.ts`)
      // 不广播 `session.changed`,三个广播点也都按 `kind === "chat"` 收了口。这一句是
      // **兜底**:以后多一个广播点,症状不该是"隐藏会话漏进侧栏"。
      if (entry.kind === "node") return;
      ctx.set((s) => {
        const patch: Partial<SessionState> = {};
        let touched = false;
        // Global pinned bucket — upsert while the changed row is pinned AND
        // active, evict otherwise (unpinned / archived). Maintained regardless
        // of whether the owning project's window is loaded, since the pinned
        // section is global. This is the echo path for remote pin toggles;
        // local toggles also end here after applySessionPinnedState (no-op).
        const inPinned = s.pinnedSessions.some((x) => x.id === entry.id);
        const shouldBePinned = !entry.archived && entry.pinnedAt != null;
        if (shouldBePinned) {
          patch.pinnedSessions = inPinned
            ? s.pinnedSessions.map((x) => (x.id === entry.id ? { ...x, ...entry } : x))
            : sortPinnedByRecency([materializeSessionEntry(entry), ...s.pinnedSessions]);
          touched = true;
        } else if (inPinned) {
          patch.pinnedSessions = s.pinnedSessions.filter((x) => x.id !== entry.id);
          touched = true;
        }
        const activeList = s.sessionsByProject[entry.projectId];
        if (activeList) {
          // Two-section cache (see splitSessionSections): local threads are
          // the paginated list the totals count; worktree-bound threads park
          // behind them. Route the changed row into its section — a row that
          // MIGRATES (worktree materialize on first turn / directory removal
          // degrading back to local) leaves one section and enters the other.
          const { local, worktree } = splitSessionSections(activeList);
          const inLocalWindow = !entry.archived && entry.pinnedAt == null && !entry.worktreePath;
          const inWorktreeWindow = !entry.archived && entry.pinnedAt == null && !!entry.worktreePath;
          const wasLocal = local.some((x) => x.id === entry.id);
          const shrinkLocalTotals = () => {
            patch.sessionsTotalByProject = {
              ...s.sessionsTotalByProject,
              [entry.projectId]: Math.max((s.sessionsTotalByProject[entry.projectId] ?? 0) - 1, 0),
            };
            patch.sessionsHasMoreByProject = {
              ...s.sessionsHasMoreByProject,
              [entry.projectId]:
                (s.sessionsTotalByProject[entry.projectId] ?? 0) - 1 >
                [...local.filter((x) => x.id !== entry.id), ...worktree].filter(
                  (x) => !x.worktreePath,
                ).length,
            };
          };
          let next: Session[];
          if (inWorktreeWindow) {
            // Upsert into the worktree section (prepend when new — newest
            // first within it); a row that just materialized its worktreePath
            // also leaves the local section, shrinking the LOCAL total.
            next = [
              ...local.filter((x) => x.id !== entry.id),
              ...(worktree.some((x) => x.id === entry.id)
                ? worktree.map((x) => (x.id === entry.id ? { ...x, ...entry } : x))
                : [materializeSessionEntry(entry), ...worktree]),
            ];
            if (wasLocal) shrinkLocalTotals();
          } else if (!inLocalWindow) {
            // Left the active window — archived (moved to the bin) or pinned
            // (moved to the global pinned section above the project tree);
            // drop it from both sections; totals shrink only when it
            // actually left the LOCAL section.
            next = [
              ...local.filter((x) => x.id !== entry.id),
              ...worktree.filter((x) => x.id !== entry.id),
            ];
            if (wasLocal) shrinkLocalTotals();
          } else if (wasLocal) {
            // Merge the slim entry OVER the cached row so heavy payloads
            // (contextSnapshot / turnFiles / …) survive the update.
            next = [...local.map((x) => (x.id === entry.id ? { ...x, ...entry } : x)), ...worktree];
          } else {
            // A session created on another client — or a worktree row that
            // just degraded back to local (directory removal) — materialize
            // it at the head of the local window; the local total grows.
            // Merge over the cached row (whichever section it sat in) so a
            // degraded worktree row keeps its heavy payloads, and drop the
            // stale copy it left behind: keeping the old worktree-bound row
            // alive would re-bucket it into its dead worktree group and the
            // left bar would keep rendering the removed worktree.
            const prevRow = activeList.find((x) => x.id === entry.id);
            next = [
              prevRow ? { ...prevRow, ...entry } : materializeSessionEntry(entry),
              ...local.filter((x) => x.id !== entry.id),
              ...worktree.filter((x) => x.id !== entry.id),
            ];
            patch.sessionsTotalByProject = {
              ...s.sessionsTotalByProject,
              [entry.projectId]: (s.sessionsTotalByProject[entry.projectId] ?? 0) + 1,
            };
          }
          patch.sessionsByProject = { ...s.sessionsByProject, [entry.projectId]: next };
          touched = true;
        }
        const archivedList = s.archivedSessionsByProject[entry.projectId];
        if (archivedList) {
          const exists = archivedList.some((x) => x.id === entry.id);
          if (!entry.archived) {
            // Restored from the bin — drop it from the archived window.
            const next = archivedList.filter((x) => x.id !== entry.id);
            if (next.length !== archivedList.length) {
              if (next.length > 0) {
                patch.archivedSessionsByProject = { ...s.archivedSessionsByProject, [entry.projectId]: next };
              } else {
                const copy = { ...s.archivedSessionsByProject };
                delete copy[entry.projectId];
                patch.archivedSessionsByProject = copy;
              }
              touched = true;
            }
          } else if (exists) {
            patch.archivedSessionsByProject = {
              ...s.archivedSessionsByProject,
              [entry.projectId]: archivedList.map((x) => (x.id === entry.id ? { ...x, ...entry } : x)),
            };
            touched = true;
          }
          // else: archived remotely but outside the loaded bin page — the
          // refresh path will pick it up.
        }
        // Cached pre-change row (same id) — the gain/loss probes below
        // compare it against the incoming entry.
        const prevEntry =
          s.sessionsByProject[entry.projectId]?.find((x) => x.id === entry.id) ??
          s.pinnedSessions.find((x) => x.id === entry.id);
        // Worktree-MATERIALIZE flip (gain direction): the entry just GAINED a
        // worktreePath — its first turn created the isolated checkout
        // (the composer-chip path materializes on sendTurn, long after the
        // session was activated, so the activation-time flip never ran). If
        // the materialized row is the ACTIVE session, the project's view
        // must follow it into the fork view and reveal the group —
        // otherwise the freshly materialized thread silently vanishes from
        // the local list the user is looking at.
        if (entry.worktreePath && !prevEntry?.worktreePath && entry.id === s.activeSessionId) {
          if (!s.worktreeViewByProject[entry.projectId]) {
            patch.worktreeViewByProject = {
              ...s.worktreeViewByProject,
              [entry.projectId]: true,
            };
          }
          const gainedKey = normWorktreeKey(entry.worktreePath);
          if (!s.expandedWorktrees[gainedKey]) {
            patch.expandedWorktrees = {
              ...s.expandedWorktrees,
              [gainedKey]: true,
            };
          }
        }
        // Worktree-degenerate view flip: this entry just LOST its
        // worktreePath — its directory was removed and clearWorktreePath
        // degraded it back to local (each referenced session broadcasts its
        // own changed event, so this fires once per row). When the project's
        // LAST worktree-bound row degenerates, fall its left-bar view back
        // to the local list — the fork view would otherwise render an empty
        // "no threads" while every local thread sits hidden in the other
        // view (the "删除工作树后会话不见了" trap).
        if (!entry.worktreePath && prevEntry?.worktreePath) {
          const stillBound =
            (s.sessionsByProject[entry.projectId]?.some(
              (x) => x.id !== entry.id && !!x.worktreePath,
            ) ?? false) ||
            s.pinnedSessions.some(
              (x) => x.id !== entry.id && x.projectId === entry.projectId && !!x.worktreePath,
            );
          if (!stillBound && s.worktreeViewByProject[entry.projectId]) {
            patch.worktreeViewByProject = {
              ...s.worktreeViewByProject,
              [entry.projectId]: false,
            };
            touched = true;
          }
        }
        if (!touched) return {};
        // Keep the derived `sessions` alias (active project's list) fresh.
        if (s.activeProjectId === entry.projectId && patch.sessionsByProject) {
          patch.sessions = patch.sessionsByProject[entry.projectId] ?? s.sessions;
        }
        // Config sync: if the changed row is the ACTIVE session, mirror its
        // model/effort/permissionMode/customModelId/providerId into the
        // composer's global slots — a change made on the OTHER client
        // (phone/desktop via session:updateSettings) takes effect here
        // immediately, matching the local setModel/setEffort/… actions.
        if (entry.id === s.activeSessionId) {
          patch.model = entry.model;
          patch.effort = entry.effort;
          patch.permissionMode = entry.permissionMode;
          patch.customModelId = entry.customModelId;
          patch.providerId = entry.providerId;
        }
        // Remote change reached the caches — the stream aggregate may be
        // stale too (ordering / title / pin / worktree fields).
        patch.streamDirty = true;
        return patch;
      });
      return;
    
}

/** `e.type === "session.deleted"` */
/** 自动落到另一个会话(删除 / 归档当前会话、关掉当前标签、别的端删了它)之后,补齐
 *  `selectSession` 做的同步:引擎 / 工作流 / 项目等配置,状态胶囊、本轮文件、用量、
 *  书签、子代理记录,以及消息历史。
 *
 *  原先这几处只内联了 model / effort / permissionMode / customModelId —— providerId
 *  不跟着换,输入框就停在上一个会话的引擎上:发送要么被「请选择模型」拦下,要么让这条
 *  会话这一轮跑在错的引擎上(主进程按请求里的 providerId 覆盖本轮);没加载过的会话
 *  还会显示成一片空白。不动 centerTabFocus —— 那是调用方各自的决定。 */
export function syncLandedSessionIfChanged(
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void,
  get: () => SessionState,
  previousActiveId: string | null,
): void {
  const landed = get().activeSessionId;
  if (!landed || landed === previousActiveId) return;
  syncConfigFromSession(set, get, landed);
  hydrateContextSnapshot(set, get, landed);
  hydrateCapsule(set, get, landed);
  hydrateTurnFiles(set, get, landed);
  hydrateUsageHistory(set, get, landed);
  hydrateBookmarks(set, get, landed);
  hydrateSubagentTranscripts(set, get, landed);
  if (!get().historyLoadedBySession[landed]) void get().prefetchSessionMessages(landed);
}

export function reduceSessionDeleted(ctx: IngestCtx, e: SessionDeletedEvent): void {
const previousActiveId = ctx.get().activeSessionId;
ctx.set((s) => applySessionDeletedState(s, ctx.sid));
syncLandedSessionIfChanged(ctx.set, ctx.get, previousActiveId);
      return;
    
}

/** `e.type === "request.resolved"` */
export function reduceRequestResolved(ctx: IngestCtx, e: RequestResolvedEvent): void {
ctx.set((s) => {
        if (e.kind === "approval") {
          const next = s.pendingApprovals.filter((p) => p.requestId !== e.requestId);
          return next.length === s.pendingApprovals.length ? {} : { pendingApprovals: next };
        }
        if (e.kind === "question") {
          const pending = s.pendingQuestionBySession[ctx.sid];
          if (!pending || pending.requestId !== e.requestId) return {};
          const bucket = { ...s.pendingQuestionBySession };
          delete bucket[ctx.sid];
          return { pendingQuestionBySession: bucket };
        }
        // plan
        const pending = s.pendingPlanApprovalBySession[ctx.sid];
        if (!pending || pending.requestId !== e.requestId) return {};
        const bucket = { ...s.pendingPlanApprovalBySession };
        delete bucket[ctx.sid];
        return { pendingPlanApprovalBySession: bucket };
      });
      return;
    
}

/** `e.type === "plan.update"` */
export function reducePlanUpdate(ctx: IngestCtx, e: PlanUpdateEvent): void {
ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        const hasApproval = !!s.pendingPlanApprovalBySession[ctx.sid];
        const next = upsertLivePlanBlock(
          list,
          e.plan,
          e.phase,
          hasApproval,
          s.runningTurnStartedAt[ctx.sid] ?? Date.now(),
          s.runningTurnModelBySession[ctx.sid],
        );
        return {
          planBySession: {
            ...s.planBySession,
            [ctx.sid]: { plan: e.plan, phase: e.phase },
          },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [ctx.sid]: next },
        };
      });
      return;
    
}

/** `e.type === "mode.change"` */
export function reduceModeChange(ctx: IngestCtx, e: ModeChangeEvent): void {
if (ctx.sid === ctx.get().activeSessionId) {
        ctx.set({ permissionMode: e.mode });
        void api.session.updateSettings({ sessionId: ctx.sid, permissionMode: e.mode }).catch((err) => {
          console.error("updateSettings(mode.change) failed:", err);
        });
      }
      return;
    
}

/** `e.type === "upstream.issue"` */
export function reduceUpstreamIssue(ctx: IngestCtx, e: UpstreamIssueEvent): void {
if (e.kind === "ok") {
        clearUpstreamIssue(ctx.set, ctx.sid);
        return;
      }
      ctx.set((s) => ({
        upstreamIssueBySession: {
          ...s.upstreamIssueBySession,
          [ctx.sid]: { cause: e.cause, attempt: e.attempt, attempts: e.attempts },
        },
      }));
      const prev = upstreamIssueDecayTimers.get(ctx.sid);
      if (prev) clearTimeout(prev);
      upstreamIssueDecayTimers.set(
        ctx.sid,
        setTimeout(() => {
          upstreamIssueDecayTimers.delete(ctx.sid);
          clearUpstreamIssue(ctx.set, ctx.sid);
        }, UPSTREAM_ISSUE_DECAY_MS),
      );
      return;
    
}

/** `e.type === "subagent.update"` */
export function reduceSubagentUpdate(ctx: IngestCtx, e: SubagentUpdateEvent): void {
const prevAgents = ctx.get().subagentsBySession[ctx.sid] ?? [];
      const prevRunning = new Set(prevAgents.filter((a) => a.status === "running").map((a) => a.taskId));
      const justFinished = e.agents.some(
        (a) => (a.status === "completed" || a.status === "failed") && prevRunning.has(a.taskId),
      );
      if (justFinished) {
        ctx.bumpUnread();
        ctx.pushToast("info", translate(ctx.get().locale, "store.toast.backgroundTaskDone"), translate(ctx.get().locale, "store.toast.backgroundTaskDoneBody"));
      }
      ctx.set((s) => {
        const agents = s.interruptedBySession[ctx.sid]
          ? e.agents.map((a) => (a.status === "running" ? { ...a, status: "killed" as const } : a))
          : e.agents;
        return { subagentsBySession: { ...s.subagentsBySession, [ctx.sid]: agents } };
      });
      // A background task can outlive the parent turn. Its final roster event
      // is then the only wake-up: no second parent turn.done will arrive.
      if (prevRunning.size > 0 && !(ctx.get().subagentsBySession[ctx.sid] ?? []).some((a) => a.status === "running")) {
        ctx.get().drainPromptQueueIfIdle(ctx.sid);
      }
      return;
    
}

/** `e.type === "subagent.transcript"` */
export function reduceSubagentTranscript(ctx: IngestCtx, e: SubagentTranscriptEvent): void {
ctx.set((s) => {
        const inner = s.subagentTranscriptsBySession[ctx.sid];
        if (inner?.[e.parentToolUseId] === e.blocks) return {};
        return {
          subagentTranscriptsBySession: {
            ...s.subagentTranscriptsBySession,
            [ctx.sid]: { ...(inner ?? {}), [e.parentToolUseId]: e.blocks },
          },
        };
      });
      return;
    
}

/** `e.type === "workflow.node.transcript"` */
export function reduceWorkflowNodeTranscript(ctx: IngestCtx, e: WorkflowNodeTranscriptEvent): void {
ctx.set((s) => {
        if (s.workflowNodeTranscripts[e.nodeSessionId] === e.blocks) return {};
        const next = { ...s.workflowNodeTranscripts, [e.nodeSessionId]: e.blocks };
        // 只在**新键**上裁:替换已有的那个不会让表变大,而按插入序裁能保证"正在看的
        // 这一步"永远裁不到。
        const keys = Object.keys(next);
        for (const stale of keys.slice(0, Math.max(0, keys.length - NODE_TRANSCRIPT_KEEP))) {
          if (stale !== e.nodeSessionId) delete next[stale];
        }
        return { workflowNodeTranscripts: next };
      });
      return;
    
}

/** `e.type === "token-usage.updated"` */
export function reduceTokenUsageUpdated(ctx: IngestCtx, e: ContextUsageEvent): void {
if (!isValidSnapshot(e.snapshot)) return;
      ctx.set((s) => {
        const patch: Partial<SessionState> = {
          contextSnapshotBySession: { ...s.contextSnapshotBySession, [ctx.sid]: e.snapshot },
        };
        // Keep the in-memory session row cache in sync. Only touch the list
        // entry actually found (no-op if this session isn't in the cache, e.g.
        // archived / not yet loaded).
        const cached = findSession(s.sessionsByProject, s.archivedSessionsByProject, s.pinnedSessions, s.streamSessions, ctx.sid);
        if (cached && cached.contextSnapshot !== e.snapshot) {
          patch.sessionsByProject = patchSessionInCache(
            s.sessionsByProject, cached.projectId, ctx.sid, { contextSnapshot: e.snapshot },
          );
          // Pinned rows live in the global pinned bucket, not the per-project
          // list — mirror the snapshot there too.
          const pinnedIdx = s.pinnedSessions.findIndex((x) => x.id === ctx.sid);
          if (pinnedIdx !== -1) {
            patch.pinnedSessions = s.pinnedSessions.map((x, i) =>
              i === pinnedIdx ? { ...x, contextSnapshot: e.snapshot } : x,
            );
          }
        }
        return patch;
      });
      return;
    
}

/** `e.type === "question.ask"` */
export function reduceQuestionAsk(ctx: IngestCtx, e: AskUserQuestionEvent): void {
ctx.bumpUnread();
      ctx.pushToast("warning", translate(ctx.get().locale, "store.toast.agentQuestion"), e.questions[0]?.question);
      // 新提问会**顶掉**同会话的旧卡片。旧提问若还带着 requestId,主进程
      // ApprovalBridge 里那个 Deferred 仍在等答案 —— 卡片没了就再没人能回它,
      // provider 那头永远等下去(M22 报告点名的悬空,与 dismissQuestion 同一条
      // 收口:按 dismissed 回掉,让那一轮继续)。同 requestId 重投(断线重发)
      // 不算顶掉;哨兵形态(无 requestId)没有 Deferred,不许胡编一个 id 去回。
      const prior = ctx.get().pendingQuestionBySession[ctx.sid];
      if (prior?.requestId !== undefined && prior.requestId !== e.requestId) {
        void api.claude
          .respondQuestion({ sessionId: ctx.sid, requestId: prior.requestId, answers: {}, dismissed: true })
          .catch((err) => {
            console.error("respondQuestion(dismiss superseded) failed:", err);
          });
      }
      ctx.set((s) => ({
        pendingQuestionBySession: {
          ...s.pendingQuestionBySession,
          [ctx.sid]: { questions: e.questions, requestId: e.requestId },
        },
      }));
      return;
    
}

/** `e.type === "approval.request"` */
export function reduceApprovalRequest(ctx: IngestCtx, e: ApprovalRequestEvent): void {
ctx.bumpUnread();
      ctx.pushToast("warning", translate(ctx.get().locale, "store.toast.toolApprovalNeeded"), e.toolName);
      ctx.set((s) => ({
        pendingApprovals: [
          ...s.pendingApprovals.filter((p) => p.requestId !== e.requestId),
          e,
        ],
      }));
      return;
    
}

/** `e.type === "plan.approval_request"` */
export function reducePlanApprovalRequest(ctx: IngestCtx, e: PlanApprovalRequestEvent): void {
ctx.bumpUnread();
      ctx.pushToast("warning", translate(ctx.get().locale, "store.toast.planApprovalPending"), translate(ctx.get().locale, "store.toast.planApprovalPendingBody"));
      ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        // The plan text on the approval request is the model's ExitPlanMode
        // payload — re-sync the inline block so it shows exactly what the
        // user is being asked to approve (phase stays "ready" per the prior
        // plan.update emitted by the adapter on ExitPlanMode).
        const next = upsertLivePlanBlock(
          list,
          e.plan,
          "ready",
          true,
          s.runningTurnStartedAt[ctx.sid] ?? Date.now(),
          s.runningTurnModelBySession[ctx.sid],
        );
        return {
          pendingPlanApprovalBySession: {
            ...s.pendingPlanApprovalBySession,
            [ctx.sid]: e,
          },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [ctx.sid]: next },
        };
      });
      return;
    
}

/** `e.type === "workflow.node.progress"` */
export function reduceWorkflowNodeProgress(ctx: IngestCtx, e: WorkflowNodeProgressEvent): void {
const progress: Block = {
        kind: "workflow-node-progress",
        runId: e.runId,
        nodeId: e.nodeId,
        nodeType: e.nodeType,
        title: e.title,
        ...(e.percent !== undefined ? { percent: Math.max(0, Math.min(100, e.percent)) } : {}),
        ...(e.message ? { message: e.message } : {}),
        ...(e.phase ? { phase: e.phase } : {}),
      };
      ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        const patched = patchWorkflowNodeProgressBlock(
          list,
          progress as Extract<Block, { kind: "workflow-node-progress" }>,
        );
        if (patched) return { messagesBySession: { ...s.messagesBySession, [ctx.sid]: patched } };
        const startedAt = s.runningTurnStartedAt[ctx.sid] ?? Date.now();
        const next = appendTurnCardBlock(list, progress, startedAt, s.runningTurnModelBySession[ctx.sid], "wfprogress");
        return next === list ? s : { messagesBySession: { ...s.messagesBySession, [ctx.sid]: next } };
      });
      return;
    
}

/** `e.type === "workflow.node.result"` */
export function reduceWorkflowNodeResult(ctx: IngestCtx, e: WorkflowNodeResultEvent): void {
ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        // **收场这一刻把过程拷进卡片**(`NODE_ARCHIVE_KEEP` 那条注释讲了两条理由)。
        //
        // **优先用事件自己带的那一份**,而不是去活的那张表里查。两处内容在正常时序下
        // 是同一份,但事件那份不依赖时序:活表有容量上限(见 `NODE_TRANSCRIPT_KEEP`),
        // 一张图跑几十步之后前面几步的过程可能**在结果事件到达之前就被顶掉了**,那时
        // 查表拿到的是 undefined,卡片上永远留不下那一步的过程。查表只当兜底 —— 事件
        // 没带(比如某个调用方没填)时还能从表里捞一把。
        const archived =
          e.transcript && e.transcript.length > 0
            ? e.transcript
            : e.nodeSessionId
              ? s.workflowNodeTranscripts[e.nodeSessionId]
              : undefined;
        const block: Block = {
          kind: "workflow-node-result",
          runId: e.runId,
          nodeId: e.nodeId,
          ...(e.round !== undefined ? { round: e.round } : {}),
          ...(e.nodeSessionId ? { nodeSessionId: e.nodeSessionId } : {}),
          ...(archived && archived.length > 0 ? { nodeTranscript: archived } : {}),
          nodeType: e.nodeType,
          title: e.title,
          ...(e.providerId ? { providerId: e.providerId } : {}),
          ...(e.model ? { model: e.model } : {}),
          status: e.status,
          summary: e.summary,
          ...(e.outputKeys && e.outputKeys.length > 0 ? { outputKeys: e.outputKeys } : {}),
          ...(e.error ? { error: e.error } : {}),
          ...(e.execution ? { execution: e.execution } : {}),
          ...(e.artifacts && e.artifacts.length > 0 ? { artifacts: e.artifacts } : {}),
          ...(e.usage ? { usage: e.usage } : {}),
        };
        // **回头绕上来的那一圈:原地换掉上一轮那张。** 换掉了就不再插新的(见
        // `patchWorkflowNodeResultBlock`)。第一轮永远换不到,于是照旧往对话末尾插。
        const replaced = patchWorkflowNodeResultBlock(
          list,
          block as Extract<Block, { kind: "workflow-node-result" }>,
        );
        if (replaced) {
          return { messagesBySession: { ...s.messagesBySession, [ctx.sid]: capNodeArchives(replaced) } };
        }
        const startedAt = s.runningTurnStartedAt[ctx.sid] ?? Date.now();
        const next = appendTurnCardBlock(
          list,
          block,
          startedAt,
          s.runningTurnModelBySession[ctx.sid],
          "wfnode",
        );
        if (next === list) return s;
        // 带上限 —— 这东西跟着卡片一起落盘(见 `NODE_ARCHIVE_KEEP`)。
        const capped = capNodeArchives(next);
        return { messagesBySession: { ...s.messagesBySession, [ctx.sid]: capped } };
      });
      // **不在这里落盘。** 每落一次 = 主进程把整个 sqlite 文件重写一遍,而一张图会
      // 结算 N 个节点 —— 那就是 N 次整库重写。这一轮结束时调度器会补一个 `turn.done`,
      // 而 turn.done 那条路本来就会把本轮新增的消息整批 upsert 下去(见文件末尾的
      // 落盘分支),这些卡片就在里面。
      return;

}

/** `e.type === "workflow.node.usage"` */
export function reduceWorkflowNodeUsage(ctx: IngestCtx, e: WorkflowNodeUsageEvent): void {
ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        const next = patchNodeUsageBlock(list, e.runId, e.nodeId, e.usage);
        return next === null ? s : { messagesBySession: { ...s.messagesBySession, [ctx.sid]: next } };
      });
      return;
    
}

/** `e.type === "workflow.node.choice"` */
export function reduceWorkflowNodeChoice(ctx: IngestCtx, e: WorkflowNodeChoiceEvent): void {
ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        const withoutProgress = removeWorkflowNodeProgressBlock(list, e.runId, e.nodeId);
        const block: Block = {
          kind: "workflow-branch-choice",
          runId: e.runId,
          nodeId: e.nodeId,
          nodeType: e.nodeType,
          title: e.title,
          attempt: e.attempt,
          options: e.options,
          // **是「运行前先问我」那一问的话,标出来。** 弹窗靠这一位认出"该我上场了"
          // (见 `AskChoiceDialog`),而卡片照常摆 —— 它是记录,也是改天回看的唯一凭据。
          ...(e.ask ? { ask: true } : {}),
          ...(e.chosen ? { chosen: e.chosen } : {}),
          ...(e.comment ? { comment: e.comment } : {}),
        };
        const patched = patchBranchChoiceBlock(list, e.runId, e.nodeId, e.attempt, block);
        // **这一处岔路口在不在等人** —— 计数喂给 `sessionBusy`(见
        // `waitingBranchesBySession`)。同一个岔路口的卡会来两次:先"在等"(没有
        // `chosen`),后"选完了"(带 `chosen`)。所以 +1 / -1 正好抵消。夹到 0 以上是
        // 兜"另一台设备点过了、这边只收到后一半"。
        const delta = e.chosen ? -1 : 1;
        const waiting = {
          ...s.waitingBranchesBySession,
          [ctx.sid]: Math.max(0, (s.waitingBranchesBySession[ctx.sid] ?? 0) + delta),
        };
        if (patched) {
          return { messagesBySession: { ...s.messagesBySession, [ctx.sid]: patched }, waitingBranchesBySession: waiting };
        }
        const startedAt = s.runningTurnStartedAt[ctx.sid] ?? Date.now();
        const next = appendTurnCardBlock(
          withoutProgress,
          block,
          startedAt,
          s.runningTurnModelBySession[ctx.sid],
          "wfbranch",
        );
        return {
          messagesBySession: next === list ? s.messagesBySession : { ...s.messagesBySession, [ctx.sid]: next },
          waitingBranchesBySession: waiting,
        };
      });
      // **不在这里落盘** —— 理由同 `workflow.node.result`:这一轮结束时的 `turn.done`
      // 会把本轮新增整批 upsert 下去,而每落一次 = 主进程把整个 sqlite 重写一遍。
      return;
    
}
