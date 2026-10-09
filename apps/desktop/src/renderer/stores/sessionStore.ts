import { create } from "zustand";
import type { Project, Session, SessionBookmark } from "@contracts/session";
import type { SessionRunningSnapshotEvent, TurnFilesEvent, CompactResultEvent, TurnRewoundEvent, RuntimeEvent, NodeArtifact, NodeExecutionRecord, PermissionMode, EffortLevel, AskUserQuestionItem, ApprovalRequestEvent, PlanApprovalRequestEvent, PlanUpdateEvent, WorkflowNodeResultEvent, WorkflowChoiceOption, SubagentSnapshot, TranscriptBlock, ContextSnapshot, TurnUsageRecord, EngineCommandInfo } from "@contracts/runtime";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import type { ContentTag } from "@renderer/lib/contentTag.js";
import { type NavEntry } from "@renderer/lib/editorNav.js";
import { disposeModel, getDisplayedPath } from "@renderer/lib/editorModelCache.js";
import { ideDirtyTracker, partitionClosable, type IdeCloseResult } from "@renderer/lib/ideDirty.js";
import { basename } from "@renderer/lib/path.js";
import type { CustomModelPublic } from "@contracts/customModel";
import { api } from "@renderer/lib/api.js";
import { textFileWrites } from "@renderer/lib/markdownFileWrites.js";
import { isElectron } from "@renderer/lib/platform.js";
import { normWorktreeKey } from "@renderer/lib/worktree.js";
import { translate } from "@renderer/lib/i18n/core.js";
import { DEFAULT_GESTURE_SETTINGS } from "@renderer/lib/gestures.js";
import { DEFAULT_EDITOR_THEME_CHOICE, parseEditorThemeChoice, type EditorThemeChoice, type EditorThemeId } from "@renderer/lib/editorThemes.js";
import { DISPLAY_MODE_SETTING_KEY, TAB_BAR_MULTI_ROW_SETTING_KEY, LEFTBAR_MODE_SETTING_KEY, THEME_STYLE_SETTING_KEY, UI_LOCALE_SETTING_KEY, DEFAULT_PROVIDER_ID, UI_CHAT_FONT_SIZE_SETTING_KEY, UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY, UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY, WORKFLOW_MAX_PARALLEL_SETTING_KEY, UI_USER_MSG_COLOR_SETTING_KEY, UI_ACCENT_COLOR_SETTING_KEY, UI_RIGHT_PANEL_TAB_SETTING_KEY, UI_VOICE_LANG_SETTING_KEY, UI_VOICE_ENGINE_SETTING_KEY, UI_VOICE_MIC_PERMISSION_SETTING_KEY, UI_VOICE_MODEL_DIR_SETTING_KEY, UI_IDE_OPEN_FILES_SETTING_KEY, UI_IDE_ACTIVE_FILE_SETTING_KEY, UI_IDE_EXPANDED_DIRS_SETTING_KEY, UI_IDE_EDITOR_MODE_SETTING_KEY, UI_GIT_DIFF_OPEN_MODE_SETTING_KEY, UI_COMMIT_GEN_MODEL_SETTING_KEY, UI_COMMIT_GEN_PROMPT_SETTING_KEY, UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY, UI_COMPOSER_MODEL_SETTING_KEY, UI_TITLE_GEN_ENABLED_SETTING_KEY, UI_TITLE_GEN_MODEL_SETTING_KEY, AGENT_OUTPUT_STYLE_SETTING_KEY, UI_GIT_COLLAPSED_REPOS_SETTING_KEY, UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY, UI_PANE_WIDTHS_SETTING_KEY, UI_PROJECT_VIEW_SETTING_KEY, UI_PROJECT_GROUPS_SETTING_KEY, UI_LAST_PROJECT_SETTING_KEY, UI_LAST_SESSION_SETTING_KEY, UI_STREAM_SCOPE_SETTING_KEY, UI_SHORTCUTS_SETTING_KEY, UI_GESTURES_SETTING_KEY, UI_CHAT_DENSITY_SETTING_KEY, UI_EDITOR_THEME_SETTING_KEY, AUTO_ARCHIVE_SETTING_KEY, DEFAULT_AUTO_ARCHIVE_CONFIG, parseAutoArchiveConfig, SESSION_WORKTREE_DEFAULT_SETTING_KEY, WORKTREE_NAMES_SETTING_KEY, PROJECT_COLORS_SETTING_KEY, ShortcutBindingsSchema, GestureSettingsSchema, RightPanelTabSchema, type AutoArchiveConfig, type DisplayMode, type LeftBarMode, type Locale, type VoiceEngine, type GestureSettings, type GestureSequence, type ChatDensity, type ProjectView, type GitWorktreeInfo, type ProjectGroupsMeta, type RightPanelTab, type IdeEditorMode, type GitDiffOpenMode, type FileViewMode, type CustomCommand, type SkillInfo, type ProviderInfo, type ProviderHealthCheckResult, type ProviderHealthStatusCode, type ShortcutBindings, type Accelerator, type LspLanguageState, type LspStateChangedPayload, type RuntimeAgentState, type RuntimeProgressPayload, type PickedElement, type BrowserDevicePreset, type BrowserOrientation } from "@contracts/ipc";
import type { ThemeStyle } from "@contracts/theme";

/** One browser tab, shared across the sidebar and overlay containers. `id` is
 *  renderer-local; `browserId` is the main-process view id. All
 *  navigation/loading/pick state is per-tab. Lives in the store (not component
 *  state) so the sidebar and overlay containers can swap without losing tabs. */
export interface BrowserTab {
  id: string;
  browserId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  pickMode: boolean;
  /** Device emulation preset (desktop = full width, mobile = narrow). */
  device: BrowserDevicePreset;
  /** Custom viewport width — set when device === "custom". */
  customWidth?: number;
  /** Custom viewport height — set when device === "custom". */
  customHeight?: number;
  /** Screen orientation (portrait/landscape). "landscape" swaps width/height
   *  when emulating. Defaults to "portrait" when absent. */
  orientation?: BrowserOrientation;
}
import type { BuiltinModelOption, UserInputAnswers } from "@contracts/provider";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { inAppToastAllowed } from "@renderer/lib/notifPrefsCache.js";
// Pure helpers live in sessionStoreHelpers.ts (split for file size; see its header).
import { CONTENT_FROZEN_EVENTS, EMPTY_BOOKMARKS, EMPTY_CODEX_MODELS, EMPTY_CUSTOM_MODELS, EMPTY_LAST_MODEL_BY_PROVIDER, EMPTY_MESSAGES, EMPTY_PI_MODELS, EMPTY_PROMPT_QUEUE, EMPTY_PROVIDERS, EMPTY_SESSIONS, EMPTY_SKILLS, EMPTY_SUBAGENTS, IDE_BUCKETS_PERSIST_DEBOUNCE_MS, LEFT_WIDTH_PCT_DEFAULT, LIVE_PLAN_ID, MESSAGE_PAGE_SIZE, NAV_HISTORY_CAP, PROVIDER_HEALTH_STALE_MS, RESYNC_AFTER_TURN_DELAY_MS, RGB_TRIPLET_RE, SESSION_PAGE_SIZE, STREAM_PAGE_SIZE, WIDE_PANEL_PCT_DEFAULT, WORKFLOW_MAX_PARALLEL_DEFAULT_RENDERER, WORKTREE_SESSIONS_FETCH_LIMIT, appendDelta, appendTurnCardBlock, applyDeltaEntries, applySessionDeletedState, applySessionPinnedState, avgIntervalMs, buildPlanKickoffPrompt, centerRightRowWidth, clampBottomTerminalHeight, clampEditorWidthPct, clampFontSize, clampLeftWidthPct, clampPasteTagThresholdChars, clampRightPanelFontSize, clampRightWidth, clampWidePanelPct, clampWorkflowMaxParallel, clearSessionDeltas, clearUpstreamIssue, coerceSlotsForProvider, commandNameForLocalOutput, currentNavEntryFor, deltaArrivals, deltaBuf, demotePreviousLatestTurnFiles, extractImagesFromToolResult, fetchProjectSessionBuckets, findOpenTurnLastAssistant, findSession, freezeLatestTurnFilesBlock, freezeOrPrunePlanBlocks, fromRecords, hasErrorInCurrentTurn, hasSelectableModel, hydrateBookmarks, hydrateCapsule, hydrateContextSnapshot, hydrateSubagentTranscripts, hydrateTurnFiles, hydrateUsageHistory, isCenterShowingDocument, isImagePath, isMarkdownPath, isPathWithinRoot, isSessionChatOnScreen, isSideChatSession, isUnsupportedPath, isValidRememberedModel, parseCustomCommandsByProject, patchSessionInCache, patchSessionRowBookmarks, pendingInterruptDone, persistComposerSelection, providerHealthRequestGate, recordDeltaArrival, reduceApprovalRequest, reduceGitChanged, reduceModeChange, reducePlanApprovalRequest, reducePlanUpdate, reduceProjectsChanged, reduceQuestionAsk, reduceRequestResolved, reduceSessionChanged, reduceSessionDeleted, reduceSettingChanged, reduceSubagentTranscript, reduceSubagentUpdate, reduceTodoUpdate, reduceTokenUsageUpdated, reduceUpstreamIssue, reduceUserMessage, reduceWorkflowNodeChoice, reduceWorkflowNodeProgress, reduceWorkflowNodeResult, reduceWorkflowNodeTranscript, reduceWorkflowNodeUsage, rememberedEntryOf, removeProjectFromState, resolveSendModel, resyncAfterTurn, sameNavEntry, sortPinnedByRecency, splitSessionSections, streamScopeQuery, surfaceRejectedCustomModelSend, syncConfigFromSession, syncLandedSessionIfChanged, toRecords, upsertLivePlanBlock, upsertLiveTurnFilesBlock, validateComposerSelection, worktreeFetchSeq } from "./sessionStoreHelpers.js";
export { BOTTOM_TERMINAL_HEIGHT_MAX, BOTTOM_TERMINAL_HEIGHT_MIN, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, EDITOR_WIDTH_PCT_MAX, EDITOR_WIDTH_PCT_MIN, EMPTY_BOOKMARKS, EMPTY_CHAT_QUEUE, EMPTY_ELEMENT_QUEUE, EMPTY_MESSAGES, EMPTY_PLAN, EMPTY_PROMPT_QUEUE, EMPTY_SUBAGENTS, EMPTY_TODOS, EMPTY_TURN_FILES, EMPTY_USAGE, LEFT_WIDTH_PCT_DEFAULT, LEFT_WIDTH_PCT_MAX, LEFT_WIDTH_PCT_MIN, PASTE_TAG_THRESHOLD_CHARS_MAX, PASTE_TAG_THRESHOLD_CHARS_MIN, RIGHT_PANEL_FONT_SIZE_MAX, RIGHT_PANEL_FONT_SIZE_MIN, RIGHT_SHARE_MAX, RIGHT_WIDTH_MIN, WIDE_PANEL_PCT_DEFAULT, WIDE_PANEL_PCT_MAX, WIDE_PANEL_PCT_MIN, WORKFLOW_MAX_PARALLEL_DEFAULT_RENDERER, clampBottomTerminalHeight, clampEditorWidthPct, clampFontSize, clampLeftWidthPct, clampPasteTagThresholdChars, clampRightPanelFontSize, clampRightWidth, clampWidePanelPct, clampWorkflowMaxParallel, isCenterShowingDocument, selectActiveEnvPath } from "./sessionStoreHelpers.js";


/** True while a navigateBack/navigateForward reveal is running. openFileInIde
 *  and setIdeActiveFile record the outgoing location into the back stack on
 *  user-initiated navigation; a history-driven reveal must NOT record (the
 *  history actions manage both stacks themselves). Set/cleared synchronously
 *  around the openFileInIde call. */
let navHistoryRevealing = false;

/** Target for the mobile shell's fullscreen viewer overlay. The web (phone)
 *  shell has no editor column / PlanViewer, so chat-stream touchpoints
 *  (FileLink, TurnFilesCard rows, plan cards) redirect here instead:
 *  - file: read-only file content (text via readFile + shiki, images inline)
 *  - diff: frozen turn `before` vs the current on-disk content (lineDiff)
 *  - plan: plan markdown rendered read-only
 * Desktop never sets this (the Electron-only UIs consume those touchpoints). */
export type MobileViewerTarget =
  | { kind: "file"; name: string; path: string }
  | { kind: "diff"; name: string; path: string; /** Undefined only on cards
   * persisted by builds predating the snapshot field — the viewer degrades
   * to a plain file view then. */ before?: string }
  | { kind: "plan"; plan: string };

/** A single content block within a message (mirrors how claude structures output). */
export type Block =
  | { kind: "text"; text: string; /** Names of skill pills embedded inline in
    *  this text (from the rich-text composer). The Markdown renderer uses this
    *  to render the corresponding `/name` occurrences as styled pills so they
    *  read the same in the stream as they did in the composer. Empty/absent
    *  for plain-text messages. */
    skillNames?: string[] }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolCallId: string; toolName: string; input: unknown; status: "running" | "done" | "error"; result?: unknown }
  | { kind: "error"; message: string }
  | { kind: "turn-incomplete"; /** Mirrors TurnIncompleteEvent.kind —
    * "dangling-tools" = the turn closed with unanswered tool_use;
    * "empty-response" = tools ran but the model never replied with text;
    * "unfinished-text" = the final text-only message ends with continuation
    * punctuation — the announced next step never arrived. */
    incompleteKind: "dangling-tools" | "empty-response" | "unfinished-text";
    /** Display names of the tool calls that never got a result
     *  ("dangling-tools" only). */
    pendingToolNames: string[] }
  | { kind: "turn-notice"; /** Mirrors TurnNoticeEvent.kind — "budget_limit" =
    * the host stopped the turn after it crossed a per-turn budget cap;
    * "fallback" = the model failed and the host is retrying the same input
    * on the next model in the chain; "structured_invalid" = the
    * structured-output JSON failed schema validation after a repair round.
    * NOT a turn terminator — turn.done still follows and owns the cleanup. */
    noticeKind: "budget_limit" | "fallback" | "structured_invalid";
    /** Human-readable, already-localized message from the host. */
    message: string }
  | { kind: "local-command"; /** Command name as typed, without the leading `/`
    *  (e.g. "usage"). Shown as the card's title. */
    name: string;
    /** Raw text the engine printed, verbatim. Rendered as-is (monospace) —
    *  it is the command's own output, not prose to be markdown-parsed. */
    content: string }
  | { kind: "attachment"; preview: string; content: string; attachmentKind?: "paste" | "file" | "quote"; filePath?: string }
  | {
      kind: "plan";
      /** Stable id for the in-turn live plan block — "current" while the turn
       *  is streaming (single live plan per turn). Lets the store upsert /
       *  replace on each plan.update without spawning duplicate blocks. When
       *  the turn ends the block is frozen in place (its planId stays). */
      planId: string;
      /** The plan markdown text drafted by the model (EnterPlanMode →
       *  ExitPlanMode). Empty during the initial drafting phase before the
       *  model has produced any plan content. */
      plan: string;
      /** Lifecycle phase mirrored from PlanUpdateEvent: "drafting" while the
       *  model is still composing, "ready" once ExitPlanMode is approved,
       *  "cleared" is transient (handled as a remove, never persisted on a
       *  frozen block). */
      phase: PlanUpdateEvent["phase"];
      /** True while an ExitPlanMode approval is pending — drives the 待审阅
       *  badge on the inline card so it mirrors the composer approval sheet. */
      hasApproval?: boolean;
    }
  | {
      kind: "turn-files";
      /** Stable id for the in-turn live turn-files block — "current" while the
       *  turn is streaming. Same pattern as the plan block's planId: lets the
       *  store upsert/replace on each turn.files event without spawning
       *  duplicates. Stays on the block after the turn freezes. */
      filesId: string;
      /** Files touched in this turn (filePath / kind / adds / dels / before).
       *  Mirrors TurnFileEntry verbatim — the same shape crosses the
       *  turn.files event, the persisted block, and the TurnFilesCard props,
       *  so the card renders identically live and from-DB. */
      files: TurnFileEntry[];
      /** True ONLY on the LATEST turn's card — gates whether the 撤销本轮
       *  button renders as the "live" rewind (clears the card on success).
       *  Demoted to false the moment a new turn opens; older cards are
       *  still rewindable individually (see `rewound`). */
      isLatestTurn?: boolean;
      /** True once this turn's files have been rewound. The card stays in
       *  the stream (the conversation record is preserved — mirroring SDK
       *  checkpoint semantics where file rollback never rolls back the
       *  conversation), but renders as a dimmed, non-interactive "已撤销"
       *  state. Set by the `turn.rewound` handler when `targetFiles`
       *  matches this card's paths. */
      rewound?: boolean;
    }
  | {
      kind: "compact-summary";
      /** What triggered the compaction - manual `/compact` or auto. */
      trigger: "manual" | "auto";
      /** Token count before compaction. */
      preTokens: number;
      /** Token count after compaction (may be absent). */
      postTokens?: number;
      /** How long the compaction took, in ms (may be absent). */
      durationMs?: number;
    }
  | {
      /** A live workflow node execution update. It is replaced by the settled result
       *  with the same runId + nodeId, so the stream never shows duplicate cards. */
      kind: "workflow-node-progress";
      runId: string;
      nodeId: string;
      nodeType: string;
      title: string;
      percent?: number;
      message?: string;
      phase?: string;
    }
  | {
      /** 工作流图里的一步收场了。**一步一张卡**,和阶段卡同型 —— 事件从主进程的
       *  调度器来(`main/orchestration/runner.ts`),节点自己跑在隐藏子会话里。 */
      kind: "workflow-node-result";
      /** 哪一次运行(`WorkflowNodeResultEvent.runId`)。带上它是为了**同一张图的卡片
       *  能归到一起** —— 一张图跑几轮,节点 id 会重复。 */
      runId: string;
      nodeId: string;
      /** 跑这一步的那个隐藏会话 id —— 卡片靠它去 `nodeTranscriptsBySession` 里取
       *  "这一步的过程"。**可缺席**:`skipped` / `cancelled` 的节点根本没跑过。 */
      nodeSessionId?: string;
      /** 这是这个节点在这次运行里的**第几轮**(1 起;第 1 轮不带)。
       *
       *  环回的图回到同一格时会再收场一次 —— 带上轮次,渲染端才认得出"这是同一格
       *  又跑了一遍",从而把上一张**换掉**而不是再插一张(见
       *  `WorkflowNodeResultEvent.round`)。 */
      round?: number;
      /** 收场那一刻的过程**快照**(见 `NODE_ARCHIVE_KEEP` 那条注释)。
       *
       *  和 `nodeSessionId` 是**两条路**,不是二选一:会话还在(`nodeSessionId` 查得到)
       *  时优先读活的那份(它最新),查不到了退回这一份。所以两个字段都要留着。 */
      nodeTranscript?: TranscriptBlock[];
      /** 节点类型 id(`mcode.agent`)。等宽显示,不翻译。 */
      nodeType: string;
      title: string;
      /** 实际执行这一步的引擎与模型；非模型节点或没跑过时缺席。 */
      providerId?: string;
      model?: string;
      status: WorkflowNodeResultEvent["status"];
      /** 这一步产出的文本。**也是喂给它下游节点的那一份**。 */
      summary: string;
      /** 这一步声明的**产出变量名**(没声明就是缺席)。
       *
       *  有它 = 这一步的产出**是一个对象**,内容全在变量里(见
       *  `WorkflowNodeResultEvent.outputKeys`)。卡片据此**逐项渲染变量**,而不是把
       *  原文摊出来 —— 那样摊出来的正好是用户说过不要看的那一坨。
       *
       *  只带名字不带值:值就在 `summary` 里,卡片用同一个解析器(`checkOutput`)
       *  自己提,提出来的是**下游拿到的那一份**。 */
      outputKeys?: string[];
      /** 没成功时的原因。 */
      error?: string;
      execution?: NodeExecutionRecord;
      /** Stable references to files, directories, or external data produced by the node. */
      artifacts?: NodeArtifact[];
      /**
       * **这一步花了多少。** 缺席有两种意思,而两种都不显示那一行:
       * 没跑过(`skipped` / `cancelled`),或者跑完了但引擎没报花费。
       *
       * ⚠️ **它多半是"过一会儿才补上"的。** 用量要等那个回合结束之后才结算落库,而卡片
       * 是在节点收场那一刻就画出来的 —— 所以先画出来的那张常常没有这一项,过几秒由
       * `workflow.node.usage` 那条事件**原地补上**(见下面的分支)。用户看到的是卡片上
       * 慢慢多出一行花费,而不是卡片闪一下重画。
       */
      usage?: { totalTokens: number; outputTokens: number; costUsd?: number };
    }
  | {
      /**
       * 一个**岔路口**在等用户拍板(`mcode.branch` 那个节点),或者一个开了
       * 「运行前先问我」的**对话节点**在等用户发话(见下面 `ask`)。
       *
       * ## 它和上面那张结果卡是两种东西
       *
       * 结果卡是**收场** —— 事情已经发生完了。这一张是**活的**:按钮点下去之前,那次
       * 运行**没有结束**,图就停在这个节点上等一个人。所以它摆的是按钮和输入框,而且
       * 只能用一次。
       *
       * ## 一张卡,更新两次
       *
       * `workflow.node.choice` 会来**两次**:第一次没带 `chosen`(在等),第二次带上
       * (选完了)。这里靠 `runId + nodeId + attempt` 认出原来那张**换掉**它 —— 追加
       * 第二张的话,对话里会出现两个格子说同一件事,其中一个还摆着已经点过的按钮。
       *
       * ⚠️ **`attempt` 那一位不能省。** 一个分支在**同一次运行**里会被问很多次(回头,
       * 见 `@contracts/workflow` 的「回头」),省掉的话第二轮的卡会去改**第一轮那张**
       * —— 用户看到一个早就点过的卡片忽然换了内容,而他第一轮点的是什么就此消失。
       *
       * 这也是为什么分支节点**没有**一张 `workflow-node-result` 卡:它的卡就是这一张
       * (见调度器 `settle` 里那条)。
       */
      kind: "workflow-branch-choice";
      /** 哪一次运行。和结果卡同一个含义 —— 同一张图跑几轮,节点 id 会重复。 */
      runId: string;
      nodeId: string;
      /** 节点类型 id(`mcode.branch`)。等宽显示,不翻译。 */
      nodeType: string;
      title: string;
      /**
       * 这一轮是这个岔路口**第几次问**(从 1 起)。回头绕第二圈时是 2。
       *
       * 卡片上会写一句「第 N 轮」—— 一列卡片摆在一起时,没有这个数字就看不出它们是
       * 同一个岔路口在不同轮次问的。
       */
      attempt: number;
      /** 待选的出路。`id` 是**边**的 id —— 点下去要把它原样发回主进程。 */
      options: WorkflowChoiceOption[];
      /**
       * **这一次问是节点上「运行前先问我」来的**(见 `@contracts/runtime` 的同名说明)。
       *
       * 载荷和岔路口几乎一样,但主界面不一样:这一种**弹在屏幕正中间**(见
       * `AskChoiceDialog`),因为它们问的不是"往哪条路走",而是"这一步现在要不要跑、
       * 怎么跑" —— 那件事跟图上的走向无关,盯着画布看不出来。
       *
       * 聊天流里这张卡**照常摆**(它是这一问留下的记录,也是改天回看时唯一说得清
       * "当时选了什么"的地方),弹窗只是主入口。
       */
      ask?: boolean;
      /** 已经选过的那条边的 id。缺席 = 还在等。 */
      chosen?: string;
      /** 用户在选择时临时写的那句话(和 `chosen` 一起来)。 */
      comment?: string;
    }
  | {
      kind: "image";
      /** The tool_use whose screenshot produced this image. Present on
       *  tool-produced images (renders next to its tool_use card, dedup by
       *  replace); ABSENT on user-attached images (the composer's 图片/paste
       *  flow), which sit standalone on the user message. */
      toolCallId?: string;
      /** Base64-encoded image bytes (no data: prefix). */
      data: string;
      /** Image MIME type — "image/png" for browser screenshots; the SendTurn
       *  allowlist (jpeg/png/gif/webp) for user-attached images. */
      mimeType: string;
    };

/** Turn-level timing metadata. Attached to the FIRST assistant message of
 *  a turn (the one created when the first text.delta / thinking / tool.use
 *  arrives) so the renderer can show "started at · duration" once per turn,
 *  above that message. `endedAt` is set when `turn.done` (or `error`) lands;
 *  while undefined the turn is still running and the duration ticks live.
 *
 *  Persisted as part of the message snapshot, so the stats survive reload. */
export interface TurnMeta {
  /** Wall-clock ms when the turn started (first assistant block arrived). */
  startedAt: number;
  /** Wall-clock ms when the turn ended (turn.done / error). Undefined while
   *  the turn is still streaming — the renderer treats this as "live". */
  endedAt?: number;
  /** Model this turn was SENT with (the composer's resolved send-model id,
   *  e.g. "deepseek-flash" / "claude-sonnet-4-5"), stamped from the send-time
   *  anchor at turn creation. Recorded per turn because the model can change
   *  between turns — the stream shows which model produced each reply.
   *  Undefined for turns that predate this field (they render without it) and
   *  for turns opened by something other than a send (resumed/legacy). */
  model?: string;
}

/** One queued prompt: a fully-prepared turn payload held back while the
 *  session is busy. When the session goes fully idle the head of the queue
 *  is drained and replayed through the normal `sendPrompt` path (so the user
 *  message, attachments, and turn lifecycle are identical to a live send).
 *
 *  `prompt` is the composed text (typed text + inlined @path / paste blocks)
 *  the SDK receives; `displayText` is just the typed text shown in the user
 *  bubble so attachment content isn't duplicated; `attachments` mirror the
 *  composer's tags so the sent message keeps its chip cards. */
export interface QueuedPrompt {
  id: string;
  prompt: string;
  displayText: string;
  attachments?: PromptAttachment[];
  /** User-attached images (downsized, ready to send). Empty/absent = text-only. */
  images?: PromptImage[];
  /** Names of skill pills embedded in the queued text (for stream rendering). */
  skillNames?: string[];
  /** Rich blocks for the user bubble, replacing the default single text block
   *  (plan handoff renders "note + plan card" instead of the raw kickoff
   *  text — `displayText` still carries the queue card's preview line). */
  displayBlocks?: Block[];
}

/** Attachment payload shared by sendPrompt and the queue (kept loose here so
 *  the queue type doesn't depend on the store's private attachment shape). */
export interface PromptAttachment {
  preview: string;
  content: string;
  attachmentKind?: "paste" | "file" | "quote";
  filePath?: string;
}

/** Execution target picked in the plan-approval sheet's 执行方式 row.
 *  "remodel" = end the blocked turn, rebind THIS session's model, fire the
 *  plan as a fresh turn in the same thread (transcript context carries).
 *  "newSession" = end the blocked turn and hand the plan to a brand-new
 *  session (optionally another SDK) as its first prompt — context rebuilds
 *  from the plan document. Approving in place is NOT part of this union; it
 *  goes through submitPlanApproval. */
export type PlanHandoffTarget =
  | { kind: "remodel"; model: string; customModelId: string | null }
  | { kind: "newSession"; providerId: string; model: string; customModelId: string | null };

/** User-attached image payload shared by sendPrompt and the queue — already
 *  downsized to the SendTurn allowlist (base64 without the data: prefix). */
export interface PromptImage {
  data: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

/** A snapshot of the composer's unsent content for one session. Written
 *  through to the store on every change and restored when the session's
 *  ChatPane remounts (single-mode session switch, tab close/reopen), so the
 *  user's typed text + attachment chips survive thread switches.
 *
 *  `text` is the plain-text-with-skills mirror (drives the empty-state/send
 *  button); `html` is the Tiptap document HTML so skill pills round-trip on
 *  restore (`getHTML()`/`setContent()`); `tags` are the file/paste/element
 *  chips above the editor. NOT persisted — in-memory only, cleared when the
 *  draft is sent or the session is deleted. */
export interface ComposerDraft {
  text: string;
  html: string;
  tags: ContentTag[];
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  blocks: Block[];
  createdAt: number;
  /** Present only on the first assistant message of a turn. Drives the
   *  per-turn "开始时间 · 工作时长" stat row above the answer. */
  turnMeta?: TurnMeta;
}

/** A single todo item from claude's TodoWrite tool. */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/** Per-session plan-mode draft for the activity capsule. `plan: ""` and
 *  `phase: "cleared"` means "not in plan mode" — the capsule drops the Plan
 *  section entirely. */
export interface PlanDraft {
  plan: string;
  phase: PlanUpdateEvent["phase"];
}

/** One open diff tab inside the Git diff dialog (the "dialog" open-mode).
 *  `id` is a stable client-side id used as the React key + dedup key; we reuse
 *  the absolute file path so re-clicking the same file refreshes its tab
 *  instead of opening a duplicate. */
export interface GitDiffDialogTab {
  /** Stable id. Working-tree: `${absPath}::staged|work`; history: absPath
   *  (or commit-scoped id from the history view). Used as the dedup key. */
  id: string;
  /** Absolute path of the file being diffed. */
  filePath: string;
  /** Original-side content (the "before" blob). */
  before: string;
  /** Modified-side content. When omitted, DiffPane reads the working-tree
   *  file from disk (working-tree diffs). History / staged diffs supply both. */
  after?: string;
  /** Short label for the tab (file basename). */
  title: string;
  /** Repo the file belongs to (for context / grouping). */
  repoPath: string;
  /** Where the diff came from - working tree vs a history commit. */
  source: "working" | "history";
  /** For working-tree diffs: whether this is the staged (index) side.
   *  Staged and unstaged views of the same file are distinct tabs. */
  staged?: boolean;
}

/** Composer working-environment choice (the chip above the textarea). The
 *  two worktree forms differ ONLY in what materialization creates — a
 *  detached checkout ("wt-detached", experimental verification) or a
 *  generated `mcode/*` branch ("wt-branch", real feature work). Also the
 *  persisted string format of settings key `session.worktreeDefault`. */
export type EnvChoice = "local" | "wt-detached" | "wt-branch";

export interface SessionState {
  /* ── projects & sessions (tree cache) ──
   * sessions are cached per-project so the left-bar tree can render every
   * project's threads without a round-trip per expand. `sessions` is kept
   * as a convenience alias for the active project's sessions. */
  projects: Project[];
  activeProjectId: string | null;
  /** Active (non-archived) sessions per project — a TWO-SECTION array (see
   *  splitSessionSections): the first `SESSION_PAGE_SIZE` LOCAL rows are
   *  loaded on init / project expand and `loadMoreSessions(projectId)` appends
   *  the next page; worktree-bound threads follow after (fetched in full, see
   *  loadWorktreeSessions). Pagination math (total / hasMore / offset) counts
   *  the LOCAL section only. `sessions` is kept as a convenience alias for
   *  the active project's cached page. */
  sessionsByProject: Record<string, Session[]>;
  /** `true` when a project has more active sessions on the server than are
   *  currently loaded into `sessionsByProject[pid]`. Drives the "加载更多"
   *  affordance under the project's thread list. */
  sessionsHasMoreByProject: Record<string, boolean>;
  /** Total active-session count per project (server-side). Lets the UI show
   *  "还有 N 条" alongside the load-more button. */
  sessionsTotalByProject: Record<string, number>;
  /** Archived sessions per project (unpaginated). Powers the bottom "已归档"
   *  bin, which is now grouped by project rather than a flat dump. Only
   *  populated for projects that have ≥1 archived session. */
  archivedSessionsByProject: Record<string, Session[]>;
  /** Pinned non-archived sessions across ALL projects (most recent pin
   *  first), hoisted out of their project's active list into the left bar's
   *  global pinned section ABOVE the project tree. Loaded once at init via
   *  `session.listPinned` and maintained incrementally by the pin/archive/
   *  delete mutations and the cross-client `session.changed` reducer. */
  pinnedSessions: Session[];

  /* ── stream sidebar cache ("stream" leftBarMode) ──
   *  Flat cross-project aggregate behind `session.listAll` — the SAME rows
   *  `sessionsByProject` serves, just merged (newest-first, pinned excluded
   *  because pinned threads render in the stream's pinned block). The two
   *  caches are independent: mutations mark `streamDirty` and the stream
   *  view refetches its first page on the next paint (a 10-row local
   *  SELECT beats duplicating the per-project patch logic). */
  streamSessions: Session[];
  /** More rows remain server-side beyond `streamSessions`. */
  streamHasMore: boolean;
  /** Server-side total matching the aggregate filter. */
  streamTotal: number;
  /** A mutation/event invalidated the cached first page (ordering, title,
   *  archive, pin, …). The stream view refetches while visible. */
  streamDirty: boolean;
  /** The stream sidebar's project scope filter: null = 全部项目,
   *  "g:<name>" = a group, "wt:<normWorktreeKey>" = a worktree checkout,
   *  otherwise a projectId. Persisted under `ui.streamScope` so re-entering
   *  the view (remount or relaunch) restores the last selected project
   *  instead of resetting to the unfiltered view. */
  streamScope: string | null;

  /** Sessions whose LAST turn ended in an error — the stream sidebar's red
   *  「失败」status label. Cleared when a new turn starts. */
  turnErrorBySession: Record<string, boolean>;

  /** Per-repo worktree inventory for the stream sidebar's inline branch /
   *  unmerged indicators, cached against `gitChangeVersionByRepo` as the
   *  invalidation key (bumped version = stale entry). */
  worktreeInfoByRepo: Record<string, { version: number; worktrees: GitWorktreeInfo[] }>;

  /** Sessions of the active project (derived view; components may read either). */
  sessions: Session[];
  activeSessionId: string | null;
  /** Which projects are expanded in the tree (UI-only, not persisted). */
  expandedProjects: Record<string, boolean>;
  /** Per-project left-bar VIEW: false (default) = local threads only,
   *  true = worktree groups. Flipped by the project row's fork toggle;
   *  auto-flipped (to true) when a worktree thread activates so the active
   *  row is always visible. UI-only, not persisted. */
  worktreeViewByProject: Record<string, boolean>;
  /** Which worktree group nodes are expanded in the tree (UI-only, keyed by
   *  normalized worktree path; not persisted). */
  expandedWorktrees: Record<string, boolean>;
  /** Left-bar display names for worktree directories (normalized path →
   *  name). Persisted in the `settings` table; cosmetic only — missing
   *  entries fall back to the directory basename. */
  worktreeNames: Record<string, string>;
  /** Per-project avatar color overrides (projectId → hex). Persisted under
   *  `project.colors`; cosmetic only — missing entries fall back to the
   *  deterministic name-hash color (lib/projectAvatar.ts). */
  projectColors: Record<string, string>;
  /** Whether the "archived" section at the bottom of the tree is expanded. */
  archivedViewOpen: boolean;

  /* ── tab state (center pane) ──
   *  `openTabs` is the ordered list of sessionIds the user has open in the
   *  center pane. In `single` displayMode the renderer only mounts the
   *  `activeSessionId` chat pane (so the list is mostly informational); in
   *  `tabs` mode the list drives the SessionTabs strip and switching
   *  between them is the primary way to navigate. We always write the
   *  list (regardless of mode) so flipping the mode switch never loses
   *  the user's open sessions. */
  openTabs: string[];
  /** How the center pane renders. Persisted in the `settings` table. */
  displayMode: DisplayMode;
  /** Whether the tab strips wrap their tabs onto multiple rows instead of
   *  scrolling one horizontal row (toggled from the bars' "⋯" overflow
   *  menu). Persisted under `ui.tabBarMultiRow`. */
  tabBarMultiRow: boolean;
  /** Which left-bar view is mounted: the classic project tree ("tree",
   *  default) or the session-first flat stream ("stream", T3-style cards
   *  with a project scope filter). Persisted; the two views are pure
   *  renderers over the same store data. */
  leftBarMode: LeftBarMode;
  /** UI theme STYLE, orthogonal to the light/dark scheme: "classic" (default)
   *  or "sketch" (纸面手绘 — paper palette + handwriting font + hand-drawn
   *  shapes, styles.css `html.sketch` section). Persisted under
   *  `ui.themeStyle`; applied to <html> as a `.sketch` class next to `.dark`
   *  (lib/theme.ts applyThemeStyle via useThemeStyle in lib/appearance.ts). */
  themeStyle: ThemeStyle;
  /** Which tab kind owns the center content area in `tabs` displayMode: the
   *  active session's chat ("chat") or the editor — file / plan tab
   *  ("editor"). Only read in `tabs` mode; `single` mode keeps the legacy
   *  chat|editor split and ignores it. UI-only (not persisted). Treat
   *  "editor" as effective only while the editor has content (an active file
   *  or an active plan tab); consumers fall back to "chat" at render time
   *  when it doesn't. */
  centerTabFocus: "chat" | "editor";
  /** UI language for all translated chrome. `"zh"` (the project's original
   *  language) is the default. Persisted in the `settings` table; components
   *  subscribe via `useI18n()` and re-render live when it flips. */
  locale: Locale;
  /** Session auto-archive rules (master switch + default inactivity days +
   *  per-project overrides). Persisted as JSON in the `settings` table under
   *  `session.autoArchive`; read fresh by the main-process AutoArchiver on
   *  every tick, so a change here takes effect within an hour. */
  autoArchiveConfig: AutoArchiveConfig;
  /** Chat message-stream vertical density. Persisted in the `settings` table
   *  under `ui.chatDensity`; applied to <html> as the --chat-row-gap-* /
   *  --chat-block-gap CSS vars by lib/appearance.ts. */
  chatDensity: ChatDensity;
  /** How the left bar renders projects. `"flat"` (default) is a plain list;
   *  `"grouped"` clusters them under collapsible headers keyed by
   *  `Project.group`. Persisted in the `settings` table. */
  projectView: ProjectView;
  /** Per-group metadata (color + display order), keyed by group name.
   *  Persisted as a JSON blob in the `settings` table. Groups themselves
   *  aren't a DB entity (they're derived from `Project.group`), so their
   *  metadata lives here. */
  groupMeta: ProjectGroupsMeta;
  /** Chat content font size in px (12–20). Persisted in the `settings`
   *  table. Applied to <html> as the --chat-font-size CSS var by
   *  lib/appearance.ts so it cascades into the message rows + markdown. */
  chatFontSize: number;
  /** Global side-panel + settings font size in px (10–22). Despite the
   *  legacy field name, this drives the whole app chrome: the left project
   *  bar, the right files/git/terminal panels, AND the settings page all
   *  inherit it. Persisted in the `settings` table. Applied to <html> as the
   *  --right-panel-font-size CSS var (plus --rp-fs-* derived variants) by
   *  lib/appearance.ts, and also fed to the xterm terminal fontSize. */
  rightPanelFontSize: number;
  /** Character threshold above which a paste is promoted to a content-tag
   *  chip (50–5000). Persisted in the `settings` table. Drives
   *  `shouldPromoteToTag` in contentTag.ts via the composer's
   *  shouldPromotePaste prop. */
  pasteTagThresholdChars: number;
  /** Default speech-recognition language tag (e.g. "zh-CN" | "en-US"). */
  voiceLang: string;
  /** Preferred ASR engine ("zipformer" streaming | "parakeet" offline). Falls
   *  back to zipformer when the chosen engine/model is unavailable. */
  voiceEngine: VoiceEngine;
  /** Cached mic-permission outcome: "granted" | "denied" | "". Empty until the
   *  user first attempts voice input. Surfaces a clear "grant access" mic
   *  state instead of a silent failure. */
  voiceMicPermission: string;
  /** Absolute path to the user-selected local ASR model directory (empty = not
   *  configured). The app never downloads models — the user fetches the files
   *  themselves and points Settings → 语音输入 → 模型目录 here. */
  voiceModelDir: string;
  /**
   * 工作流**最多同时跑几个节点**(见 `@contracts/ipc` 的
   * `WORKFLOW_MAX_PARALLEL_SETTING_KEY`)。
   *
   * ⚠️ 这里存的是**给界面看的那个数** —— 真正生效的是主进程每次派发现读的那一份。
   * 两边读同一个设置键,所以它们通常一致;不一致的窗口只有"改完还没落盘"那一瞬。
   */
  workflowMaxParallel: number;
  /** True when a voice model is both SELECTED and present on disk (from
   *  `voice.modelList`, which rescans the model root). The composer's mic
   *  button renders only while this is true — before the user downloads a
   *  model in Settings → 语音输入 there is nothing to dictate with, so the
   *  icon stays hidden instead of failing on click. Refreshed at boot and
   *  whenever the settings dialog closes (covers select/download/remove done
   *  inside the panel). */
  voiceModelReady: boolean;
  /** Custom user-message background color as an "R G B" triplet string
   *  (e.g. "124 58 237"), or null to use the theme default. Persisted in
   *  the `settings` table. Applied to <html> as --user-bubble. */
  userMessageColor: string | null;
  /** Custom global brand/accent color as an "R G B" triplet string
   *  (e.g. "5 150 105"), or null to use the theme default. Persisted in
   *  the `settings` table. Applied to <html> as --accent, which cascades
   *  into the `accent` Tailwind token used by buttons, links, selected
   *  states, focus rings, and the prompt-card accents. */
  accentColor: string | null;
  /** Monaco editor color-scheme choice, one scheme id per app theme (the
   *  file editor + plan viewer follow the effective light/dark mode; the
   *  dark scheme applies in dark mode, the light one in light mode).
   *  Persisted as JSON in the `settings` table under `ui.editorTheme`;
   *  themes themselves are registered by lib/monacoSetup.ts from
   *  lib/editorThemes.ts. Consumed by FileEditor's useMonacoTheme(). */
  editorTheme: EditorThemeChoice;
  /** User's keyboard-shortcut overrides: commandId → Accelerator. Only the
   *  entries the user has rebound live here; every other command falls back
   *  to its compiled-in `defaultAccelerator` (see lib/shortcuts.ts). Persisted
   *  in the `settings` table as one JSON blob. Hydrated in `initDeferred`. */
  shortcutOverrides: ShortcutBindings;

  messagesBySession: Record<string, ChatMessage[]>;
  /** Whether older messages remain unloaded on the server, per session.
   *  `undefined`/absent = not yet determined (session never loaded); `true` =
   *  more history is available above the current head; `false` = all loaded. */
  hasMoreMessagesBySession: Record<string, boolean>;
  /** In-flight FIRST-PAGE history fetch, per session. True between the
   *  activation/prefetch fetch starting and its IPC round-trip landing.
   *  The ChatPane reads this (bucket undefined + loading) to show a
   *  skeleton instead of the empty-thread welcome while persisted history
   *  streams in — no more "blank composer, then content pops in" flash. */
  loadingMessagesBySession: Record<string, boolean>;
  /** In-flight "load older" request, per session. Guards against stacking
   *  concurrent paginated fetches when the user holds the scroll at the top. */
  loadingOlderBySession: Record<string, boolean>;
  /** Per-session "persisted history hydrated" flag. True ONLY after
   *  prefetchSessionMessages has merged the DB's first page into the bucket
   *  (or the session was created locally, whose history is empty by
   *  definition). Bucket EXISTENCE is not enough as the guard: ingestEvent
   *  creates partial buckets on the fly for sessions never opened locally
   *  (e.g. a turn driven from the mobile companion while the desktop app was
   *  running but the thread wasn't open) — such a bucket holds only the live
   *  event window, and letting it suppress the first-page fetch hides every
   *  earlier persisted message (sent from this PC in a previous run, or from
   *  the phone) until an app restart re-hydrates from the DB. */
  historyLoadedBySession: Record<string, boolean>;
  /** Per-session running flag. Keyed by sessionId so a turn running in
   *  thread A doesn't lock the composer in thread B — the user can keep
   *  composing / inspecting other threads while a background turn streams.
   *  `false` / missing entry = idle. Reads should go through the
   *  `isRunningForActiveSession` selector below (or compute on the fly)
   *  so consumers always see "am I running?" relative to the active thread. */
  runningBySession: Record<string, boolean>;
  /**
   * 引擎自己报上来的斜杠命令清单，**按引擎存**（2026-09-21）。
   *
   * ## 为什么键是引擎而不是会话
   *
   * 清单是**引擎的属性**，不是某一次对话的属性 —— Claude 那 57 条不随你会话的标题、
   * 项目、消息多少而变（项目技能会影响它，所以取的时候带 `cwd`，但那是"同一个引擎在
   * 不同目录下的答案"，仍然属于引擎这一层）。按会话存会让同一批命令在每个会话里各
   * 复制一份，而菜单读的永远是"当前引擎的那一份"。
   *
   * ## 两个来源，一个字段
   *
   *  - **主动取**（`reloadEngineCommands`，会话就绪时）—— 这条路解决了"还没发消息时
   *    菜单是空的"。
   *  - **事件推**（`system/init` 的 `slash_commands` / `commands_changed`）—— 这条路
   *    是唯一能反映"引擎中途换了清单"（装了插件、动态发现技能）的。
   *
   * `supported: false` = 这个引擎**根本没有**命令清单（Pi / Codex），与"还没取到"
   * （字段不存在）要分开 —— 界面上前者说"这个引擎不提供"，后者说"还没拉到"。
   */
  engineCommandsByProvider: Record<string, { supported: boolean; commands: EngineCommandInfo[] }>;
  /** 主动去问引擎要清单（见上面字段的说明）。失败安静 —— 不弹错。 */
  reloadEngineCommands: (providerId?: string | null) => Promise<void>;
  /** Per-session wall-clock ms stamped at send time - the time anchor for the
   *  "开始 · 用时" stat row BEFORE the first assistant content block arrives.
   *  Without this, the stat row only appears when the first delta/tool/plan
   *  lands (which can lag send by seconds while the model "thinks"), leaving
   *  the user with no running feedback. The three isNewTurn stamping sites
   *  (flushDeltas / tool.use / upsertLivePlanBlock) fall back to this value
   *  so the real turnMeta.continues the synthesized row's timing seamlessly.
   *  NOT persisted - it's transient: cleared on turn.done / error / interrupt
   *  / session delete, alongside runningBySession. */
  runningTurnStartedAt: Record<string, number>;
  /**
   * 这个对话里**有几处岔路口正挂着等人**。
   *
   * ## 为什么非有不可
   *
   * 图停在岔路口等人的时候,`runningBySession` 仍然是真(那一轮还没收尾),于是输入框
   * 被当成"忙" —— 用户敲回车只是把话**排队**,而队列要等 `turn.done` 才排空,可那张图
   * 正等着他点,永远不会自己收尾。现象就是用户的原话:「我无法发送消息了」。
   *
   * 而那个时刻**整张图唯一在做的事就是等他**,把它算成"忙"是不诚实的。所以这一格 0 的
   * 时候,`ChatPane` 把 `sessionBusy` 放开(见那里),让他能直接说话。
   *
   * ## 为什么是计数不是布尔
   *
   * 两处岔路口可以**同时**挂在等人(它们互不依赖)—— 布尔的话,一处答完就把另一处的
   * "有人在等"抹掉了。
   *
   * 只活在**活着的会话**里:重启之后它是空的,而那时确实没有任何图在等人(进程死过,
   * 那一次运行已经没了)。要接着跑是另一条路 —— 点那张旧卡片,见 `runner.ts`。
   */
  waitingBranchesBySession: Record<string, number>;
  /** Send-time MODEL anchor: the resolved model id the in-flight turn was sent
   *  with (see resolveSendModel). Consumed by the same three isNewTurn stamping
   *  sites as runningTurnStartedAt to write `turnMeta.model`, so the stream can
   *  show which model produced each turn even though the composer's selection
   *  can change between turns. Read at CREATE time only — unlike the requested
   *  config it can't be retroactively changed by a later model switch.
   *  NOT persisted — transient, same lifetime as runningTurnStartedAt. */
  runningTurnModelBySession: Record<string, string>;
  /** Per-session "用户已手动停止"哨兵。interrupt() 置位,下一个真正启动的
   *  turn (sendPrompt / editAndResendMessage) 清除。存活期间,迟到的
   *  subagent.update / turn.done 不得复活 running 子代理或保留 running roster
   *  -- 用户的中断是权威意图。NOT persisted - 仅内存态,随 deleteSession
   *  一并清理。 */
  interruptedBySession: Record<string, boolean>;
  /** Per-session "turn ended but the work didn't finish" flag. Set by
   *  `turn.incomplete` (gateway returned an empty final response — the turn
   *  closed with dangling tool_use or no reply text); consumed by the very
   *  next turn.done, which then skips its misleading "回合完成" toast/unread
   *  bump (the turn.incomplete case already toasted a warning). Lifetime is
   *  effectively milliseconds — the adapter always emits turn.incomplete
   *  immediately before turn.done. NOT persisted. */
  turnIncompleteBySession: Record<string, boolean>;
  /** Per-session transient upstream-network issue (the OpenAI bridge's retry
   *  loop: connect timeout / reset / refused — see UpstreamIssueEvent). Set on
   *  `upstream.issue{kind:"retry"}`; cleared on kind:"ok", turn end (turn.done
   *  / error), interrupt, session delete, and a decay timer (a retry that goes
   *  quiet without any terminal event must not pin the hint forever). The chat
   *  renders it beside the streaming spinner so a 10s+ mid-turn stall is
   *  explained instead of looking like a hang. NOT persisted — live feedback. */
  upstreamIssueBySession: Record<string, { cause: string; attempt: number; attempts: number }>;
  /** Per-session unread event counter. Incremented in `ingestEvent` whenever a
   *  noteworthy event (turn done, error, blocking approval/question, background
   *  subagent completion) arrives for a session that is NOT the active session.
   *  Cleared to 0 when the user selects/opens that session (selectSession /
   *  openTab). Drives the red dot badge in the left bar + tab strip. NOT
   *  persisted - unread state is transient and shouldn't survive a restart. */
  unreadBySession: Record<string, number>;
  /** Per-repo git-change version, bumped by the `git.changed` runtime event
   *  (broadcast by the main process after ANY client's commit / stage /
   *  unstage / push / pull / discard / checkout). Git surfaces (mobile Git
   *  screen, desktop GitRepoCard, GitHistoryView) select the counter for the
   *  repo they're viewing and re-fetch when it moves — so a commit on the
   *  phone refreshes the desktop panel and vice versa, with no polling. NOT
   *  persisted — a missed bump just means one manual refresh. */
  gitChangeVersionByRepo: Record<string, number>;
  /** Whether the main window is currently focused (frontmost + not minimized +
   *  the renderer tab is visible). Fed from the Electron `window:focusChanged`
   *  push event + `document.visibilitychange`. The notification layer reads
   *  this to decide between an OS notification (window unfocused) vs an in-app
   *  toast (window focused). NOT persisted. */
  isWindowFocused: boolean;
  /** Health is provider-scoped; never reuse one backend's probe for another. */
  providerHealthById: Record<string, {
    loading: boolean;
    ok: boolean | null;
    code?: ProviderHealthStatusCode;
    checkedAt?: number;
    version?: string;
    error?: string;
  }>;
  /** Settings modal visibility (opened from the LeftBar ⚙ footer and the CLI-missing CTA). */
  settingsOpen: boolean;
  /** Initial settings section to land on when the modal opens. Callers that
   *  know which section the user wants (e.g. the composer's "管理模型…"
   *  entry → "custom-models" / "pi-models") pass it to setSettingsOpen; null
   *  means "use the default section". Cleared on close. */
  settingsSection: string | null;
  /**
   * **一次性**的"打开设置后选中哪一份工作流/自动化"。技能/插件页的「节点」反查里点一行
   * 时带上它,`WorkflowLibraryView` 挂载后选中并清掉(见 `setSettingsOpen` 的第三参)。
   * `null` = 不指定(打开停在库列表,不自动选)。和 `settingsSection` 一样 **close 时清**。
   */
  settingsFocusWorkflowId: string | null;
  /** "尚未配置模型" dialog visibility. Opened by sendPrompt / editAndResendMessage
   *  when the active provider has no configured model to send with (model is
   *  auto/"default" and nothing is configured). NOT persisted. */
  modelConfigPromptOpen: boolean;
  /** Send-blocked-because-no-model-picked pulse counter. Bumped by the
   *  send-time guard instead of firing a global toast: the ModelDropdown chip
   *  watches this nonce and answers in place — a short shake + a small
   *  floating "请先选择模型" hint anchored above the chip. Monotonic so
   *  repeat sends while blocked re-trigger the nudge. NOT persisted. */
  modelGuardPulse: number;
  /** Command palette (Cmd/Ctrl+K) visibility. Toggled by the global hotkey
   *  wired in App.tsx and by any in-app "command palette" affordance. The
   *  palette itself (CommandPalette.tsx) reads this to mount/unmount. */
  commandPaletteOpen: boolean;
  /** File search dialog visibility. Opened from the Files panel search
   *  button, the `files.search` command, or the Cmd/Ctrl+Shift+F hotkey.
   *  The dialog (SearchDialog.tsx) reads this to mount/unmount. NOT persisted. */
  searchDialogOpen: boolean;
  /** Left sidebar visibility. Lifted from App.tsx local state so the
   *  command palette (and other store consumers) can toggle it. Workspace-only
   *  — the settings view pins it open. NOT persisted (matches original behavior). */
  leftOpen: boolean;
  /** Right (IDE) panel visibility. Lifted from App.tsx local state. NOT persisted.
   *  `ideFocusNonce` bumps still drive this to `true` (the App effect now
   *  calls setRightOpen(true) instead of touching local state). */
  rightOpen: boolean;
  /** Bottom terminal bar visibility. Lifted from App.tsx local state. NOT
   *  persisted. The bar stays mounted (keep-alive) regardless; this only
   *  controls whether it's expanded. */
  bottomTerminalOpen: boolean;
  /** Browser panel visibility. When true the BrowserPanel overlay mounts over
   *  the workspace and the embedded WebContentsView is shown; false hides both.
   *  NOT persisted (pure in-memory, like the other layout flags). */
  browserPanelOpen: boolean;
  /** Wide-panel (3:7) mode: hides the left sidebar + center editor so the
   *  workspace shows only the chat column (3) and the full right panel (7).
   *  Toggled from the right-panel rail fullscreen button / command palette.
   *  While on, the left sidebar can't be opened. NOT persisted (transient,
   *  like the other layout flags); on exit the pre-enter layout state is
   *  restored from widePanelSnapshot. */
  widePanelOpen: boolean;
  /** Right-panel share (%) of the wide-panel chat|right split; the chat column
   *  gets the remainder. Default 70 → the requested 3:7. Draggable via the
   *  split's Divider; double-click resets to the default. In-memory only. */
  widePanelPct: number;
  /** Layout state captured when wide-panel mode opened, restored on exit.
   *  rightPanelTab is deliberately NOT snapshotted — tab switches the user
   *  makes while in wide mode are respected on exit. */
  widePanelSnapshot: { leftOpen: boolean; rightOpen: boolean; rightWidth: number } | null;
  /** Number of open browser tabs (mirrors BrowserPanel's local tabs state so
   *  the Titlebar toggle button can show a count badge). Updated by the panel
   *  via setBrowserTabCount. NOT persisted. */
  browserTabCount: number;
  /** Device-toolbar visibility in the browser panel (the DevTools-style bar
   *  under the address bar with the device dropdown + custom dims + rotate).
   *  Toggled by the 📱 button in BrowserToolbar; a per-session in-memory flag
   *  (NOT persisted) like the other browser layout state. */
  browserDeviceToolbarOpen: boolean;
  /** Open browser tabs, shared between the sidebar (mobile-first) and overlay
   *  (PC fullscreen) containers. Each owns a main-process WebContentsView by
   *  browserId; the view pool survives container swaps. NOT persisted. */
  browserTabs: BrowserTab[];
  /** The currently active browser tab id (shared across containers). */
  browserActiveTabId: string | null;
  /** A URL staged by an external entry (e.g. file-tree "open in browser") to
   *  be loaded into the browser panel when no tab exists yet. BrowserPanel's
   *  first-tab effect consumes and clears it. NOT persisted. */
  pendingBrowserUrl: string | null;
  /** Suppression counter for the embedded browser's OS-level WebContentsView.
   *  The native view always floats above renderer DOM, so a renderer-DOM
   *  overlay that must cover it (image lightbox, etc.) increments this while
   *  open; BrowserPanel reacts by hiding the view, and restores it when the
   *  counter returns to zero. A counter (not a boolean) composes correctly
   *  when multiple overlays are open at once. NOT persisted. */
  browserViewSuppressed: number;
  /* ── Draggable pane sizes ──
   *  Persisted as one JSON blob (UI_PANE_WIDTHS_SETTING_KEY) and re-clamped
   *  on hydrate. Updated live during drag (synchronous set); the DB write is
   *  debounced so a drag doesn't hammer the settings table. */
  /** Left sidebar share of the window width, as a percentage 0–100
   *  (default/min 12 — a compact ~259px sidebar on a 2160px window). */
  leftWidthPct: number;
  /** Right IDE panel width in px. */
  rightWidth: number;
  /** Bottom terminal bar height in px (when expanded). */
  bottomTerminalHeight: number;
  /** Editor-column share of the center pane, as a percentage 0–100. The chat
   *  column gets the remainder. Only meaningful when a file is open. */
  editorWidthPct: number;
  /** Permission mode for the next session. The 6-value union
   *  (default / acceptEdits / plan / bypassPermissions / dontAsk / auto)
   *  mirrors the Claude Agent SDK's accepted literals; the composer chip
   *  only surfaces the 4 user-facing ones. See PermissionMode in
   *  @contracts/runtime for the full list. */
  permissionMode: PermissionMode;
  /** 当前会话用的工作流(内置的六个,或用户自建的 `wf_`)。和模型 / 权限一样是
   *  **每会话一个**的槽位 —— `syncConfigFromSession` 在切换会话时重新灌进来。
   *  开放字符串:内置 id(见 `BuiltinWorkflowId`)只是它的一个子集。 */
  workflowId: string;
  /** Default working environment for NEW sessions: "local" (project root),
   *  "wt-detached" (isolated detached checkout — experimental verification)
   *  or "wt-branch" (isolated checkout on a generated `mcode/*` branch —
   *  real feature work). The worktree materializes on the first turn.
   *  Persisted (settings key `session.worktreeDefault`, same three-value
   *  strings) so the choice sticks across restarts. Flipping the chip while
   *  the ACTIVE
   *  session is still an un-materialized intent edits THAT session instead
   *  (see setEnvChoice) — the slot itself only seeds new rows. */
  envChoice: EnvChoice;
  /** Provider powering the next session ("claude-sdk" / "pi-sdk"). Chosen in
   *  the composer's provider chip; persisted on the session row at creation.
   *  Once a session has messages, this is read-only (a session's provider is
   *  fixed at creation). */
  providerId: string;
  /** Model for the next session ("default" = let claude pick). → --model. */
  model: string;
  /** Custom-model config bound to the active session (null = built-in). */
  customModelId: string | null;
  /** Last user-picked composer config per provider ("记住每个 SDK 上次选的
   *  模型 / 思考级别 / 权限级别"). The model binding is written by setModel /
   *   setCustomModel; the thinking-level + permission-mode slots by setEffort /
   *   setPermissionMode; setProvider stashes the OUTGOING provider's full
   *  snapshot and restores the target's remembered one — switching SDKs back
   *  re-selects what the user last used with that provider (values the target
   *  doesn't declare are snapped to "default" via coerceSlotsForProvider)
   *  instead of carrying the outgoing provider's values over. Persisted as
   *  part of the composer selection setting. Entries whose model was deleted
   *  are dropped (see validateComposerSelection). */
  lastModelByProvider: Record<
    string,
    {
      model: string;
      customModelId: string | null;
      /** Optional: older persisted entries carry only the model binding. */
      effort?: EffortLevel;
      permissionMode?: PermissionMode;
    }
  >;
  /** User-defined custom-model configs (desensitized — tokens masked). */
  customModels: CustomModelPublic[];
  /** Registered AI backends from `provider.list`. Empty until initDeferred. */
  providers: ProviderInfo[];
  /** Pi SDK models the user can pick (from ~/.pi/agent/models.json +
   *  injected apiKeys). Populated by `reloadPiAvailableModels` — used by
   *  ModelDropdown when the active provider is pi-sdk, since pi's
   *  `capabilities.builtinModels` is empty (models are dynamic). */
  piAvailableModels: BuiltinModelOption[];
  /** Codex models the user can pick (configured third-party providers from
   *  the settings panel, projected to "providerId/modelId"). Populated by
   *  `reloadCodexAvailableModels` — used by ModelDropdown when the active
   *  provider is codex-sdk, since codex's `capabilities.builtinModels` is
   *  empty (models come from user config, mirroring pi). */
  codexAvailableModels: BuiltinModelOption[];
  /** Discovered skills for the composer `/` menu. Cached per active project
   *  (global ~/.claude/skills + the project's .claude/skills); refreshed on
   *  init and project switch. Empty list = no skills installed. */
  skills: SkillInfo[];
  /** Reasoning effort for the next session ("default" = don't pass --effort).
   *  Defaults to "high" so new sessions get the most thinking out of the
   *  box — users can cycle down to Auto if they want claude to pick. */
  effort: EffortLevel;
  /** Latest task list per session (from claude's TodoWrite; null = none yet). */
  todosBySession: Record<string, TodoItem[]>;
  /** Per-session plan-mode draft (empty = not in plan mode). Drives the
   *  Plan section of the activity capsule. */
  planBySession: Record<string, PlanDraft>;
  /** Per-session plan text selected for viewing in the editor column as a
   *  plan tab. null = no plan tab open. Set when the user clicks a plan title
   *  in the activity popover or a plan card in the message stream; cleared on
   *  close / session reset. Ephemeral (not persisted). */
  planDrawerPlanBySession: Record<string, string | null>;
  /** Per-session flag: when true AND planDrawerPlanBySession[sid] is non-null,
   *  the editor column shows the PlanViewer (plan tab is "active"). Switching
   *  to a file tab sets this false (but keeps the plan text so the plan tab
   *  can be re-activated). Ephemeral. */
  planTabActiveBySession: Record<string, boolean>;
  /** Per-session edited draft of a pending plan approval. When the user edits
   *  the plan in the Monaco editor (opened from the approval prompt via
   *  "编辑计划"), the edited text is staged here so PlanApprovalPrompt picks
   *  it up as its draft - the user still confirms via 批准并执行, so editing
   *  in the editor never auto-approves. Cleared on submitPlanApproval /
   *  closePlanDrawer / session reset. Ephemeral (not persisted). */
  planApprovalDraftBySession: Record<string, string>;
  /** Mobile-shell fullscreen viewer target (see {@link MobileViewerTarget}).
   *  null = closed. Ephemeral (not persisted). */
  mobileViewer: MobileViewerTarget | null;
  /** Per-session subagent roster (REPLACE semantics from `subagent.update`).
   *  Empty array = no subagents active. Includes recently-completed ones
   *  until the next turn clears them. */
  subagentsBySession: Record<string, SubagentSnapshot[]>;
  /** Per-session subagent live transcripts (the side-panel subagent viewer).
   *  Outer key = sessionId, inner key = the spawning Task tool_use id (same
   *  id as SubagentSnapshot.toolUseId). NOT persisted — process-lifetime
   *  data rebuilt each turn; cleared when a new turn starts (mirroring the
   *  roster's rebuild cycle). */
  subagentTranscriptsBySession: Record<string, Record<string, TranscriptBlock[]>>;
  /** 每个**工作流节点**跑出来的过程,按**节点会话 id** 索引(`WorkflowNodeTranscriptEvent`)。
   *  卡片上那个「过程」读它。
   *
   * ## 为什么是平铺一层,不是"父会话 → 节点"两层
   *
   * 读它的地方是对话里的那张卡片,而卡片手上只有 `block.nodeSessionId`(见
   * `WorkflowNodeResultEvent`)。要按父会话索引就得把 sessionId 一路透传进
   * `MessageBlocks` —— 那是个**刻意的纯展示组件**(不碰任何 per-session 状态桶)。
   * 而节点会话 id 本来就全局唯一,一层就够,还省掉那条透传。
   *
   * ## 两条与 subagentTranscriptsBySession 不同的地方
   *
   * - **新回合开始时不清。** 子代理转录是"这一轮谁在干活",清掉正合适;而过程挂在
   *   **消息流里的卡片**上,卡片留在历史里 —— 一清,上一轮的卡片点开就成空的了。
   * - **有容量上限**(见 `NODE_TRANSCRIPT_KEEP`),因为不清就意味着它会随进程一直涨。 */
  workflowNodeTranscripts: Record<string, TranscriptBlock[]>;
  /** Per-session context-window snapshot (from `token-usage.updated` events).
   *  The adapter already did all the math (usedTokens / maxTokens / pct /
   *  warning), so the renderer only stores + renders. Keyed by sessionId so
   *  each tab shows its own occupancy. Hydrated from the session row on
   *  select/open (the snapshot is persisted), then kept live as
   *  `token-usage.updated` events stream in. */
  contextSnapshotBySession: Record<string, ContextSnapshot>;
  /** Per-session, append-only log of finalized turn usage snapshots.
   *  Appended at `turn.done` from the latest ContextSnapshot, so each entry
   *  is the post-turn token/cost breakdown for one completed turn. Used by
   *  the activity capsule's "上下文消耗" section to show a per-turn history
   *  + a session total. Ephemeral (not persisted): a restart starts empty,
   *  same as todos/subagents. */
  usageHistoryBySession: Record<string, TurnUsageRecord[]>;
  /** Per-session pending AskUserQuestion. Keyed by sessionId so a
   *  question popping up in tab B doesn't clobber tab A's. The sessionId
   *  lives on the inner record for cross-checking at render time.
   *
   *  `requestId` correlates the answer back to the provider's pending
   *  user-input Deferred — submitting answers resolves that Deferred so
   *  the SAME turn continues (it does NOT start a new turn). Absent only
   *  for the sentinel-fallback path (no Deferred to resolve). */
  pendingQuestionBySession: Record<string, { questions: AskUserQuestionItem[]; requestId?: string }>;
  /** Per-session tool-approval queue. The head (index 0 of the sub-array
   *  for the session) is what's rendered in the composer overlay. The
   *  top-level array holds all sessions' pending approvals; UI filters
   *  by sessionId. */
  pendingApprovals: ApprovalRequestEvent[];
  /** Per-session pending ExitPlanMode approval. Unlike tool approvals
   *  (which queue), plan approval is one-at-a-time per session — the model
   *  calls ExitPlanMode once per plan. `null` = no plan awaiting decision.
   *  Keyed by sessionId so each tab tracks its own. */
  pendingPlanApprovalBySession: Record<string, PlanApprovalRequestEvent>;

  /** Files modified or created in the most recent turn (for the
   *  "本轮文件" rewind card). Per-session: a new turn in session A does
   *  not overwrite session B's card. The card is cleared on
   *  `turn.rewound` for the same session. */
  turnFilesBySession: Record<string, TurnFileEntry[]>;

  /** Per-session user-placed message bookmarks (selection → "添加书签").
   *  Persisted on the session row; hydrated on select/open so the capsule
   *  segment + timeline markers survive a reopen. Per-session for the same
   *  tab-isolation reason as turnFilesBySession. Stale entries (their
   *  message was truncated away by an edit-resend) are kept until the user
   *  deletes them — the popover renders them greyed out. */
  bookmarksBySession: Record<string, SessionBookmark[]>;

  /** Per-session ephemeral queue of absolute file paths the user wants added
   *  to the composer as file-reference tags (e.g. from the file-tree context
   *  menu's "Add to chat" action). The owning ChatPane drains its session's
   *  queue via {@link drainChatFileQueue} and converts the paths to tags.
   *  NOT persisted - it's a one-shot hand-off channel, not session data. */
  chatFileQueueBySession: Record<string, string[]>;

  /** Per-session ephemeral queue of DOM elements picked from the embedded
   *  browser panel. The owning ChatPane drains its session's queue via
   *  {@link drainChatElementQueue} and converts each to an element tag. Same
   *  one-shot hand-off pattern as chatFileQueueBySession. NOT persisted. */
  chatElementQueueBySession: Record<string, PickedElement[]>;

  /** Per-session FIFO prompt queue. Populated when the user "排队" a prompt
   *  while the session is busy; auto-drained (head sent) when the session
   *  goes fully idle (no running turn AND no running background subagent).
   *  Keyed by sessionId so the queue survives tab switches — draining lives
   *  in the store's event handlers, where there's no component to hold it.
   *  NOT persisted: ephemeral run-ahead buffer, not session history. */
  promptQueueBySession: Record<string, QueuedPrompt[]>;

  /** Per-session composer draft (typed-but-unsent content + attachment chips).
   *  Written through by the ChatPane on every composer change; restored when
   *  the session's pane remounts (single-mode thread switch, tab close/reopen)
   *  so the user's input survives thread switches. NOT persisted — in-memory
   *  only, cleared once the draft is sent or the session is deleted. */
  composerDraftBySession: Record<string, ComposerDraft>;

  /* ── Side chat (right-panel ask tab) ──
   *  Side chats are full sessions with kind="side" + parentSessionId, hidden
   *  from every left-bar list (repo queries exclude them). They run fully
   *  concurrent with their parent — RuntimeManager keys everything by
   *  sessionId — and are managed here, keyed by their PARENT session id. */
  /** Loaded side-chat lists, keyed by parent (main) session id. Hydrated on
   *  demand when the ask tab opens or the active main session changes
   *  (hydrateSideChats); NOT part of sessionsByProject. Ordered by
   *  created_at DESC (newest Q&A thread first), matching the repo query. */
  sideChatsByParent: Record<string, Session[]>;
  /** The side chat currently open in the ask tab's chat view; null = the
   *  list view is showing. NOT reset on main-session switch — the panel
   *  derives "activeSideChat belongs to the current parent" and falls back
   *  to the list view when it doesn't, so switching threads can't strand
   *  the user in another thread's chat view. */
  activeSideChatId: string | null;
  /** One-shot seed text waiting to be dropped into a side chat's composer,
   *  keyed by the SIDE chat's session id. Written by askInSideChat (the
   *  message-stream selection toolbar's "发送到侧边对话" action), consumed and
   *  drained by the side chat's own ChatPane instance. One-shot channel,
   *  not persisted — same hand-off pattern as chatFileQueueBySession. */
  sideChatSeedBySession: Record<string, string>;
  /**
   * 外部投递草稿的 **touch 计数**（key 是会话 id）。`deliverComposerDraft` 每次投递
   * 递增一格；挂载中的 ChatPane 订阅它、变了就当场重跑草稿还原 —— 这是「目标会话
   * 开着时写草稿看不见」的根因修复（见 `deliverComposerDraft` 的说明）。不持久化，
   * 会话删除时一并清掉。
   */
  composerDraftTouchBySession: Record<string, number>;
  /** One-shot "open this subagent's transcript" request from outside the
   *  side panel (the ActivityPopover's subagent row click). Carries the
   *  PARENT session id (ownership check) + the subagent's taskId; consumed
   *  and drained by SideChatPanel. Not persisted. */
  pendingSubagentView: { sessionId: string; taskId: string } | null;
  /** One-shot "open this session and jump to this message" request.
   *  Producers: the Ctrl+K palette's bookmark result click, and the turn
   *  flow panel's step rows (locate-in-chat navigation). Consumed by the
   *  target session's ChatPane once the message stream holds the target
   *  message (openTab's history prefetch is async); cleared without jumping
   *  when the history is loaded but the message is gone (stale bookmark /
   *  truncated by an edit-resend). Not persisted. */
  pendingBookmarkJump: {
    sessionId: string;
    messageId: string;
    excerpt?: string;
  } | null;

  /* ── IDE right-panel state ──
   *  Editor state (open files, active file, view mode, expanded tree dirs)
   *  is PER-PROJECT: switching to project B shows B's open files, and
   *  switching back to A restores A's. This mirrors the per-session bucket
   *  pattern (messagesBySession, todosBySession). Keyed by projectId.
   *
   *  A few IDE prefs remain global (not per-project) because they express a
   *  user preference, not project state: rightPanelTab, ideEditorMode,
   *  ideFocusNonce. */
  /** Active tab in the right panel. Persisted so reopening the app restores
   *  the last-used inspector. Only "files" is implemented in P4; the other
   *  three round-trip for forward-compat. */
  rightPanelTab: RightPanelTab;
  /** 每「要求」一次内置页签就 +1(哪怕值没变)。session-only。右栏上正开着一个
   *  **自定义页签**时,别处代码调 `setRightPanelTab`(左栏单击文件 → 预览、工作流起跑 →
   *  运行看板……)意思是「把那个面板摆到用户眼前」,自定义页签得让位 ——
   *  `customUiStore` 订阅这个数来清掉它。只看 `rightPanelTab` 不够:值常常没变。 */
  rightPanelTabSeq: number;
  /** Per-project terminal quick-commands. Outer key = projectId, value = that
   *  project's saved commands. Persisted as a JSON object (keyed by projectId)
   *  in the settings table; read/written by the terminal toolbar's commands
   *  menu and the settings → terminal panel. */
  customCommandsByProject: Record<string, CustomCommand[]>;
  /** Per-project ordered list of absolute file paths open in the Monaco
   *  editor area. Drives the OpenTabsBar. Persisted as a JSON object keyed
   *  by projectId. */
  ideOpenFilesByProject: Record<string, string[]>;
  /** Optional per-project labels for open file tabs, keyed by real file path.
   *  Falls back to the path basename when absent; labels are session-only. */
  ideFileDisplayNamesByProject: Record<string, Record<string, string>>;
  /** Per-project currently-active file (member of the project's open list,
   *  or null). Persisted as a JSON object keyed by projectId. */
  ideActiveFileByProject: Record<string, string | null>;
  /** Per-project per-file view mode ("diff" shows before-vs-current; "edit"
   *  is the normal editor). Outer key = projectId, inner key = filePath.
   *  NOT persisted — resets each session, since the `before` snapshot only
   *  exists for the latest turn anyway. */
  ideFileViewModeByProject: Record<string, Record<string, FileViewMode>>;
  /** How opening a file affects the open-file list:
   *   - "tabs"    (default): each file accumulates as a tab.
   *   - "replace": opening a file replaces whatever was open (≤1 file at a
   *     time). Persisted in the settings table. Global (not per-project). */
  ideEditorMode: IdeEditorMode;
  /** Where a git-diff click opens the diff viewer:
   *   - "center"  (default): center-area Monaco editor (existing behavior).
   *   - "dialog": a floating modal dialog with multiple diff tabs.
   *  Persisted in the settings table. Global (not per-project). */
  gitDiffOpenMode: GitDiffOpenMode;
  /** Diff tabs currently open in the Git diff dialog (the "dialog" open-mode).
   *  Ephemeral (NOT persisted) - restarting clears them. Dedup by file path. */
  gitDiffDialogTabs: GitDiffDialogTab[];
  /** Active tab id in the Git diff dialog, or null when none. Ephemeral. */
  gitDiffDialogActiveId: string | null;
  /** Whether the Git diff dialog is currently shown. Closing it keeps the
   *  tabs; the Git panel toolbar button re-opens it. Ephemeral. */
  gitDiffDialogOpen: boolean;
  /** How the Git diff dialog presents its open diff files:
   *   - "tabs"   (default): show a top tab strip + the left file list.
   *   - "single": hide the tab strip; navigate via the left file list only.
   *  Ephemeral (NOT persisted) - restarting resets to "tabs". */
  gitDiffDialogViewMode: "tabs" | "single";
  /** Per-project absolute directory paths expanded in the file tree.
   *  Persisted as a JSON object keyed by projectId so each project's tree
   *  re-opens to where the user left it. */
  ideExpandedDirsByProject: Record<string, string[]>;
  /** Per-project per-file git diff pair for the center Monaco DiffEditor.
   *  - Working-tree clicks stash `{ before }` only → DiffPane reads disk as after.
   *  - History clicks stash `{ before, after }` → DiffPane uses both blobs (no disk).
   *  Ephemeral (NOT persisted). Outer key = projectId, inner key = abs filePath. */
  gitDiffByProject: Record<string, Record<string, { before: string; after?: string }>>;
  /** Per-project per-file "open-as-diff" before-snapshot override. When a
   *  turn-files card opens a file for review it passes the card's frozen
   *  `before` (works for HISTORICAL turns too, whose snapshot is gone from
   *  turnFilesBySession). FileEditor uses this as a fallback diff source.
   *  Ephemeral (NOT persisted) - a stale before is harmless: the worst case
   *  is an outdated left pane until the user closes the file. */
  ideDiffBeforeByProject: Record<string, Record<string, string>>;
  /** Custom-model id used for git-commit-message generation, or null for
   *  built-in. Persisted in the settings table. */
  commitGenModel: string | null;
  /** Prompt template for commit-message generation. Persisted. Empty = use
   *  the built-in default (defined in the main-process handler). */
  commitGenPrompt: string;
  /** Custom-model id used for AI git-conflict resolution, or null for the
   *  built-in model. Stored as `"configId:roleKey"`. Persisted in the settings
   *  table; independent of commitGenModel so the two can use different models. */
  conflictResolveModel: string | null;
  /** Whether auto thread-title generation is enabled. When true, the main
   *  process fires a one-shot LLM call on a session's first user message to
   *  generate a short Chinese title. Persisted in the settings table. */
  titleGenEnabled: boolean;
  /** Custom-model id used for auto thread-title generation, or null for the
   *  built-in model. Stored as `"configId:roleKey"`. Persisted in the settings
   *  table; independent of the other gen models. */
  titleGenModel: string | null;
  /** Selected Claude output style name (built-in id or custom style name), or
   *  null = never configured → the CLI default style. Persisted in the
   *  settings table; injected per-turn by the Claude provider. */
  outputStyle: string | null;
  /** Per-repo collapsed state in the Git panel. Persisted in the settings
   *  table as a JSON-encoded Record<string, boolean>. */
  collapsedGitRepos: Record<string, boolean>;
  /** Monotonically-increasing counter bumped whenever something requests the
   *  right panel's attention (e.g. the 审查 button on a turn-files card).
   *  App.tsx watches this via effect and opens the panel if collapsed —
   *  decoupling the store (which can't reach into App's local state) from
   *  the visibility toggle. */
  ideFocusNonce: number;

  /** Pending "reveal in file tree" target — set by the turn-files card's
   *  定位到工作树 button. FileTree expands the target's ancestor dirs and
   *  scrolls it into view whenever this object's identity changes (the nonce
   *  makes every request a new object, like ideRevealNonce). Not
   *  consumed/cleared — the effect only reacts to change, a stale value is
   *  inert. Not persisted. */
  ideTreeReveal: { filePath: string; nonce: number } | null;

  /** Pending goto-definition reveal target. When non-null, the EditPane for
   *  `filePath` should scroll to (line, column) and place the caret there on
   *  mount/nonce-bump, then clear this. Driven by `openFileInIde` line/col. */
  idePendingReveal: { filePath: string; line: number; column: number } | null;
  /** Monotonic counter bumped whenever idePendingReveal is set, so an
   *  already-mounted EditPane re-runs its reveal effect. */
  ideRevealNonce: number;

  /** Per-project editor navigation-history BACK stack (Alt+←). Each entry is
   *  a location the user navigated AWAY from (goto-definition invocation,
   *  file switch). Ephemeral — NOT persisted; resets each session. */
  navBackByProject: Record<string, NavEntry[]>;
  /** Per-project editor navigation-history FORWARD stack (Alt+→). Filled by
   *  navigateBack (the location left behind), cleared by any new push. */
  navForwardByProject: Record<string, NavEntry[]>;

  /** Language server states, hydrated from `api.lsp.list()` in initDeferred.
   *  Empty array until first load completes. Not persisted (re-fetched each
   *  startup from the main process). */
  lspLanguages: LspLanguageState[];

  /** Agent runtime states (claude/codex/pi download-on-demand), hydrated
   *  lazily when the settings panel mounts. Empty until first load. Not
   *  persisted. Install progress merges in from `runtimes:event` pushes. */
  runtimes: RuntimeAgentState[];

  /** Language-server lifecycle phase per `${workspacePath}::${language}`,
   *  driven by `lsp:event` stateChanged pushes (see LspStateChangedPayload).
   *  The editor toolbar reads it to show a loading pill while a server starts
   *  and a failure notice when it couldn't start. Ephemeral. */
  lspPhasesByWorkspace: Record<string, { phase: "starting" | "running" | "stopped" | "importing"; error?: string; detail?: string }>;

  /** True once `init()` has started - guards against React StrictMode's
   *  double-effect in dev firing init twice. */
  _initStarted: boolean;

  // actions
  init: () => Promise<void>;
  /** Deferred (non-critical) hydration kicked off by `init()` after the
   *  first-paint essentials are done. Loads health-check, custom models,
   *  appearance extras, and IDE/git panel prefs - none of which are needed
   *  for the first visible frame. */
  initDeferred: () => Promise<void>;
  addProjectFromFolder: () => Promise<string | null>;
  selectProject: (projectId: string) => Promise<void>;
  toggleProjectExpanded: (projectId: string) => void;
  /** Flip a project's left-bar view between local threads and worktree
   *  groups (drives the project row's fork toggle). */
  setProjectWorktreeView: (projectId: string, on: boolean) => void;
  /** Toggle a worktree group node's expanded state in the left-bar tree
   *  (keyed by raw worktree path; normalized internally). */
  toggleWorktreeExpanded: (worktreePath: string) => void;
  /** Set (or clear, empty name) the left-bar display name for a worktree
   *  directory. Optimistic local patch + fire-and-forget settings write. */
  renameWorktree: (worktreePath: string, name: string) => Promise<void>;
  setArchivedViewOpen: (open: boolean) => void;
  /** Fetch the next page of active sessions for a project and append it to
   *  `sessionsByProject[projectId]`. No-op when there are no more to load. */
  loadMoreSessions: (projectId: string) => Promise<void>;
  /** (Re)fetch a project's worktree-bound threads in full and merge them into
   *  the cache's worktree section (local section untouched). A directory
   *  holds few threads, so this is unpaginated (capped well beyond realistic
   *  use). Fired on init, project expand and project selection; the
   *  `session.changed` reducer maintains the section incrementally in
   *  between. No-op when the project's cache isn't loaded (init brings both
   *  sections together). */
  loadWorktreeSessions: (projectId: string) => Promise<void>;
  startSession: (projectId?: string, overrides?: { providerId?: string; model?: string; customModelId?: string | null; worktreePath?: string; /** Force the working-environment intent (bypasses the composer's env chip — e.g. a conflict-resolution session must stay in the real checkout). */ envMode?: "local" | "worktree" }) => Promise<void>;
  /** 把一段对话复制成新的一段(带着一模一样的历史与上下文)。`title` 由调用方给 ——
   *  新对话叫什么是一句界面文案,主进程那侧没有 i18n。 */
  forkSession: (sessionId: string, title: string) => Promise<void>;
  /** Move a FRESH local session to a different project (the directory
   *  switcher in the new-session composer panel). Main-side guards reject
   *  anything that already started (messages / materialized worktree / bad
   *  target); the renderer caches migrate only after the IPC accepts. */
  moveSession: (sessionId: string, toProjectId: string) => Promise<void>;
  /** Switch the active session (and load its history if not cached).
   *  Always replaces the center pane content. In `single` displayMode
   *  this is the only navigation primitive; in `tabs` mode it's used
   *  by SessionTabs to flip between already-open tabs. */
  selectSession: (sessionId: string) => Promise<void>;
  /** Open a session as a tab. If it's already in `openTabs` this is a
   *  no-op except for the activeSessionId flip; otherwise it's appended
   *  to the end of the list. This is the LeftBar's "click a thread"
   *  entry point in both display modes — the difference is purely
   *  cosmetic (single mode hides the tab strip, tabs mode shows it). */
  openTab: (sessionId: string) => Promise<void>;
  /** Load a session's first page of persisted messages WITHOUT activating
   *  it. Used for hover-prefetch from the sidebar so that by the time the
   *  click lands the bucket is already warm (or in flight) and the center
   *  pane swaps in with content instead of a blank frame. No-op when the
   *  bucket exists or a fetch is already running. */
  prefetchSessionMessages: (sessionId: string) => Promise<void>;
  /** Fetch the next page of older messages for a session and prepend them.
   *  No-op when nothing more is available or a fetch is already in flight. */
  loadOlderMessages: (sessionId: string) => Promise<void>;
  /** Remove a session from the tab strip. If it was the active tab,
   *  focus shifts to the previous one (or the next, if there is no
   *  previous); running turns are NOT cancelled — they keep streaming
   *  in the background and the user can re-open the tab to see them. */
  closeTab: (sessionId: string) => void;
  /** Reorder the tab strip by moving the tab at `from` to index `to`.
   *  Pure order shuffle: activeSessionId is untouched, config sync is
   *  unaffected (it keys off the session row, not tab order), and the
   *  order is not persisted (openTabs is in-memory only). */
  reorderTab: (from: number, to: number) => void;
  deleteProject: (id: string) => Promise<void>;
  /** 重拉项目列表并与本地做差异合并:新出现的项目补上会话列表,消失的项目
   *  连同它的会话 / 标签 / 编辑器桶一起清掉,其余行(改名 / 归档 / 置顶 / 分组 /
   *  排序)整体换成服务端那份。`projects.changed` 事件和断线补齐都走这里。 */
  refreshProjects: () => Promise<void>;
  /** 手机 SSE 重连之后补齐断开期间漏掉的东西:项目列表、已加载项目的会话列表、
   *  置顶列表,以及每个已缓存会话的消息(不在跑的立刻从库里重拉;在跑的等它这一轮
   *  结束再拉)。只由网页壳调用(见 `AppMobile` 的 `onSseResync`)。 */
  resyncAfterReconnect: () => Promise<void>;
  /** 用库里最新一页替换某个会话的消息(库为准),只保留比这一页更早的、已经
   *  上翻加载过的消息。会话正在跑时不动。 */
  resyncSessionMessages: (sessionId: string) => Promise<void>;
  archiveProject: (id: string, archived: boolean) => Promise<void>;
  /** Assign a project to a group (left-bar "grouped" view). Pass null to
   *  remove it from any group. */
  setProjectGroup: (id: string, group: string | null) => Promise<void>;
  /** Rename a project (display-only; the on-disk folder is untouched). The
   *  returned project replaces the stale copy in state. */
  renameProject: (id: string, name: string) => Promise<void>;
  /** Pin/unpin a project. Pinning MOVES the row: out of the flat list / its
   *  group and into the pinned section above the left bar's project tree
   *  (most recent pin first); unpinning returns it to its drag-order spot.
   *  Refetches the whole list afterwards — the row's position changes, and
   *  the DB's ordering is the single source of truth for it. */
  setProjectPinned: (id: string, pinned: boolean) => Promise<void>;
  /** Persist a drag-to-reorder. `orderedIds` is the full visible project id
   *  list in the new order. */
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  /** Rename a session (persist a user-edited title). Updates the row in
   *  `sessionsByProject` if it's in the loaded page slice, so the left bar
   *  + tab strip reflect the new title immediately. The store does NOT trim
   *  the title - the caller should pass a non-empty trimmed string. */
  renameSession: (id: string, title: string) => Promise<void>;
  /** Pin/unpin a session within its project (project-scoped: pinned sessions
   *  sort to the top of the project's session list). Persists via IPC, patches
   *  the cached row with the server-fresh copy, then re-sorts the project's
   *  loaded window so pinned rows float to the top immediately. */
  setSessionPinned: (id: string, pinned: boolean) => Promise<void>;
  /** Add a message bookmark (message-level anchor + display excerpt).
   *  Optimistically updates the per-session bucket (the fly-to-capsule
   *  animation needs instant feedback), persists the full list via IPC, and
   *  rolls the bucket back if the write fails. */
  addBookmark: (
    sessionId: string,
    bookmark: { messageId: string; excerpt: string; role: "user" | "assistant" },
  ) => Promise<void>;
  /** Remove a bookmark by id (same optimistic-then-persist flow as
   *  {@link addBookmark}). */
  removeBookmark: (sessionId: string, bookmarkId: string) => Promise<void>;
  /** Set a bookmark's user-defined display name. Empty/whitespace title
   *  clears the rename (lists fall back to the excerpt). The excerpt is
   *  never rewritten — it anchors the jump's precise text highlight. Same
   *  optimistic-then-persist flow as {@link removeBookmark}. */
  renameBookmark: (sessionId: string, bookmarkId: string, title: string) => Promise<void>;
  /** Apply a title update pushed from main (auto title-gen). Patches the
   *  in-memory session lists directly - the DB row is already updated by the
   *  main process, so no IPC round-trip. Mirrors renameSession's patching. */
  applySessionTitleUpdate: (sessionId: string, title: string) => void;
  /** 往正在跑的那一轮里塞一句话(生成过程中插话)。返回"送出去了没有" —— `false`
   *  的三种情形(没在跑 / 引擎不支持 / 刚好收尾)要求调用方**兜回 `sendPrompt`**。 */
  injectPrompt: (sessionId: string, text: string) => Promise<boolean>;

  sendPrompt: (
    prompt: string,
    attachments?: { preview: string; content: string; attachmentKind?: "paste" | "file" | "quote"; filePath?: string }[],
    /** Text shown in the user message's text block. Defaults to `prompt`,
     *  but when attachments are present the caller passes just the typed
     *  text (without the inlined attachment content) so the card + text
     *  don't duplicate the same payload. The full `prompt` (with
     *  attachments inlined) is still what gets sent to the SDK. */
    displayText?: string,
    /** Names of skill pills embedded inline in the text (for stream rendering
     *  — the Markdown renderer turns the matching `/name` occurrences into
     *  styled pills). Absent for plain-text messages. */
    skillsUsed?: string[],
    /** User-attached images (downsized base64 content blocks). Rendered as
     *  image blocks on the user message and inlined into the provider request.
     *  An image-only turn passes an empty `prompt`. */
    images?: PromptImage[],
    /** Rich blocks for the user bubble, replacing the default single text
     *  block. The plan handoff uses this to render "note + plan card" instead
     *  of dumping the raw kickoff prompt — `prompt` still carries the full
     *  text to the model. Absent for ordinary typed messages. */
    displayBlocks?: Block[],
    /** Explicit target session. Defaults to the global activeSessionId; the
     *  side-chat pane passes ITS own sessionId so its sends never leak into
     *  the foreground main session (and vice versa). */
    sessionId?: string,
  ) => Promise<boolean>;
  /** Resolves true when the prompt was accepted into the stream (the caller
   *  may then clear the composer), false when a guard blocked it (no session,
   *  session running, or the "尚未配置模型" dialog was raised — in which case
   *  the caller should keep the composer's input so nothing is lost). */
  /** Edit a previously-sent user message in place and resend it. Truncates
   *  the session's message history at the target message (removing it and
   *  everything after it - including the AI's reply), persists the
   *  truncated history, then sends the edited prompt as a fresh user
   *  message. The session must NOT be running when this is called.
   *
   *  `images` is the surviving image list from the inline editor (empty
   *  array = the user deleted them all). When omitted, the original
   *  message's images are preserved verbatim.
   *
   *  Takes an explicit `sessionId` (not activeSessionId) so it works
   *  correctly across multiple open tabs. */
  editAndResendMessage: (
    sessionId: string,
    messageId: string,
    newPrompt: string,
    attachments?: { preview: string; content: string; attachmentKind?: "paste" | "file" | "quote"; filePath?: string }[],
    displayText?: string,
    skillsUsed?: string[],
    images?: PromptImage[],
  ) => Promise<void>;
  interrupt: (sessionId?: string) => Promise<void>;
  ingestEvent: (e: RuntimeEvent) => void;
  /** Update the window-focus flag. Called from useClaudeEvents on Electron
   *  `window:focusChanged` + `document.visibilitychange`. When the window
   *  regains focus, the active session's unread counter is cleared (the user
   *  is looking at it now). */
  setWindowFocused: (focused: boolean) => void;
  setSettingsOpen: (open: boolean, section?: string, focusWorkflowId?: string) => void;
  /** Toggle the "尚未配置模型" dialog open/closed (send-time guard). */
  setModelConfigPromptOpen: (open: boolean) => void;
  /** Toggle the Cmd/Ctrl+K command palette open/closed. */
  setCommandPaletteOpen: (open: boolean) => void;
  /** Toggle the file search dialog open/closed. Opened from the Files panel
   *  search button, the `files.search` command, or the Cmd/Ctrl+Shift+F
   *  global hotkey. NOT persisted (pure in-memory, like the command palette). */
  setSearchDialogOpen: (open: boolean) => void;
  /** Toggle the left sidebar open/closed (direct set). NOT persisted. */
  setLeftOpen: (open: boolean) => void;
  /** Toggle the right IDE panel open/closed (direct set). NOT persisted. */
  setRightOpen: (open: boolean) => void;
  /** Toggle the bottom terminal bar open/closed (direct set). NOT persisted. */
  setBottomTerminalOpen: (open: boolean) => void;
  /** Toggle the browser panel open/closed (direct set). NOT persisted. */
  setBrowserPanelOpen: (open: boolean) => void;
  /** Enter/exit wide-panel (3:7) mode. Entering hides the left sidebar + closes
   *  any open browser overlay and snapshots the pre-enter layout; exiting
   *  restores leftOpen / rightOpen / rightWidth from that snapshot. */
  setWidePanelOpen: (open: boolean) => void;
  /** Apply an incremental delta to the wide-panel percentage (the right
   *  panel's share of the chat|right split). Divider sits left of the right
   *  column, so a right drag (positive delta) shrinks it — same sign convention
   *  as adjustEditorWidthPct. */
  adjustWidePanelPct: (deltaPx: number) => void;
  /** Reset the wide-panel split to the default 3:7 (double-click on divider). */
  resetWidePanelPct: () => void;
  /** Set the browser device-toolbar visibility (DevTools-style bar under the
   *  address bar). NOT persisted. */
  setBrowserDeviceToolbarOpen: (open: boolean) => void;
  /** Update the open-browser-tab count (drives the Titlebar badge). */
  setBrowserTabCount: (count: number) => void;
  /** Replace the whole browser-tabs list (shared sidebar/overlay state). */
  setBrowserTabs: (tabs: BrowserTab[]) => void;
  /** Set the active browser tab id. */
  setBrowserActiveTabId: (id: string | null) => void;
  /** Increment/decrement the browser-view suppression counter. While > 0 the
   *  active WebContentsView is hidden so renderer-DOM overlays (image lightbox,
   *  etc.) can cover it. Call `suppressBrowserView(false)` in a cleanup to
   *  restore. NOT persisted. */
  suppressBrowserView: (suppressed: boolean) => void;
  /** Append a new browser tab. */
  addBrowserTab: (tab: BrowserTab) => void;
  /** Remove a browser tab by its renderer-local id; returns nothing. */
  removeBrowserTab: (id: string) => void;
  /** Patch one browser tab by its main-process browserId. */
  patchBrowserTab: (browserId: string, patch: Partial<BrowserTab>) => void;
  /** Open the browser sidebar and load `url` (a fully-qualified URL such as a
   *  `file://` path) into the active tab. If no tab exists yet, the URL is
   *  stashed as `pendingBrowserUrl` and loaded once BrowserPanel creates its
   *  first tab. */
  openUrlInBrowser: (url: string) => void;
  /** Adopt a browser view created by an agent tool (not by BrowserPanel's
   *  createTab) into the renderer's tab list, so BrowserPanel's show/hide/
   *  bounds logic can manage it. Idempotent: if a tab for this browserId
   *  already exists, just updates its url/title/device and activates it. */
  adoptAgentBrowserTab: (
    browserId: string,
    info: {
      url?: string;
      title?: string;
      device?: BrowserDevicePreset;
      orientation?: BrowserOrientation;
    },
  ) => boolean;
  /** Apply an incremental delta (in percentage points of the window width) to
   *  the left sidebar share (clamped, then a debounced DB write). The caller
   *  converts the divider's px delta via the container width. */
  adjustLeftWidthPct: (deltaPct: number) => void;
  /** Apply an incremental delta to the right panel width. */
  adjustRightWidth: (deltaPx: number) => void;
  /** Apply an incremental delta to the bottom terminal height. */
  adjustBottomTerminalHeight: (deltaPx: number) => void;
  /** Apply an incremental delta to the editor-column percentage. The delta
   *  is in px; the caller converts to pct via the container width. */
  adjustEditorWidthPct: (deltaPx: number) => void;
  /** Reset a pane width to its default (double-click on the divider). */
  resetLeftWidthPct: () => void;
  resetRightWidth: () => void;
  resetBottomTerminalHeight: () => void;
  resetEditorWidthPct: () => void;
  /** Update the center-pane display mode. Persists to the `settings`
   *  table so the choice survives restart. */
  setDisplayMode: (mode: DisplayMode) => Promise<void>;
  /** Toggle multi-row tab wrapping for the center tab strips. Instant
   *  local flip + fire-and-forget persistence (same pattern as
   *  setDisplayMode). */
  setTabBarMultiRow: (on: boolean) => void;
  /** Switch the left-bar view between the project tree and the session
   *  stream. Instant local flip + fire-and-forget persistence (same
   *  pattern as setDisplayMode). */
  setLeftBarMode: (mode: LeftBarMode) => Promise<void>;
  /** Switch the UI theme style (classic ↔ sketch). Instant local flip +
   *  fire-and-forget persistence; the `.sketch` class application reacts
   *  via useThemeStyle (lib/appearance.ts). */
  setThemeStyle: (style: ThemeStyle) => void;
  /** Set the stream sidebar's project scope filter. Persists under
   *  `ui.streamScope` so the selection survives remounts and relaunches. */
  setStreamScope: (scope: string | null) => void;
  /** (Re)fetch the stream sidebar's aggregate first page. No-op when the
   *  cache is warm and clean; `reset` forces a refetch. */
  loadStreamSessions: (reset?: boolean) => Promise<void>;
  /** Append the next aggregate page to `streamSessions`. No-op when
   *  `streamHasMore` is false. */
  loadMoreStreamSessions: () => Promise<void>;
  /** Refresh `worktreeInfoByRepo[repoPath]` when its gitChangeVersion is
   *  newer than the cached entry (or nothing is cached). Cheap to call —
   *  a warm, current cache is a pure no-op. */
  ensureWorktreeInfo: (repoPath: string) => Promise<void>;
  /** Switch the unified center tab bar's focus (tabs displayMode) between
   *  the chat view and the editor view. Most flips flow through natural
   *  actions (selectSession / openFileInIde / setIdeActiveFile / ...);
   *  this is the direct escape hatch for chrome that toggles the view. */
  setCenterTabFocus: (focus: "chat" | "editor") => void;
  /** Update the UI language. Persists to the `settings` table so the
   *  choice survives restart; translated components re-render live. */
  setLocale: (locale: Locale) => Promise<void>;
  /** Update the session auto-archive rules. Persists to the `settings`
   *  table; the main-process AutoArchiver picks the change up on its next
   *  tick. */
  setAutoArchiveConfig: (config: AutoArchiveConfig) => Promise<void>;
  /** Update the chat message-stream density. Persists to the `settings`
   *  table so the choice survives restart. */
  setChatDensity: (mode: ChatDensity) => Promise<void>;
  /** Toggle the left-bar project view between flat and grouped. Persists
   *  to the `settings` table so the choice survives restart. */
  setProjectView: (mode: ProjectView) => Promise<void>;
  /** Set a group's color ("R G B" triplet or null for default). */
  setGroupColor: (name: string, rgb: string | null) => void;
  /** Set / clear a project's custom avatar color (new-session panel's
   *  manage menu). null falls back to the name-hash default. */
  setProjectColor: (id: string, hex: string | null) => void;
  /** Persist a new group order (full ordered name list). */
  setGroupOrder: (orderedNames: string[]) => void;
  /** Migrate group metadata when a group is renamed. */
  renameGroupMeta: (oldName: string, newName: string) => void;
  /** Write the current groupMeta to the settings blob. */
  persistGroupMeta: (meta: ProjectGroupsMeta) => void;
  /** Update the chat content font size (clamped to 12–20 px). Persists to
   *  the `settings` table. */
  setChatFontSize: (px: number) => Promise<void>;
  /** Update the right-panel base font size (clamped to 10–22 px). Persists
   *  to the `settings` table. */
  setRightPanelFontSize: (px: number) => Promise<void>;
  /** Update the paste-to-card threshold (clamped to 50–5000 chars). Persists
   *  to the `settings` table. */
  setPasteTagThresholdChars: (n: number) => Promise<void>;
  /** 改工作流并发上限(见 `workflowMaxParallel`)。钳制后落盘,主进程下次派发生效。 */
  setWorkflowMaxParallel: (n: number) => Promise<void>;
  /** Re-check whether a voice model is selected AND downloaded
   *  (`voice.modelList` rescans disk) and update `voiceModelReady`. */
  refreshVoiceModelStatus: () => Promise<void>;
  /** Set the default speech-recognition language tag ("zh-CN" | "en-US"). */
  setVoiceLang: (lang: string) => Promise<void>;
  /** Set the preferred ASR engine ("zipformer" | "parakeet"). */
  setVoiceEngine: (engine: VoiceEngine) => Promise<void>;
  /** Cache the mic-permission outcome ("granted" | "denied" | ""). */
  setVoiceMicPermission: (perm: string) => Promise<void>;
  /** Set the user-selected local ASR model directory (absolute path). */
  setVoiceModelDir: (dir: string) => Promise<void>;
  /** Update the user-message background color (R G B triplet, or null =
   *  theme default). Persists to the `settings` table. */
  setUserMessageColor: (rgb: string | null) => Promise<void>;
  /** Set the global brand/accent color ("R G B" triplet, or null for the
   *  theme default). Persists to the `settings` table. */
  setAccentColor: (rgb: string | null) => Promise<void>;
  /** Set the Monaco editor color scheme for one app mode ("dark"|"light").
   *  The whole per-mode choice persists to the `settings` table as one JSON
   *  blob; mounted editors re-render live via useMonacoTheme(). */
  setEditorTheme: (mode: "dark" | "light", id: EditorThemeId) => Promise<void>;
  /** Bind (or rebind) a keyboard shortcut for `commandId`. Pass `null` to
   *  clear the override and fall back to the compiled-in default. Persists
   *  the whole override map to the `settings` table as one JSON blob. */
  setShortcutOverride: (commandId: string, accel: Accelerator | null) => void;
  /** Clear every shortcut override, restoring all defaults. Persists. */
  resetAllShortcuts: () => void;
  /** True while the shortcut recorder is capturing a chord. The global
   *  keydown listener checks this to suppress dispatch (otherwise pressing
   *  a bound chord mid-recording would both record it AND fire its command). */
  shortcutRecording: boolean;
  setShortcutRecording: (recording: boolean) => void;
  /** Mouse-gesture settings (enabled / trigger button / binding overrides).
   *  Persisted as one JSON blob under `ui.gestures`; hydrated in
   *  initDeferred. Overrides-only, mirroring shortcutOverrides. */
  gestureSettings: GestureSettings;
  /** Bind (or rebind) a mouse gesture for `commandId`. Pass `null` to clear
   *  the override and fall back to the compiled-in default. Persists the
   *  whole settings blob. */
  setGestureOverride: (commandId: string, seq: GestureSequence | null) => void;
  setGestureEnabled: (enabled: boolean) => void;
  setGestureTrigger: (trigger: "right" | "middle") => void;
  /** Clear every gesture override, restoring all defaults. Persists. */
  resetAllGestures: () => void;
  /** The commandId whose gesture is being re-recorded in the settings panel,
   *  or null. The global gesture listener stands down while this is set so a
   *  captured stroke records instead of dispatching. */
  gestureRecording: string | null;
  setGestureRecording: (commandId: string | null) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  /** 给**当前会话**选一个工作流(输入框那个选择器)。像模型 / 权限一样存到会话行上。
   *  ⚠️ id 是**开放字符串** —— 内置六个之外,用户自建的工作流(`wf_` 前缀)也走这条路。 */
  setWorkflowId: (workflowId: string) => void;
  /** Pick the working-environment chip. When the ACTIVE session is an
   *  un-materialized intent, the choice edits THAT session's envMode + wtStyle
   *  (updateSettings) instead of the global default — the chip reads as
   *  "this thread's environment" until the first turn locks it. Otherwise
   *  (local/absent/materialized sessions) it sets the persisted default for
   *  NEW sessions. */
  setEnvChoice: (choice: EnvChoice) => void;
  /** Switch the provider for the NEXT session (no effect once a session has
   *  messages — a session's provider is fixed at creation). */
  setProvider: (id: string) => void;
  /** Re-fetch the registered provider list from main. Called on init. */
  reloadProviders: () => Promise<void>;
  refreshProviderHealth: (providerId: string, options?: { force?: boolean }) => Promise<void>;
  /** Re-fetch the list of models the pi SDK can authenticate with the
   *  currently-configured keys. Populates `piAvailableModels` (read by
   *  ModelDropdown when the active provider is pi-sdk). Called on init and
   *  after any PiModelsPanel save/delete. */
  reloadPiAvailableModels: () => Promise<void>;
  reloadCodexAvailableModels: () => Promise<void>;
  setModel: (model: string) => void;
  setEffort: (effort: EffortLevel) => void;
  setCustomModel: (id: string | null, model?: string) => void;
  reloadCustomModels: () => Promise<void>;
  /** Re-fetch language server states from main. Called on init and after any
   *  lsp mutation (install/toggle/setPath). Best-effort; failures are logged
   *  and leave the existing state. Also re-applies the TS-Worker diagnostic
   *  suppression when the typescript server is enabled. */
  reloadLspLanguages: () => Promise<void>;
  /** Kick off the active project's Java server in the background
   *  (LspManager.prewarm): the one-time Maven/Gradle import then runs while
   *  the user browses instead of blocking the first Java file they open.
   *  No-op when java is disabled / no active project / on web. Main-side
   *  ensureServer is idempotent, so repeated calls are cheap. */
  prewarmJavaLspForActiveProject: () => void;
  /** Re-fetch the agent runtime states (claude/codex/pi) from main. Called
   *  when the settings panel mounts and after install/remove finishes. */
  reloadRuntimes: () => Promise<void>;
  /** Merge one `runtimes:event` progress payload into `runtimes` (in-flight
   *  progress / done / error) without a full re-list. No-op when the panel
   *  hasn't loaded yet. */
  applyRuntimeProgress: (payload: RuntimeProgressPayload) => void;
  /** Re-fetch the skill list for the active project from main (scans
   *  ~/.claude/skills + the project's .claude/skills). Safe to call anytime;
   *  no-op silently when there is no active project. */
  reloadSkills: () => Promise<void>;
  dismissQuestion: () => void;
  /** Submit answers to the head AskUserQuestion for the active session.
   *  Calls `claude:respondQuestion` which resolves the provider's pending
   *  user-input Deferred — the SAME turn then continues (the model receives
   *  the answers and proceeds). This is the correct path: it does NOT start
   *  a new turn. For sentinel-fallback requests (no Deferred), main composes
   *  the answers into a prompt and starts a follow-up turn itself. */
  submitQuestion: (
    answers: UserInputAnswers,
    /** Owning session; defaults to the global activeSessionId. The side-chat
     *  pane passes its own id so answering ITS question doesn't resolve the
     *  foreground session's pending card. */
    sessionId?: string,
  ) => Promise<void>;
  /** Approve or deny the head of the approval queue. Called by the
   *  composer overlay; resolves the matching canUseTool on the main side
   *  and shifts the head off. If the queue has more items, the next one
   *  auto-promotes. */
  decideApproval: (requestId: string, granted: boolean, always?: boolean) => Promise<void>;
  /** Submit the user's approve/reject decision on a pending ExitPlanMode
   *  plan. Resolves the provider's pending plan-approval Deferred via
   *  `claude:respondPlanApproval` so the SAME turn continues — approve →
   *  SDK exits plan mode and starts executing; reject → SDK stays in plan
   *  mode and the model can revise. On success the pending card clears;
   *  on IPC failure it stays so the user can retry. */
  submitPlanApproval: (requestId: string, approved: boolean, editedPlan?: string, reason?: string, feedback?: string) => Promise<void>;
  /** Hand a pending plan approval to a different executor instead of
   *  approving in place. "remodel" interrupts the blocked turn, rebinds this
   *  session's model, and fires the plan as a fresh turn in the same thread;
   *  "newSession" interrupts it and creates a new session (optionally another
   *  SDK) seeded with the plan as its first prompt. The pending ExitPlanMode
   *  dialog is never answered — the turn is aborted, so no request.resolved
   *  event will arrive and the local pending state is cleared here. Must run
   *  from the foreground tab (config-slot rebind + sendPrompt are
   *  active-session scoped). */
  handoffPlanApproval: (sessionId: string, requestId: string, target: PlanHandoffTarget, feedback?: string) => Promise<void>;
  /** Open a plan tab in the editor column for a session, showing the given
   *  plan markdown. Activates the plan tab (planTabActive = true). Called
   *  when the user clicks a plan card or a plan title in the activity
   *  popover. Ephemeral view state (not persisted). */
  openPlanDrawer: (sessionId: string, plan: string) => void;
  /** Open the mobile shell's fullscreen viewer (file / diff / plan). No-op
   *  target routing on the desktop shell — nothing consumes it there. */
  openMobileViewer: (target: MobileViewerTarget) => void;
  /** Close the mobile shell's fullscreen viewer. */
  closeMobileViewer: () => void;
  /** Close the plan tab for a session (removes the plan text entirely). */
  closePlanDrawer: (sessionId: string) => void;
  /** Set whether the plan tab is the active tab in the editor column. When
   *  true the editor shows PlanViewer; when false it shows the active file.
   *  Does NOT clear the plan text - the plan tab stays in the tab bar. */
  setPlanTabActive: (sessionId: string, active: boolean) => void;
  /** Stage an edited plan draft (from the Monaco editor) for a pending
   *  ExitPlanMode approval. PlanApprovalPrompt reads this as its initial
   *  draft so edits made in the editor flow back to the approval sheet
   *  without auto-approving. */
  setPlanApprovalDraft: (sessionId: string, draft: string) => void;
  /** Update the plan text shown in the plan tab (PlanViewer). For historical
   *  (already-frozen) plan edits this updates the local view model only - it
   *  does NOT rewrite the frozen message-stream block or persist. */
  updatePlanDrawerPlan: (sessionId: string, plan: string) => void;
  /** Rewind the most recent turn: restore all files Edit/Write touched
   *  to their pre-turn state. The IPC call returns the list of restored
   *  paths; we leave the UI state update to the `turn.rewound` event
   *  that main emits after restore completes (single source of truth
   *  for "files are back"). The call is fire-and-await; failures log
   *  to console and leave state untouched so the user can retry.
   *
   *  `targetFiles` (the requested path set) is forwarded to main so the
   *  `turn.rewound` event carries it; the handler then marks the matching
   *  card `rewound: true` in place — for both latest-turn and historical
   *  rewinds. The card is never removed, so the stream keeps a trace. */
  rewindTurn: (files: TurnFileEntry[], targetFiles: string[]) => Promise<void>;

  /** Reveal a file in the IDE right panel's file tree: switches the panel to
   *  the files tab, bumps ideFocusNonce (App's effect opens the panel if
   *  collapsed), and sets ideTreeReveal so the tree expands the file's
   *  ancestor dirs and scrolls to it. Desktop only — the mobile shell has no
   *  file tree. */
  revealInFileTree: (filePath: string) => void;

  /** Enqueue a file path to be added to the active session's composer as a
   *  file-reference tag. The owning ChatPane drains its queue (see
   *  {@link drainChatFileQueue}) and converts the path to a tag. No-op if no
   *  active session. Duplicate paths within the queue are kept; the composer
   *  dedups by absolute path when materializing tags. */
  enqueueChatFile: (filePath: string) => void;
  /** Read and clear the active session's pending chat-file queue, returning
   *  the paths so the caller can turn them into tags. Returns an empty array
   *  if no active session or queue is empty. */
  drainChatFileQueue: (sessionId?: string) => string[];

  /** Enqueue a DOM element picked from the embedded browser to be added to the
   *  active session's composer as an element tag. The owning ChatPane drains
   *  its queue (see {@link drainChatElementQueue}). No-op if no active session. */
  enqueueChatElement: (element: PickedElement) => void;
  /** Read and clear the active session's pending chat-element queue, returning
   *  the elements so the caller can turn them into tags. Empty array if no
   *  active session or queue is empty. */
  drainChatElementQueue: (sessionId?: string) => PickedElement[];

  /** Append a prepared prompt to a session's FIFO queue. Called by the
   *  composer's "排队" action while the session is busy. Generates the id;
   *  the caller passes prompt/displayText/attachments. The head is drained
   *  automatically when the session next goes fully idle. */
  enqueuePrompt: (sessionId: string, item: Omit<QueuedPrompt, "id">) => void;
  /** Remove a single queued prompt by id (the ✕ on a queue chip). */
  removeQueuedPrompt: (sessionId: string, id: string) => void;
  /** Drop the entire queue for a session (the "清空" button). */
  clearPromptQueue: (sessionId: string) => void;
  /** If `sessionId` is fully idle (no running turn + no running background
   *  subagent) and its queue is non-empty, send the head prompt via
   *  `sendPrompt` and drop it from the queue. No-op otherwise. Called from
   *  the `turn.done` / `error` / sendTurn-failure paths so a queued prompt
   *  fires the moment the previous turn truly ends. Safe to call any time. */
  drainPromptQueueIfIdle: (sessionId: string) => void;
  /** Send a specific queued prompt immediately as a new turn. If the session
   *  is currently busy (running turn or running background subagent), it is
   *  interrupted first — `await interrupt()` clears `runningBySession` before
   *  sendPrompt runs. Only the targeted item is dropped; the rest stay queued.
   *  sendPrompt resets the interruptedBySession sentinel, so the old turn's
   *  late turn.done{interrupted} is filtered by the existing race guard. */
  sendQueuedPromptNow: (sessionId: string, id: string) => Promise<void>;
  /** Reorder a session's queue to match `newOrder` (a list of ids). Any ids
   *  present in the queue but missing from newOrder are appended at the end
   *  in their original order, so a malformed caller can't drop items. */
  reorderPromptQueue: (sessionId: string, newOrder: string[]) => void;

  /**
   * 落一条会话的输入框草稿（typed-but-unsent content），让它在 ChatPane 卸载后还在
   * （线程切换 / 关页签）。**只给挂载中的 ChatPane 自己的 write-through 用** ——
   * 它自己写的东西自己知道，不碰 touch。外部投递走 {@link deliverComposerDraft}。
   */
  saveComposerDraft: (sessionId: string, draft: ComposerDraft) => void;
  /**
   * **外部投递**一条草稿（引用、图节点「跟主对话说」……）。
   *
   * ## 为什么不能只是 save —— touch 计数（2026-09-24 修根因）
   *
   * 草稿还原 effect 的依赖只有 `sessionId`，**目标会话开着时写草稿是看不见的**
   * （还原只在换会话时跑）。从前靠每个调用点「seed + draft 双写」绕过 —— 五个
   * 调用点各抄一份，上轮 ddae1cf 漏改 ChatPane 正是这么出的 bug。
   *
   * 现在：投递 = 写草稿 + **递增该会话的 touch 计数**（`composerDraftTouchBySession`）。
   * 挂载中的 ChatPane 订阅这个计数，变了就**当场重跑还原**；没挂载的会话草稿躺在
   * store 里，下次挂载照常还原。**一个调用，两条情形都到。**
   */
  deliverComposerDraft: (sessionId: string, draft: ComposerDraft) => void;
  /**
   * 把一条**引用**（content tag）落进目标会话的输入框 —— 所有引用入口
   * （选段 / 文件预览 / 编辑器 / 左栏）唯一的落点，共享实现只有一份（硬规矩 2）。
   *
   * 做三件事：取目标现有草稿 → tags 追加这条 → {@link deliverComposerDraft}
   * （touch 让开着的输入框当场见、没开的下次挂载见）。
   *
   * 成功提示（toast）不在这里推 —— 各入口的文案与时机不同，调用方自己推。
   */
  quoteIntoComposer: (sessionId: string, tag: ContentTag) => void;
  /** Drop a session's stored composer draft (empty composer / after send). */
  clearComposerDraft: (sessionId: string) => void;

  /* ── IDE right-panel actions ── */
  /** Switch the active right-panel tab. Persists to settings. */
  setRightPanelTab: (tab: RightPanelTab) => void;

  /* ── Side chat (right-panel ask tab) actions ── */
  /** Reveal the right panel and focus the sidechat tab (the ask-tab entry
   *  point behind the rail button / global shortcut). Does NOT create a
   *  session — creation is an explicit "+ 新问答" in the panel's list view. */
  openSideChatPanel: () => void;
  /** Fetch a main session's side chats into sideChatsByParent (idempotent
   *  refresh — also re-syncs titles/status after background changes). */
  hydrateSideChats: (parentSessionId: string) => Promise<void>;
  /** Create a fresh side chat under the ACTIVE main session, enter its chat
   *  view. Reuses the composer's global config slots (the user's current
   *  model/provider), mirroring sendPrompt's send-model guard. */
  createSideChat: () => Promise<void>;
  /** 「新建子对话」—— 从「+」菜单里那一项开出来的子对话,三档都在这里收口:
   *
   *   - `profile === null` → **空白**(与 `createSideChat` 建出来的同一个东西);
   *   - `profile` + `memory: false` → **档案**(角色提示词每轮都带);
   *   - `profile` + `memory: true` → **档案 + 记忆**(再加一份建会话那一刻的记忆快照)。
   *
   *  与 `createSideChat` **同一个落点**(kind="side"、挂在当前主会话下),但**不复用它的
   *  空壳**:角色对不上时那边会重用一个不对的壳,而这里挑的是"这个对话是谁",认错了比
   *  多建一个空壳坏得多(见 main/lib/sessionStart.ts 里 `sameProfile` 那段)。
   *
   *  建完**不自动打开**:这个对话在右侧「问答」页签的列表里等着,用户想聊了再点进去 ——
   *  从输入框的「+」菜单里点一下就把整个右侧面板抢过去,会打断他正在打的字。
   *
   *  返回建出来的那一条;`null` = **根本没开始建**(没有当前主会话 / 没配模型 —— 后者
   *  会自己把配置弹窗叫起来,见 `raiseModelGuard`)。**真的建失败了会抛**(档案被删了、
   *  档案没填指令 —— 消息来自主进程,原样带上原因),调用方据此把红字显示出来。
   *  这条路刻意不吞错误:用户点了一下,界面上要么多出一个对话,要么说清为什么没有。 */
  createSubChat: (choice: {
    profile: { id: string; name: string } | null;
    memory: boolean;
  }) => Promise<Session | null>;
  /** Enter a side chat's chat view (lazy-loads its persisted history). */
  selectSideChat: (sessionId: string) => Promise<void>;
  /** Leave the chat view, back to the ask tab's list view. */
  closeSideChatView: () => void;
  /** Send a main-session text selection to the side chat: ensures an active
   *  side chat exists for the ACTIVE main session (creating one if needed),
   *  reveals the right panel's ask tab, and seeds the side chat's composer
   *  with the text (see sideChatSeedBySession). No-op without an active
   *  main session or a configured model (createSideChat raises the config
   *  dialog in that case). */
  askInSideChat: (text: string) => Promise<void>;
  /** Clear a side chat's pending seed after its ChatPane consumed it. */
  drainSideChatSeed: (sessionId: string) => void;
  /** Open a subagent's read-only transcript in the right panel's sidechat
   *  tab (from the ActivityPopover's subagent row). Reveals the panel and
   *  posts a one-shot request SidePanel consumes to enter the view. */
  openSubagentTranscript: (sessionId: string, taskId: string) => void;
  /** Clear the one-shot subagent-view request after consumption. */
  clearPendingSubagentView: () => void;
  /** Queue a one-shot jump-to-bookmark for `sessionId`'s ChatPane (the
   *  palette's bookmark result). The caller is responsible for opening the
   *  session (selectProject/openTab) — this only stages the jump. */
  setPendingBookmarkJump: (jump: {
    sessionId: string;
    messageId: string;
    excerpt?: string;
  }) => void;
  /** Clear the one-shot bookmark jump (consumed, or abandoned as stale). */
  clearPendingBookmarkJump: () => void;

  /** Replace a single project's saved terminal quick-commands. Persists the
   *  whole per-project map (JSON-encoded) to settings. Both the terminal
   *  commands menu (quick-add) and the settings -> terminal panel call this.
   *  No-op if `projectId` is null (no active project). */
  setCustomCommandsByProject: (projectId: string, commands: CustomCommand[]) => void;
  /** Append a new command to a project's list. Generates a stable id. */
  addCustomCommand: (projectId: string, cmd: Omit<CustomCommand, "id">) => void;
  /** Replace an existing command (matched by id) within a project's list. */
  updateCustomCommand: (projectId: string, cmd: CustomCommand) => void;
  /** Remove a command (matched by id) from a project's list. */
  removeCustomCommand: (projectId: string, id: string) => void;
  /** Open a file in the Monaco editor (dedup + append to ideOpenFiles, set
   *  active). `opts.diff` opens it in diff mode (used by the 审查 button when
   *  a before-snapshot exists). `opts.line`/`opts.column` (1-based) request a
   *  goto-definition reveal once the editor mounts. Plain opens bump
   *  ideFocusNonce so App opens the right panel if it's collapsed; diff opens
   *  don't — they render in the center editor and shouldn't drag the right
   *  panel (files tab + tree reveal) into view. */
  openFileInIde: (
    filePath: string,
    opts?: { diff?: boolean; before?: string; line?: number; column?: number; displayName?: string },
  ) => void;
  /** Clear a consumed pending reveal (called by EditPane after applying it). */
  clearIdePendingReveal: () => void;
  /** Push a location onto the active project's editor navigation-history back
   *  stack (dedups a consecutive identical entry, clears the forward stack).
   *  Called by openFileInIde/setIdeActiveFile when the user navigates away,
   *  and by the LSP providers for same-file jumps (Monaco navigates those
   *  natively, bypassing the store). */
  pushNavHistory: (entry: NavEntry) => void;
  /** Alt+← — go back to the previous editor location (cross-file or
   *  same-file). No-op when the back stack is empty. */
  navigateBack: () => void;
  /** Alt+→ — go forward again after one or more navigateBack calls. No-op
   *  when the forward stack is empty. */
  navigateForward: () => void;
  /** Remove a file from the editor's open list; active shifts to the
   *  previous file (or next, or null).
   *
   *  **有未保存改动时拦住**(返回 `blocked`),与标签栏 × 的规矩一致 —— 编辑器没有
   *  自动保存,Ctrl+S 是唯一的落盘入口,静默关掉就是静默丢改动。`force=true` 给
   *  "文件已经不在了"那几条路(删除文件/目录),那时未保存已无意义。 */
  closeFileInIde: (filePath: string, force?: boolean) => IdeCloseResult;
  /** Remove every open file that lives under `dirPath` (prefix match), and
   *  drop expanded-dir records under it too. Used by the file-tree "删除"
   *  action when a directory is trashed, so stale editor tabs disappear. */
  closeFilesUnderDir: (dirPath: string) => void;
  /** Migrate editor state after a rename. For a file, the single open path is
   *  rewritten oldPath -> newPath (active / view-mode / diff-before keys too).
   *  For a directory, every open path and expanded-dir record under it is
   *  re-prefixed. Used by the file-tree "重命名" action. */
  renamePathInIde: (oldPath: string, newPath: string, isDir: boolean) => void;
  /** Close every open file EXCEPT the given one; the given file becomes
   *  active. Used by the tab context menu's "关闭其他". Files with unsaved
   *  edits are left open and reported in `blocked` (see `closeFileInIde`). */
  closeOtherFilesInIde: (keepFilePath: string, force?: boolean) => IdeCloseResult;
  /** Close all open files; active becomes null (editor column hides). Used
   *  by the tab context menu's "关闭全部". Unsaved files stay open and are
   *  reported in `blocked` (see `closeFileInIde`). */
  closeAllFilesInIde: (force?: boolean) => IdeCloseResult;
  /** 把一次被守卫拦下的关闭(未保存改动)显式告诉用户。批量关闭的菜单项在动作后
   *  调它;单条关闭靠菜单项置灰,不走这里。 */
  reportBlockedIdeClose: (blocked: readonly string[]) => void;
  /** Set the active file (must already be open). */
  setIdeActiveFile: (filePath: string) => void;
  /** Hide the editor column by clearing the active file, WITHOUT removing it
   *  from the open-files list. The editor column disappears; re-opening any
   *  file restores it. Used by the toolbar's editor-column toggle button. */
  clearIdeActiveFile: () => void;
  /** Move an open file within the editor's tab strip (drag-to-reorder).
   *  No-op for out-of-range / same index. Persists. */
  reorderIdeFile: (from: number, to: number) => void;
  /** Set a file's view mode (edit/diff). */
  setIdeFileViewMode: (filePath: string, mode: FileViewMode) => void;
  /** Switch the editor open-mode (tabs vs replace). Persists. When switching
   *  to "replace", if more than one file is open, keeps only the active one. */
  setIdeEditorMode: (mode: IdeEditorMode) => void;
  /** Set the git-diff open-mode (center vs dialog). Persists to settings. */
  setGitDiffOpenMode: (mode: GitDiffOpenMode) => void;
  /** Open (or refresh) a diff tab in the Git diff dialog. Dedups by file path
   *  (re-clicking the same file refreshes its before/after and activates it),
   *  then opens the dialog. Ephemeral (not persisted). */
  openGitDiffDialogTab: (tab: GitDiffDialogTab) => void;
  /** Remove a diff tab from the Git diff dialog. If the active tab is closed,
   *  activation shifts to an adjacent tab; if none remain the dialog closes. */
  closeGitDiffDialogTab: (id: string) => void;
  /** Set the active diff tab in the Git diff dialog. */
  setGitDiffDialogActive: (id: string | null) => void;
  /** Show/hide the Git diff dialog. Closing keeps the tabs so they can be
   *  re-opened from the Git panel toolbar button. */
  setGitDiffDialogOpen: (open: boolean) => void;
  /** Set the Git diff dialog's view mode: "tabs" (tab strip + file list) or
   *  "single" (file list only, no tab strip). Ephemeral (not persisted). */
  setGitDiffDialogViewMode: (mode: "tabs" | "single") => void;
  /** Toggle a directory's expanded state in the file tree. Persists. */
  toggleDirExpanded: (dirPath: string) => void;
  /** Explicitly set a directory's expanded state. Persists. */
  setDirExpanded: (dirPath: string, open: boolean) => void;
  /** Write content to disk via file.writeFile. Returns ok. Does NOT touch
   *  editor state — the caller (FileEditor) keeps its own dirty tracking. */
  saveFileContent: (filePath: string, content: string) => Promise<boolean>;
  /** Stash a git diff "before" content for a file so the center editor can
   *  show a Monaco diff against the working tree. Keyed by the active project.
   *  Ephemeral. Equivalent to `setGitDiffPair(path, { before })`. */
  setGitDiffBefore: (filePath: string, before: string) => void;
  /** Stash a before/after pair for Monaco diff. When `after` is set the
   *  DiffPane uses it directly (history commits); when omitted it reads disk. */
  setGitDiffPair: (filePath: string, pair: { before: string; after?: string }) => void;
  /** Clear a file's git diff pair (e.g. after the file is staged or discarded). */
  clearGitDiffBefore: (filePath: string) => void;
  /** Set the custom-model id used for commit-message generation. Persists. */
  setCommitGenModel: (modelId: string | null) => void;
  /** Set the prompt template for commit-message generation. Persists. */
  setCommitGenPrompt: (prompt: string) => void;
  /** Set the custom-model id used for AI git-conflict resolution. Persists. */
  setConflictResolveModel: (modelId: string | null) => void;
  /** Toggle auto thread-title generation on/off. Persists. */
  setTitleGenEnabled: (enabled: boolean) => void;
  /** Set the custom-model id used for auto thread-title generation. Persists. */
  setTitleGenModel: (modelId: string | null) => void;
  /** Set the Claude output style (null = CLI default). Persists. */
  setOutputStyle: (style: string | null) => void;
  /** Toggle a git repo card's collapsed state. Persists. */
  toggleCollapsedGitRepo: (repoPath: string) => void;
}
let ideBucketsPersistTimer: ReturnType<typeof setTimeout> | null = null;
let ideBucketsLastWritten: {
  openFiles: string;
  activeFile: string;
  expandedDirs: string;
} | null = null;
function persistIdeBuckets(get: () => SessionState): void {
  if (ideBucketsPersistTimer) clearTimeout(ideBucketsPersistTimer);
  ideBucketsPersistTimer = setTimeout(() => {
    ideBucketsPersistTimer = null;
    const s = get();
    const next = {
      openFiles: JSON.stringify(s.ideOpenFilesByProject),
      activeFile: JSON.stringify(s.ideActiveFileByProject),
      expandedDirs: JSON.stringify(s.ideExpandedDirsByProject),
    };
    const last = ideBucketsLastWritten;
    if (last?.openFiles !== next.openFiles) {
      void api.setting
        .set({ key: UI_IDE_OPEN_FILES_SETTING_KEY, value: next.openFiles })
        .catch((err) => console.error("setting.set(ideOpenFiles) failed:", err));
    }
    if (last?.activeFile !== next.activeFile) {
      void api.setting
        .set({ key: UI_IDE_ACTIVE_FILE_SETTING_KEY, value: next.activeFile })
        .catch((err) => console.error("setting.set(ideActiveFile) failed:", err));
    }
    if (last?.expandedDirs !== next.expandedDirs) {
      void api.setting
        .set({ key: UI_IDE_EXPANDED_DIRS_SETTING_KEY, value: next.expandedDirs })
        .catch((err) => console.error("setting.set(ideExpandedDirs) failed:", err));
    }
    ideBucketsLastWritten = next;
  }, IDE_BUCKETS_PERSIST_DEBOUNCE_MS);
}

/** Monotonic token guarding the stream cache against overlapping fetches.
 *  A scope switch (or init's landing set re-dirtying) can start a new first
 *  page fetch while an earlier one is still in flight — the earlier
 *  response, resolving late, must not clobber the newer scope's pages (the
 *  "切了项目列表又跳回去" race). */
let streamFetchSeq = 0;

/** 挡 `reloadSkills` 的旧回包 —— 切项目时快速连切,先发的那次可能后回来把新清单盖掉。 */
let reloadSkillsSeq = 0;

/** Raise the send-time model guard UI after resolveSendModel returned null:
 *  selectable-but-unpicked → bump `modelGuardPulse` so the ModelDropdown chip
 *  nudges in place (shake + floating hint — far lighter than a global toast);
 *  nothing selectable → the config dialog (the only way out). Shared by
 *  sendPrompt / editAndResendMessage / drainPromptQueueIfIdle / createSideChat. */
function raiseModelGuard(): void {
  const s = useSessionStore.getState();
  if (hasSelectableModel(s)) {
    useSessionStore.setState({ modelGuardPulse: s.modelGuardPulse + 1 });
  } else {
    useSessionStore.setState({ modelConfigPromptOpen: true });
  }
}

/* ──────────────── Delta buffer (performance: batch text.delta per rAF) ────────────────
 *
 * Each `text.delta` / `thinking` event from the stream triggers a full `setState`
 * that rebuilds the messages array. During a long output this can happen thousands
 * of times per second. The buffer accumulates raw deltas and flushes them on a
 * `requestAnimationFrame` boundary (~60 Hz), collapsing many single-character
 * deltas into one `setState` per frame.
 *
 * Terminal events (turn.done, error) force an immediate flush so no content is
 * lost before the turn closes. The buffer is module-scoped, *not* inside the
 * Zustand store, so it doesn't trigger React re-renders on accumulation.
 */

type DeltaSeg = { k: "text" | "thinking"; text: string };

export type DeltaEntry = {
  sessionId: string;
  messageId: string;
  /** Content segments in TRUE arrival order. A flush window routinely
   *  straddles a text↔thinking boundary (the bridge's <think> segmenter
   *  interleaves the two every few chunks) — the segments must then apply in
   *  stream order. The old two-slot shape (`text` + `thinking` strings,
   *  always applied text-first) swapped the blocks across the boundary:
   *  prose landed before the reasoning that preceded it. */
  segs: DeltaSeg[];
};

let flushScheduled = false;

function scheduleDeltaFlush(): void {
  recordDeltaArrival();
  if (flushScheduled) return;
  flushScheduled = true;

  const avg = avgIntervalMs();
  if (avg > 100 && deltaArrivals.length >= 2) {
    // Sparse deltas: flush on next microtask (near-immediate).
    queueMicrotask(flushDeltas);
  } else if (avg > 16) {
    // Moderate pace: 50 ms timer for a modest batch window.
    setTimeout(flushDeltas, 50);
  } else {
    // Dense burst: rAF (natural 60 Hz batch).
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(flushDeltas);
    } else {
      setTimeout(flushDeltas, 16);
    }
  }
}

function flushDeltas(): void {
  flushScheduled = false;
  if (deltaBuf.size === 0) return;

  // Snapshot the buffer and clear it atomically so new deltas that arrive
  // during this flush start a fresh accumulation rather than being lost.
  const entries = Array.from(deltaBuf.values());
  deltaBuf.clear();

  useSessionStore.setState((s) => {
    // Group entries by sessionId so we only iterate each session's messages
    // once per flush cycle.
    const bySession = new Map<string, DeltaEntry[]>();
    for (const e of entries) {
      const arr = bySession.get(e.sessionId);
      if (arr) arr.push(e);
      else bySession.set(e.sessionId, [e]);
    }

    for (const [sid, sessionEntries] of bySession) {
      const list = s.messagesBySession[sid] ?? [];
      // 纯函数,见 `applyDeltaEntries` 的文件头:分段合并、建新回合、丢迟到 delta、
      // 降级上一张最新回合卡都在那里,且成本每帧 O(N) 而不是 O(分段数 × N)。
      // `runningTurn*` 从 store 现读 —— 与从前内联时一致(它可能就是本帧刚变的)。
      const next = applyDeltaEntries(list, sessionEntries, {
        runningTurnStartedAt: useSessionStore.getState().runningTurnStartedAt[sid],
        runningTurnModel: useSessionStore.getState().runningTurnModelBySession[sid],
      });

      // Write back only if the session changed — avoid touching unrelated sessions.
      if (next !== list) {
        s.messagesBySession[sid] = next;
      }
    }

    // Return a minimal diff — we mutated messagesBySession directly inside the
    // setState callback (Zustand accepts this pattern because setState runs
    // synchronously and can detect the mutation via its proxy).
    return { messagesBySession: { ...s.messagesBySession } };
  });
}

/** Flush any buffered deltas immediately (called before terminal events). */
function forceDeltaFlush(): void {
  if (deltaBuf.size === 0) return;
  flushScheduled = false;
  deltaArrivals.length = 0; // Reset the adaptive window.
  flushDeltas();
}

/* ─── Pane-width persistence (debounced) ───
 * A drag fires many mousemove events; each calls an adjust* action that
 * updates the store synchronously (instant UI). The DB write is debounced so
 * the settings table only gets hit once, ~400ms after the last move. The
 * timer is module-scoped so successive adjust calls reset the same timer. */
let paneWidthPersistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePaneWidthPersist(get: () => SessionState): void {
  if (paneWidthPersistTimer) clearTimeout(paneWidthPersistTimer);
  paneWidthPersistTimer = setTimeout(async () => {
    paneWidthPersistTimer = null;
    const s = get();
    try {
      await api.setting.set({
        key: UI_PANE_WIDTHS_SETTING_KEY,
        value: JSON.stringify({
          leftPct: s.leftWidthPct,
          right: s.rightWidth,
          bottomTerminal: s.bottomTerminalHeight,
          editor: s.editorWidthPct,
        }),
      });
    } catch (err) {
      console.error("setting.set(paneWidths) failed:", err);
    }
  }, 400);
}

/* ═══════════════ 事件归约:每一类事件一个具名函数 ═══════════════
 *
 * 这些原先**全部内联在 `ingestEvent` 里**（那个函数 1458 行、25 个早返回分支 +
 * 一个 switch 大块）。内联的代价不是「丑」,是**改一处要读完整段**:想知道
 * `turn.rewound` 做了什么，得先在一千多行里定位到它，还要一路确认前面那些分支
 * 不会先把它拦掉。
 *
 * 现在每个事件有自己的名字。主函数只剩分派，而且**短路顺序一字未改** ——
 * 早返回分支的先后本身是语义（有的分支专门抢在别的分支前面拦），不能重排。
 *
 * 函数体是**逐字节从原处搬过来的**，只把自由变量换成了 `ctx.` 前缀。
 * ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
 * 跨端同步(桌面 ⇄ 手机浏览器):谁来落库、设置实时套用、项目列表差异合并
 * ═══════════════════════════════════════════════════════════════ */

/**
 * 回合里**由事件推出来的**消息(turn.done / error 收尾、turn.files、compact、
 * rewound、中断收尾),这一端要不要写回库。
 *
 * 以前每个连着的客户端都写:桌面写一遍,手机再写一遍。而手机的 SSE 是会断的 ——
 * 断过一截的手机在 turn.done 时手里是缺块的消息,没有发送锚点时还会整桶写,
 * 直接盖掉桌面写好的完整行。现在:桌面(IPC 无损,每个事件都收得到)是**唯一**
 * 的写者;网页壳只在桌面窗口不在时才写(macOS 关窗后主进程还活着,手机照样能
 * 发起回合,那时没人替它写)。用户自己的动作(发出去的那条消息、编辑重发的截断)
 * 不受影响,仍由发起端写。
 *
 * 默认 false = 旧行为(网页壳自己写):老主进程的快照不带 `desktopAttached`,
 * Node 里跑的冒烟(`isElectron` 为 false)也落在这一档。每次 SSE (重)连上的
 * 那帧 `session.runningSnapshot` 会更新它。
 */
let desktopWritesTurns = false;

function persistsTurnContent(): boolean {
  return isElectron || !desktopWritesTurns;
}

/** 归约一个事件时用得着的那几样。**故意做窄** —— 只放这些分支真正用到的，
 *  多一样都会让「这个归约函数能用什么」变得说不清。 */
export interface IngestCtx {
  /** zustand 的 setter。 */
  set: (partial: Partial<SessionState> | ((s: SessionState) => Partial<SessionState>)) => void;
  /** zustand 的 getter。 */
  get: () => SessionState;
  /** 这条事件的会话 id（`e.sessionId`，主函数开头取好）。 */
  sid: string;
  /** 非当前会话 + 窗口没在看时，给左边栏红点加一。 */
  bumpUnread: () => void;
  /** 非当前会话 + 窗口聚焦时的应用内提示（窗口失焦时由主进程发系统通知）。 */
  pushToast: (kind: "info" | "warning" | "error", title: string, body?: string) => void;
}

function reduceSessionRunningSnapshot(ctx: IngestCtx, e: SessionRunningSnapshotEvent): void {
// 顺带更新「回合消息谁来落库」(见 persistsTurnContent)。
desktopWritesTurns = e.desktopAttached === true;
const running = new Set(e.running);
      ctx.set((s) => {
        const next: Record<string, boolean> = {};
        for (const id of Object.keys(s.runningBySession)) next[id] = running.has(id);
        for (const id of running) next[id] = true;
        return { runningBySession: next };
      });
      return;
    
}

/** `e.type === "turn.files"` */
function reduceTurnFiles(ctx: IngestCtx, e: TurnFilesEvent): void {
const changedMessages: ChatMessage[] = [];
      ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        const next = upsertLiveTurnFilesBlock(list, e.files);
        if (next !== list) {
          // upsertLiveTurnFilesBlock only replaces/appends touched messages —
          // every other row keeps its reference, so index-wise inequality is
          // an exact changed-rows diff.
          for (let i = 0; i < next.length; i++) {
            if (next[i] !== list[i]) changedMessages.push(next[i]);
          }
        }
        return {
          turnFilesBySession: { ...s.turnFilesBySession, [ctx.sid]: e.files },
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [ctx.sid]: next },
        };
      });
      // Persist the touched rows so the card survives restart. This is the
      // ONLY persist some arrivals get: an interrupted turn's closing
      // turn.done{interrupted} is dropped by the stale-guard above, so its
      // late turn.files never gets a turn.done persist pass. IPC ordering
      // preserves "last write wins" for the normal path (this lands after
      // the turn.done persist, which already covers the card).
      if (changedMessages.length > 0 && persistsTurnContent()) {
        persistMessages({ sessionId: ctx.sid, messages: toRecords(ctx.sid, changedMessages) });
      }
      return;
    
}

/** `e.type === "compact.result"` */
function reduceCompactResult(ctx: IngestCtx, e: CompactResultEvent): void {
ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        const block: Block = {
          kind: "compact-summary",
          trigger: e.trigger,
          preTokens: e.preTokens,
          postTokens: e.postTokens,
          durationMs: e.durationMs,
        };
        // Use the send-time anchor (stamped in sendPrompt) so the compact
        // card's turnMeta continues the synthesized pendingTurn row's timing
        // seamlessly - same pattern as tool.use / text.delta. Falls back to
        // now if the anchor is missing (resumed/legacy turn).
        const startedAt = s.runningTurnStartedAt[ctx.sid] ?? Date.now();
        const next = appendTurnCardBlock(
          list,
          block,
          startedAt,
          s.runningTurnModelBySession[ctx.sid],
          "compact",
        );
        return next === list
          ? s
          : { messagesBySession: { ...s.messagesBySession, [ctx.sid]: next } };
      });
      // Persist so the card survives reload. Incremental upsert: only the
      // trailing assistant message (or a freshly-appended turn opener) changed.
      if (persistsTurnContent()) {
        const list = ctx.get().messagesBySession[ctx.sid];
        if (list && list.length > 0) {
          const last = list[list.length - 1];
          persistMessages({ sessionId: ctx.sid, messages: toRecords(ctx.sid, [last]) });
        }
      }
      return;
    
}

/** `e.type === "turn.rewound"` */
function reduceTurnRewound(ctx: IngestCtx, e: TurnRewoundEvent): void {
let rewoundLatest = false;
      const rewoundChanged: ChatMessage[] = [];
      ctx.set((s) => {
        const list = s.messagesBySession[ctx.sid] ?? EMPTY_MESSAGES;
        const targetSet = new Set(e.targetFiles);
        let changed = false;
        const next = list.map((m) => {
          let touched = false;
          const blocks = m.blocks.map((b) => {
            if (
              b.kind === "turn-files" &&
              !b.rewound &&
              b.files.length === targetSet.size &&
              b.files.every((f) => targetSet.has(f.filePath))
            ) {
              touched = true;
              if (b.isLatestTurn) rewoundLatest = true;
              return { ...b, rewound: true };
            }
            return b;
          });
          if (!touched) return m;
          changed = true;
          const updated = { ...m, blocks };
          rewoundChanged.push(updated);
          return updated;
        });
        if (!changed) return s;
        // If the rewound card was the live one, also clear the latest-turn
        // bucket (its files are back on disk — no longer "this turn's").
        return rewoundLatest
          ? {
              messagesBySession: { ...s.messagesBySession, [ctx.sid]: next },
              turnFilesBySession: { ...s.turnFilesBySession, [ctx.sid]: [] },
            }
          : { messagesBySession: { ...s.messagesBySession, [ctx.sid]: next } };
      });
      // Persist the rewound state so the marker survives session reopen.
      // (The card is kept, so this is a mutation, not a removal.) Incremental
      // upsert: only the rows whose blocks actually changed need writing.
      if (rewoundChanged.length > 0 && persistsTurnContent()) {
        persistMessages({ sessionId: ctx.sid, messages: toRecords(ctx.sid, rewoundChanged) });
      }
      return;
    
}
/**
 * 落库消息(fire-and-forget)。**必须带 catch**:以前是裸 `void`,IPC / 手机 RPC 一 reject
 * (401、断网、超时)这一轮就**静默没存下来**,而渲染端没有 unhandledrejection 监听,
 * 谁也不知道。失败弹一条错误提示(toastStore 按标题去重,连续失败不会刷屏)。
 */
function persistMessages(req: Parameters<typeof api.session.upsertMessages>[0]): void {
  api.session.upsertMessages(req).catch((err: unknown) => {
    console.error("session.upsertMessages failed:", err);
    useToastStore.getState().push({
      kind: "error",
      title: translate(useSessionStore.getState().locale, "store.toast.persistFailed"),
      body: err instanceof Error ? err.message : String(err),
    });
  });
}

/** 编辑重发那条路：先截断旧尾巴、再插入新的用户消息。**与 `persistMessages` 同一套
 *  「必须带 catch」的规矩** —— 从前这里是裸 `void`,IPC/RPC 一 reject(401、断网、超时)
 *  截断就**静默没发生**:库里的旧尾巴还在,用户下次重开那条对话时被删掉的消息又冒出来,
 *  而界面上一句提示都没有。 */
function persistTruncateAndInsert(req: Parameters<typeof api.session.truncateAndInsertMessages>[0]): void {
  api.session.truncateAndInsertMessages(req).catch((err: unknown) => {
    console.error("session.truncateAndInsertMessages failed:", err);
    useToastStore.getState().push({
      kind: "error",
      title: translate(useSessionStore.getState().locale, "store.toast.persistFailed"),
      body: err instanceof Error ? err.message : String(err),
    });
  });
}

/** 写一条界面设置(fire-and-forget)。失败只记日志 —— 丢一次「上次打开的项目」不值得打扰用户,
 *  但不能变成未处理的 rejection。 */
function saveSetting(req: Parameters<typeof api.setting.set>[0]): void {
  api.setting.set(req).catch((err: unknown) => {
    console.error(`setting.set(${req.key}) failed:`, err);
  });
}

/**
 * 一条**用户显式改的偏好**(主题/语言/密度/布局…)落盘失败时报给用户。
 *
 * 为什么与 {@link saveSetting} 分开:那些 setter 都是"先乐观 `set` store、再落盘",
 * 而界面上已经是新值了。落盘失败只打日志的话,用户看到的就是"改动生效了" ——
 * 直到重启,一切**静默**弹回旧值,而他从没被告知过。数据根所在磁盘写满 / 被占用 /
 * sql.js 导出失败都会走到这里。(toastStore 按标题去重,连续失败不会刷屏。)
 */
function reportSettingSaveFailed(err: unknown): void {
  useToastStore.getState().push({
    kind: "error",
    title: translate(useSessionStore.getState().locale, "store.toast.settingSaveFailed"),
    body: err instanceof Error ? err.message : String(err),
  });
}

/** 书签的新增/删除/重命名落库失败(`session.updateBookmarks`)。这三处都已经把 UI
 *  回滚了 —— 但"刚加的书签自己消失了、一句话没有"仍是静默失败:用户会以为点错了、
 *  再点一次,或者以为书签功能坏了。 */
function reportBookmarkSaveFailed(err: unknown): void {
  useToastStore.getState().push({
    kind: "error",
    title: translate(useSessionStore.getState().locale, "chatStream.bookmark.saveFailed"),
    body: err instanceof Error ? err.message : String(err),
  });
}

export const useSessionStore = create<SessionState>((set, get) => ({
  /**
   * 一次关闭请求被守卫拦下(callback 返回了 `blocked`)时,把"哪些文件没关、
   * 为什么"显式说出来 —— 见仓库硬规矩「坏东西显式报出来,不静默跳过」。文件多了就
   * 只报数量,免得标题被一串路径淹掉(toast 是单行)。
   *
   * 单条关闭(菜单里那个**置灰**的「关闭」)不走这里:用户点不动它,提示挂在菜单项的
   * `title` 上,再弹一条 toast 是重复。
   */
  reportBlockedIdeClose: (blocked) => {
    if (blocked.length === 0) return;
    const locale = get().locale;
    const names = blocked.slice(0, 3).map((p) => basename(p));
    const title = translate(locale, "store.toast.ideCloseBlockedTitle");
    const body = blocked.length <= 3
      ? translate(locale, "store.toast.ideCloseBlockedBody", { names: names.join(locale === "en" ? ", " : "、") })
      : translate(locale, "store.toast.ideCloseBlockedMany", { count: blocked.length });
    useToastStore.getState().push({ kind: "warning", title, body });
  },

  projects: [],
  activeProjectId: null,
  sessionsByProject: {},
  sessionsHasMoreByProject: {},
  sessionsTotalByProject: {},
  archivedSessionsByProject: {},
  pinnedSessions: [],
  gitChangeVersionByRepo: {},
  sessions: [],
  activeSessionId: null,
  expandedProjects: {},
  worktreeViewByProject: {},
  expandedWorktrees: {},
  worktreeNames: {},
  projectColors: {},
  archivedViewOpen: false,
  // openTabs is filled by `init` (lands on the first non-archived session,
  // if any) and by `startSession`. Defaulting to [] here means there's no
  // phantom active tab before hydration completes.
  openTabs: [],
  // Persisted in `settings` table; init() overwrites from the DB. Default is
  // `tabs` (unified tab bar) — new users land on the tabbed center pane;
  // anyone who explicitly picked a mode keeps their stored choice.
  displayMode: "tabs",
  // Tab strips wrap onto multiple rows instead of horizontal scrolling.
  // Persisted under `ui.tabBarMultiRow`; init() overwrites from the DB.
  // Default false = the classic single scrolling row.
  tabBarMultiRow: false,
  // Left-bar view: classic project tree is the default; init() overwrites
  // from the persisted ui.leftBarMode preference.
  leftBarMode: "tree",
  // UI theme style (orthogonal to light/dark). Default "classic"; init()
  // overwrites from the persisted ui.themeStyle preference.
  themeStyle: "classic",
  // Center focus for the unified tab bar (`tabs` displayMode). UI-only.
  centerTabFocus: "chat",
  // UI language. Persisted in `settings` table; init() overwrites from the
  // DB. "zh" is the default (and the pre-i18n behavior) so existing users see
  // no change until they opt into English.
  locale: "zh",
  // Session auto-archive rules. Persisted as JSON in `settings`; initDeferred
  // hydrates. Disabled by default so existing users opt in.
  autoArchiveConfig: { ...DEFAULT_AUTO_ARCHIVE_CONFIG, overrides: {} },
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // "comfortable" so existing users see no change until they opt in.
  chatDensity: "comfortable",
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // "flat" so existing users see no change until they opt into grouping.
  projectView: "flat",
  // Per-group metadata (color + order). Empty until init() hydrates from the
  // `ui.projectGroups` JSON blob; groups not present here fall back to default
  // color and first-appearance order.
  groupMeta: {},
  // Persisted in `settings` table; init() overwrites from the DB. Defaults
  // mirror the CSS var defaults in styles.css (14px = text-sm).
  chatFontSize: 14,
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // 14px mirrors the --right-panel-font-size CSS var in styles.css.
  rightPanelFontSize: 14,
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // 200 mirrors the previous hardcoded TAG_THRESHOLD_CHARS in contentTag.ts.
  pasteTagThresholdChars: 200,
  // Default voice input: Chinese, streaming zipformer. Dictation itself is
  // click-to-toggle — there is no capture mode to persist.
  voiceLang: "zh-CN",
  voiceEngine: "zipformer" as const,
  voiceMicPermission: "",
  voiceModelDir: "",
  // 和主进程那份默认值必须一致(见 `WORKFLOW_MAX_PARALLEL_DEFAULT_RENDERER` 的注释)。
  workflowMaxParallel: WORKFLOW_MAX_PARALLEL_DEFAULT_RENDERER,
  voiceModelReady: false,
  userMessageColor: null,
  accentColor: null,
  editorTheme: DEFAULT_EDITOR_THEME_CHOICE,
  shortcutOverrides: {},
  shortcutRecording: false,
  gestureSettings: DEFAULT_GESTURE_SETTINGS,
  gestureRecording: null,
    messagesBySession: {},
    hasMoreMessagesBySession: {},
    loadingMessagesBySession: {},
    loadingOlderBySession: {},
    historyLoadedBySession: {},
  runningBySession: {},
  engineCommandsByProvider: {},
  runningTurnStartedAt: {},
  waitingBranchesBySession: {},
  runningTurnModelBySession: {},
  turnErrorBySession: {},
  // Stream sidebar cache: empty + dirty so the first mount fetches.
  streamSessions: [],
  streamHasMore: false,
  streamTotal: 0,
  streamDirty: true,
  // Stream scope filter: unfiltered until init() hydrates the persisted
  // ui.streamScope choice.
  streamScope: null,
  worktreeInfoByRepo: {},
  interruptedBySession: {},
  turnIncompleteBySession: {},
  upstreamIssueBySession: {},
  unreadBySession: {},
  isWindowFocused: true,
  providerHealthById: {},
  settingsOpen: false,
  settingsSection: null,
  settingsFocusWorkflowId: null,
  modelConfigPromptOpen: false,
  modelGuardPulse: 0,
  commandPaletteOpen: false,
  // File search dialog (opened from the Files panel search button / Cmd+Shift+F
  // / command palette). Pure in-memory, mirrors commandPaletteOpen.
  searchDialogOpen: false,
  // Layout panel visibility — lifted from App.tsx useState. Right panel
  // starts hidden by default (the titlebar toggle / command palette reopens
  // it). NOT persisted.
  leftOpen: true,
  rightOpen: false,
  bottomTerminalOpen: false,
  // Browser panel overlay - closed by default. NOT persisted.
  browserPanelOpen: false,
  // Wide-panel (3:7) mode - off by default; transient like browserPanelOpen.
  widePanelOpen: false,
  widePanelPct: WIDE_PANEL_PCT_DEFAULT,
  widePanelSnapshot: null,
  // Mobile-shell fullscreen viewer (file/diff/plan) - closed by default.
  mobileViewer: null,
  browserTabCount: 0,
  browserDeviceToolbarOpen: false,
  browserTabs: [],
  browserActiveTabId: null,
  pendingBrowserUrl: null,
  browserViewSuppressed: 0,
  // Draggable pane sizes. Persisted as one JSON blob (UI_PANE_WIDTHS_SETTING_KEY);
  // init() hydrates + clamps. These defaults match the original hardcoded
  // widths so the first-run layout is unchanged.
  leftWidthPct: LEFT_WIDTH_PCT_DEFAULT,
  rightWidth: 360,
  bottomTerminalHeight: 280,
  editorWidthPct: 50,
  permissionMode: "default",
  workflowId: "default",
    envChoice: "local",
  providerId: DEFAULT_PROVIDER_ID,
  model: "default",
  customModelId: null,
  lastModelByProvider: EMPTY_LAST_MODEL_BY_PROVIDER,
  customModels: EMPTY_CUSTOM_MODELS,
  providers: EMPTY_PROVIDERS,
  piAvailableModels: EMPTY_PI_MODELS,
  codexAvailableModels: EMPTY_CODEX_MODELS,
  skills: EMPTY_SKILLS,
  effort: "high",
  todosBySession: {},
  planBySession: {},
  planDrawerPlanBySession: {},
  planTabActiveBySession: {},
  planApprovalDraftBySession: {},
  subagentsBySession: {},
  subagentTranscriptsBySession: {},
  workflowNodeTranscripts: {},
  contextSnapshotBySession: {},
  usageHistoryBySession: {},
  pendingQuestionBySession: {},
  pendingApprovals: [],
  pendingPlanApprovalBySession: {},
  turnFilesBySession: {},
  bookmarksBySession: {},
  chatFileQueueBySession: {},
  chatElementQueueBySession: {},
  promptQueueBySession: {},
  composerDraftBySession: {},
  // Side chat (right-panel ask tab). Lists hydrate on demand per parent.
  sideChatsByParent: {},
  activeSideChatId: null,
  sideChatSeedBySession: {},
  composerDraftTouchBySession: {},
  pendingSubagentView: null,
  pendingBookmarkJump: null,
  // IDE right-panel. Editor state is per-project (keyed by projectId);
  // init() hydrates from the settings table. rightPanelTab / ideEditorMode
  // are global user prefs.
  rightPanelTab: "files",
  rightPanelTabSeq: 0,
  customCommandsByProject: {},
  ideOpenFilesByProject: {},
  ideFileDisplayNamesByProject: {},
  ideActiveFileByProject: {},
  ideFileViewModeByProject: {},
  ideEditorMode: "tabs",
  gitDiffOpenMode: "center",
  gitDiffDialogTabs: [],
  gitDiffDialogActiveId: null,
  gitDiffDialogOpen: false,
  gitDiffDialogViewMode: "single",
  ideExpandedDirsByProject: {},
  gitDiffByProject: {},
  ideDiffBeforeByProject: {},
  commitGenModel: null,
  commitGenPrompt: "",
  conflictResolveModel: null,
  titleGenEnabled: false,
  titleGenModel: null,
  outputStyle: null,
  collapsedGitRepos: {} as Record<string, boolean>,
  ideFocusNonce: 0,
  ideTreeReveal: null,
  idePendingReveal: null,
  ideRevealNonce: 0,
  navBackByProject: {},
  navForwardByProject: {},
  lspLanguages: [] as LspLanguageState[],
  runtimes: [] as RuntimeAgentState[],
  lspPhasesByWorkspace: {} as Record<string, { phase: "starting" | "running" | "stopped" | "importing"; error?: string; detail?: string }>,

  /** True once `init()` has started, to guard against React StrictMode's
   *  double-effect in dev (which would otherwise fire init twice). */
  _initStarted: false,

  init: async () => {
    // StrictMode guard: dev runs effects twice. The second call would re-fetch
    // everything and (worse) race with the first. Bail out silently.
    if (get()._initStarted) return;
    set({ _initStarted: true });

    // IDE hydration staging: parsed from deferred settings, applied after the
    // project list loads so we can drop paths that belong to no project.
    let ideHydrationPending: {
      open: Record<string, string[]>;
      active: Record<string, string | null>;
      dirs: Record<string, string[]>;
    } | null = null;

    // ── First-paint essentials ──
    // Only what the user sees on the very first frame: the center-pane layout
    // mode, the chat font size (avoids a font flash), and the project + session
    // list. Everything else (health check, appearance extras, IDE/git prefs) is
    // deferred to `initDeferred()` after this resolves.

    // First-paint settings: one bulk read instead of N serial round-trips.
    // Each value is applied in its own try/catch so a malformed blob for one
    // key can't poison the rest (same isolation as the old per-key reads).
    const fp = await api.setting
      .getMany({
        keys: [
          DISPLAY_MODE_SETTING_KEY,
          TAB_BAR_MULTI_ROW_SETTING_KEY,
          LEFTBAR_MODE_SETTING_KEY,
          THEME_STYLE_SETTING_KEY,
          UI_LOCALE_SETTING_KEY,
          UI_CHAT_DENSITY_SETTING_KEY,
          UI_PROJECT_VIEW_SETTING_KEY,
          UI_PROJECT_GROUPS_SETTING_KEY,
          UI_LAST_PROJECT_SETTING_KEY,
          UI_LAST_SESSION_SETTING_KEY,
          UI_STREAM_SCOPE_SETTING_KEY,
          UI_COMPOSER_MODEL_SETTING_KEY,
          SESSION_WORKTREE_DEFAULT_SETTING_KEY,
          WORKTREE_NAMES_SETTING_KEY,
          PROJECT_COLORS_SETTING_KEY,
        ],
      })
      .catch((err) => {
        console.error("setting.getMany(first-paint) failed:", err);
        return {} as Record<string, string | null>;
      });

    // Composer's default working environment for new sessions. Folded into
    // the first-paint batch so the chip renders correctly on frame one.
    // Only the EnvChoice strings hydrate; anything else (including the
    // legacy boolean era's "true"/"false") is ignored and the factory
    // default "local" stands — new sessions start in the project root.
    try {
      const value = fp[SESSION_WORKTREE_DEFAULT_SETTING_KEY];
      if (value === "local" || value === "wt-detached" || value === "wt-branch") {
        set({ envChoice: value });
      }
    } catch (err) {
      console.error("apply(envChoice) failed:", err);
    }

    // Left-bar display names for worktree directories. Cosmetic — a failed
    // parse just falls back to directory basenames for every group.
    try {
      const value = fp[WORKTREE_NAMES_SETTING_KEY];
      if (value) set({ worktreeNames: JSON.parse(value) as Record<string, string> });
    } catch (err) {
      console.error("apply(worktreeNames) failed:", err);
    }

    // Per-project avatar color overrides. Cosmetic — a failed parse just
    // falls back to the name-hash defaults everywhere.
    try {
      const value = fp[PROJECT_COLORS_SETTING_KEY];
      if (value) set({ projectColors: JSON.parse(value) as Record<string, string> });
    } catch (err) {
      console.error("apply(projectColors) failed:", err);
    }

    // displayMode determines single vs tabs layout - needed before first render
    // of the center pane so the right structure mounts.
    try {
      const value = fp[DISPLAY_MODE_SETTING_KEY];
      if (value === "single" || value === "tabs") set({ displayMode: value });
    } catch (err) {
      console.error("apply(displayMode) failed:", err);
    }

    // Multi-row tab wrapping — must land before the bars' first render so
    // they don't flash the single-row layout.
    try {
      const value = fp[TAB_BAR_MULTI_ROW_SETTING_KEY];
      if (value === "true") set({ tabBarMultiRow: true });
    } catch (err) {
      console.error("apply(tabBarMultiRow) failed:", err);
    }

    // leftBarMode determines which sidebar component mounts on frame one.
    try {
      const value = fp[LEFTBAR_MODE_SETTING_KEY];
      if (value === "tree" || value === "stream") set({ leftBarMode: value });
    } catch (err) {
      console.error("apply(leftBarMode) failed:", err);
    }

    // Theme style (classic ↔ sketch): reconciles the FOUC guard's
    // localStorage guess against the SQLite source of truth. Values other
    // than the two enum members (corrupt row) are ignored → classic stands.
    try {
      const value = fp[THEME_STYLE_SETTING_KEY];
      if (value === "classic" || value === "sketch") set({ themeStyle: value });
    } catch (err) {
      console.error("apply(themeStyle) failed:", err);
    }

    // Stream sidebar scope filter. "" = the unfiltered "全部项目" view
    // (setStreamScope's null encoding); a stale project/group id is NOT
    // dropped here — the sidebar degrades it to the unfiltered view once
    // the live project list is known, which also keeps an early hydration
    // (projects still empty) from discarding a valid scope.
    try {
      const value = fp[UI_STREAM_SCOPE_SETTING_KEY];
      if (value != null) set({ streamScope: value === "" ? null : value });
    } catch (err) {
      console.error("apply(streamScope) failed:", err);
    }

    // locale drives every translated string — must land before first paint so
    // the UI never flashes the wrong language. Also mirror onto <html lang>.
    try {
      const value = fp[UI_LOCALE_SETTING_KEY];
      if (value === "zh" || value === "en") {
        set({ locale: value });
        document.documentElement.lang = value === "en" ? "en" : "zh-CN";
      }
    } catch (err) {
      console.error("apply(locale) failed:", err);
    }

    // chatDensity controls message-stream vertical rhythm (row + block gaps).
    // Applied to <html> as CSS vars by useChatAppearance; read here so the
    // first paint already reflects the saved preference.
    try {
      const value = fp[UI_CHAT_DENSITY_SETTING_KEY];
      if (value === "compact" || value === "comfortable" || value === "cozy") {
        set({ chatDensity: value });
      }
    } catch (err) {
      console.error("apply(chatDensity) failed:", err);
    }

    // projectView determines whether the left bar renders projects as a flat
    // list or clustered under group headers. Needed before first paint so the
    // tree mounts in the right shape.
    try {
      const value = fp[UI_PROJECT_VIEW_SETTING_KEY];
      if (value === "flat" || value === "grouped") set({ projectView: value });
    } catch (err) {
      console.error("apply(projectView) failed:", err);
    }

    // groupMeta (per-group color + order) — parsed from the ui.projectGroups
    // JSON blob. Defensive parse: a malformed blob leaves the default {}.
    try {
      const value = fp[UI_PROJECT_GROUPS_SETTING_KEY];
      if (value) {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          set({ groupMeta: parsed as ProjectGroupsMeta });
        }
      }
    } catch (err) {
      console.error("apply(projectGroups) failed:", err);
    }

    // Composer's persisted provider/model choice — the "next session" defaults
    // written by setProvider / setModel / setCustomModel. Restored so the last
    // SDK + model pick is pre-selected at boot. Validity against the CURRENT
    // model lists is checked once reloadProviders / reloadCustomModels /
    // reloadPiAvailableModels resolve (a deleted model falls back to auto via
    // validateComposerSelection).
    try {
      const value = fp[UI_COMPOSER_MODEL_SETTING_KEY];
      if (value) {
        const parsed = JSON.parse(value) as {
          providerId?: unknown;
          model?: unknown;
          customModelId?: unknown;
          lastModelByProvider?: unknown;
        };
        if (parsed && typeof parsed === "object" && typeof parsed.providerId === "string") {
          // Per-provider remembered models (newer format). Guarded shape check;
          // malformed entries are simply ignored.
          let lastMap: SessionState["lastModelByProvider"] = {};
          if (parsed.lastModelByProvider && typeof parsed.lastModelByProvider === "object") {
            for (const [k, v] of Object.entries(
              parsed.lastModelByProvider as Record<string, unknown>,
            )) {
              if (
                v &&
                typeof v === "object" &&
                typeof (v as { model?: unknown }).model === "string"
              ) {
                const rec = v as { model: string; customModelId?: unknown; effort?: unknown; permissionMode?: unknown };
                const cid = rec.customModelId;
                lastMap[k] = {
                  model: rec.model,
                  customModelId: typeof cid === "string" ? cid : null,
                  // Optional slots (older entries carry only the model
                  // binding). String-typed only; validity against the
                  // provider's declared options is enforced by
                  // coerceSlotsForProvider once reloadProviders resolves.
                  ...(typeof rec.effort === "string" ? { effort: rec.effort as EffortLevel } : {}),
                  ...(typeof rec.permissionMode === "string"
                    ? { permissionMode: rec.permissionMode as PermissionMode }
                    : {}),
                };
              }
            }
          }
          // Top-level model/customModelId come from the legacy (pre-map) format;
          // a remembered entry for the restored provider takes precedence.
          const remembered = lastMap[parsed.providerId];
          set({
            providerId: parsed.providerId,
            model:
              remembered?.model ??
              (typeof parsed.model === "string" ? parsed.model : "default"),
            customModelId: remembered
              ? remembered.customModelId
              : typeof parsed.customModelId === "string"
                ? parsed.customModelId
                : null,
            // Remembered thinking/permission slots ride along with the model
            // restore; without an entry the boot defaults stand (effort
            // "high", permission "default") until a session re-syncs.
            ...(remembered?.effort !== undefined ? { effort: remembered.effort } : {}),
            ...(remembered?.permissionMode !== undefined
              ? { permissionMode: remembered.permissionMode }
              : {}),
            lastModelByProvider: lastMap,
          });
        }
      }
    } catch (err) {
      console.error("apply(composerModel) failed:", err);
    }

    // Fetch the project list, chat font size, and the global pinned bucket in
    // parallel - all three are needed for the first frame (session tree + chat
    // text size + pinned section above the tree).
    const [projectListRes, fontRes, pinnedRes] = await Promise.allSettled([
      api.project.list(),
      api.setting.get({ key: UI_CHAT_FONT_SIZE_SETTING_KEY }),
      api.session.listPinned(),
    ]);

    // Apply chat font size (best-effort - missing/invalid leaves the default).
    if (fontRes.status === "fulfilled" && fontRes.value.value != null) {
      const px = Number(fontRes.value.value);
      if (Number.isFinite(px)) set({ chatFontSize: clampFontSize(px) });
    }

    if (projectListRes.status !== "fulfilled") {
      // project.list failed - can't proceed with session loading. Show empty
      // state rather than crashing into a blank screen.
      console.error("project.list failed:", projectListRes.reason);
      // Kick off deferred work even on failure (health check etc. still useful).
      queueMicrotask(() => void get().initDeferred());
      return;
    }
    const { projects } = projectListRes.value;
    set({ projects });

    if (projects.length === 0) {
      queueMicrotask(() => void get().initDeferred());
      return;
    }

    // Eagerly load the FIRST page of active sessions for every project so
    // the tree renders without a round-trip per expand. The paginated list
    // counts LOCAL threads only; worktree-bound threads are fetched in full
    // alongside (a directory holds few) and parked AFTER the local section,
    // so a project heavy with worktree threads still shows its first 5 local
    // rows without pressing "load more". The archived bin is also pre-fetched
    // (grouped by project) so the bottom section is ready.
    const { byProject, hasMoreByProject, totalByProject, archivedByProject } =
      await fetchProjectSessionBuckets(projects);

    // Pick the first non-archived project (fall back to the first project) and
    // its latest non-archived session as the landing target.
    const firstActive =
      projects.find((p) => !p.archived) ?? projects[0];
    const firstSessions = byProject[firstActive.id] ?? [];
    const firstSession = firstSessions.find((s) => !s.archived);

    // Restore the last-opened project/session (persisted on every session
    // activation) instead of always landing on the first project — so a restart
    // puts the user back where they left off. Validated against the CURRENT
    // project/session lists: a saved id that was deleted or archived since is
    // silently dropped and we fall back to the default first-project target.
    let landingProject = firstActive;
    let landingSession = firstSession;
    const lastProjectId =
      typeof fp[UI_LAST_PROJECT_SETTING_KEY] === "string" ? fp[UI_LAST_PROJECT_SETTING_KEY] : null;
    const lastSessionId =
      typeof fp[UI_LAST_SESSION_SETTING_KEY] === "string" ? fp[UI_LAST_SESSION_SETTING_KEY] : null;
    if (lastProjectId) {
      const savedProject = projects.find((p) => p.id === lastProjectId);
      if (savedProject) {
        landingProject = savedProject;
        const savedSessions = byProject[savedProject.id] ?? [];
        landingSession =
          savedSessions.find((s) => s.id === lastSessionId) ??
          savedSessions.find((s) => !s.archived);
      }
    }

    set({
      sessionsByProject: byProject,
      sessionsHasMoreByProject: hasMoreByProject,
      sessionsTotalByProject: totalByProject,
      archivedSessionsByProject: archivedByProject,
      pinnedSessions: pinnedRes.status === "fulfilled" ? pinnedRes.value.sessions : [],
      sessions: byProject[landingProject.id] ?? [],
      activeProjectId: landingProject.id,
      // Auto-expand the active project so its threads are visible on load.
      expandedProjects: { [landingProject.id]: true },
      // Seed the tab list with the landing session (if any). In `single`
      // mode this is informational; in `tabs` mode it shows the initial
      // open tab. Either way the user starts with a coherent state.
      openTabs: landingSession ? [landingSession.id] : [],
      // The project list only NOW exists — an early-mounted stream sidebar
      // (leftBarMode hydrates before this) may have fetched its first page
      // unfiltered, because the persisted scope couldn't resolve against an
      // empty project list. Re-dirty so the scope-aware fetch supersedes it.
      streamDirty: true,
    });
    if (landingSession) {
      try {
        await get().selectSession(landingSession.id);
      } catch (err) {
        console.error("selectSession failed:", err);
      }
    }

    // Kick off deferred (non-critical) hydration after first paint.
    queueMicrotask(() => void get().initDeferred());
  },

  initDeferred: async () => {
    // Custom-model configs for the model dropdown.
    void get().reloadCustomModels();

    // Registered AI backends for the provider picker.
    void get().reloadProviders();

    // Pi SDK models the user can pick from in the model dropdown. Lazy/async
    // — may take a moment on first run while the SDK loads; the dropdown
    // shows an empty state until it resolves.
    void get().reloadPiAvailableModels();
    void get().reloadCodexAvailableModels();

    // Skill list for the composer `/` menu (scans ~/.claude/skills + the
    // active project's .claude/skills).
    void get().reloadSkills();

    // Language server states (install/running) for the settings panel + Monaco.
    // Desktop-only: the web shim exposes no `api.lsp` surface (no editor /
    // settings panel on mobile), so skip it to avoid a spurious load error.
    if (isElectron) {
      void get().reloadLspLanguages();
      // Agent runtime availability (claude/codex/pi) — the composer's provider
      // dropdown greys out providers whose runtime isn't usable, so it needs
      // this at startup, not only when the settings panel mounts.
      void get().reloadRuntimes();
      // Track the language-server lifecycle per (workspace, language) so the
      // editor toolbar can show a loading indicator while a server starts
      // (Java's jdtls can take minutes to import a project) and a failure
      // notice when it can't start. App-lifetime subscription — no teardown.
      api.on.lspEvent((msg) => {
        if (msg.type !== "stateChanged") return;
        const p = msg.payload as LspStateChangedPayload;
        if (
          !p ||
          (p.phase !== "starting" &&
            p.phase !== "running" &&
            p.phase !== "stopped" &&
            p.phase !== "importing")
        )
          return;
        set((s) => ({
          lspPhasesByWorkspace: {
            ...s.lspPhasesByWorkspace,
            [`${msg.workspacePath}::${msg.language}`]: { phase: p.phase, error: p.error, detail: p.detail },
          },
        }));
      });
    }

    // Deferred settings: one bulk read for everything non-critical-paint
    // (appearance, pane widths, IDE/git prefs). One IPC instead of four
    // sequential awaits that each did their own Promise.all internally.
    const ds = await api.setting
      .getMany({
        keys: [
          UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
          UI_USER_MSG_COLOR_SETTING_KEY,
          UI_ACCENT_COLOR_SETTING_KEY,
          UI_EDITOR_THEME_SETTING_KEY,
          UI_SHORTCUTS_SETTING_KEY,
          UI_PANE_WIDTHS_SETTING_KEY,
          UI_RIGHT_PANEL_TAB_SETTING_KEY,
          UI_IDE_OPEN_FILES_SETTING_KEY,
          UI_IDE_ACTIVE_FILE_SETTING_KEY,
          UI_IDE_EXPANDED_DIRS_SETTING_KEY,
          UI_IDE_EDITOR_MODE_SETTING_KEY,
          UI_GIT_DIFF_OPEN_MODE_SETTING_KEY,
          UI_COMMIT_GEN_MODEL_SETTING_KEY,
          UI_COMMIT_GEN_PROMPT_SETTING_KEY,
          UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY,
          UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY,
          UI_TITLE_GEN_ENABLED_SETTING_KEY,
          UI_TITLE_GEN_MODEL_SETTING_KEY,
          AGENT_OUTPUT_STYLE_SETTING_KEY,
          UI_GIT_COLLAPSED_REPOS_SETTING_KEY,
          UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY,
          UI_VOICE_LANG_SETTING_KEY,
          UI_VOICE_ENGINE_SETTING_KEY,
          UI_VOICE_MIC_PERMISSION_SETTING_KEY,
          UI_VOICE_MODEL_DIR_SETTING_KEY,
          AUTO_ARCHIVE_SETTING_KEY,
          UI_GESTURES_SETTING_KEY,
          WORKFLOW_MAX_PARALLEL_SETTING_KEY,
        ],
      })
      .catch((err) => {
        console.error("setting.getMany(deferred) failed:", err);
        return {} as Record<string, string | null>;
      });

    // Appearance extras (right-panel font size, user-message bg, accent color).
    // chatFontSize was already loaded in init() - only the rest here.
    try {
      const rpFontRaw = ds[UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY];
      if (rpFontRaw != null) {
        const px = Number(rpFontRaw);
        if (Number.isFinite(px)) set({ rightPanelFontSize: clampRightPanelFontSize(px) });
      }
      const pasteThresholdRaw = ds[UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY];
      if (pasteThresholdRaw != null) {
        const n = Number(pasteThresholdRaw);
        if (Number.isFinite(n)) set({ pasteTagThresholdChars: clampPasteTagThresholdChars(n) });
      }
      const maxParallelRaw = ds[WORKFLOW_MAX_PARALLEL_SETTING_KEY];
      if (maxParallelRaw != null) {
        const n = Number(maxParallelRaw);
        if (Number.isFinite(n)) set({ workflowMaxParallel: clampWorkflowMaxParallel(n) });
      }
      const colorRaw = ds[UI_USER_MSG_COLOR_SETTING_KEY];
      if (colorRaw && RGB_TRIPLET_RE.test(colorRaw)) set({ userMessageColor: colorRaw });
      const accentRaw = ds[UI_ACCENT_COLOR_SETTING_KEY];
      if (accentRaw && RGB_TRIPLET_RE.test(accentRaw)) set({ accentColor: accentRaw });
      // Editor color scheme (per-mode Monaco theme ids; unknown ids inside a
      // corrupt row fall back to the defaults field-by-field).
      if (ds[UI_EDITOR_THEME_SETTING_KEY] != null) {
        set({ editorTheme: parseEditorThemeChoice(ds[UI_EDITOR_THEME_SETTING_KEY]) });
      }
      // Voice-input prefs. Validate against the schemas so a corrupt row can't
      // crash the store; keep defaults otherwise.
      const voiceLangRaw = ds[UI_VOICE_LANG_SETTING_KEY];
      if (voiceLangRaw && voiceLangRaw.length <= 20) set({ voiceLang: voiceLangRaw });
      const voiceEngineRaw = ds[UI_VOICE_ENGINE_SETTING_KEY];
      if (voiceEngineRaw === "zipformer" || voiceEngineRaw === "parakeet") {
        set({ voiceEngine: voiceEngineRaw });
      }
      const voiceMicRaw = ds[UI_VOICE_MIC_PERMISSION_SETTING_KEY];
      if (voiceMicRaw === "granted" || voiceMicRaw === "denied") set({ voiceMicPermission: voiceMicRaw });
      const voiceModelDirRaw = ds[UI_VOICE_MODEL_DIR_SETTING_KEY];
      if (voiceModelDirRaw) set({ voiceModelDir: voiceModelDirRaw });
      // Mic visibility: a model must be selected AND on disk — modelList
      // rescans the root, so this is authoritative, not just the setting row.
      void get().refreshVoiceModelStatus();
      // Shortcut overrides — parsed from the ui.shortcuts JSON blob.
      // safeParse rejects malformed blobs so a corrupt row can't crash the
      // store; on failure we keep the empty default (all defaults apply).
      const shortcutsRaw = ds[UI_SHORTCUTS_SETTING_KEY];
      if (shortcutsRaw) {
        const parsed = ShortcutBindingsSchema.safeParse(JSON.parse(shortcutsRaw));
        if (parsed.success) set({ shortcutOverrides: parsed.data });
      }
      // Mouse gestures — same overrides-only pattern as shortcuts; safeParse
      // rejects malformed blobs so a corrupt row can't crash the store.
      const gesturesRaw = ds[UI_GESTURES_SETTING_KEY];
      if (gesturesRaw) {
        const parsed = GestureSettingsSchema.safeParse(JSON.parse(gesturesRaw));
        if (parsed.success) set({ gestureSettings: parsed.data });
      }
    } catch (err) {
      console.error("apply(appearance deferred) failed:", err);
    }

    // Session auto-archive rules (JSON blob). parseAutoArchiveConfig never
    // throws — malformed rows fall back to the disabled default.
    const autoArchiveRaw = ds[AUTO_ARCHIVE_SETTING_KEY];
    if (autoArchiveRaw) set({ autoArchiveConfig: parseAutoArchiveConfig(autoArchiveRaw) });

    // Draggable pane widths (one JSON blob).
    try {
      const paneRaw = ds[UI_PANE_WIDTHS_SETTING_KEY];
      if (paneRaw) {
        const parsed = JSON.parse(paneRaw) as Partial<{
          leftPct: number; right: number; bottomTerminal: number; editor: number;
        }>;
        const patch: Partial<SessionState> = {};
        if (parsed && typeof parsed === "object") {
          // Only `leftPct` is read — the legacy `left` (px) field from the old
          // fixed-width layout is deliberately dropped; the redesigned 3:7
          // layout starts everyone at the percentage default.
          if (Number.isFinite(parsed.leftPct)) patch.leftWidthPct = clampLeftWidthPct(parsed.leftPct!);
          if (Number.isFinite(parsed.right)) {
            // Clamp against the live row width so a width dragged up to the
            // 2:8 cap survives a restart (the fixed 640px cap is gone).
            const leftPct = Number.isFinite(parsed.leftPct)
              ? parsed.leftPct!
              : get().leftWidthPct;
            patch.rightWidth = clampRightWidth(
              parsed.right!,
              centerRightRowWidth(get().leftOpen, leftPct),
            );
          }
          if (Number.isFinite(parsed.bottomTerminal)) {
            patch.bottomTerminalHeight = clampBottomTerminalHeight(parsed.bottomTerminal!);
          }
          if (Number.isFinite(parsed.editor)) patch.editorWidthPct = clampEditorWidthPct(parsed.editor!);
          if (Object.keys(patch).length > 0) set(patch);
        }
      }
    } catch (err) {
      console.error("apply(paneWidths) failed:", err);
    }

    // IDE right-panel prefs (active tab, open files, active file, expanded tree
    // dirs, editor mode, diff mode, commit-gen model/prompt, custom commands,
    // conflict-resolve model). All optional JSON-in-settings.
    try {
      const tabRaw = ds[UI_RIGHT_PANEL_TAB_SETTING_KEY];
      const openRaw = ds[UI_IDE_OPEN_FILES_SETTING_KEY];
      const activeRaw = ds[UI_IDE_ACTIVE_FILE_SETTING_KEY];
      const dirsRaw = ds[UI_IDE_EXPANDED_DIRS_SETTING_KEY];
      const modeRaw = ds[UI_IDE_EDITOR_MODE_SETTING_KEY];
      const diffModeRaw = ds[UI_GIT_DIFF_OPEN_MODE_SETTING_KEY];
      const commitModelRaw = ds[UI_COMMIT_GEN_MODEL_SETTING_KEY];
      const commitPromptRaw = ds[UI_COMMIT_GEN_PROMPT_SETTING_KEY];
      const commandsByProjectRaw = ds[UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY];
      const conflictModelRaw = ds[UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY];
      const titleGenEnabledRaw = ds[UI_TITLE_GEN_ENABLED_SETTING_KEY];
      const titleGenModelRaw = ds[UI_TITLE_GEN_MODEL_SETTING_KEY];

      // ⚠️ 白名单**直接从 `RightPanelTabSchema` 派生**,不再手抄一份枚举 —— 手抄那份
      // 与 schema 漂过一次(`browser` 只加进 schema、忘了这一行,用户选了它重启后右栏
      // **悄悄**回到 files,没有报错也没有日志)。schema 是契约里那份真相,这里引用它
      // 就不可能再漏。
      const rightPanelTabValues = RightPanelTabSchema.options as readonly string[];
      if (typeof tabRaw === "string" && rightPanelTabValues.includes(tabRaw))
        set({ rightPanelTab: tabRaw as RightPanelTab });
      // **存量的 `sidechat` 折成 `flow`**（2026-09-21）：子对话列表并进了「工作流运行」
      // 那张面板的下半部分，独立的 tab 已删。老用户设置表里存的就是 `sidechat` ——
      // 直接不管它会让右栏落到**默认的 files**（上面那个白名单不收它），用户重开
      // 发现"我上次停在的那个面板没了"。折过去，落点才对。
      else if (tabRaw === "sidechat") set({ rightPanelTab: "flow" });
      if (modeRaw === "tabs" || modeRaw === "replace") set({ ideEditorMode: modeRaw });
      if (diffModeRaw === "center" || diffModeRaw === "dialog") set({ gitDiffOpenMode: diffModeRaw });
      set({ commitGenModel: commitModelRaw || null });
      if (commitPromptRaw) set({ commitGenPrompt: commitPromptRaw });
      set({ conflictResolveModel: conflictModelRaw || null });
      set({ titleGenEnabled: titleGenEnabledRaw === "on" });
      set({ titleGenModel: titleGenModelRaw || null });
      const outputStyleRaw = ds[AGENT_OUTPUT_STYLE_SETTING_KEY];
      set({ outputStyle: outputStyleRaw || null });
      const parseBucket = <T>(raw: string | null): Record<string, T> => {
        if (!raw) return {};
        try {
          const obj = JSON.parse(raw);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, T>;
        } catch {
          /* malformed JSON - leave empty */
        }
        return {};
      };
      const parsedOpen = parseBucket<string[]>(openRaw);
      const parsedActive = parseBucket<string | null>(activeRaw);
      const parsedDirs = parseBucket<string[]>(dirsRaw);
      // Apply IDE file/dir state, dropping paths that belong to no project.
      const projects = get().projects;
      const projectById = new Map(projects.map((p) => [p.id, p]));
      const filterProjectPaths = (pid: string, paths: string[]) => {
        const proj = projectById.get(pid);
        if (!proj) return [];
        return paths.filter((p) => isPathWithinRoot(proj.path, p));
      };
      const openByProject: Record<string, string[]> = {};
      const activeByProject: Record<string, string | null> = {};
      const dirsByProject: Record<string, string[]> = {};
      for (const pid of Object.keys(parsedOpen)) {
        const filtered = filterProjectPaths(pid, parsedOpen[pid] ?? []);
        if (filtered.length > 0) openByProject[pid] = filtered;
      }
      for (const pid of Object.keys(parsedActive)) {
        const proj = projectById.get(pid);
        const active = parsedActive[pid];
        if (proj && active && isPathWithinRoot(proj.path, active)) {
          const open = openByProject[pid] ?? [];
          activeByProject[pid] = open.includes(active) ? active : (open[0] ?? null);
        }
      }
      for (const pid of Object.keys(parsedDirs)) {
        const filtered = filterProjectPaths(pid, parsedDirs[pid] ?? []);
        if (filtered.length > 0) dirsByProject[pid] = filtered;
      }
      set({
        ideOpenFilesByProject: openByProject,
        ideActiveFileByProject: activeByProject,
        ideExpandedDirsByProject: dirsByProject,
      });
      // Per-project terminal quick-commands.
      set({ customCommandsByProject: parseCustomCommandsByProject(commandsByProjectRaw) });
    } catch (err) {
      console.error("apply(ide deferred) failed:", err);
    }

    // Collapsed git repo card states.
    try {
      const raw = ds[UI_GIT_COLLAPSED_REPOS_SETTING_KEY];
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          set({ collapsedGitRepos: parsed as Record<string, boolean> });
        }
      }
    } catch (err) {
      console.error("apply(gitCollapsedRepos) failed:", err);
    }
  },

  addProjectFromFolder: async () => {
    const { path } = await api.pickFolder();
    if (!path) return null;

    // Normalize the chosen path so the same folder isn't imported twice under
    // different surface forms (drive-letter case, forward vs. back slashes,
    // trailing separator). Comparison is case-insensitive on Windows/macOS
    // where the filesystem is case-insensitive; on Linux paths stay as-is
    // (toLowerCase on a Linux path would wrongly merge distinct folders, but
    // it's harmless there because the only difference is the slashes).
    const normalize = (p: string) =>
      p
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
    const normalized = normalize(path);

    // An existing project already points at this folder. Don't create a
    // duplicate - just activate it (restoring if it was archived) so the user
    // lands on the folder they picked without a second entry.
    const existing = get().projects.find((p) => normalize(p.path) === normalized);
    if (existing) {
      if (existing.archived) {
        await get().archiveProject(existing.id, false);
      }
      await get().selectProject(existing.id);
      return existing.id;
    }

    const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
    const { project } = await api.project.create({ name, path });
    set((s) => ({
      // 主进程的 projects.changed 可能比这里先到、refreshProjects 已经把它加进来了
      // —— 去重,不然左栏会出现两行同一个项目。
      projects: [...s.projects.filter((p) => p.id !== project.id), project],
      sessionsByProject: { ...s.sessionsByProject, [project.id]: s.sessionsByProject[project.id] ?? [] },
      sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [project.id]: false },
      sessionsTotalByProject: { ...s.sessionsTotalByProject, [project.id]: 0 },
      activeProjectId: project.id,
      sessions: [],
      activeSessionId: null,
      // Expand the newly added project.
      expandedProjects: { ...s.expandedProjects, [project.id]: true },
    }));
    // Load skills for the freshly activated project's `/` menu.
    void get().reloadSkills();
    // Fresh Java workspace → start its import immediately in the background.
    get().prewarmJavaLspForActiveProject();
    return project.id;
  },

  /** Switch the active project and (re)load its session list from cache. */
  selectProject: async (projectId) => {
    const sessions = get().sessionsByProject[projectId] ?? [];
    // Pick the latest non-archived session of this project to land on.
    // Pinned rows aren't in the project's list (they render in the global
    // pinned section) — fall back to the project's most recent pinned row
    // so a project whose threads are ALL pinned still lands on one instead
    // of the empty state.
    const next =
      sessions.find((s) => !s.archived) ??
      get().pinnedSessions.find((s) => s.projectId === projectId && !s.archived);
    set((s) => ({
      activeProjectId: projectId,
      sessions,
      activeSessionId: next?.id ?? null,
      expandedProjects: { ...s.expandedProjects, [projectId]: true },
      // Switching projects is a hard reset of the tab strip — tabs belong to
      // a project, so we don't carry them across. The new project lands on
      // its own first session.
      openTabs: next ? [next.id] : [],
    }));
    // Catch up the worktree section for the newly selected project (see
    // toggleProjectExpanded — incremental echoes in between, refetch here).
    void get().loadWorktreeSessions(projectId);
    // An explicit project selection is the new "where I am" — remember it as
    // the next launch's landing project. A project WITH sessions persists via
    // selectSession → syncConfigFromSession below; an EMPTY project otherwise
    // silently fell back to the first project on restart.
    saveSetting({ key: UI_LAST_PROJECT_SETTING_KEY, value: projectId });
    if (next) {
      await get().selectSession(next.id);
    }
    // Skills are project-scoped (project's .claude/skills overlays the global
    // dir), so refresh the composer `/` menu for the newly active project.
    void get().reloadSkills();
    // Start the Java import for the newly active project in the background
    // so opening a Java file later doesn't wait behind it.
    get().prewarmJavaLspForActiveProject();
  },

  toggleProjectExpanded: (projectId) => {
    const wasExpanded = !!get().expandedProjects[projectId];
    set((s) => {
      // Collapsing resets the per-project pagination cache back to the first
      // page so the next expand shows the initial slice again (instead of the
      // full list accumulated by "加载更多"). The server-side total is
      // unchanged, so `hasMore` is recomputed from it; the list is trimmed in
      // place — no IPC, no flicker. The trim keeps the array head, i.e. the
      // LOCAL section; worktree rows past the page may linger until the
      // expand-path refetch below restores the full section.
      if (!wasExpanded) {
        return {
          expandedProjects: { ...s.expandedProjects, [projectId]: true },
        };
      }
      const prevList = s.sessionsByProject[projectId] ?? EMPTY_SESSIONS;
      const total = s.sessionsTotalByProject[projectId] ?? prevList.length;
      // Reset ONLY the local section's pagination cache — the worktree
      // section is not paginated, so there is nothing to reset there, and
      // trimming it away would evict OPEN worktree threads from the cache:
      // tab / toolbar titles resolve by id against these caches (the stream
      // fallback is stale or empty in tree mode), so a trimmed row renders
      // "(unknown)" and syncConfigFromSession silently no-ops (reproduced:
      // open a worktree thread → collapse its project).
      const { local, worktree } = splitSessionSections(prevList);
      const trimmed = [...local.slice(0, SESSION_PAGE_SIZE), ...worktree];
      const isActive = projectId === s.activeProjectId;
      return {
        expandedProjects: { ...s.expandedProjects, [projectId]: false },
        sessionsByProject: { ...s.sessionsByProject, [projectId]: trimmed },
        sessionsHasMoreByProject: {
          ...s.sessionsHasMoreByProject,
          [projectId]: total > SESSION_PAGE_SIZE,
        },
        sessions: isActive ? trimmed : s.sessions,
      };
    });
    // Expanding refreshes the worktree section: `session.changed` echoes
    // maintain it incrementally in between, and this is the cheap catch-up
    // that also re-syncs its updated_at order after local mutations.
    if (!wasExpanded) void get().loadWorktreeSessions(projectId);
  },

  // Worktree group nodes hold few sessions (one directory, few threads), so
  // unlike toggleProjectExpanded there is no pagination cache to reset — a
  // pure expand-state flip. Groups render COLLAPSED by default (absent key),
  // so the flip tests plain truthiness: flipping an untouched (undefined)
  // group OPENS it, flipping an open one folds it back.
  toggleWorktreeExpanded: (worktreePath) =>
    set((s) => {
      const key = normWorktreeKey(worktreePath);
      return {
        expandedWorktrees: { ...s.expandedWorktrees, [key]: !s.expandedWorktrees[key] },
      };
    }),

  setProjectWorktreeView: (projectId, on) =>
    set((s) => {
      if (!!s.worktreeViewByProject[projectId] === on) return s;
      return { worktreeViewByProject: { ...s.worktreeViewByProject, [projectId]: on } };
    }),

  renameWorktree: async (worktreePath, name) => {
    const key = normWorktreeKey(worktreePath);
    const trimmed = name.trim();
    const next = { ...get().worktreeNames };
    if (trimmed) next[key] = trimmed;
    else delete next[key];
    // Optimistic local patch — the group header renames immediately; the
    // settings write is fire-and-forget (a failed write costs the name on
    // next boot, same trade-off as the other cosmetic settings).
    set({ worktreeNames: next });
    try {
      await api.setting.set({ key: WORKTREE_NAMES_SETTING_KEY, value: JSON.stringify(next) });
    } catch (err) {
      console.error("setting.set(worktreeNames) failed:", err);
    }
  },

  setArchivedViewOpen: (open) => set({ archivedViewOpen: open }),

  /** Fetch the next page of active LOCAL sessions for a project and append
   *  to the cached list's local section (the worktree section parked after
   *  it is untouched). Updates `hasMore` / `total` from the server response
   *  so the "加载更多" affordance reflects the truth. No-op when nothing
   *  more to load. */
  loadMoreSessions: async (projectId) => {
    if (!get().sessionsHasMoreByProject[projectId]) return;
    // The offset counts LOCAL rows only — the worktree section after them is
    // not part of this list's pagination.
    const offset = splitSessionSections(get().sessionsByProject[projectId] ?? []).local.length;
    const page = await api.project.sessions({
      projectId,
      limit: SESSION_PAGE_SIZE,
      offset,
      archived: false,
      worktree: "exclude",
    });
    set((s) => {
      const { local, worktree } = splitSessionSections(s.sessionsByProject[projectId] ?? []);
      // De-dup in case a session was created mid-fetch (newest-first means
      // newly-created rows would slide in ahead of the next page; we drop
      // any overlap by id rather than risk showing a row twice).
      const seen = new Set(local.map((x) => x.id));
      const merged = [...local, ...page.sessions.filter((x) => !seen.has(x.id)), ...worktree];
      const isActive = projectId === s.activeProjectId;
      return {
        sessionsByProject: { ...s.sessionsByProject, [projectId]: merged },
        sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: page.hasMore },
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: page.total },
        sessions: isActive ? merged : s.sessions,
      };
    });
  },

  loadWorktreeSessions: async (projectId) => {
    const seq = (worktreeFetchSeq[projectId] ?? 0) + 1;
    worktreeFetchSeq[projectId] = seq;
    const res = await api.project.sessions({
      projectId,
      archived: false,
      worktree: "only",
      limit: WORKTREE_SESSIONS_FETCH_LIMIT,
    });
    set((s) => {
      // A newer fetch for this project superseded us — applying would revert it.
      if (worktreeFetchSeq[projectId] !== seq) return {};
      const prev = s.sessionsByProject[projectId];
      if (!prev) return {}; // cache not loaded yet — init brings both sections
      const { local, worktree } = splitSessionSections(prev);
      // Union with rows that landed in the section while this fetch was in
      // flight (echo-inserted after the server snapshot) — the next full
      // fetch prunes them for real if they no longer belong.
      // 只收真带 worktreePath、且不在本地段里的行(同 fetchProjectSessionBuckets 的防御)。
      const localIds = new Set(local.map((x) => x.id));
      const fetched = res.sessions.filter((x) => x.worktreePath && !localIds.has(x.id));
      const fetchedIds = new Set(fetched.map((x) => x.id));
      const strays = worktree.filter((x) => !fetchedIds.has(x.id));
      const merged = [...local, ...fetched, ...strays];
      if (merged.length === prev.length && merged.every((x, i) => x === prev[i])) return {};
      const isActive = projectId === s.activeProjectId;
      return {
        sessionsByProject: { ...s.sessionsByProject, [projectId]: merged },
        sessions: isActive ? merged : s.sessions,
      };
    });
  },

  startSession: async (projectIdArg, overrides) => {
    const projectId = projectIdArg ?? get().activeProjectId;
    if (!projectId) return;
    // `overrides` (plan handoff) replaces the composer-slot defaults for this
    // creation only — the slots themselves are re-synced from the new session
    // row below, so the foreground chips match the thread the user lands on.
    const model = overrides?.model ?? get().model;
    const { session } = await api.claude.startSession({
      projectId,
      kind: "chat",
      providerId: overrides?.providerId ?? get().providerId,
      model: model !== "default" ? model : undefined,
      effort: get().effort,
      permissionMode: get().permissionMode,
      // Working-environment intent from the composer chip — materialized on
      // the first turn (see sendTurn's resolveSessionCwd), never here. An
      // explicit worktreePath (LeftBar "在此工作树中新建会话") BINDS the new
      // session to an existing managed checkout instead of creating one (the
      // checkout's own form applies; wtStyle is moot for binds). `envMode`
      // override wins over the chip (conflict-resolution sessions force
      // "local" — the agent must work in the real checkout, not a worktree).
      envMode:
        overrides?.envMode ??
        (overrides?.worktreePath || get().envChoice !== "local" ? "worktree" : "local"),
      wtStyle:
        !overrides?.envMode &&
        !overrides?.worktreePath &&
        get().envChoice !== "local"
          ? get().envChoice === "wt-branch" ? "branch" : "detached"
          : undefined,
      worktreePath: overrides?.worktreePath,
      customModelId:
        overrides?.customModelId !== undefined ? overrides.customModelId : get().customModelId,
    });
    set((s) => {
      // Worktree-bound thread (LeftBar "在此工作树中新建会话" bind): it lands
      // in the cache's worktree SECTION, and the LOCAL list's pagination is
      // untouched — no total / hasMore churn, the 5 local rows the user is
      // looking at stay put. The `session.changed` echo may have inserted the
      // slim row into the section ahead of this resolve (events deliver ahead
      // of invoke responses) — merge, don't duplicate.
      if (session.worktreePath) {
        const { local, worktree } = splitSessionSections(s.sessionsByProject[projectId] ?? []);
        const existsWt = worktree.some((x) => x.id === session.id);
        const nextWorktree = existsWt
          ? worktree.map((x) => (x.id === session.id ? { ...x, ...session } : x))
          : [session, ...worktree];
        const merged = [...local, ...nextWorktree];
        const isactiveWt = projectId === s.activeProjectId;
        return {
          sessionsByProject: { ...s.sessionsByProject, [projectId]: merged },
          sessions: isactiveWt ? merged : s.sessions,
          activeProjectId: projectId,
          activeSessionId: session.id,
          expandedProjects: { ...s.expandedProjects, [projectId]: true },
          // The new thread's group must be visible: groups render collapsed by
          // default, so this explicit true is what opens the group the freshly
          // created thread landed in (a "+" on a folded worktree header must
          // not spawn an invisible thread).
          expandedWorktrees: {
            ...s.expandedWorktrees,
            [normWorktreeKey(session.worktreePath)]: true,
          },
          messagesBySession: { ...s.messagesBySession, [session.id]: [] },
          hasMoreMessagesBySession: { ...s.hasMoreMessagesBySession, [session.id]: false },
          // Locally-created session: the empty bucket IS the full history —
          // mark it hydrated so selectSession/openTab never re-fetch for it.
          historyLoadedBySession: { ...s.historyLoadedBySession, [session.id]: true },
          openTabs: s.openTabs.includes(session.id) ? s.openTabs : [...s.openTabs, session.id],
          centerTabFocus: "chat" as const,
        };
      }
      const prevList = s.sessionsByProject[projectId] ?? [];
      // The IPC handler broadcasts a `session.changed` event for cross-client
      // list sync BEFORE returning the invoke response, and Electron delivers
      // that event ahead of the invoke resolution — so by the time we reach
      // here the session may ALREADY be in the cache (inserted by the
      // `session.changed` reducer below). A blind prepend would then yield two
      // list entries with the same id — a duplicate-keyed phantom row React
      // renders but can't cleanly target for delete ("新建会话 生成了两个、删不掉一个").
      // Upsert instead: merge over an existing row, else prepend; and only bump
      // the total when the row is genuinely new (the event reducer already
      // counted it in that case). The merge HOISTS the row to the head: a
      // brand-new row has the newest `updated_at`, and a REUSED fresh row
      // (createOrReuseSession bumps an existing "New session" row instead of
      // creating another) may sit mid-list — leaving it there would contradict
      // the updated_at-desc order a fresh fetch would show.
      const exists = prevList.some((x) => x.id === session.id);
      const upserted = exists
        ? [
            // Merge over the cached row so heavy fields the slim `session`
            // payload lacks (contextSnapshot / turnFiles / …) survive.
            { ...(prevList.find((x) => x.id === session.id) as Session), ...session },
            ...prevList.filter((x) => x.id !== session.id),
          ]
        : [session, ...prevList];
      // New sessions are never pinned — the active list holds unpinned rows
      // only (pinned ones live in the global pinned bucket), and a new
      // session is the newest row so it lands at the head.
      const nextByProject = {
        ...s.sessionsByProject,
        [projectId]: upserted,
      };
      const isactive = projectId === s.activeProjectId;
      const prevTotal = s.sessionsTotalByProject[projectId] ?? 0;
      const nextTotal = exists ? prevTotal : prevTotal + 1;
      return {
        sessionsByProject: nextByProject,
        // A brand-new session sits at the head (newest created_at) and bumps
        // the active-thread total by one. `hasMore` flips on if the page now
        // exceeds SESSION_PAGE_SIZE — the load-more button reveals to fetch
        // the next page rather than growing the cache unbounded. Both are
        // no-ops when the row was already inserted by the ahead-of-response
        // `session.changed` event (so the count isn't double-bumped).
        sessionsTotalByProject: {
          ...s.sessionsTotalByProject,
          [projectId]: nextTotal,
        },
        sessionsHasMoreByProject: {
          ...s.sessionsHasMoreByProject,
          [projectId]: nextTotal > SESSION_PAGE_SIZE,
        },
        sessions: isactive ? nextByProject[projectId] : s.sessions,
        activeProjectId: projectId,
        activeSessionId: session.id,
        expandedProjects: { ...s.expandedProjects, [projectId]: true },
        // The new thread's side of the project view must be the visible one:
        // a worktree-bound session needs the fork view, a local one the
        // default list — otherwise the freshly activated row is invisible.
        worktreeViewByProject: {
          ...s.worktreeViewByProject,
          [projectId]: !!session.worktreePath,
        },
        // A worktree-bound new session must land inside a VISIBLE group node.
        expandedWorktrees: session.worktreePath
          ? { ...s.expandedWorktrees, [normWorktreeKey(session.worktreePath)]: true }
          : s.expandedWorktrees,
        messagesBySession: { ...s.messagesBySession, [session.id]: [] },
        hasMoreMessagesBySession: { ...s.hasMoreMessagesBySession, [session.id]: false },
        // Locally-created session: the empty bucket IS the full history — mark
        // it hydrated so selectSession/openTab never re-fetch for it.
        historyLoadedBySession: { ...s.historyLoadedBySession, [session.id]: true },
        // New session lands as a fresh tab. If it was somehow already open
        // (e.g. a duplicate id — shouldn't happen) we don't double-add.
        openTabs: s.openTabs.includes(session.id) ? s.openTabs : [...s.openTabs, session.id],
        // A brand-new session is a chat view by definition.
        centerTabFocus: "chat" as const,
      };
    });
    // With explicit overrides the new row's config differs from the composer
    // slots — re-sync so the chips reflect the session the user just landed
    // on. Skipped in the normal path (slots were the row's source anyway) to
    // keep that behavior untouched.
    if (overrides) syncConfigFromSession(set, get, session.id);
  },

  /**
   * 把一段对话复制成新的一段(右键左栏的对话 → 复制一份)。
   *
   * ## 主进程那边做了什么
   *
   * 两件事,而且顺序不能反:先在**引擎**那边把会话文件复制一份(上下文原样带过去,
   * 消息 UUID 全部重编 —— 之后两边各写各的文件),再建一条新的 Mcode 会话行、把消息
   * 行抄过去。所以这里拿到的 `session` 已经是一个**带着历史和上下文**的完整对话。
   *
   * ## 与 `startSession` 最关键的一处不同
   *
   * **不能把 `historyLoadedBySession` 标成 true。** 那个标志的意思是"这个会话一个 token
   * 都还没发过,空桶就是它的全部历史"(见 `startSession` 里那条注释)。复制来的会话恰恰
   * 相反 —— 它的历史在库里躺着,标成已加载会让打开的那一屏**是空的**,而用户明明刚
   * 看着那段对话复制的。
   */
  forkSession: async (sessionId, title) => {
    let fork: Session;
    try {
      ({ session: fork } = await api.session.fork({ id: sessionId, title }));
    } catch (err) {
      // 分叉会失败得很具体(引擎不支持、会话文件不在了),而那正是用户唯一能据此
      // 做点什么的信息 —— 不能只吞掉了事。
      useToastStore.getState().push({
        kind: "error",
        title: translate(get().locale, "store.toast.forkFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const projectId = fork.projectId;
    set((s) => {
      // 与 `startSession` 的本地那一支同一套写法 —— 包括"`session.changed` 的广播可能
      // 已经先一步把这一行插进去了,所以这里是 upsert 而不是 prepend"。那一段的来龙去脉
      // (以及为什么必须是 upsert)见 `startSession`。
      const prevList = s.sessionsByProject[projectId] ?? [];
      const cached = prevList.find((x) => x.id === fork.id);
      const upserted = cached
        ? [{ ...cached, ...fork }, ...prevList.filter((x) => x.id !== fork.id)]
        : [fork, ...prevList];
      const nextByProject = { ...s.sessionsByProject, [projectId]: upserted };
      const prevTotal = s.sessionsTotalByProject[projectId] ?? 0;
      const nextTotal = cached ? prevTotal : prevTotal + 1;
      const isactive = projectId === s.activeProjectId;
      return {
        sessionsByProject: nextByProject,
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: nextTotal },
        sessionsHasMoreByProject: {
          ...s.sessionsHasMoreByProject,
          [projectId]: nextTotal > SESSION_PAGE_SIZE,
        },
        sessions: isactive ? nextByProject[projectId] : s.sessions,
        activeProjectId: projectId,
        expandedProjects: { ...s.expandedProjects, [projectId]: true },
        // 分叉出来的那一段跟源在同一台工作树里(主进程照抄了目录设置),所以左栏要
        // 停在能看见它的那一侧 —— 与 `startSession` 里同一条理由。
        worktreeViewByProject: {
          ...s.worktreeViewByProject,
          [projectId]: !!fork.worktreePath,
        },
        expandedWorktrees: fork.worktreePath
          ? { ...s.expandedWorktrees, [normWorktreeKey(fork.worktreePath)]: true }
          : s.expandedWorktrees,
      };
    });
    // 打开它 —— `openTab` 会顺带把复制过来的那一段历史拉下来(上面刻意没标"已加载")
    // 并按新行的配置同步那几个前台开关。
    await get().openTab(fork.id);
  },

  /** Re-aim a fresh local session at another project (composer directory
   *  switcher). The main handler validates (no messages, un-materialized,
   *  existing target) and broadcasts `session.changed` for the moved row —
   *  which lands BEFORE this invoke resolves (same ordering startSession
   *  documents), so the echo has already upserted the slim row into the NEW
   *  project's loaded bucket. What the echo does NOT do is evict the row
   *  from the OLD project's cache — that cleanup lives here, totals
   *  included. */
  moveSession: async (sessionId, toProjectId) => {
    const sess = findSession(
      get().sessionsByProject,
      get().archivedSessionsByProject,
      get().pinnedSessions,
      get().streamSessions,
      sessionId,
    );
    if (!sess || sess.projectId === toProjectId) return;
    const fromProjectId = sess.projectId;
    try {
      await api.session.updateSettings({ sessionId, projectId: toProjectId });
    } catch (err) {
      // 主进程在"已经有消息 / 已物化工作树"时会拒这次目录切换(守卫在
      // `SESSION_UPDATE_SETTINGS`)。从前的裸 `console.error` 意味着:菜单关了、
      // 目录没变、屏幕上一句话没有 —— 用户以为切过去了。
      console.error("moveSession: updateSettings rejected the move:", err);
      useToastStore.getState().push({
        kind: "error",
        title: translate(useSessionStore.getState().locale, "chat.directory.moveFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    set((s) => {
      const fromList = s.sessionsByProject[fromProjectId];
      if (!fromList) return {};
      const nextFrom = fromList.filter((x) => x.id !== sessionId);
      if (nextFrom.length === fromList.length) return {};
      // Totals count LOCAL rows only — evicting a worktree-bound row (it sat
      // in the cache's worktree section) leaves them untouched.
      const movedIsLocal = !sess.worktreePath;
      const total = movedIsLocal
        ? Math.max((s.sessionsTotalByProject[fromProjectId] ?? 0) - 1, 0)
        : (s.sessionsTotalByProject[fromProjectId] ?? 0);
      return {
        sessionsByProject: { ...s.sessionsByProject, [fromProjectId]: nextFrom },
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [fromProjectId]: total },
        sessionsHasMoreByProject: {
          ...s.sessionsHasMoreByProject,
          [fromProjectId]: movedIsLocal ? total > SESSION_PAGE_SIZE : (s.sessionsHasMoreByProject[fromProjectId] ?? false),
        },
        // `sessions` mirrors the ACTIVE project's bucket — refresh it when
        // the eviction touched that project.
        sessions: s.activeProjectId === fromProjectId ? nextFrom : s.sessions,
        streamDirty: true,
      };
    });
    // The active thread moved: follow it into the new project and make sure
    // its first page is loaded (the echo SKIPS unloaded buckets).
    if (get().activeSessionId === sessionId) {
      set({ activeProjectId: toProjectId });
      // The directory chip's project pick is an explicit "I work here now" —
      // record it as the next launch's landing spot. The UI_LAST_* pair is
      // otherwise only written by syncConfigFromSession (session ACTIVATION),
      // which a move doesn't trigger — without this, a restart would land on
      // the pre-move project and a new session would default there instead
      // of the project the user chose in the new-session panel.
      saveSetting({ key: UI_LAST_PROJECT_SETTING_KEY, value: toProjectId });
      saveSetting({ key: UI_LAST_SESSION_SETTING_KEY, value: sessionId });
      try {
        const page = await api.project.sessions({
          projectId: toProjectId,
          limit: SESSION_PAGE_SIZE,
          offset: 0,
          archived: false,
          worktree: "exclude",
        });
        set((s) => {
          // The fresh local page replaces the local section; the worktree
          // section is preserved (the moved row, if worktree-bound, arrived
          // here via the `session.changed` echo and must survive the reload).
          const prevWt = splitSessionSections(s.sessionsByProject[toProjectId] ?? []).worktree;
          const merged = [...page.sessions, ...prevWt];
          return {
            sessionsByProject: { ...s.sessionsByProject, [toProjectId]: merged },
            sessionsTotalByProject: { ...s.sessionsTotalByProject, [toProjectId]: page.total },
            sessionsHasMoreByProject: {
              ...s.sessionsHasMoreByProject,
              [toProjectId]: page.hasMore,
            },
            sessions: s.activeProjectId === toProjectId ? merged : s.sessions,
          };
        });
      } catch (err) {
        console.error("moveSession: project.sessions reload failed:", err);
      }
    }
  },

  /** Activate an existing session and load its persisted history.
   *  Per-thread config (model / effort / permissionMode / customModelId) is
   *  hydrated from the session row via `syncConfigFromSession` BEFORE the
   *  activeSessionId flip — that way the chip components see the right
   *  values on their next render and never show the previous thread's
   *  config as a flash while messages are still loading.
   *
   *  Pure focus switch: doesn't touch the tab strip or any per-session
   *  data buckets. The user can flip between already-open tabs (in
   *  `tabs` mode) or between arbitrary sessions (in `single` mode) with
   *  the same code path. */
  selectSession: async (sessionId) => {
    syncConfigFromSession(set, get, sessionId);
    hydrateContextSnapshot(set, get, sessionId);
    hydrateCapsule(set, get, sessionId);
    hydrateTurnFiles(set, get, sessionId);
    hydrateUsageHistory(set, get, sessionId);
    hydrateBookmarks(set, get, sessionId);
    hydrateSubagentTranscripts(set, get, sessionId);
    set((s) => {
      // Clear the unread badge - the user is now looking at this session.
      // Activating a session also pulls the unified center bar back to the
      // chat view (tabs displayMode).
      if (!s.unreadBySession[sessionId])
        return { activeSessionId: sessionId, centerTabFocus: "chat" as const };
      const unreadBySession = { ...s.unreadBySession };
      delete unreadBySession[sessionId];
      return { activeSessionId: sessionId, unreadBySession, centerTabFocus: "chat" as const };
    });
    // Gate on the hydration flag, NOT bucket existence: a bucket may already
    // exist having been created by ingestEvent from another client's turn
    // (mobile companion) — it holds only the live event window and must not
    // suppress loading the full persisted history. See prefetchSessionMessages.
    if (get().historyLoadedBySession[sessionId]) return;
    void get().prefetchSessionMessages(sessionId);
  },

  /** Open a session as a tab. Already-open tabs simply become active; new
   *  ones get appended. Both display modes call this; the difference is
   *  purely cosmetic (the tab strip only renders in `tabs` mode).
   *
   *  The full logic chain matches `selectSession` (sync config + load
   *  history) so the first time a tab opens, its messages show up. */
  openTab: async (sessionId) => {
    syncConfigFromSession(set, get, sessionId);
    hydrateContextSnapshot(set, get, sessionId);
    hydrateCapsule(set, get, sessionId);
    hydrateTurnFiles(set, get, sessionId);
    hydrateUsageHistory(set, get, sessionId);
    hydrateBookmarks(set, get, sessionId);
    hydrateSubagentTranscripts(set, get, sessionId);
    set((s) => {
      // Clear the unread badge - the user is now looking at this session.
      const unreadBySession = { ...s.unreadBySession };
      delete unreadBySession[sessionId];
      return {
        activeSessionId: sessionId,
        // Append only if not already present; preserves the order in which
        // tabs were opened (newer tabs on the right).
        openTabs: s.openTabs.includes(sessionId) ? s.openTabs : [...s.openTabs, sessionId],
        unreadBySession,
        // Opening/activating a session tab shows its chat in the center.
        centerTabFocus: "chat" as const,
      };
    });
    // Same hydration-flag gate as selectSession — an event-created partial
    // bucket (another client's turn) must not suppress the history fetch.
    if (!get().historyLoadedBySession[sessionId]) {
      void get().prefetchSessionMessages(sessionId);
    }
  },

  /** Shared first-page history fetch behind selectSession / openTab / hover
   *  prefetch. Tracks in-flight state in `loadingMessagesBySession` so the
   *  ChatPane can distinguish "history loading" (skeleton) from "thread
   *  genuinely empty" (welcome screen), and dedupes concurrent callers.
   *
   *  When a live bucket already exists (created by ingestEvent from a turn
   *  driven by ANOTHER client — e.g. the mobile companion — before this
   *  client ever opened the thread), the fetched page is MERGED with it
   *  instead of replacing it: shared ids keep the live copy (fresher stream
   *  state than the persisted row mid-turn), live-only messages append, and
   *  the union is re-sorted by the same (createdAt, id) key the DB pages by.
   *  This is what makes "chat on the phone → come back to the PC" show the
   *  full thread instead of just the phone-driven tail. */
  prefetchSessionMessages: async (sessionId) => {
    if (get().historyLoadedBySession[sessionId]) return;
    if (get().loadingMessagesBySession[sessionId]) return;
    set((s) => ({
      loadingMessagesBySession: { ...s.loadingMessagesBySession, [sessionId]: true },
    }));
    try {
      const { messages, hasMore } = await api.session.messages({
        sessionId,
        limit: MESSAGE_PAGE_SIZE,
      });
      const fetched = fromRecords(messages);
      const live = get().messagesBySession[sessionId];
      let merged: ChatMessage[];
      if (live && live.length > 0) {
        const byId = new Map(fetched.map((m) => [m.id, m]));
        const extras: ChatMessage[] = [];
        for (const m of live) {
          if (byId.has(m.id)) byId.set(m.id, m);
          else extras.push(m);
        }
        merged = [...byId.values(), ...extras].sort(
          (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      } else {
        merged = fetched;
      }
      set((s) => ({
        messagesBySession: { ...s.messagesBySession, [sessionId]: merged },
        hasMoreMessagesBySession: { ...s.hasMoreMessagesBySession, [sessionId]: hasMore },
        historyLoadedBySession: { ...s.historyLoadedBySession, [sessionId]: true },
        loadingMessagesBySession: { ...s.loadingMessagesBySession, [sessionId]: false },
      }));
    } catch (err) {
      // Keep the previous live messages and leave hydration unset so reopening
      // can retry. An empty-looking conversation must never hide a failed read.
      console.error("session.messages(initial) failed:", err);
      set((s) => ({
        loadingMessagesBySession: { ...s.loadingMessagesBySession, [sessionId]: false },
      }));
      // Hover prefetch is speculative; only surface failure when the user is
      // actually viewing this session. Do not put DB paths/IPC internals in UI.
      if (get().activeSessionId === sessionId) {
        useToastStore.getState().push({
          kind: "error",
          title: translate(get().locale, "store.toast.historyLoadFailed"),
          sessionId,
        });
      }
    }
  },

  /** Fetch the next page of older messages and prepend them to the session's
   *  message list. Used by the "pull to load history" hook at the top of the
   *  chat list. Safe to call repeatedly — concurrent calls are deduped via
   *  `loadingOlderBySession`, and a `false` hasMore short-circuits future ones. */
  loadOlderMessages: async (sessionId) => {
    // Bail when there's nothing more to load or a fetch is already in flight.
    if (!get().hasMoreMessagesBySession[sessionId]) return;
    if (get().loadingOlderBySession[sessionId]) return;
    const list = get().messagesBySession[sessionId];
    if (!list || list.length === 0) return;
    const head = list[0];
    set((s) => ({
      loadingOlderBySession: { ...s.loadingOlderBySession, [sessionId]: true },
    }));
    try {
      const { messages, hasMore } = await api.session.messages({
        sessionId,
        limit: MESSAGE_PAGE_SIZE,
        beforeCreatedAt: head.createdAt,
        beforeId: head.id,
      });
      const older = fromRecords(messages);
      set((s) => {
        const cur = s.messagesBySession[sessionId] ?? EMPTY_MESSAGES;
        // Avoid duplicates if the cursor drifted (defensive; the (createdAt,id)
        // tiebreaker should already prevent overlap).
        const existingIds = new Set(cur.map((m) => m.id));
        const merged = [...older.filter((m) => !existingIds.has(m.id)), ...cur];
        return {
          messagesBySession: { ...s.messagesBySession, [sessionId]: merged },
          hasMoreMessagesBySession: { ...s.hasMoreMessagesBySession, [sessionId]: hasMore },
          loadingOlderBySession: { ...s.loadingOlderBySession, [sessionId]: false },
        };
      });
    } catch (err) {
      console.error("loadOlderMessages failed:", err);
      set((s) => ({
        loadingOlderBySession: { ...s.loadingOlderBySession, [sessionId]: false },
      }));
    }
  },

  /** Remove a session from the tab strip. If it was the active tab, the
   *  focus shifts to the previous tab (the one to the left), or if there
   *  is none, to the new tail. Closing the last tab leaves the center
   *  pane empty (rendered as the "no session" placeholder).
   *
   *  In-flight turns are NOT cancelled — they keep streaming in the
   *  background, the events still get bucketed by sessionId, and the
   *  user can re-open the tab to see the latest state. We only drop the
   *  tab from the strip; the underlying session row + runtime binding
   *  are untouched. */
  closeTab: (sessionId) => {
    const previousActiveId = get().activeSessionId;
    set((s) => {
      const idx = s.openTabs.indexOf(sessionId);
      if (idx === -1) return {};
      const nextTabs = s.openTabs.filter((id) => id !== sessionId);
      const wasActive = s.activeSessionId === sessionId;
      let nextActive = s.activeSessionId;
      if (wasActive) {
        // Prefer the tab to the left (idx - 1), or fall back to the new
        // tail (which used to be at idx). If neither exists, leave
        // activeSessionId null so the empty-state placeholder shows.
        if (nextTabs.length === 0) {
          nextActive = null;
        } else if (idx > 0) {
          nextActive = nextTabs[idx - 1];
        } else {
          nextActive = nextTabs[0];
        }
      }
      // Unified center bar focus: only the ACTIVE tab's closure moves it —
      // closing a background session tab must not yank the editor away.
      // Closing the active tab lands on the successor session's chat; when
      // that was the LAST session tab, keep the editor if a file is active
      // (otherwise the center would go blank for no reason).
      let centerTabFocus = s.centerTabFocus;
      if (wasActive) {
        if (nextTabs.length > 0) {
          centerTabFocus = "chat";
        } else {
          const pid = s.activeProjectId;
          centerTabFocus =
            pid && (s.ideActiveFileByProject[pid] ?? null) ? "editor" : "chat";
        }
      }
      // If the new active tab changed, sync its config so the composer
      // chips reflect the right model/effort/permission. Also clear its
      // unread badge - it's now the visible session.
      if (nextActive && nextActive !== s.activeSessionId) {
        // Defer to the set body: we can't call syncConfigFromSession
        // here because it uses the same `set`. Inline the same lookup.
        const sess = findSession(s.sessionsByProject, s.archivedSessionsByProject, s.pinnedSessions, s.streamSessions, nextActive);
        const unreadBySession = { ...s.unreadBySession };
        delete unreadBySession[nextActive];
        return {
          openTabs: nextTabs,
          activeSessionId: nextActive,
          model: sess?.model ?? s.model,
          effort: sess?.effort ?? s.effort,
          permissionMode: sess?.permissionMode ?? s.permissionMode,
          customModelId: sess?.customModelId ?? s.customModelId,
          unreadBySession,
          centerTabFocus,
        };
      }
      return { openTabs: nextTabs, activeSessionId: nextActive, centerTabFocus };
    });
    syncLandedSessionIfChanged(set, get, previousActiveId);
  },

  /** Move a tab within the strip. No-op for out-of-range / same index. */
  reorderTab: (from, to) =>
    set((s) => {
      if (
        from === to ||
        from < 0 ||
        from >= s.openTabs.length ||
        to < 0 ||
        to >= s.openTabs.length
      ) {
        return {};
      }
      const next = [...s.openTabs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { openTabs: next };
    }),

  /** Hard-delete a project; its sessions + messages cascade-delete in the DB.
   *  If it was active, fall back to the first remaining project. */
  deleteProject: async (id) => {
    await api.project.delete({ id });
    // Model cache: none of the deleted project's files will be in any open
    // list after this, so dispose their models — except the DISPLAYED one
    // (still attached to the live editor; EditPane's teardown owns it once
    // the re-render tears the column down).
    const before = get();
    const removedOpen = before.ideOpenFilesByProject[id];
    const displayed = getDisplayedPath();
    if (removedOpen) {
      for (const p of removedOpen) {
        if (p !== displayed) disposeModel(p);
      }
    }
    // 状态手术与「别的端删了项目」共用一份(removeProjectFromState)。主进程的
    // projects.changed 可能比这里先到、已经摘过一次 —— 那样这里是空操作。
    set((s) => removeProjectFromState(s, id));
  },

  refreshProjects: async () => {
    let projects: Project[];
    try {
      ({ projects } = await api.project.list());
    } catch (err) {
      console.error("project.list(refresh) failed:", err);
      return;
    }
    const known = new Set(get().projects.map((p) => p.id));
    const added = projects.filter((p) => !known.has(p.id));
    const buckets = added.length > 0 ? await fetchProjectSessionBuckets(added) : null;
    const serverIds = new Set(projects.map((p) => p.id));
    set((s) => {
      // 消失的项目:和本地删除同一套清理(标签、桶、当前项目回落)。
      let cur: SessionState = s;
      for (const p of s.projects) {
        if (!serverIds.has(p.id)) cur = { ...cur, ...removeProjectFromState(cur, p.id) };
      }
      const patch: Partial<SessionState> = {
        ...(cur === s ? {} : cur),
        // 行本身(名字 / 归档 / 置顶 / 分组 / 排序)以服务端为准。
        projects,
      };
      if (buckets) {
        const sessionsByProject = { ...cur.sessionsByProject };
        const hasMore = { ...cur.sessionsHasMoreByProject };
        const total = { ...cur.sessionsTotalByProject };
        const archived = { ...cur.archivedSessionsByProject };
        for (const p of added) {
          // 本地 create 已经先一步建好桶的(本端发起的新建)不覆盖。
          if (sessionsByProject[p.id] !== undefined) continue;
          sessionsByProject[p.id] = buckets.byProject[p.id] ?? [];
          hasMore[p.id] = buckets.hasMoreByProject[p.id] ?? false;
          total[p.id] = buckets.totalByProject[p.id] ?? 0;
          if (buckets.archivedByProject[p.id]) archived[p.id] = buckets.archivedByProject[p.id];
        }
        patch.sessionsByProject = sessionsByProject;
        patch.sessionsHasMoreByProject = hasMore;
        patch.sessionsTotalByProject = total;
        patch.archivedSessionsByProject = archived;
      }
      // 当前项目本身被别的端删了 → removeProjectFromState 已经挑好下一个;但
      // 如果本地原来一个项目都没有(首次在另一端建项目),落到新项目上。
      const activeProjectId = patch.activeProjectId !== undefined ? patch.activeProjectId : cur.activeProjectId;
      if (activeProjectId == null && projects.length > 0) {
        const landing = projects.find((p) => !p.archived) ?? projects[0];
        patch.activeProjectId = landing.id;
        patch.sessions = (patch.sessionsByProject ?? cur.sessionsByProject)[landing.id] ?? [];
      }
      patch.streamDirty = true;
      return patch;
    });
  },

  resyncAfterReconnect: async () => {
    await get().refreshProjects();
    // 已加载过会话列表的项目:首屏整页换成库里的(断开期间别的端新建 / 删除 /
    // 改名的会话)。上翻加载过的更多页会收回到首屏 —— 用户再点「更多」即可。
    const loaded = get().projects.filter((p) => get().sessionsByProject[p.id] !== undefined);
    const [buckets, pinned] = await Promise.all([
      fetchProjectSessionBuckets(loaded),
      api.session.listPinned().catch((err: unknown) => {
        console.error("session.listPinned(resync) failed:", err);
        return null;
      }),
    ]);
    set((s) => {
      const sessionsByProject = { ...s.sessionsByProject };
      const hasMore = { ...s.sessionsHasMoreByProject };
      const total = { ...s.sessionsTotalByProject };
      const archived = { ...s.archivedSessionsByProject };
      for (const p of loaded) {
        const fresh = buckets.byProject[p.id];
        if (!fresh) continue; // 这个项目拉失败了 —— 保留旧的
        sessionsByProject[p.id] = fresh;
        hasMore[p.id] = buckets.hasMoreByProject[p.id] ?? false;
        total[p.id] = buckets.totalByProject[p.id] ?? 0;
        if (buckets.archivedByProject[p.id]) archived[p.id] = buckets.archivedByProject[p.id];
        else delete archived[p.id];
      }
      return {
        sessionsByProject,
        sessionsHasMoreByProject: hasMore,
        sessionsTotalByProject: total,
        archivedSessionsByProject: archived,
        sessions: s.activeProjectId ? (sessionsByProject[s.activeProjectId] ?? s.sessions) : s.sessions,
        ...(pinned ? { pinnedSessions: pinned.sessions } : {}),
        streamDirty: true,
      };
    });
    // 消息:每个有缓存的会话都可能缺了断开期间的正文。running 集合已经被重连
    // 那帧快照校正过。
    const st = get();
    const sids = Object.keys(st.messagesBySession);
    await Promise.all(
      sids.map(async (sid) => {
        if (st.runningBySession[sid]) {
          resyncAfterTurn.add(sid);
          return;
        }
        await get().resyncSessionMessages(sid);
      }),
    );
  },

  resyncSessionMessages: async (sessionId) => {
    if (get().runningBySession[sessionId]) return;
    let fetched: ChatMessage[];
    let hasMore: boolean;
    try {
      const res = await api.session.messages({ sessionId, limit: MESSAGE_PAGE_SIZE });
      fetched = fromRecords(res.messages);
      hasMore = res.hasMore;
    } catch (err) {
      console.error("session.messages(resync) failed:", err);
      return;
    }
    set((s) => {
      // 拉的这段时间里新一轮开始了 —— 它的正文正在流进来,别动。
      if (s.runningBySession[sessionId]) return s;
      const live = s.messagesBySession[sessionId];
      if (!live) return s; // 会话已被关掉 / 删掉
      // 库里一条都没有:多半是这一端自己写的还没到(或根本没人写)—— 宁可留着
      // 手里的,也不清空。
      if (fetched.length === 0) return s;
      const head = fetched[0];
      const ids = new Set(fetched.map((m) => m.id));
      // 只保留比这一页更早、之前上翻加载过的;这一页的时间窗里以库为准(断开期间
      // 缺的块、重复的客户端 id 都随之消失)。
      const older = live.filter(
        (m) =>
          !ids.has(m.id) &&
          (m.createdAt < head.createdAt || (m.createdAt === head.createdAt && m.id < head.id)),
      );
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: [...older, ...fetched] },
        hasMoreMessagesBySession: {
          ...s.hasMoreMessagesBySession,
          [sessionId]: older.length > 0 ? (s.hasMoreMessagesBySession[sessionId] ?? hasMore) : hasMore,
        },
        historyLoadedBySession: { ...s.historyLoadedBySession, [sessionId]: true },
      };
    });
  },

  /** Set a project's archived flag (soft-delete; restorable from the archived view). */
  archiveProject: async (id, archived) => {
    const { project } = await api.project.archive({ id, archived });
    set((s) => {
      const projects = s.projects.map((p) => (p.id === id ? project : p));
      // If we just archived the active project, jump to the next active one.
      const wasActive = s.activeProjectId === id;
      // Scrub tabs belonging to the archived project — archived sessions
      // shouldn't linger in the center pane.
      const removedSessionIds = new Set((s.sessionsByProject[id] ?? []).map((sess) => sess.id));
      const openTabs = s.openTabs.filter((sid) => !removedSessionIds.has(sid));
      if (!wasActive || !archived) {
        return { projects, openTabs };
      }
      const next = projects.find((p) => !p.archived);
      const nextSessions = next ? (s.sessionsByProject[next.id] ?? []) : [];
      const nextSession = nextSessions.find((sess) => !sess.archived);
      return {
        projects,
        activeProjectId: next?.id ?? null,
        sessions: nextSessions,
        activeSessionId: nextSession?.id ?? null,
        openTabs: nextSession ? [nextSession.id] : openTabs,
      };
    });
  },

  /** Hard-delete a session; its messages cascade-delete in the DB. The row is
   *  removed from whichever per-project cache currently holds it (active or
   *  archived). If it was active, fall back to the next session in the same
   *  project. */
  deleteSession: async (id) => {
    await api.session.delete({ id });
    // Shared cleanup — a remote `session.deleted` event runs the same state
    // surgery (see applySessionDeletedState) so phone-side deletes behave
    // identically to local ones.
    const previousActiveId = get().activeSessionId;
    set((s) => applySessionDeletedState(s, id));
    syncLandedSessionIfChanged(set, get, previousActiveId);
  },

  /** Set a session's archived flag (soft-delete; restorable). The session
   *  MOVES between the active cache (`sessionsByProject`) and the archived
   *  cache (`archivedSessionsByProject`) of its project so each list only
   *  contains rows in the matching state — the left-bar tree renders active
   *  threads inline under the project, and archived threads in the bottom
   *  "已归档" bin, also grouped by project. Totals are recomputed from the
   *  server response so `hasMore` / the load-more button stay accurate. */
  archiveSession: async (id, archived) => {
    const { session } = await api.session.archive({ id, archived });
    const previousActiveId = get().activeSessionId;
    set((s) => {
      const projectId = session.projectId;
      const isActiveProject = projectId === s.activeProjectId;

      // Pull the row out of whichever cache currently holds it and push the
      // server-fresh copy into the opposite cache. The global pinned bucket
      // participates too: archiving evicts the row from the pinned section
      // (pinned rows are active-only; the row stays visible in the bin), and
      // restoring a still-pinned row sends it back to the pinned section
      // rather than the project's list (pin survives archive/restore).
      const oldActive = s.sessionsByProject[projectId] ?? [];
      const oldArchived = s.archivedSessionsByProject[projectId] ?? [];
      // Whether the row sat in this project's active window — only then does
      // archiving shrink the active total (pinned rows aren't in it).
      const wasActiveRow = oldActive.some((x) => x.id === id);
      let nextActive: Session[];
      let nextArchived: Session[];
      let nextPinned = s.pinnedSessions;
      if (archived) {
        nextActive = oldActive.filter((x) => x.id !== id);
        nextArchived = [session, ...oldArchived.filter((x) => x.id !== id)];
        if (nextPinned.some((x) => x.id === id)) {
          nextPinned = nextPinned.filter((x) => x.id !== id);
        }
      } else {
        nextArchived = oldArchived.filter((x) => x.id !== id);
        if (session.pinnedAt != null) {
          nextActive = oldActive.filter((x) => x.id !== id);
          nextPinned = sortPinnedByRecency([
            session,
            ...nextPinned.filter((x) => x.id !== id),
          ]);
        } else {
          nextActive = [session, ...oldActive.filter((x) => x.id !== id)];
          if (nextPinned.some((x) => x.id !== id)) {
            nextPinned = nextPinned.filter((x) => x.id !== id);
          }
        }
      }
      const sessionsByProject = { ...s.sessionsByProject, [projectId]: nextActive };
      const archivedByProject = { ...s.archivedSessionsByProject };
      if (nextArchived.length > 0) {
        archivedByProject[projectId] = nextArchived;
      } else {
        delete archivedByProject[projectId];
      }
      // Keep the active-thread totals in lockstep with the cache move. Only
      // rows that actually sat in the active window (or now return to it)
      // move the count — a pinned row isn't part of the project list, so
      // archiving/restoring it leaves the total alone. The archive cache
      // isn't paginated, so no hasMore/total tracking needed there.
      const totalActive = Math.max(
        (s.sessionsTotalByProject[projectId] ?? 0) +
          (archived ? (wasActiveRow ? -1 : 0) : session.pinnedAt != null ? 0 : 1),
        0,
      );
      const hasMoreActive = totalActive > nextActive.length;

      // Archived sessions shouldn't stay open in the tab strip — the user
      // archived them, they don't want to see them in the center pane.
      const idx = s.openTabs.indexOf(id);
      const openTabs = archived && idx !== -1 ? s.openTabs.filter((sid) => sid !== id) : s.openTabs;
      const wasActive = s.activeSessionId === id;
      if (!isActiveProject || !wasActive || !archived) {
        return {
          sessionsByProject,
          archivedSessionsByProject: archivedByProject,
          pinnedSessions: nextPinned,
          sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: Math.max(totalActive, 0) },
          sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
          sessions: isActiveProject ? nextActive : s.sessions,
          openTabs,
          streamDirty: true,
        };
      }
      // Archived the active session → jump to the next visible one.
      const next = nextActive.find((sess) => !sess.archived);
      let nextActiveId: string | null = next?.id ?? null;
      // If the new active was the previous tab (idx > 0), keep that; else
      // fall back to the new tail of the now-shortened list.
      if (openTabs.length > 0) {
        nextActiveId = idx > 0 ? openTabs[idx - 1] : openTabs[0];
      }
      const sess = nextActiveId
        ? findSession(sessionsByProject, archivedByProject, nextPinned, s.streamSessions, nextActiveId)
        : undefined;
      // Clear the new active session's unread badge - it's now visible.
      const unreadBySession = { ...s.unreadBySession };
      if (nextActiveId) delete unreadBySession[nextActiveId];
      return {
        sessionsByProject,
        archivedSessionsByProject: archivedByProject,
        pinnedSessions: nextPinned,
        sessionsTotalByProject: { ...s.sessionsTotalByProject, [projectId]: Math.max(totalActive, 0) },
        sessionsHasMoreByProject: { ...s.sessionsHasMoreByProject, [projectId]: hasMoreActive },
        sessions: nextActive,
        openTabs,
        activeSessionId: nextActiveId,
        model: sess?.model ?? s.model,
        effort: sess?.effort ?? s.effort,
        permissionMode: sess?.permissionMode ?? s.permissionMode,
        customModelId: sess?.customModelId ?? s.customModelId,
        unreadBySession,
        streamDirty: true,
      };
    });
    syncLandedSessionIfChanged(set, get, previousActiveId);
  },

  renameSession: async (id, title) => {
    const { session } = await api.session.rename({ id, title });
    set((s) => {
      const projectId = session.projectId;
      // Update the row in whichever cache holds it (active page or archived
      // bin). Title is the only field that changes, but we replace the whole
      // row with the server-fresh copy to keep things consistent.
      const patchRow = (list: Session[] | undefined) =>
        list && list.some((x) => x.id === id)
          ? list.map((x) => (x.id === id ? session : x))
          : list;
      const sessionsByProject = { ...s.sessionsByProject };
      if (sessionsByProject[projectId]) {
        const next = patchRow(sessionsByProject[projectId]);
        if (next) sessionsByProject[projectId] = next;
      }
      const archivedSessionsByProject = { ...s.archivedSessionsByProject };
      if (archivedSessionsByProject[projectId]) {
        const next = patchRow(archivedSessionsByProject[projectId]);
        if (next) archivedSessionsByProject[projectId] = next;
      }
      const pinnedSessions = patchRow(s.pinnedSessions) ?? s.pinnedSessions;
      // The `sessions` alias mirrors the active project's list; refresh it in
      // case the renamed session lives in the active project (title chip etc.).
      const sessions = s.activeProjectId === projectId
        ? (sessionsByProject[projectId] ?? s.sessions)
        : s.sessions;
      return { sessionsByProject, archivedSessionsByProject, pinnedSessions, sessions, streamDirty: true };
    });
  },

  setSessionPinned: async (id, pinned) => {
    const { session } = await api.session.pin({ id, pinned });
    // Pinning MOVES the row: out of the project's active window and into the
    // global pinned section above the project tree (unpinning moves it back).
    // The shared state builder also runs for the cross-client
    // `session.changed` echo, so this stays idempotent. streamDirty either
    // way — pin state decides which stream section (pinned block vs live
    // list) renders the row.
    set((s) => ({ ...applySessionPinnedState(s, session), streamDirty: true }));
  },

  addBookmark: async (sessionId, input) => {
    const bookmark: SessionBookmark = {
      // Time + random suffix: two bookmarks added in the same millisecond
      // (impossible by hand, possible by scripted double-fire) stay distinct.
      id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      messageId: input.messageId,
      excerpt: input.excerpt,
      title: null,
      role: input.role,
      createdAt: Date.now(),
    };
    const prev = get().bookmarksBySession[sessionId] ?? EMPTY_BOOKMARKS;
    const next = [...prev, bookmark];
    // Optimistic bucket update first — the fly-to-capsule animation needs the
    // capsule segment (and its count) to appear before the IPC round-trip.
    set((s) => ({ bookmarksBySession: { ...s.bookmarksBySession, [sessionId]: next } }));
    try {
      const { session } = await api.session.updateBookmarks({ id: sessionId, bookmarks: next });
      // Patch the cached row with the same array reference (the schema parse
      // doesn't mutate values), so hydrateBookmarks's guard skips the rewrite.
      set((s) => patchSessionRowBookmarks(s, sessionId, session.projectId, next));
    } catch (err) {
      console.error("[store] addBookmark failed, rolling back", err);
      reportBookmarkSaveFailed(err);
      set((s) => {
        const bucket = { ...s.bookmarksBySession };
        const cur = bucket[sessionId];
        if (cur) {
          const filtered = cur.filter((b) => b.id !== bookmark.id);
          if (filtered.length > 0) bucket[sessionId] = filtered;
          else delete bucket[sessionId];
        }
        return { bookmarksBySession: bucket };
      });
    }
  },

  removeBookmark: async (sessionId, bookmarkId) => {
    const prev = get().bookmarksBySession[sessionId];
    if (!prev) return;
    const next = prev.filter((b) => b.id !== bookmarkId);
    if (next.length === prev.length) return;
    set((s) => {
      const bucket = { ...s.bookmarksBySession };
      if (next.length > 0) bucket[sessionId] = next;
      else delete bucket[sessionId];
      return { bookmarksBySession: bucket };
    });
    try {
      const { session } = await api.session.updateBookmarks({ id: sessionId, bookmarks: next });
      set((s) => patchSessionRowBookmarks(s, sessionId, session.projectId, next));
    } catch (err) {
      console.error("[store] removeBookmark failed, rolling back", err);
      reportBookmarkSaveFailed(err);
      set((s) => ({ bookmarksBySession: { ...s.bookmarksBySession, [sessionId]: prev } }));
    }
  },

  renameBookmark: async (sessionId, bookmarkId, title) => {
    const prev = get().bookmarksBySession[sessionId];
    if (!prev) return;
    const trimmed = title.trim().slice(0, 80);
    const nextTitle = trimmed.length > 0 ? trimmed : null;
    const existing = prev.find((b) => b.id === bookmarkId);
    if (!existing || (existing.title ?? null) === nextTitle) return;
    const next = prev.map((b) => (b.id === bookmarkId ? { ...b, title: nextTitle } : b));
    set((s) => ({ bookmarksBySession: { ...s.bookmarksBySession, [sessionId]: next } }));
    try {
      const { session } = await api.session.updateBookmarks({ id: sessionId, bookmarks: next });
      set((s) => patchSessionRowBookmarks(s, sessionId, session.projectId, next));
    } catch (err) {
      console.error("[store] renameBookmark failed, rolling back", err);
      reportBookmarkSaveFailed(err);
      set((s) => ({ bookmarksBySession: { ...s.bookmarksBySession, [sessionId]: prev } }));
    }
  },

  applySessionTitleUpdate: (sessionId, title) => {
    // Find the session's projectId from whichever cache holds it. The main
    // process already persisted the title, so we only patch in-memory lists.
    set((s) => {
      // Side chats live in the ask tab's per-parent buckets, not the
      // left-bar caches — patch those and be done.
      for (const [parent, list] of Object.entries(s.sideChatsByParent)) {
        if (list?.some((x) => x.id === sessionId)) {
          return {
            sideChatsByParent: {
              ...s.sideChatsByParent,
              [parent]: list.map((x) => (x.id === sessionId ? { ...x, title } : x)),
            },
          };
        }
      }
      let projectId: string | undefined;
      for (const pid of Object.keys(s.sessionsByProject)) {
        if (s.sessionsByProject[pid]?.some((x) => x.id === sessionId)) {
          projectId = pid;
          break;
        }
      }
      // Pinned rows live in the global pinned bucket — their owning project
      // comes from the row itself.
      const pinnedRow = projectId
        ? undefined
        : s.pinnedSessions.find((x) => x.id === sessionId);
      if (!projectId && pinnedRow) projectId = pinnedRow.projectId;
      if (!projectId) {
        for (const pid of Object.keys(s.archivedSessionsByProject)) {
          if (s.archivedSessionsByProject[pid]?.some((x) => x.id === sessionId)) {
            projectId = pid;
            break;
          }
        }
      }
      if (!projectId) return {}; // session not loaded anywhere yet

      // Patch the title in whichever cache(s) hold the row.
      const patchRow = (list: Session[] | undefined) =>
        list && list.some((x) => x.id === sessionId)
          ? list.map((x) => (x.id === sessionId ? { ...x, title } : x))
          : list;

      const sessionsByProject = { ...s.sessionsByProject };
      if (sessionsByProject[projectId]) {
        const next = patchRow(sessionsByProject[projectId]);
        if (next) sessionsByProject[projectId] = next;
      }
      const archivedSessionsByProject = { ...s.archivedSessionsByProject };
      if (archivedSessionsByProject[projectId]) {
        const next = patchRow(archivedSessionsByProject[projectId]);
        if (next) archivedSessionsByProject[projectId] = next;
      }
      const pinnedSessions = patchRow(s.pinnedSessions) ?? s.pinnedSessions;
      const sessions = s.activeProjectId === projectId
        ? (sessionsByProject[projectId] ?? s.sessions)
        : s.sessions;
      return { sessionsByProject, archivedSessionsByProject, pinnedSessions, sessions };
    });
  },

  /**
   * 往**正在跑的那一轮**里塞一句话(生成过程中插话)。返回"送出去了没有"。
   *
   * ## 与 `sendPrompt` 的分工
   *
   * 那一条是"说一句新的"(它自己会判断是发出去还是排队),这一条是"给正在跑的这一轮
   * 补一句" —— 那一轮**不中断**。两件事都要有,所以界面上是两个入口。
   *
   * ## 返回 false 的三种情形,以及为什么调用方必须兜底
   *
   * 没在跑 / 引擎不支持 / 刚好收尾了。三种都**什么都没发生**,所以调用方应当退回
   * `sendPrompt`(排队或直发),而不是把用户那句话丢掉 —— 打了字按了回车、界面上毫无
   * 动静,是最糟的一种结果。
   *
   * ## 收下了才画,画了就落库
   *
   * 落库的规矩和 `sendPrompt` 里那条一模一样、理由也一样:**这一轮可能永远到不了终态**
   * (用户中途按了停止),那时"我补过一句什么"不能跟着一起没掉。只写这一条而不是整份
   * 快照,所以顺序上没有副作用。
   *
   * 注意**不动** `runningBySession` / `runningTurnStartedAt` —— 插话不是新的一轮。
   */
  injectPrompt: async (sessionId, text) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    if (!get().runningBySession[sessionId]) return false;
    let delivered = false;
    try {
      ({ delivered } = await api.claude.inject({ sessionId, text: trimmed }));
    } catch {
      // 手机端的 shim 没有这条 RPC —— 按"没送出去"处理,调用方会兜回普通的发送。
      return false;
    }
    if (!delivered) return false;
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks: [{ kind: "text", text: trimmed }],
      createdAt: Date.now(),
    };
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg],
      },
      // 这一轮还在跑,但**有新内容**了 —— 让左栏那条"有动静"的提示跟上。
      streamDirty: true,
    }));
    persistMessages({ sessionId, messages: toRecords(sessionId, [userMsg]) });
    return true;
  },

  sendPrompt: async (prompt, attachments, displayText, skillsUsed, images, displayBlocks, sessionIdArg) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return false;
    // An image-only turn (no typed text) is valid — the images are the prompt.
    if (!prompt.trim() && !(images && images.length > 0)) return false;
    // Per-thread guard: only block this thread from sending if IT is running.
    // Another thread's running turn shouldn't lock the composer in this one.
    if (get().runningBySession[sessionId]) return false;

    // Resolve the model BEFORE showing the user message: claude and pi have
    // NO default model — an unselected model ("default") blocks the send, as
    // does a provider with nothing configured at all. Aborting here leaves
    // the composer untouched.
    const resolvedModel = resolveSendModel(get());
    if (!resolvedModel) {
      raiseModelGuard();
      return false;
    }

    // 1. immediately show the user's message. Attachments (pasted content
    //    promoted to cards in the composer) render as attachment blocks
    //    ABOVE the typed text, mirroring the composer's chip-above-editor
    //    layout. The text block shows only the typed text (displayText) —
    //    the full `prompt` (with attachments inlined via
    //    composePromptWithTags) is what the SDK receives, but showing it
    //    here too would duplicate the attachment content as plain text.
    //    `skillsUsed` records which `/name` occurrences in the text are skill
    //    pills, so the stream can render them as styled inline pills.
    const blocks: Block[] = [];
    if (attachments) {
      for (const a of attachments) {
        blocks.push({
          kind: "attachment",
          preview: a.preview,
          content: a.content,
          attachmentKind: a.attachmentKind,
          filePath: a.filePath,
        });
      }
    }
    // User-attached images render inline between the attachment cards and the
    // text block (mirrors the composer's chip-above-editor layout).
    if (images) {
      for (const img of images) {
        blocks.push({ kind: "image", data: img.data, mimeType: img.mimeType });
      }
    }
    // Image-only turns have no text block at all (empty bubble otherwise).
    // `displayBlocks` (plan handoff) replaces the default text block with
    // richer content — e.g. a short note + the plan card — so the raw
    // kickoff prompt never dumps into the bubble.
    if (displayBlocks) {
      blocks.push(...displayBlocks);
    } else {
      const textForBlock = displayText ?? prompt;
      if (textForBlock.trim()) {
        blocks.push({
          kind: "text",
          text: textForBlock,
          skillNames: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
        });
      }
    }
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks,
      createdAt: Date.now(),
    };
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), userMsg],
      },
      runningBySession: { ...s.runningBySession, [sessionId]: true },
      // A new turn supersedes the previous one's error label + floats the
      // session to the top of the stream list.
      turnErrorBySession: { ...s.turnErrorBySession, [sessionId]: false },
      streamDirty: true,
      // NOTE: subagent roster/transcripts are intentionally NOT cleared here
      // — they are session-scoped history now; main replays the accumulated
      // state at each turn start (RuntimeManager.sendTurn).
      // Stamp the turn's start time NOW (send moment), not when the first
      // assistant block arrives. This anchors the synthesized "开始 · 用时"
      // row that renders before any token lands, and the real turnMeta
      // (stamped at the first delta/tool/plan) falls back to this value so
      // the timing is continuous across the handoff. Reuses userMsg.createdAt
      // (not a fresh Date.now()) so the turn-done incremental persist's
      // `createdAt >= anchor` filter can never tick past the user message
      // and drop it from the persisted tail on a millisecond boundary.
      runningTurnStartedAt: { ...s.runningTurnStartedAt, [sessionId]: userMsg.createdAt },
      // Model anchor: the exact model id this turn is being sent with. Stamped
      // into turnMeta by the isNewTurn sites so the stream can show which model
      // produced each reply (the composer's selection may change next turn).
      runningTurnModelBySession: {
        ...s.runningTurnModelBySession,
        [sessionId]: resolvedModel.model,
      },
      // A new turn supersedes any prior manual interrupt: clear the sentinel
      // so subagent.update / turn.done events for THIS turn aren't filtered.
      interruptedBySession: { ...s.interruptedBySession, [sessionId]: false },
    }));

    // 用户消息**立刻落库,不等终态**。
    //
    // 持久化原本只发生在 turn.done / error 上(见 ingestEvent 末尾那段注释)。但一轮
    // 可能**永远到不了终态**:用户中途点了停止,或流被掐断。那时不仅助手的话没了,
    // 连"我问过什么"都不见了 —— 用户报的就是这个。
    //
    // 只写这一条而不是整份快照:它正是这一轮的锚,终态那条增量 upsert 按
    // `createdAt >= userMsg.createdAt` 挑尾巴,所以它先落库不会有任何副作用;而这一轮
    // 哪怕一条助手消息都没产出,用户至少看得到自己问过什么。
    persistMessages({ sessionId, messages: toRecords(sessionId, [userMsg]) });

	    // 2. fire the turn; events stream back via ingestEvent. Run the IPC in
	    //    the BACKGROUND and return true the moment the user message lands
	    //    in the stream — the main handler awaits provider.startTurn (SDK
	    //    spawn / bridge acquisition) before its invoke resolves, which can
	    //    take hundreds of ms. Awaiting it here kept the composer's typed
	    //    text frozen next to the already-rendered user bubble, which read
	    //    as "send lag". Ship the
	    //    current model / customModelId / effort / permissionMode from the
	    //    store as per-turn overrides - the DB row may be stale because
	    //    `setModel` / `setCustomModel` persist via fire-and-forget
	    //    `updateSettings`, which races `sendTurn`. The main handler
	    //    applies these overrides to the in-memory session so
	    //    RuntimeManager always sees the latest UI state. The model pair
	    //    comes from `resolvedModel` above (auto → first configured model).
	    void (async () => {
      const { effort, permissionMode, workflowId, providerId } = get();
      let updated;
      try {
        ({ session: updated } = await api.claude.sendTurn({
          sessionId,
          prompt,
          model: resolvedModel.model,
          effort,
          permissionMode,
          workflowId,
          customModelId: resolvedModel.customModelId,
          // Per-turn provider override — lets the active provider drive
          // which backend handles this turn without persisting the change
          // to the session row. Combined with the per-turn overrides above
          // this keeps "switch SDK at any time" working.
          providerId,
          skills: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
          // User-attached images inlined into the provider request (base64
          // content blocks — never paths).
          images: images && images.length > 0 ? images : undefined,
          // Cross-client echo: main re-broadcasts this bubble to every OTHER
          // client (phone ⇄ PC) as a `user.message` event keyed by the id.
          // The local copy appended above makes the echo a no-op here.
          userMessage: { id: userMsg.id, createdAt: userMsg.createdAt, blocks: userMsg.blocks },
        }));
      } catch (err) {
        // 主进程已发错误事件,但手机 SSE 可能掉线,不能只把 RPC 失败写到控制台。
        // 若事件先到,兜底不会再添一条;若事件后到,ingestEvent 会对本轮去重。
        console.error("sendTurn IPC failed:", err);
        surfaceRejectedCustomModelSend(get, sessionId, err);
        // 兜底仅覆盖自定义配置失效;其他 IPC 故障仍需释放 running/计时锚。
        set((s) => {
          const runningBySession = { ...s.runningBySession, [sessionId]: false };
          const runningTurnStartedAt = { ...s.runningTurnStartedAt };
          delete runningTurnStartedAt[sessionId];
          const runningTurnModelBySession = { ...s.runningTurnModelBySession };
          delete runningTurnModelBySession[sessionId];
          return { runningBySession, runningTurnStartedAt, runningTurnModelBySession };
        });
        // IPC rejected → no terminal event will arrive to clear the turn, so
        // also try draining the queue here (the session is now idle).
        get().drainPromptQueueIfIdle(sessionId);
        return;
      }
      set((s) => {
        // Side chats never touch the left-bar caches — patch the ask tab's
        // per-parent bucket instead (the row carries the first-question
        // rewrite of the "Quick ask" placeholder title). List order is
        // created_at, so replace-in-place rather than unshift.
        if (updated.kind === "side") {
          const parent = updated.parentSessionId;
          if (!parent) return {};
          const list = s.sideChatsByParent[parent];
          if (!list) return {};
          return {
            sideChatsByParent: {
              ...s.sideChatsByParent,
              [parent]: list.map((x) => (x.id === updated.id ? updated : x)),
            },
          };
        }
        const pid = updated.projectId;
        const prevList = s.sessionsByProject[pid] ?? [];
        // Sending a message makes this session the most recently active, so move
        // it to the head of the list (mirrors the `updated_at DESC` server order
        // and the head-insert done by `startSession`). Replace-in-place would
        // leave a stale position; unshift keeps the left bar in sync with activity.
        const rest = prevList.filter((sess) => sess.id !== updated.id);
        const nextList = [updated, ...rest];
        return {
          sessionsByProject: { ...s.sessionsByProject, [pid]: nextList },
          sessions: pid === s.activeProjectId ? nextList : s.sessions,
        };
      });
    })();
    // Accepted: the user message is in the stream and the turn is dispatched
    // in the background. The caller clears the composer immediately.
    return true;
  },

  editAndResendMessage: async (sessionId, messageId, newPrompt, attachments, displayText, skillsUsed, images) => {
    if (!sessionId || !newPrompt.trim()) return;
    // The session must be idle - editing while a turn is running would
    // race the truncation against live event ingestion.
    if (get().runningBySession[sessionId]) return;

    // Same send-model guard as sendPrompt: no default model — an unpicked
    // model or an empty provider blocks the resend.
    const resolvedModel = resolveSendModel(get());
    if (!resolvedModel) {
      raiseModelGuard();
      return;
    }

    const current = get().messagesBySession[sessionId] ?? [];
    const idx = current.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const editedMsg = current[idx];
    if (!editedMsg) return;

    // 1. Truncate: keep only messages BEFORE the edited one. The edited
    //    message itself and everything after it (the AI's reply, any
    //    follow-up exchanges) are discarded.
    const truncated = current.slice(0, idx);

    // 2. Build the new user message from the edited prompt. Mirrors
    //    sendPrompt's block construction: attachment blocks first, then a
    //    single text block holding displayText (or the raw prompt when
    //    there are no attachments).
    //    User-attached images on the edited message survive the edit — the
    //    inline editor shows them as removable thumbnails and passes back the
    //    surviving list; the blocks already carry the base64, so they're
    //    re-sent verbatim without re-reading anything from disk. An omitted
    //    list (no editor round-trip) preserves every image, matching the
    //    pre-editor behavior.
    const preservedImages: PromptImage[] =
      images ??
      editedMsg.blocks
        .filter((b): b is Extract<Block, { kind: "image" }> => b.kind === "image")
        .map((b) => ({ data: b.data, mimeType: b.mimeType as PromptImage["mimeType"] }));
    // A plan block on the edited message (the plan handoff's first prompt)
    // survives the edit verbatim — the card keeps rendering on the re-sent
    // bubble, and its text is re-appended to the model prompt below. The
    // inline editor only edits the note text, so without this the re-send
    // would silently drop the plan the executor runs on.
    const preservedPlanBlock = editedMsg.blocks.find(
      (b): b is Extract<Block, { kind: "plan" }> => b.kind === "plan",
    );
    const modelPrompt = preservedPlanBlock
      ? `${newPrompt}\n\n<approved-plan>\n${preservedPlanBlock.plan}\n</approved-plan>`
      : newPrompt;
    const blocks: Block[] = [];
    if (attachments) {
      for (const a of attachments) {
        blocks.push({
          kind: "attachment",
          preview: a.preview,
          content: a.content,
          attachmentKind: a.attachmentKind,
          filePath: a.filePath,
        });
      }
    }
    for (const img of preservedImages) {
      blocks.push({ kind: "image", data: img.data, mimeType: img.mimeType });
    }
    blocks.push({
      kind: "text",
      text: displayText ?? newPrompt,
      skillNames: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
    });
    if (preservedPlanBlock) blocks.push(preservedPlanBlock);
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      sessionId,
      role: "user",
      blocks,
      createdAt: Date.now(),
    };

    // 3. Apply the truncation + new message + running flag atomically.
    //    Also clear the per-turn file snapshot for this session: the old
    //    turn's "本轮修改" card belongs to the truncated-away history and
    //    must not survive the edit.
    set((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...truncated, userMsg],
      },
      runningBySession: { ...s.runningBySession, [sessionId]: true },
      turnErrorBySession: { ...s.turnErrorBySession, [sessionId]: false },
      streamDirty: true,
      // Same anchor rule as sendPrompt: reuse userMsg.createdAt so the
      // turn-done incremental persist can never filter out the user message.
      runningTurnStartedAt: { ...s.runningTurnStartedAt, [sessionId]: userMsg.createdAt },
      // Same model anchor rule as sendPrompt (a resend re-resolves the model).
      runningTurnModelBySession: {
        ...s.runningTurnModelBySession,
        [sessionId]: resolvedModel.model,
      },
      // A new turn supersedes any prior manual interrupt: clear the sentinel
      // so subagent.update / turn.done events for THIS turn aren't filtered.
      interruptedBySession: { ...s.interruptedBySession, [sessionId]: false },
      turnFilesBySession: { ...s.turnFilesBySession, [sessionId]: [] },
    }));

    // 4. Persist the truncation immediately so a crash mid-turn doesn't leave
    //    the DB with the old (pre-edit) messages. Use truncateAndInsert rather
    //    than replaceAll so that older rows not loaded into renderer memory
    //    (paginated out) are preserved — replaceAll would wipe the whole table
    //    and lose them. The cursor is the edited message's (createdAt, id);
    //    the new user message is the only row inserted now (subsequent turn
    //    events stream in via upsertMessages on terminal events).
    persistTruncateAndInsert({
      sessionId,
      cursorCreatedAt: editedMsg.createdAt,
      cursorId: editedMsg.id,
      messages: toRecords(sessionId, [userMsg]),
    });
    // 5. Fire the turn; events stream back via ingestEvent. Same per-turn
    //    override pattern as sendPrompt (model pair from resolvedModel above),
    //    and same BACKGROUND dispatch: the truncated stream + new user message
    //    are already on screen, so don't block this action's completion on the
    //    main process's provider.startTurn round-trip.
    void (async () => {
      const { effort, permissionMode, workflowId, providerId } = get();
      let updated;
      try {
        ({ session: updated } = await api.claude.sendTurn({
          sessionId,
          // Carries the preserved plan payload (if any) — the bubble's text
          // block shows only the edited note text.
          prompt: modelPrompt,
          model: resolvedModel.model,
          effort,
          permissionMode,
          workflowId,
          customModelId: resolvedModel.customModelId,
          providerId,
          skills: skillsUsed && skillsUsed.length > 0 ? skillsUsed : undefined,
          // Preserved user-attached images from the pre-edit message.
          images: preservedImages.length > 0 ? preservedImages : undefined,
          // Cross-client echo (same as sendPrompt): other clients append the
          // re-sent bubble by id. Their stale pre-edit tail is a separate
          // cross-client sync concern; this at least surfaces the new prompt.
          userMessage: {
            id: userMsg.id,
            createdAt: userMsg.createdAt,
            blocks: userMsg.blocks,
            // Edit marker: other connected clients truncate their own stale
            // pre-edit tail at THIS message before appending, so the old
            // message (and its old reply) don't survive on their screens or
            // get re-persisted into the DB at their turn.done.
            editedMessageId: messageId,
          },
        }));
      } catch (err) {
        console.error("editAndResendMessage: sendTurn IPC failed:", err);
        surfaceRejectedCustomModelSend(get, sessionId, err);
        set((s) => {
          const runningBySession = { ...s.runningBySession, [sessionId]: false };
          const runningTurnStartedAt = { ...s.runningTurnStartedAt };
          delete runningTurnStartedAt[sessionId];
          const runningTurnModelBySession = { ...s.runningTurnModelBySession };
          delete runningTurnModelBySession[sessionId];
          return { runningBySession, runningTurnStartedAt, runningTurnModelBySession };
        });
        get().drainPromptQueueIfIdle(sessionId);
        return;
      }
      set((s) => {
        // Side chats patch the ask tab's per-parent bucket (see sendPrompt).
        if (updated.kind === "side") {
          const parent = updated.parentSessionId;
          const list = parent ? s.sideChatsByParent[parent] : undefined;
          if (!parent || !list) return {};
          return {
            sideChatsByParent: {
              ...s.sideChatsByParent,
              [parent]: list.map((x) => (x.id === updated.id ? updated : x)),
            },
          };
        }
        const pid = updated.projectId;
        const prevList = s.sessionsByProject[pid] ?? [];
        // Sending a message makes this session the most recently active, so move
        // it to the head of the list (mirrors the `updated_at DESC` server order
        // and the head-insert done by `startSession`). Replace-in-place would
        // leave a stale position; unshift keeps the left bar in sync with activity.
        const rest = prevList.filter((sess) => sess.id !== updated.id);
        const nextList = [updated, ...rest];
        return {
          sessionsByProject: { ...s.sessionsByProject, [pid]: nextList },
          sessions: pid === s.activeProjectId ? nextList : s.sessions,
        };
      });
    })();
  },

  interrupt: async (sessionIdArg) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return;
    // Capture the turn anchor BEFORE the set below deletes it — the persist at
    // the end of this function filters this turn's messages by it.
    const turnStartAt = get().runningTurnStartedAt[sessionId];
    // 先登记「欠一条中断收口」,再发 IPC:收口可能在 await 期间就到(那时哨兵还没立,
    // 守卫会把它当陈旧事件丢掉 —— 无妨,下面这段本来就把运行标志/计时/落库都做了)。
    pendingInterruptDone.add(sessionId);
    // ⚠️ **IPC 失败也必须往下走完本地收尾。** 从前这里裸 `await`,IPC 一 reject
    // (401/断网/超时)就跳过下面那一大段:界面**一直停在"运行中"**、`pendingInterruptDone`
    // 也留着一个悬空条目,用户点了停止像没反应。主进程那边可能没真停(如实报出来),
    // 但本地这份收尾(解锁输入框、冻结计时、落库已产出的内容)不该跟着失败。
    try {
      await api.claude.interrupt({ sessionId });
    } catch (err) {
      console.error("claude.interrupt failed:", err);
      useToastStore.getState().push({
        kind: "error",
        title: translate(get().locale, "store.toast.errorOccurred"),
        body: err instanceof Error ? err.message : String(err),
      });
    }
    // Drop this session's buffered deltas: after abort, flushFinal may emit a
    // few straggler text.delta/thinking while the generator unwinds, but the
    // user asked to STOP — none of it should reach the page. Combined with
    // the ingestEvent content freeze (sentinel check below), the transcript
    // stays frozen exactly where the user stopped it.
    clearSessionDeltas(sessionId);
    // Clear only the interrupted thread's flag. The `turn.done` (with reason
    // "interrupted") event from main will also clear it; doing it here too
    // is a defensive in case the event races with the user click.
    //
    // Also demote any still-running subagents (typically backgrounded tasks
    // whose lifecycle outlived the parent turn's stream) to "killed": the
    // user asked to STOP, so the composer must unlock even if the CLI hasn't
    // fully torn those tasks down yet.
    //
    // Set a per-session "interrupted" sentinel so the LATE events that the
    // abort unwinds (flushFinal's subagent.update carrying still-running
    // backgrounded subagents, and the follow-up turn.done) can't resurrect a
    // running subagent / keep the roster alive and re-lock the composer. The
    // sentinel survives until the next real turn starts (sendPrompt /
    // editAndResendMessage clear it). Without it, switching tabs away and
    // back re-mounts ChatPane, re-reads the running roster, and the send
    // button flips back to "running".
    set((s) => {
      const runningTurnStartedAt = { ...s.runningTurnStartedAt };
      delete runningTurnStartedAt[sessionId];
      const curAgents = s.subagentsBySession[sessionId] ?? [];
      const subagentsBySession = curAgents.some((a) => a.status === "running")
        ? {
            ...s.subagentsBySession,
            [sessionId]: curAgents.map((a) =>
              a.status === "running" ? { ...a, status: "killed" as const } : a,
            ),
          }
        : s.subagentsBySession;
      const list = s.messagesBySession[sessionId];
      // Freeze the aborted turn's "开始·用时" row NOW instead of waiting for
      // the late turn.done{interrupted} (which lands seconds later while the
      // SDK unwinds). The turn.done reducer only stamps endedAt where it's
      // still undefined, so this earlier freeze is never overwritten.
      const frozen = list
        ? list.map((m) =>
            m.turnMeta && m.turnMeta.endedAt === undefined
              ? { ...m, turnMeta: { ...m.turnMeta, endedAt: Date.now() } }
              : m,
          )
        : undefined;
      return {
        runningBySession: { ...s.runningBySession, [sessionId]: false },
        runningTurnStartedAt,
        interruptedBySession: { ...s.interruptedBySession, [sessionId]: true },
        subagentsBySession,
        ...(frozen ? { messagesBySession: { ...s.messagesBySession, [sessionId]: frozen } } : {}),
      };
    });
    // User stopped the turn — drop any live upstream-retry hint with it.
    clearUpstreamIssue(set, sessionId);

    // 中断的这一轮**也必须落库**。
    //
    // 消息的持久化原本只发生在终态事件(turn.done / error)上,而中止的一轮**不保证**
    // 有终态事件到达 —— 用户点了停止、流被掐断,那一轮就一条都不留。用户报的正是
    // 这个:「中断之后这里为什么没有显示记录呀,对话记录没有呀」—— 他试检索的两个
    // 会话在库里是 **0 条消息**。
    //
    // 只存这一轮(按发送时的锚点过滤),不是整份快照:长会话整份存是 O(N),而这里
    // 和终态那条持久化路径是同一个道理。锚点可能缺失(恢复出来的、或没走 sendPrompt
    // 的一轮),那就退化成整份存 —— 宁可多写一次,也不能让记录丢掉。
    //
    // 网页壳且桌面窗口开着时不写:桌面没点停止,它会照常收到迟到的
    // turn.done{interrupted} 并把这一轮写进库(见 persistsTurnContent)。
    const snapshot = get().messagesBySession[sessionId];
    if (snapshot && snapshot.length > 0 && persistsTurnContent()) {
      const tail =
        turnStartAt != null
          ? snapshot.filter(
              (m) => m.createdAt >= turnStartAt || m.turnMeta?.startedAt === turnStartAt,
            )
          : snapshot;
      const toSave = tail.length > 0 ? tail : snapshot;
      persistMessages({ sessionId, messages: toRecords(sessionId, toSave) });
    }
  },

  ingestEvent: (e) => {
    const sid = e.sessionId;

    // RPC 先拒绝且 SSE 随后才抵达:上一条错误已经由发送方补成气泡,不要
    // 重复报错 / 全量落库。新一轮用户消息会自然分开两次相同的失败。
    if (e.type === "error" && e.code === "custom_model_unavailable" &&
        hasErrorInCurrentTurn(get().messagesBySession[sid] ?? [], e.message)) return;

    // Capture the current turn's send-time anchor BEFORE any set() runs —
    // turn.done clears it inside its own set, so by the time we reach the
    // terminal-event persist below it's gone. Keeping it lets us persist only
    // this turn's messages (incremental upsert) instead of the whole session.
    const turnStartAtCapture = get().runningTurnStartedAt[sid];

    // Bump the unread counter for non-active sessions on noteworthy events.
    // The counter drives the red-dot badge in the left bar + tab strip so the
    // user knows "this background thread has new activity you haven't seen."
    // Cleared on selectSession/openTab (user looked at it). We do NOT bump for
    // streaming deltas / thinking / tool-use-start / plan-drafting - those are
    // mid-turn noise that would make the badge flicker incessantly. Only
    // terminal and blocking events count: the user actually needs to act or
    // the result is ready.
    const bumpUnread = () => {
      if (isSideChatSession(sid, get())) return;
      if (isSessionChatOnScreen(sid, get())) return;
      set((s) => ({
        unreadBySession: { ...s.unreadBySession, [sid]: (s.unreadBySession[sid] ?? 0) + 1 },
      }));
    };
    // Push an in-app toast for non-active sessions when the window is focused.
    // When the window is unfocused, the main-process NotificationManager
    // handles OS notifications instead. Toasts are always supplemented by the
    // badge (bumpUnread), so the user sees both the dot + the detail card.
    const pushToast = (kind: "info" | "warning" | "error", title: string, body?: string) => {
      if (isSideChatSession(sid, get())) return;
      if (isSessionChatOnScreen(sid, get())) return;
      if (!get().isWindowFocused) return;
      // 设置 → 消息通知:「前台时弹提示」/ 按项目静音 / 免打扰时段。
      const st = get();
      const projectId = Object.keys(st.sessionsByProject).find((pid) =>
        st.sessionsByProject[pid]?.some((x) => x.id === sid),
      );
      if (!inAppToastAllowed(projectId)) return;
      useToastStore.getState().push({ kind, title, body, sessionId: sid });
    };

    /** 归约上下文 —— 一次性备好，交给下面每个 `reduceXxx`。 */
    const ctx: IngestCtx = { set, get, sid, bumpUnread, pushToast };

    // Terminal events: flush any buffered deltas before processing the
    // turn-end event so no content is lost when the stream closes.
    if (e.type === "turn.done" || e.type === "error") {
      forceDeltaFlush();
    }
    // A tool.use must land AFTER any narration text that has already
    // streamed. The text is still sitting in the rAF delta buffer — flush it
    // first (for EVERY tool.use, not just ones carrying an owning messageId:
    // pi snapshots the narration message at toolcall_start; claude reuses
    // the preceding text/thinking block's messageId). Without the flush a
    // messageId-less tool could be appended to an earlier message while the
    // buffered narration later materializes as a message AFTER it — the
    // renderer's completed-turn split ("everything up to the last tool call
    // is process") would then misclassify that narration as the final reply
    // and leak it out of the process panel.
    if (e.type === "tool.use") {
      forceDeltaFlush();
    }

    // Stale `turn.done` guard — fixes the stop→edit→resend race.
    //
    // When the user clicks stop, interrupt() flips runningBySession to false
    // and sets the interruptedBySession sentinel. The SDK's async iterator
    // then unwinds (ac.abort() throws), and flushFinal() emits a *late*
    // turn.done{reason:"interrupted"} once the generator actually tears down.
    //
    // If the user edits & resends BEFORE that late event lands,
    // editAndResendMessage clears the sentinel and flips running back to true
    // for the NEW turn. The late turn.done then arrives carrying
    // reason:"interrupted" while the sentinel is already cleared — proof it
    // belongs to the OLD (aborted) turn. Applying it would (a) stamp endedAt
    // on the NEW turn's opener (splitting the stream into two "开始·用时"
    // panels) and (b) reset runningBySession to false (composer looks idle,
    // no spinner).
    //
    // Detection: the turn.done is stale only when THIS renderer still owes an
    // interrupted close-out (`pendingInterruptDone`, registered by interrupt())
    // AND a newer turn already cleared the sentinel. The legitimate local path
    // (user stopped, didn't resend) still has the sentinel set, so it runs.
    //
    // "sentinel not set" alone is NOT proof of staleness: interrupts also come
    // from main (turn budget → `enforceBudget` → handle.interrupt()), from the
    // phone (`mobileRpc` → runtimeManager.interrupt) and from workflow cancel —
    // none of those set this renderer's sentinel. Dropping their turn.done left
    // `runningBySession` true forever: composer locked, timer ticking, turn not
    // persisted, queued prompt never fired. Any turn.done settles the debt, so a
    // stop whose close-out never arrived can't poison a later turn either.
    if (e.type === "turn.done") {
      const owed = pendingInterruptDone.delete(sid);
      if (e.reason === "interrupted" && owed && !get().interruptedBySession[sid]) {
        return;
      }
    }

    // Turn end: snapshot the final subagent roster + transcripts onto the
    // cached session row(s). hydrateCapsule / hydrateSubagentTranscripts read
    // the ROW, and the row as loaded predates this turn — without this patch
    // a tab-switch-and-back would clobber the live buckets with the stale row
    // value (the "subagents vanish after the turn ends" symptom). (Main
    // persists the same data to DB, so a restart reloads it via the row
    // naturally.) Done once here rather than per event — those fire per
    // subagent MESSAGE and must not re-render the left bar.
    if (e.type === "turn.done") {
      const transcripts = get().subagentTranscriptsBySession[sid];
      const agents = get().subagentsBySession[sid];
      if ((transcripts && Object.keys(transcripts).length > 0) || (agents && agents.length > 0)) {
        set((s) => {
          const mapRow = (x: Session) =>
            x.id === sid
              ? {
                  ...x,
                  ...(transcripts && Object.keys(transcripts).length > 0
                    ? { subagentTranscripts: transcripts }
                    : {}),
                  ...(agents && agents.length > 0 ? { subagents: agents } : {}),
                }
              : x;
          const patch: Partial<SessionState> = {};
          for (const [pid, list] of Object.entries(s.sessionsByProject)) {
            if (list?.some((x) => x.id === sid)) {
              patch.sessionsByProject = {
                ...(patch.sessionsByProject ?? s.sessionsByProject),
                [pid]: list.map(mapRow),
              };
            }
          }
          if (s.pinnedSessions.some((x) => x.id === sid)) {
            patch.pinnedSessions = s.pinnedSessions.map(mapRow);
          }
          return patch;
        });
      }
    }

    // Stop → freeze the transcript: while the interrupt sentinel is set, drop
    // any remaining content-carrying events from the aborted turn. flushFinal
    // emits buffered text.delta / thinking / tool.result while the SDK
    // generator unwinds — seconds after the Stop click — and without this
    // guard they'd keep rendering. Status events still flow so cleanup
    // proceeds. sendPrompt / editAndResendMessage clear the sentinel, so a
    // NEW turn's events stream normally again.
    if (get().interruptedBySession[sid] && CONTENT_FROZEN_EVENTS.has(e.type)) {
      return;
    }

    // session.runningSnapshot — mobile SSE (re)connect compensation. The
    // mobile event bus is unbuffered: a phone backgrounded while a turn ran
    // (iOS suspends EventSource) misses the terminal `turn.done` and its
    // runningBySession stays stuck on — which keeps the spinner alive and
    // silently disables the slash picker (inputBlocked). The host pushes
    // this snapshot as the first frame of every SSE (re)connect; it carries
    // the authoritative running set, so replace our local guesses wholesale.
    // `runningTurnStartedAt` is intentionally left untouched: its consumers
    // all fall back to Date.now(), so a snapshot-discovered running turn
    // persists correctly when its (possibly missed-then-resynced) turn.done
    // lands.
    if (e.type === "session.runningSnapshot") {
      reduceSessionRunningSnapshot(ctx, e);
      return;
    }

    // user.message — cross-client echo of a prompt typed on another client
    // (phone → PC or PC → phone), emitted by main right before the turn
    // starts. The originator appended its bubble optimistically at send and
    // passed the SAME id, so the id check below makes the echo a no-op
    // there; everyone else appends the bubble verbatim, in time to sit above
    // the assistant reply that is about to stream in. Without this, a
    // phone-typed prompt only reached the PC via the DB on a later
    // open/restart — a hydrated session never re-fetched, so the bubble was
    // simply missing while the reply streamed in headerless.
    if (e.type === "user.message") {
      reduceUserMessage(ctx, e);
      return;
    }

    // todo.update is an independent state slice — handle and skip the
    // message-accumulation logic below.
    if (e.type === "todo.update") {
      reduceTodoUpdate(ctx, e);
      return;
    }
    // git.changed — a repo's git state changed on the host (any client).
    // Independent state slice: bump the per-repo version; git surfaces
    // re-fetch in their own effects. No sessionId semantics — the host emits
    // "" (envelope compatibility, see SessionRunningSnapshotEvent).
    if (e.type === "git.changed") {
      reduceGitChanged(ctx, e);
      return;
    }
    // setting.changed / projects.changed — cross-client sync of account-level
    // prefs and the project list (see @contracts/ipc/settingsSync). No
    // sessionId semantics (""), same as git.changed.
    if (e.type === "setting.changed") {
      reduceSettingChanged(ctx, e);
      return;
    }
    if (e.type === "projects.changed") {
      reduceProjectsChanged(ctx, e);
      return;
    }
    // session.changed — cross-client list sync (a phone or another client
    // created/renamed/pinned/archived a session; the same event also echoes
    // our OWN local mutations back, idempotently). Upserts the slim row into
    // whichever per-project cache is loaded. Unloaded projects are skipped —
    // their buckets are (re)fetched wholesale by loadSessions/selectProject.
    if (e.type === "session.changed") {
      reduceSessionChanged(ctx, e);
      return;
    }
    // session.deleted — a session row was hard-deleted on another client.
    // Same in-memory surgery as the local deleteSession action (tabs, buckets,
    // active-thread fallback all included).
    if (e.type === "session.deleted") {
      reduceSessionDeleted(ctx, e);
      return;
    }
    // request.resolved — a pending approval / question / plan request was
    // answered on ANOTHER client (the main-side Deferred resolves exactly
    // once). Close this client's copy of the dialog: the requestId can no
    // longer be answered. The answering client's own local cleanup already ran
    // when it submitted, so the filter is a no-op there.
    if (e.type === "request.resolved") {
      reduceRequestResolved(ctx, e);
      return;
    }
    // plan.update: drives BOTH the activity capsule (planBySession) AND the
    // inline `kind: "plan"` block on the current turn's trailing assistant
    // message. The inline block is what the user actually reads in the
    // message stream — it stays put per-turn (different turns → different
    // plan blocks in history), unlike the old footer card which was a single
    // session-global slot that got overwritten each turn.
    //   phase "drafting" → no card yet: the drafting placeholder arrives with
    //     empty text (EnterPlanMode), and an empty plan card is noise. The
    //     inline block only appears once real plan text exists (ready).
    //   phase "ready"    → live card with 已就绪 badge after ExitPlanMode.
    //   phase "cleared"  → remove the live block (plan mode exited / denied).
    if (e.type === "plan.update") {
      reducePlanUpdate(ctx, e);
      return;
    }
    // mode.change: the model (or host) flipped the session's effective
    // permission mode mid-turn (e.g. EnterPlanMode / ExitPlanMode after
    // approval). Sync the composer chip for the ACTIVE session so it
    // reflects runtime reality instead of the stale startup mode. Only the
    // active session's chip is updated — other tabs keep their own config.
    // Persist fire-and-forget so a resumed turn starts in the right mode.
    if (e.type === "mode.change") {
      reduceModeChange(ctx, e);
      return;
    }
    // upstream.issue — transient transport trouble on the session's model
    // channel (the OpenAI bridge retrying a connect timeout / reset). No
    // message-stream impact: the hint renders beside the streaming spinner
    // (ChatPane) so a 10s+ stall reads as "网络在重试" instead of a hang.
    // kind "ok" (a retried request went through) and turn-end paths clear it,
    // plus the decay timer above as the safety net.
    if (e.type === "upstream.issue") {
      reduceUpstreamIssue(ctx, e);
      return;
    }
    // subagent.update: REPLACE semantics — swap the full roster.
    if (e.type === "subagent.update") {
      reduceSubagentUpdate(ctx, e);
      return;
    }
    // subagent.transcript: REPLACE one subagent's transcript (inner key =
    // the spawning Task tool_use id). Process-lifetime data — no persistence,
    // cleared when the next turn starts (see sendPrompt).
    if (e.type === "subagent.transcript") {
      reduceSubagentTranscript(ctx, e);
      return;
    }
    // workflow.node.transcript: REPLACE one workflow node's transcript (key = 跑那一步的
    // 隐藏会话 id)。**替换语义** —— 主进程每次发全量,这里整体换掉,所以丢一条也不会让
    // 界面停在半截状态。与 subagent.transcript 同一套做法,差别只在"新回合不清"和
    // "有容量上限"(见 `workflowNodeTranscripts` 上那两条)。
    if (e.type === "workflow.node.transcript") {
      reduceWorkflowNodeTranscript(ctx, e);
      return;
    }
    // token-usage.updated: replace this session's context snapshot. The
    // adapter already normalized everything (usedTokens / maxTokens / pct /
    // warning), so we just store + the chip renders. Main also persists this
    // to the session row, so it round-trips on reload via hydrateContextSnapshot.
    // We also mirror it into the sessionsByProject cache so the next
    // selectSession/openTab's hydrate reads a fresh value instead of the
    // stale snapshot captured at list time (which could be null/invalid and
    // trigger the else-delete branch, hiding the ring until the next event).
    if (e.type === "token-usage.updated") {
      reduceTokenUsageUpdated(ctx, e);
      return;
    }
    if (e.type === "question.ask") {
      reduceQuestionAsk(ctx, e);
      return;
    }
    if (e.type === "approval.request") {
      reduceApprovalRequest(ctx, e);
      return;
    }
    if (e.type === "plan.approval_request") {
      reducePlanApprovalRequest(ctx, e);
      return;
    }
    if (e.type === "turn.files") {
      reduceTurnFiles(ctx, e);
      return;
    }
    if (e.type === "compact.result") {
      reduceCompactResult(ctx, e);
      return;
    }
    if (e.type === "workflow.node.progress") {
      reduceWorkflowNodeProgress(ctx, e);
      return;
    }
    if (e.type === "workflow.node.result") {
      reduceWorkflowNodeResult(ctx, e);
      return;
    }
    if (e.type === "workflow.node.usage") {
      reduceWorkflowNodeUsage(ctx, e);
      return;
    }
    if (e.type === "workflow.node.choice") {
      reduceWorkflowNodeChoice(ctx, e);
      return;
    }
    if (e.type === "turn.rewound") {
      reduceTurnRewound(ctx, e);
      return;
    }
    if (e.type === "commands.available") {
      // 引擎报来的斜杠命令清单（见 `engineCommandsByProvider`）。整体替换 —— 装了
      // 插件之后清单会变，合并只会留下已经消失的命令。
      //
      // ⚠️ **要落到"这个会话的引擎"那一格**，不是当前选中的引擎：事件是某个会话发出来
      // 的，而用户可能已经切到别的引擎的会话上了。取不到就跳过（会话刚建、还没进
      // streamSessions）—— 那种情况下主动取那条路（`reloadEngineCommands`）会补上。
      const evProviderId = get().streamSessions.find((s) => s.id === sid)?.providerId;
      if (evProviderId) {
        set((s) => ({
          engineCommandsByProvider: {
            ...s.engineCommandsByProvider,
            [evProviderId]: {
              supported: true,
              commands: e.commands,
            },
          },
        }));
      }
      return;
    }

    set((s) => {
      const list = s.messagesBySession[sid] ?? [];
      let next: ChatMessage[] = list;

      switch (e.type) {
        case "text.delta": {
          // Buffer the delta — flushDeltas will apply accumulated text in a
          // single rAF-bound setState, collapsing many single-char deltas into
          // one React update per frame (~60 Hz instead of per-char).
          const key = `${sid}:${e.messageId}`;
          const existing = deltaBuf.get(key);
          if (existing) {
            appendDelta(existing, "text", e.text);
          } else {
            deltaBuf.set(key, { sessionId: sid, messageId: e.messageId, segs: [{ k: "text", text: e.text }] });
          }
          scheduleDeltaFlush();
          // Don't add to `next` — flushDeltas mutates the store directly.
          break;
        }
        case "thinking": {
          const key = `${sid}:${e.messageId}`;
          const existing = deltaBuf.get(key);
          if (existing) {
            appendDelta(existing, "thinking", e.text);
          } else {
            deltaBuf.set(key, { sessionId: sid, messageId: e.messageId, segs: [{ k: "thinking", text: e.text }] });
          }
          scheduleDeltaFlush();
          break;
        }
        case "tool.use": {
          // messageId path: the event carries the owning message (pi: the
          // PiMessageAdapter forwards the narration messageId snapshot at
          // toolcall_start; claude: the SdkMessageAdapter reuses the
          // preceding text/thinking block's messageId). The narration text
          // was already flushed to that message (forceDeltaFlush above), so
          // append the tool directly to it. This keeps the interleaved
          // "text → tool → text → tool" timeline intact; without it every
          // tool would pile onto the turn's opener via the heuristic below.
          const targetIdx = e.messageId ? next.findIndex((m) => m.id === e.messageId) : -1;
          if (targetIdx >= 0) {
            const block: Block = { kind: "tool_use", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input, status: "running" };
            const updated = { ...next[targetIdx], blocks: [...next[targetIdx].blocks, block] };
            next = next.map((m, i) => (i === targetIdx ? updated : m));
            break;
          }
          // Fallback (no usable messageId — e.g. a tool block with no
          // preceding text/thinking in the same assistant message, or a
          // legacy event): target the open turn's chronologically-LAST
          // assistant message (findOpenTurnLastAssistant — NOT the opener,
          // and NOT a naive "last assistant message": appending to the opener
          // would place this tool BEFORE narration messages that already
          // streamed, corrupting the arrival-order timeline the completed-
          // turn process/reply split relies on; a naive last-assistant scan
          // would, after an edit-resend / history truncation, hit a CLOSED
          // turn's message and merge two turns into one giant panel).
          const openIdx = findOpenTurnLastAssistant(next);
          let lastAssistant = openIdx >= 0 ? next[openIdx] : undefined;
          if (!lastAssistant) {
            // No open-turn assistant message exists — this tool_use starts a
            // fresh turn. Stamp turnMeta so the renderer shows the per-turn
            // stat row above this message. Past turns' messages still carry
            // their (now-ended) turnMeta, so we checked endedAt above, not
            // just presence.
            const isNewTurn = !next.some(
              (m) => m.role === "assistant" && m.turnMeta && m.turnMeta.endedAt === undefined,
            );
            // Prefer the send-time anchor (stamped in sendPrompt) so the real
            // turnMeta continues the synthesized pendingTurn row's timing
            // seamlessly - otherwise the duration would jump. Falls back to
            // now if the anchor is missing (resumed/legacy turn).
            const startedAt = (isNewTurn && s.runningTurnStartedAt[sid]) || Date.now();
            lastAssistant = {
              id: `a_${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              blocks: [],
              createdAt: Date.now(),
              ...(isNewTurn
                ? { turnMeta: { startedAt, model: s.runningTurnModelBySession[sid] } }
                : {}),
            };
            next = [...next, lastAssistant];
            // A new turn opened (no prior open-turn assistant message) — demote
            // any previous latest turn-files card to read-only.
            if (isNewTurn) next = demotePreviousLatestTurnFiles(next);
          }
          const block: Block = { kind: "tool_use", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input, status: "running" };
          const updated = { ...lastAssistant, blocks: [...lastAssistant.blocks, block] };
          next = next.map((m) => (m.id === lastAssistant!.id ? updated : m));
          break;
        }
        case "tool.result": {
          next = next.map((m) => {
            const hasBlock = m.blocks.some((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
            if (!hasBlock) return m;
            // If the result carries image(s) (e.g. a Claude-path screenshot),
            // attach inline image blocks right after the tool_use card. A single
            // result may carry multiple images. Skip images already present for
            // this toolCallId (the Pi path may have added some via browser.image
            // events) — match by data to dedupe, not by mere existence.
            const imgs = extractImagesFromToolResult(e.content);
            const blocks: Block[] = m.blocks.map((b) => {
              if (b.kind === "tool_use" && b.toolCallId === e.toolCallId) {
                return { ...b, status: e.isError ? "error" : "done", result: e.content };
              }
              return b;
            });
            if (imgs.length > 0) {
              const tuIdx = blocks.findIndex((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
              const existing = new Set(
                blocks.filter((b) => b.kind === "image").map((b) => (b as { data: string }).data),
              );
              const toAdd: Block[] = [];
              for (const img of imgs) {
                if (!existing.has(img.data)) {
                  toAdd.push({ kind: "image", toolCallId: e.toolCallId, data: img.data, mimeType: img.mimeType });
                }
              }
              if (toAdd.length > 0) blocks.splice(tuIdx + 1, 0, ...toAdd);
            }
            return { ...m, blocks };
          });
          break;
        }
        case "browser.image": {
          // Pi path: the provider emits this when browser_screenshot runs.
          // Attach an inline image block right after the tool_use card,
          // deduped by toolCallId (an earlier tool.result may have already
          // extracted the image from the result content).
          next = next.map((m) => {
            const tuIdx = m.blocks.findIndex((b) => b.kind === "tool_use" && b.toolCallId === e.toolCallId);
            if (tuIdx < 0) return m;
            const hasImage = m.blocks.some((b) => b.kind === "image" && b.toolCallId === e.toolCallId);
            if (hasImage) return m;
            const imageBlock = { kind: "image" as const, toolCallId: e.toolCallId, data: e.data, mimeType: e.mimeType };
            const blocks = [...m.blocks];
            blocks.splice(tuIdx + 1, 0, imageBlock);
            return { ...m, blocks };
          });
          break;
        }
        case "turn.incomplete": {
          // Gateway-truncated turn (empty final response). The adapter emits
          // this immediately BEFORE turn.done — append the warning card and
          // toast here, and flag the session so the turn.done case skips its
          // misleading "回合完成" toast/unread bump (already done here).
          next = [
            ...next,
            {
              id: `ti_${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              blocks: [
                {
                  kind: "turn-incomplete",
                  incompleteKind: e.kind,
                  pendingToolNames: e.pendingToolCalls.map((c) => c.toolName),
                },
              ],
              createdAt: Date.now(),
            },
          ];
          bumpUnread();
          pushToast(
            "warning",
            translate(get().locale, "store.toast.turnIncomplete"),
            translate(
              get().locale,
              e.kind === "empty-response"
                ? "chatStream.turnIncomplete.emptyDesc"
                : e.kind === "unfinished-text"
                  ? "chatStream.turnIncomplete.unfinishedDesc"
                  : "chatStream.turnIncomplete.danglingDesc",
            ),
          );
          set((s) => ({ turnIncompleteBySession: { ...s.turnIncompleteBySession, [sid]: true } }));
          break;
        }
        case "turn.notice": {
          // Host-side lifecycle notice (S2/S3/S4: structured output failed
          // validation, per-turn budget cap reached, model fallback retry).
          // NOT a turn terminator — turn.done still follows and owns the
          // terminal cleanup. Append the inline card and surface it like any
          // other stream output. For `fallback`, the turn.done(reason=
          // "error") that preceded it already ran that cleanup (running=
          // false, approvals dropped, …) — the host immediately retries the
          // SAME input on the next model and events keep streaming, so
          // re-arm the running flag here (the composer must stay locked).
          next = [
            ...next,
            {
              id: `tn_${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              blocks: [{ kind: "turn-notice", noticeKind: e.kind, message: e.message }],
              createdAt: Date.now(),
            },
          ];
          bumpUnread();
          if (e.kind === "fallback") {
            set((s) => ({ runningBySession: { ...s.runningBySession, [sid]: true } }));
          }
          break;
        }
        case "local_command.output": {
          // 本地斜杠命令（`/usage`、`/context` 这类不经过模型的）的结果文本。
          // 引擎把它当「assistant-style text in the transcript」发回来，所以我们
          // 也当一条 assistant 消息落进流里 —— 用户发了命令，就该看得见结果。
          //
          // 命令名从**用户刚发的那条消息**上取：引擎只回内容、不带命令名，而那条
          // 消息就在同一个列表里（渲染端有，不必再走一遍 IPC 把名字带过来）。
          next = [
            ...next,
            {
              id: `lc_${Date.now()}`,
              sessionId: sid,
              role: "assistant",
              blocks: [{ kind: "local-command", name: commandNameForLocalOutput(next), content: e.content }],
              createdAt: Date.now(),
            },
          ];
          bumpUnread();
          break;
        }
        case "error": {
          next = [...next, { id: `err_${Date.now()}`, sessionId: sid, role: "assistant", blocks: [{ kind: "error", message: e.message }], createdAt: Date.now() }];
          // An error terminates the turn just like turn.done - stamp the
          // end time so the duration row freezes.
          const errEndedAt = Date.now();
          next = next.map((m) =>
            m.turnMeta && m.turnMeta.endedAt === undefined
              ? { ...m, turnMeta: { ...m.turnMeta, endedAt: errEndedAt } }
              : m,
          );
          bumpUnread();
          pushToast("error", translate(get().locale, "store.toast.errorOccurred"), e.message);
          set((s) => {
            const runningTurnStartedAt = { ...s.runningTurnStartedAt };
            delete runningTurnStartedAt[sid];
            return {
              runningBySession: { ...s.runningBySession, [sid]: false },
              runningTurnStartedAt,
              // Stream sidebar's 「失败」label — sticky until the next turn.
              turnErrorBySession: { ...s.turnErrorBySession, [sid]: true },
              // Only drop approvals + files belonging to this session; the
              // head pendingApprovals is per-session already, but it's a
              // flat array - filter down to the affected one.
              pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid),
              turnFilesBySession: { ...s.turnFilesBySession, [sid]: [] },
            };
          });
          // Turn over — any live upstream-retry hint is stale (a later retry
          // re-arms it for the next turn).
          clearUpstreamIssue(set, sid);
          break;
        }
        case "turn.done": {
          // A turn.incomplete arrived just before this turn.done — the work
          // did NOT finish (gateway returned an empty final response) and its
          // own case already toasted a warning + bumped unread. Consume the
          // flag so we don't ALSO toast "回合完成" on a truncated turn.
          const turnIncomplete = !!get().turnIncompleteBySession[sid];
          if (turnIncomplete) {
            set((s) => {
              const turnIncompleteBySession = { ...s.turnIncompleteBySession };
              delete turnIncompleteBySession[sid];
              return { turnIncompleteBySession };
            });
          }
          // Bump unread for non-active sessions on turn completion - the
          // result is ready and the user may have switched away. Skipped for
          // interrupted turns (the user initiated the stop, no surprise),
          // for tool_use turns (the adapter will resume streaming shortly;
          // the intermediate result is not a "done" signal), for incomplete
          // turns (see above), and for failed turns: the preceding error event
          // already bumped unread and showed the actual failure, so a second
          // "turn complete" toast here would contradict it.
          if (e.reason !== "interrupted" && e.reason !== "tool_use" && e.reason !== "error" && !turnIncomplete) {
            bumpUnread();
            if (e.reason === "max_tokens") {
              pushToast("warning", translate(get().locale, "store.toast.outputTruncated"), translate(get().locale, "store.toast.outputTruncatedBody"));
            } else {
              pushToast("info", translate(get().locale, "store.toast.turnComplete"), translate(get().locale, "store.toast.turnCompleteBody"));
            }
          }
          // Close out any tool_use still "running": the turn ended without a
          // matching tool.result (plan mode, or interrupted).
          next = next.map((m) => ({
            ...m,
            blocks: m.blocks.map((b) =>
              b.kind === "tool_use" && b.status === "running"
                ? { ...b, status: "done" as const, result: b.result ?? "(no result — turn ended)" }
                : b,
            ),
          }));
          // Stamp the turn's end time on its first assistant message so
          // the per-turn "工作时长" stat row freezes (stops ticking live).
          //
          // Prefer the timestamp main stamped on this event: main files the
          // turn's usage record under that same instant, and the ledger receipt
          // finds a turn's token count by matching it. Both processes read the
          // same system clock, so this stays compatible with the renderer-side
          // startedAt used for durations. Falls back to now for older senders.
          const endedAt = e.endedAt ?? Date.now();
          next = next.map((m) =>
            m.turnMeta && m.turnMeta.endedAt === undefined
              ? { ...m, turnMeta: { ...m.turnMeta, endedAt } }
              : m,
          );
          // Freeze or prune the inline plan block(s) on this just-closed turn.
          // An approved plan (phase "ready" + non-empty text) stays as a frozen
          // historical card in the stream; drafting / cleared / empty plans are
          // removed (they represent an in-progress or rejected draft). A plan-
          // only assistant message that prunes to empty is dropped entirely.
          // Keyed off endedAt so we touch only THIS turn's messages.
          next = freezeOrPrunePlanBlocks(next, endedAt);
          // Finalize the just-closed turn's turn-files block: mark it
          // isLatestTurn=true (it's now the latest rewindable turn) and demote
          // every earlier turn's card to read-only. turn-files blocks are
          // never pruned — each turn that touched files keeps its card in
          // history. Keyed off endedAt so only THIS turn's messages are
          // promoted; older turns get demoted by demotePreviousLatestTurnFiles.
          next = freezeLatestTurnFilesBlock(next, endedAt);
          // Any pending approvals are stale: the turn ended, the SDK won't
          // be waiting on them anymore. Drop the queue for this session so
          // a stale card doesn't linger in another tab's composer.
          // turnFilesBySession is NOT cleared here — the `turn.files` event
          // already arrived (immediately before turn.done via flushFinal)
          // and populated it. Clearing here would race with that and could
          // wipe the file list mid-event. The `turn.rewound` event is
          // what clears it on user rewind.
          //
          // Activity-capsule state (plan draft, subagent roster) is also
          // wiped here. The adapter normally emits `plan.update phase:cleared`
          // and final `subagent.update` events before turn.done, so this
          // is a defensive net for turns where neither was active (e.g.
          // a pure Q&A turn that never spawned anything). Either way, the
          // next turn starts with a clean capsule.
          set((s) => {
            const { [sid]: _dropPlan, ...restPlanApprovals } = s.pendingPlanApprovalBySession;
            // If any subagent is still `running` (typically a backgrounded task
            // whose lifecycle outlives this turn's stream), KEEP the roster so
            // the renderer can keep the composer locked + show the task as
            // in-progress. Only clear when nothing is running (the normal
            // case - foreground tasks were force-completed by the adapter).
            // EXCEPTION: a user-interrupted session (sentinel set by
            // interrupt()) must NOT keep a running roster - the abort's late
            // subagent.update can leave a backgrounded subagent "running" and
            // re-lock the composer after the user explicitly stopped. Clear it.
            const curAgents = s.subagentsBySession[sid] ?? [];
            const interrupted = !!s.interruptedBySession[sid];
            const hasRunning = !interrupted && curAgents.some((a) => a.status === "running");
            // Append a finalized usage record for this turn (for the activity
            // capsule's consumption history). Derive the turn's start from the
            // first assistant message still carrying this turn's turnMeta.
            const snap = s.contextSnapshotBySession[sid];
            const turnStart =
              next.find((m) => m.turnMeta && m.turnMeta.endedAt === endedAt)?.turnMeta?.startedAt ??
              endedAt;
            const prevHistory = s.usageHistoryBySession[sid] ?? [];
            const history =
              snap != null
                ? [
                    ...prevHistory,
                    {
                      endedAt,
                      durationMs: Math.max(0, endedAt - turnStart),
                      totalProcessedTokens: snap.totalProcessedTokens,
                      outputTokens: snap.outputTokens,
                      cacheReadTokens: snap.cacheReadTokens ?? 0,
                      cacheCreationTokens: snap.cacheCreationTokens ?? 0,
                      costUsd: snap.costUsd,
                      usedTokens: snap.usedTokens,
                      model: snap.model,
                    } satisfies TurnUsageRecord,
                  ]
                : prevHistory;
            // Mirror the appended record into the session row cache — same
            // rationale as the contextSnapshot mirror in token-usage.updated:
            // hydrateUsageHistory re-reads the ROW on every selectSession /
            // openTab, and the row as loaded predates this turn. Without the
            // mirror, switching away and back replaces the bucket with the
            // stale row value, wiping this turn's record until the next full
            // list reload (turns panel shows 无用量记录).
            let rowsUsagePatch: Partial<SessionState> | null = null;
            if (history !== prevHistory) {
              const cached = findSession(
                s.sessionsByProject, s.archivedSessionsByProject, s.pinnedSessions, s.streamSessions, sid,
              );
              if (cached && cached.usageHistory !== history) {
                rowsUsagePatch = {
                  sessionsByProject: patchSessionInCache(
                    s.sessionsByProject, cached.projectId, sid, { usageHistory: history },
                  ),
                };
                const pinnedIdx = s.pinnedSessions.findIndex((x) => x.id === sid);
                if (pinnedIdx !== -1) {
                  rowsUsagePatch.pinnedSessions = s.pinnedSessions.map((x, i) =>
                    i === pinnedIdx ? { ...x, usageHistory: history } : x,
                  );
                }
              }
            }
            return {
              runningBySession: { ...s.runningBySession, [sid]: false },
              // Turn closed - drop the send-time anchor so the synthesized
              // pendingTurn row stops rendering (it keys off isRunning, but
              // clearing this is belt-and-suspenders and keeps the slice tidy
              // for the next turn).
              runningTurnStartedAt: (() => {
                const m = { ...s.runningTurnStartedAt };
                delete m[sid];
                return m;
              })(),
              // 这一轮收尾了 —— 就算还有卡片显示"在等",那个等待也跟着这次运行一起
              // 结束了(要么没人点、要么被取消)。**这一句是 `waitingBranchesBySession`
              // 的兜底**:计数器靠两条事件配对,而"配对失败"的任何一种都会让它永远
              // 大于 0 —— 那时输入框会一直不锁,用户能在图正干活的时候插话。
              // 宁可少放松一次,不要多放松。
              waitingBranchesBySession: { ...s.waitingBranchesBySession, [sid]: 0 },
              pendingApprovals: s.pendingApprovals.filter((p) => p.sessionId !== sid),
              pendingPlanApprovalBySession: restPlanApprovals,
              // Keep the plan card visible when the plan was APPROVED (phase
              // "ready" with non-empty text) so it persists in the message
              // stream after the turn ends and across thread reopen. Clear
              // drafting / empty / cleared plans — those represent an
              // unapproved draft or the absence of a plan.
              planBySession: {
                ...s.planBySession,
                [sid]: (s.planBySession[sid]?.phase === "ready" && s.planBySession[sid]?.plan)
                  ? s.planBySession[sid]
                  : { plan: "", phase: "cleared" },
              },
              subagentsBySession: hasRunning
                ? s.subagentsBySession
                : { ...s.subagentsBySession, [sid]: [] },
              usageHistoryBySession: { ...s.usageHistoryBySession, [sid]: history },
              ...(rowsUsagePatch ?? {}),
            };
          });
          // Turn closed — drop any live upstream-retry hint (the channel may
          // still flap next turn, which re-arms it).
          clearUpstreamIssue(set, sid);
          break;
        }
        default:
          break;
      }

      return { messagesBySession: { ...s.messagesBySession, [sid]: next } };
    });

    // At terminal events the snapshot is final — persist it so the history
    // survives restart. Fire-and-forget; don't block the UI.
    //
    // Incremental upsert: only this turn's messages changed (the send-time
    // user message + every assistant message produced this turn). Persisting
    // just those rows avoids the O(N) DELETE+re-INSERT of a full snapshot on
    // every turn — the cost is O(this turn) regardless of session length.
    if (e.type === "turn.done" || e.type === "error") {
      const snapshot = get().messagesBySession[sid];
      if (snapshot && persistsTurnContent()) {
        // Identify this turn's messages by the captured send-time anchor.
        // Falls back to full saveMessages when the anchor is missing (e.g. a
        // turn done arrived for a session we never started, or resumed mid-
        // turn) — preserving the old robustness.
        const tail =
          turnStartAtCapture != null
            ? snapshot.filter(
                (m) => m.createdAt >= turnStartAtCapture || m.turnMeta?.startedAt === turnStartAtCapture,
              )
            : snapshot;
        const toSave = tail.length > 0 ? tail : snapshot;
        persistMessages({ sessionId: sid, messages: toRecords(sid, toSave) });
      }
      // The session may have just gone fully idle — if the user queued a
      // prompt while busy, fire the head now. drainPromptQueueIfIdle is a
      // no-op when still busy (e.g. backgrounded subagents still running) or
      // when the queue is empty.
      get().drainPromptQueueIfIdle(sid);
      // 重连时这一轮还在跑、断开期间漏了正文 —— 现在它收尾了,等桌面写完库再
      // 整页重拉(见 resyncAfterReconnect)。
      if (e.type === "turn.done" && resyncAfterTurn.delete(sid)) {
        setTimeout(() => void get().resyncSessionMessages(sid), RESYNC_AFTER_TURN_DELAY_MS);
      }
    }
  },

  setSettingsOpen: (open, section, focusWorkflowId) => {
    set(
      open
        ? {
            settingsOpen: true,
            settingsSection: section ?? null,
            settingsFocusWorkflowId: focusWorkflowId ?? null,
          }
        : { settingsOpen: false, settingsSection: null, settingsFocusWorkflowId: null },
    );
    // Closing the settings dialog may have changed the voice model setup
    // (download / select / remove in 语音输入) — re-check so the composer mic
    // appears/disappears without a restart.
    if (!open) void get().refreshVoiceModelStatus();
  },

  setModelConfigPromptOpen: (open) => set({ modelConfigPromptOpen: open }),

  setWindowFocused: (focused) => {
    set({ isWindowFocused: focused });
    // When the window regains focus, the active session is by definition
    // "seen" - clear its unread badge so the dot doesn't linger after the
    // user returns. Non-active sessions keep their badges (the user hasn't
    // looked at those yet).
    if (focused) {
      const healthState = get();
      const health = healthState.providerHealthById[healthState.providerId];
      if (!health?.loading && (!health?.checkedAt || Date.now() - health.checkedAt >= PROVIDER_HEALTH_STALE_MS)) {
        void get().refreshProviderHealth(healthState.providerId);
      }
      const activeId = get().activeSessionId;
      if (activeId && get().unreadBySession[activeId]) {
        set((s) => {
          const unreadBySession = { ...s.unreadBySession };
          delete unreadBySession[activeId];
          return { unreadBySession };
        });
      }
    }
  },

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSearchDialogOpen: (open) => set({ searchDialogOpen: open }),
  setLeftOpen: (open) => {
    // While wide-panel (3:7) mode is on the left sidebar must stay closed —
    // guard in the store so no caller/command can open it.
    if (open && get().widePanelOpen) return;
    set({ leftOpen: open });
  },
  setRightOpen: (open) => set({ rightOpen: open }),
  setBottomTerminalOpen: (open) => set({ bottomTerminalOpen: open }),
  setBrowserPanelOpen: (open) => {
    // Opening the fullscreen overlay forces the right panel closed so the
    // embedded sidebar browser unmounts — the two containers must never be
    // active at once (they'd fight over the shared WebContentsView). Closing
    // the overlay leaves rightOpen as-is (the user can reopen the panel).
    if (open) {
      set({ browserPanelOpen: true, rightOpen: false });
    } else {
      set({ browserPanelOpen: false });
    }
  },
  setWidePanelOpen: (open) => {
    const s = get();
    if (open === s.widePanelOpen) return;
    if (open) {
      // Enter wide mode: snapshot the pre-enter layout so exit can restore it,
      // hide the left sidebar and close any browser overlay (it would cover the
      // wide layout). rightPanelTab is left untouched — the right 8/10 keeps
      // whatever tab is already active.
      set({
        widePanelSnapshot: {
          leftOpen: s.leftOpen,
          rightOpen: s.rightOpen,
          rightWidth: s.rightWidth,
        },
        widePanelOpen: true,
        leftOpen: false,
        // The right panel is the mode's centerpiece — always show it on enter.
        // (The titlebar right-panel toggle then hides/shows it during the
        // mode; exit still restores the pre-enter rightOpen from the snapshot.)
        rightOpen: true,
        browserPanelOpen: false,
      });
    } else {
      const snap = s.widePanelSnapshot;
      set({
        widePanelOpen: false,
        widePanelSnapshot: null,
        leftOpen: snap?.leftOpen ?? true,
        rightOpen: snap?.rightOpen ?? true,
        rightWidth: snap?.rightWidth ?? s.rightWidth,
      });
    }
  },
  setBrowserTabCount: (count) => set({ browserTabCount: Math.max(0, count) }),
  setBrowserDeviceToolbarOpen: (open) => set({ browserDeviceToolbarOpen: open }),
  suppressBrowserView: (suppressed) =>
    set((s) => ({ browserViewSuppressed: Math.max(0, s.browserViewSuppressed + (suppressed ? 1 : -1)) })),
  setBrowserTabs: (tabs) => set({ browserTabs: tabs }),
  setBrowserActiveTabId: (id) => set({ browserActiveTabId: id }),
  addBrowserTab: (tab) => set((s) => ({ browserTabs: [...s.browserTabs, tab] })),
  removeBrowserTab: (id) =>
    set((s) => ({ browserTabs: s.browserTabs.filter((t) => t.id !== id) })),
  patchBrowserTab: (browserId, patch) =>
    set((s) => ({
      browserTabs: s.browserTabs.map((t) => (t.browserId === browserId ? { ...t, ...patch } : t)),
    })),
  openUrlInBrowser: (url) => {
    // Reveal the browser sidebar + stage the URL. BrowserPanel opens it in a
    // NEW tab: when tabs already exist it creates one for the URL; when none
    // exist (panel first opened) the first-tab effect loads it into the
    // initial tab.
    get().setRightPanelTab("browser");
    set({ rightOpen: true, pendingBrowserUrl: url });
  },
  adoptAgentBrowserTab: (browserId, info) => {
    const s = get();
    const existing = s.browserTabs.find((t) => t.browserId === browserId);
    if (existing) {
      // Already adopted — refresh url/title ONLY and activate it. We must NOT
      // overwrite device/orientation/customWidth/customHeight: the user may have
      // manually selected a device preset or custom size, and an agent
      // navigation (which defaults device to "desktop") must never clobber that
      // selection. Chromium device emulation also persists across navigations,
      // so the main process keeps the user's emulation without re-applying.
      if (info.url || info.title) {
        set({
          browserTabs: s.browserTabs.map((t) =>
            t.browserId === browserId
              ? {
                  ...t,
                  ...(typeof info.url === "string" ? { url: info.url } : {}),
                  ...(typeof info.title === "string" ? { title: info.title } : {}),
                }
              : t,
          ),
        });
      }
      if (s.browserActiveTabId !== existing.id) set({ browserActiveTabId: existing.id });
      return false;
    }
    // Register a new tab for the agent-created view. device comes from the
    // agent's navigate call (default desktop = no emulation, full viewport).
    const tab: BrowserTab = {
      id: `agent-${browserId}`,
      browserId,
      url: info.url ?? "",
      title: info.title ?? "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      pickMode: false,
      device: info.device ?? "desktop",
      orientation: info.orientation,
    };
    set({ browserTabs: [...s.browserTabs, tab], browserActiveTabId: tab.id });
    return true;
  },

  // ── Draggable pane sizes ──
  // adjust* apply an incremental delta (from the drag handle) to the current
  // value, clamp, and set synchronously (instant UI). The DB write is
  // debounced so a drag (many mousemove events) only hits the settings table
  // once after the user stops. reset* restore the defaults (double-click).
  adjustLeftWidthPct: (deltaPct) => {
    // The divider sits to the RIGHT of the sidebar, so dragging it right
    // (delta>0) widens the sidebar — no sign flip (unlike the right-bar /
    // bottom-terminal dividers). delta is already in percentage points; the
    // caller converted px via the container width.
    const next = clampLeftWidthPct(get().leftWidthPct + deltaPct);
    set({ leftWidthPct: next });
    schedulePaneWidthPersist(get);
  },
  adjustRightWidth: (deltaPx) => {
    const s = get();
    const next = clampRightWidth(
      s.rightWidth - deltaPx,
      centerRightRowWidth(s.leftOpen, s.leftWidthPct),
    );
    set({ rightWidth: next });
    schedulePaneWidthPersist(get);
  },
  adjustBottomTerminalHeight: (deltaPx) => {
    // Divider sits on TOP of the terminal. Dragging the handle DOWN (delta>0)
    // pushes it toward the terminal, so the terminal SHRINKS — same sign flip
    // as the right-bar divider. Drag UP (delta<0) to grow it.
    const next = clampBottomTerminalHeight(get().bottomTerminalHeight - deltaPx);
    set({ bottomTerminalHeight: next });
    schedulePaneWidthPersist(get);
  },
  adjustEditorWidthPct: (deltaPx) => {
    // The divider sits to the LEFT of the editor column. Dragging it RIGHT
    // (delta>0) should move the divider rightward, which SHRINKS the editor
    // (the pane on the right of the handle) — same sign flip as the right-bar
    // and bottom-terminal dividers. Without the flip the divider moved
    // opposite to the cursor (drag left → editor shrank → handle appeared to
    // jump right).
    const next = clampEditorWidthPct(get().editorWidthPct - deltaPx);
    set({ editorWidthPct: next });
    schedulePaneWidthPersist(get);
  },
  resetLeftWidthPct: () => {
    set({ leftWidthPct: LEFT_WIDTH_PCT_DEFAULT });
    schedulePaneWidthPersist(get);
  },
  resetRightWidth: () => {
    set({ rightWidth: 360 });
    schedulePaneWidthPersist(get);
  },
  resetBottomTerminalHeight: () => {
    set({ bottomTerminalHeight: 280 });
    schedulePaneWidthPersist(get);
  },
  resetEditorWidthPct: () => {
    set({ editorWidthPct: 50 });
    schedulePaneWidthPersist(get);
  },
  adjustWidePanelPct: (deltaPx) => {
    // Divider sits LEFT of the right panel in the wide-panel split, so a drag
    // right (delta>0) shrinks the right pane — same sign flip as the editor
    // divider. In-memory only (no schedulePaneWidthPersist).
    set({ widePanelPct: clampWidePanelPct(get().widePanelPct - deltaPx) });
  },
  resetWidePanelPct: () => {
    set({ widePanelPct: WIDE_PANEL_PCT_DEFAULT });
  },

  /** Update the center-pane display mode. The local store flips
   *  immediately so the layout change is instant; the DB write is
   *  fire-and-forget so a failed write doesn't block the UI. On the
   *  next app start, `init` re-hydrates from the `settings` table. */
  setDisplayMode: async (mode) => {
    set({ displayMode: mode });
    try {
      await api.setting.set({ key: DISPLAY_MODE_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(displayMode) failed:", err);
      reportSettingSaveFailed(err);
    }
  },

  setTabBarMultiRow: (on) => {
    set({ tabBarMultiRow: on });
    // Fire-and-forget — a failed write keeps the in-session choice.
    api.setting.set({ key: TAB_BAR_MULTI_ROW_SETTING_KEY, value: on ? "true" : "false" })
      .catch((err) => {
        console.error("setting.set(tabBarMultiRow) failed:", err);
        reportSettingSaveFailed(err);
      });
  },

  setLeftBarMode: async (mode) => {
    set({ leftBarMode: mode });
    // Entering the stream with a warm-but-dirty cache should show fresh
    // data; entering with a clean cache is instant.
    if (mode === "stream") set({ streamDirty: true });
    try {
      await api.setting.set({ key: LEFTBAR_MODE_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(leftBarMode) failed:", err);
      reportSettingSaveFailed(err);
    }
  },

  setThemeStyle: (style) => {
    set({ themeStyle: style });
    // Fire-and-forget — a failed write keeps the in-session choice (same
    // pattern as setTabBarMultiRow). The <html>.sketch class reacts via
    // useThemeStyle (lib/appearance.ts), which also refreshes the
    // localStorage cache the boot FOUC guard reads.
    api.setting.set({ key: THEME_STYLE_SETTING_KEY, value: style })
      .catch((err) => {
        console.error("setting.set(themeStyle) failed:", err);
        reportSettingSaveFailed(err);
      });
  },

  setStreamScope: (scope) => {
    // Dirty, not just a value swap: the cached pages were fetched under the
    // OLD scope — the view must refetch its first page so the list AND the
    // bottom "显示更多" count (hasMore/total are scope-filtered server-side)
    // follow the switched-to project.
    set({ streamScope: scope, streamDirty: true });
    // setting.set only accepts strings — the unfiltered "全部项目" state is
    // encoded as the empty string (mirror of the hydration rule in init).
    // Fire-and-forget: a failed write just means the next visit falls back
    // to the unfiltered view.
    api.setting
      .set({ key: UI_STREAM_SCOPE_SETTING_KEY, value: scope ?? "" })
      .catch((err) => console.error("setting.set(streamScope) failed:", err));
  },

  loadStreamSessions: async (reset) => {
    const s = get();
    if (!reset && s.streamSessions.length > 0 && !s.streamDirty) return;
    const seq = ++streamFetchSeq;
    try {
      const res = await api.session.listAll({
        offset: 0,
        limit: STREAM_PAGE_SIZE,
        ...streamScopeQuery(s.streamScope, s.projects),
      });
      // Superseded by a newer fetch (scope flipped / re-dirty mid-flight):
      // the newer response owns the cache.
      if (seq !== streamFetchSeq) return;
      set({ streamSessions: res.sessions, streamHasMore: res.hasMore, streamTotal: res.total, streamDirty: false });
    } catch (err) {
      console.error("session.listAll failed:", err);
    }
  },

  loadMoreStreamSessions: async () => {
    const s = get();
    if (!s.streamHasMore) return;
    const seq = ++streamFetchSeq;
    try {
      const res = await api.session.listAll({
        offset: s.streamSessions.length,
        limit: STREAM_PAGE_SIZE,
        ...streamScopeQuery(s.streamScope, s.projects),
      });
      if (seq !== streamFetchSeq) return;
      set((st) => ({
        streamSessions: [...st.streamSessions, ...res.sessions],
        streamHasMore: res.hasMore,
        streamTotal: res.total,
      }));
    } catch (err) {
      console.error("session.listAll(more) failed:", err);
    }
  },

  ensureWorktreeInfo: async (repoPath) => {
    const s = get();
    const version = s.gitChangeVersionByRepo[repoPath] ?? 0;
    const cached = s.worktreeInfoByRepo[repoPath];
    if (cached && cached.version === version) return;
    try {
      const { worktrees } = await api.git.worktreeList({ repoPath });
      // Re-check under the set: a git event may have bumped the version
      // mid-flight; storing the OLD version would pin a stale entry only
      // until the next ensure — harmless either way.
      set((st) => ({
        worktreeInfoByRepo: { ...st.worktreeInfoByRepo, [repoPath]: { version, worktrees } },
      }));
    } catch (err) {
      console.error("git.worktreeList(ensure) failed:", err);
    }
  },

  /** Direct focus switch for the unified center tab bar (tabs displayMode).
   *  See the `centerTabFocus` field doc — natural actions flip it too. */
  setCenterTabFocus: (focus) => {
    set({ centerTabFocus: focus });
  },

  /** Update the UI language. Same immediate-flip + fire-and-forget-persist
   *  pattern as setDisplayMode. Also mirrors the choice onto
   *  <html lang> so assistive tech + font selection follow the UI language. */
  setLocale: async (locale) => {
    set({ locale });
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    try {
      await api.setting.set({ key: UI_LOCALE_SETTING_KEY, value: locale });
    } catch (err) {
      console.error("setting.set(locale) failed:", err);
      reportSettingSaveFailed(err);
    }
  },

  /** Update the session auto-archive rules. Same immediate-flip +
   *  fire-and-forget-persist pattern as setDisplayMode; the main-process
   *  AutoArchiver re-reads the key on its next tick. */
  setAutoArchiveConfig: async (config) => {
    set({ autoArchiveConfig: config });
    try {
      await api.setting.set({ key: AUTO_ARCHIVE_SETTING_KEY, value: JSON.stringify(config) });
    } catch (err) {
      console.error("setting.set(autoArchive) failed:", err);
    }
  },

  /** Update the chat density. Same immediate-flip + fire-and-forget-persist
   *  pattern as setDisplayMode; the CSS vars are re-applied reactively by
   *  useChatAppearance subscribing to `chatDensity`. */
  setChatDensity: async (mode) => {
    set({ chatDensity: mode });
    try {
      await api.setting.set({ key: UI_CHAT_DENSITY_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(chatDensity) failed:", err);
      reportSettingSaveFailed(err);
    }
  },

  /** Toggle the left-bar project view between flat and grouped. Same
   *  immediate-flip + fire-and-forget-persist pattern as setDisplayMode. */
  setProjectView: async (mode) => {
    set({ projectView: mode });
    try {
      await api.setting.set({ key: UI_PROJECT_VIEW_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(projectView) failed:", err);
      reportSettingSaveFailed(err);
    }
  },

  /** Write the current groupMeta to the settings blob (fire-and-forget). */
  persistGroupMeta: (meta) => {
    try {
      saveSetting({
        key: UI_PROJECT_GROUPS_SETTING_KEY,
        value: JSON.stringify(meta),
      });
    } catch (err) {
      console.error("setting.set(projectGroups) failed:", err);
    }
  },

  /** Set a group's color. `rgb` is a "R G B" triplet or null (default). */
  setGroupColor: (name, rgb) => {
    const meta = get().groupMeta;
    const next: ProjectGroupsMeta = {
      ...meta,
      [name]: { ...meta[name], color: rgb },
    };
    set({ groupMeta: next });
    get().persistGroupMeta(next);
  },

  /** Set / clear a project's avatar color override. State flips immediately;
    * the settings write is fire-and-forget (a failed write costs at most a
    * reverted color on next launch — same trade as worktreeNames). */
  setProjectColor: (id, hex) => {
    const next = { ...get().projectColors };
    if (hex) next[id] = hex;
    else delete next[id];
    set({ projectColors: next });
    api.setting
      .set({ key: PROJECT_COLORS_SETTING_KEY, value: JSON.stringify(next) })
      .catch((err: unknown) => console.error("setting.set(projectColors) failed:", err));
  },

  /** Persist a new group order. `orderedNames` is the full group-name list in
   *  the desired order; index becomes each group's `order`. */
  setGroupOrder: (orderedNames) => {
    const meta = get().groupMeta;
    const next: ProjectGroupsMeta = { ...meta };
    orderedNames.forEach((name, i) => {
      next[name] = { ...next[name], order: i };
    });
    set({ groupMeta: next });
    get().persistGroupMeta(next);
  },

  /** Migrate a group's metadata when it's renamed (color + order follow). */
  renameGroupMeta: (oldName, newName) => {
    const meta = get().groupMeta;
    if (!meta[oldName]) return;
    const { [oldName]: entry, ...rest } = meta;
    const next: ProjectGroupsMeta = { ...rest, [newName]: entry };
    set({ groupMeta: next });
    get().persistGroupMeta(next);
  },

  /** Assign a project to a group (left-bar "grouped" view). Pass null to
   *  remove it. The returned project replaces the stale copy in state. */
  setProjectGroup: async (id, group) => {
    const { project } = await api.project.setGroup({ id, group });
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
  },

  /** Rename a project (display-only). The returned project replaces the
   *  stale copy in state — every consumer (left bar, archive bin, settings
   *  project pickers) reads the same `projects` array and follows along. */
  renameProject: async (id, name) => {
    const { project } = await api.project.rename({ id, name });
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
  },

  /** Pin/unpin a project. The row's POSITION changes (pinned section vs
   *  flat list / group), and the authoritative ordering lives in the DB's
   *  list query — rather than hand-maintaining that order in the renderer,
   *  refetch the whole (small) list after the write. */
  setProjectPinned: async (id, pinned) => {
    await api.project.setPinned({ id, pinned });
    const { projects } = await api.project.list();
    set({ projects });
  },

  /** Persist a drag-to-reorder. The renderer sends the full ordered id list
   *  (across the current view); here we optimistically reorder the in-memory
   *  `projects` array to match (keeping each project object reference stable
   *  so consumers keyed on identity don't re-render), then fire-and-forget
   *  the DB write. Projects not present in `orderedIds` (e.g. archived rows
   *  filtered out of the drag view) keep their relative position at the end. */
  reorderProjects: async (orderedIds) => {
    set((s) => {
      const byId = new Map(s.projects.map((p) => [p.id, p]));
      const next: Project[] = [];
      const seen = new Set<string>();
      for (const id of orderedIds) {
        const p = byId.get(id);
        if (p && !seen.has(id)) {
          next.push(p);
          seen.add(id);
        }
      }
      // Append any projects not in orderedIds (archived / filtered out) so
      // they aren't dropped from state.
      for (const p of s.projects) {
        if (!seen.has(p.id)) next.push(p);
      }
      return { projects: next };
    });
    try {
      await api.project.reorder({ orderedIds });
    } catch (err) {
      // **写失败必须把顺序收回去。** 只打一行日志的话,左栏会一直显示那个**没有落盘**
      // 的新顺序 —— 直到下次启动、或者任何一条 `projects.changed`(比如手机碰了一下
      // 项目触发 `refreshProjects`)把它**静默**弹回旧序。用户看到的是"我拖好的顺序
      // 自己变回去了",查无对证。这里重读一次列表收回乐观改动(与 `setProjectPinned`
      // 失败后同一条路)。
      console.error("project.reorder failed:", err);
      try {
        const { projects } = await api.project.list();
        set({ projects });
      } catch {
        // 连重读都失败:保持乐观顺序(总比清空强),让下一条 projects.changed 收口。
      }
    }
  },

  setChatFontSize: async (px) => {
    const clamped = clampFontSize(px);
    set({ chatFontSize: clamped });
    try {
      await api.setting.set({
        key: UI_CHAT_FONT_SIZE_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(chatFontSize) failed:", err);
    }
  },

  setRightPanelFontSize: async (px) => {
    const clamped = clampRightPanelFontSize(px);
    set({ rightPanelFontSize: clamped });
    try {
      await api.setting.set({
        key: UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(rightPanelFontSize) failed:", err);
    }
  },

  setPasteTagThresholdChars: async (n) => {
    const clamped = clampPasteTagThresholdChars(n);
    set({ pasteTagThresholdChars: clamped });
    try {
      await api.setting.set({
        key: UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(pasteTagThresholdChars) failed:", err);
    }
  },

  setWorkflowMaxParallel: async (n) => {
    const clamped = clampWorkflowMaxParallel(n);
    set({ workflowMaxParallel: clamped });
    try {
      await api.setting.set({
        key: WORKFLOW_MAX_PARALLEL_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(workflowMaxParallel) failed:", err);
    }
  },

  setVoiceLang: async (lang) => {
    set({ voiceLang: lang });
    try {
      await api.setting.set({ key: UI_VOICE_LANG_SETTING_KEY, value: lang });
    } catch (err) {
      console.error("setting.set(voiceLang) failed:", err);
    }
  },

  setVoiceEngine: async (engine) => {
    set({ voiceEngine: engine });
    try {
      await api.setting.set({ key: UI_VOICE_ENGINE_SETTING_KEY, value: engine });
    } catch (err) {
      console.error("setting.set(voiceEngine) failed:", err);
    }
  },

  setVoiceMicPermission: async (perm) => {
    set({ voiceMicPermission: perm });
    try {
      await api.setting.set({ key: UI_VOICE_MIC_PERMISSION_SETTING_KEY, value: perm });
    } catch (err) {
      console.error("setting.set(voiceMicPermission) failed:", err);
    }
  },

  setVoiceModelDir: async (dir) => {
    set({ voiceModelDir: dir });
    try {
      await api.setting.set({ key: UI_VOICE_MODEL_DIR_SETTING_KEY, value: dir });
    } catch (err) {
      console.error("setting.set(voiceModelDir) failed:", err);
    }
    // The model root moved — the downloaded set (and thus readiness) may have
    // changed with it (the new dir can already contain catalog models).
    void get().refreshVoiceModelStatus();
  },

  refreshVoiceModelStatus: async () => {
    try {
      const res = await api.voice.modelList();
      // Ready = a model is selected AND its files are actually on disk
      // (modelList rescans the root). A selection pointing at a removed
      // download keeps the mic hidden instead of failing on click.
      set({ voiceModelReady: !!res.selected && res.downloaded.includes(res.selected) });
    } catch (err) {
      // Desktop voice engine not ready — keep the previous flag (boot default
      // false hides the mic, which is the safe side).
      console.error("voice.modelList failed:", err);
    }
  },

  setUserMessageColor: async (rgb) => {
    // null or malformed → treat as "use theme default" and clear any stored
    // value so the default re-asserts cleanly on reload.
    const safe = rgb && RGB_TRIPLET_RE.test(rgb) ? rgb : null;
    set({ userMessageColor: safe });
    try {
      await api.setting.set({
        key: UI_USER_MSG_COLOR_SETTING_KEY,
        value: safe ?? "",
      });
    } catch (err) {
      console.error("setting.set(userMessageColor) failed:", err);
    }
  },

  setAccentColor: async (rgb) => {
    // Same normalization as setUserMessageColor: null or malformed → clear
    // the override so the per-theme --accent default re-asserts.
    const safe = rgb && RGB_TRIPLET_RE.test(rgb) ? rgb : null;
    set({ accentColor: safe });
    try {
      await api.setting.set({
        key: UI_ACCENT_COLOR_SETTING_KEY,
        value: safe ?? "",
      });
    } catch (err) {
      console.error("setting.set(accentColor) failed:", err);
    }
  },

  setEditorTheme: async (mode, id) => {
    // Optimistic: the new choice is in the store immediately so mounted
    // editors re-theme live; the DB write is fire-and-forget like the other
    // appearance setters.
    const next = { ...get().editorTheme, [mode]: id };
    set({ editorTheme: next });
    try {
      await api.setting.set({
        key: UI_EDITOR_THEME_SETTING_KEY,
        value: JSON.stringify(next),
      });
    } catch (err) {
      console.error("setting.set(editorTheme) failed:", err);
    }
  },

  /** Bind (or rebind) a keyboard shortcut. Optimistic: the in-memory override
   *  map flips immediately so the next keydown uses the new chord; the DB
   *  write is fire-and-forget. Passing `null` removes the override for
   *  `commandId`, so the command falls back to its compiled-in default
   *  (or to "no binding" if it has none). The whole override map is serialized
   *  as one JSON blob — only user-changed entries are stored, defaults live
   *  in code. */
  setShortcutOverride: (commandId, accel) => {
    const next = { ...get().shortcutOverrides };
    if (accel) next[commandId] = accel;
    else delete next[commandId];
    set({ shortcutOverrides: next });
    try {
      saveSetting({
        key: UI_SHORTCUTS_SETTING_KEY,
        value: JSON.stringify(next),
      });
    } catch (err) {
      console.error("setting.set(shortcuts) failed:", err);
    }
  },

  /** Clear all shortcut overrides, restoring every default binding. The
   *  in-memory map empties immediately; the DB write persists an empty blob. */
  resetAllShortcuts: () => {
    set({ shortcutOverrides: {} });
    try {
      saveSetting({
        key: UI_SHORTCUTS_SETTING_KEY,
        value: "{}",
      });
    } catch (err) {
      console.error("setting.set(shortcuts reset) failed:", err);
    }
  },

  /** Bind (or rebind) a mouse gesture. Optimistic like setShortcutOverride:
   *  the in-memory override flips immediately so the next stroke uses it;
   *  the DB write is fire-and-forget. `null` removes the override, falling
   *  back to the compiled-in default (or to "no gesture"). */
  setGestureOverride: (commandId, seq) => {
    const cur = get().gestureSettings;
    const overrides = { ...cur.overrides };
    // 空数组 = 明确解除绑定(连默认手势也不要),见 lib/gestures.ts unbindGestureFor。
    if (seq) overrides[commandId] = seq;
    else delete overrides[commandId];
    const next = { ...cur, overrides };
    set({ gestureSettings: next });
    try {
      saveSetting({
        key: UI_GESTURES_SETTING_KEY,
        value: JSON.stringify(next),
      });
    } catch (err) {
      console.error("setting.set(gestures) failed:", err);
    }
  },

  setGestureEnabled: (enabled) => {
    const next = { ...get().gestureSettings, enabled };
    set({ gestureSettings: next });
    try {
      saveSetting({
        key: UI_GESTURES_SETTING_KEY,
        value: JSON.stringify(next),
      });
    } catch (err) {
      console.error("setting.set(gestures enabled) failed:", err);
    }
  },

  setGestureTrigger: (trigger) => {
    const next = { ...get().gestureSettings, trigger };
    set({ gestureSettings: next });
    try {
      saveSetting({
        key: UI_GESTURES_SETTING_KEY,
        value: JSON.stringify(next),
      });
    } catch (err) {
      console.error("setting.set(gestures trigger) failed:", err);
    }
  },

  /** Clear all gesture overrides, restoring the compiled-in defaults. */
  resetAllGestures: () => {
    const next = { ...get().gestureSettings, overrides: {} };
    set({ gestureSettings: next });
    try {
      saveSetting({
        key: UI_GESTURES_SETTING_KEY,
        value: JSON.stringify(next),
      });
    } catch (err) {
      console.error("setting.set(gestures reset) failed:", err);
    }
  },

  /** Toggle the "recording a gesture" sentinel (holds the target commandId). */
  setGestureRecording: (commandId) => {
    set({ gestureRecording: commandId });
  },

  /** Toggle the "recording a chord" sentinel. The global keydown listener
   *  suppresses dispatch while this is true so a captured chord doesn't
   *  also fire the command it's being assigned to. Not persisted. */
  setShortcutRecording: (recording) => {
    set({ shortcutRecording: recording });
  },

  /** Persist the active session's permission mode. The local slot is updated
   *  immediately so the chip reflects the change without a round-trip; the
   *  DB write is fire-and-forget — if it fails, the next `selectSession`
   *  (or app restart) will re-hydrate from the row. */
  setPermissionMode: (mode) => {
    const sessionId = get().activeSessionId;
    set((s) => ({
      permissionMode: mode,
      // Refresh the per-provider memory so the pick survives a provider
      // switch (setProvider restores it) and an app restart.
      lastModelByProvider: {
        ...s.lastModelByProvider,
        [s.providerId]: { ...rememberedEntryOf(s), permissionMode: mode },
      },
    }));
    if (sessionId) {
      void api.session.updateSettings({ sessionId, permissionMode: mode }).catch((err) => {
        console.error("updateSettings(permissionMode) failed:", err);
      });
    }
    persistComposerSelection(get());
  },

  /** Persist the ACTIVE session's composer working mode. Same optimistic slot +
   *  fire-and-forget DB write as `setPermissionMode`.
   *
   *  Deliberately does NOT touch `lastModelByProvider`: 工作流不是按提供方分的,
   *  新会话应该从「默认」开始,而不是悄悄继承上一个会话的意图
   *  ("这条已经在评审了" 不是下一个会话的性质)。 */
  setWorkflowId: (workflowId) => {
    const sessionId = get().activeSessionId;
    set({ workflowId });
    if (sessionId) {
      void api.session.updateSettings({ sessionId, workflowId }).catch((err) => {
        console.error("updateSettings(workflowId) failed:", err);
      });
    }
  },

  setEnvChoice: (choice) => {
    set({ envChoice: choice });
    const g = get();
    const sessionId = g.activeSessionId;
    const active = sessionId
      ? findSession(g.sessionsByProject, g.archivedSessionsByProject, g.pinnedSessions, g.streamSessions, sessionId)
      : undefined;
    // Any UN-MATERIALIZED session in the foreground (local OR worktree
    // intent — it still has no git footprint) → the choice edits THAT
    // session's environment, both directions. This is what makes the chip
    // read as "this thread's environment" until the first turn locks it.
    if (active && !active.worktreePath) {
      const envMode = choice === "local" ? ("local" as const) : ("worktree" as const);
      // null on the local flip clears any stale form intent on the row.
      const wtStyle =
        choice === "wt-branch" ? ("branch" as const) : choice === "wt-detached" ? ("detached" as const) : null;
      void api.session
        .updateSettings({ sessionId: active.id, envMode, wtStyle })
        .catch((err) => {
          console.error("updateSettings(envMode) failed:", err);
        });
      // Patch the cached row so the chip reflects it locally without
      // waiting for the session.changed round-trip.
      set((s) => ({
        sessionsByProject: patchSessionInCache(s.sessionsByProject, active.projectId, active.id, {
          envMode,
          wtStyle,
        }),
      }));
      return;
    }
    // No session in the foreground (empty state) — or the session is already
    // materialized (locked; the UI disables switching): fall through to the
    // persisted DEFAULT for new sessions. Stored as the EnvChoice string;
    // hydration only accepts those strings (see init).
    void api.setting
      .set({ key: SESSION_WORKTREE_DEFAULT_SETTING_KEY, value: choice })
      .catch((err) => {
        console.error("setting.set(worktreeDefault) failed:", err);
      });
  },

  /** Persist the active session's model. See `setPermissionMode` for the
   *  optimistic-local / fire-and-forget pattern. */
  setModel: (model) => {
    const sessionId = get().activeSessionId;
    set((s) => ({
      model,
      lastModelByProvider: {
        ...s.lastModelByProvider,
        [s.providerId]: { ...rememberedEntryOf(s), model },
      },
    }));
    if (sessionId) {
      void api.session.updateSettings({ sessionId, model }).catch((err) => {
        console.error("updateSettings(model) failed:", err);
      });
    }
    // Remember the pick as the next-session default (restored at boot).
    persistComposerSelection(get());
  },
  /** Persist the active session's reasoning effort. See `setPermissionMode`
   *  for the pattern. */
  setEffort: (effort) => {
    const sessionId = get().activeSessionId;
    set((s) => ({
      effort,
      // Refresh the per-provider memory so the pick survives a provider
      // switch (setProvider restores it) and an app restart.
      lastModelByProvider: {
        ...s.lastModelByProvider,
        [s.providerId]: { ...rememberedEntryOf(s), effort },
      },
    }));
    if (sessionId) {
      void api.session.updateSettings({ sessionId, effort }).catch((err) => {
        console.error("updateSettings(effort) failed:", err);
      });
    }
    persistComposerSelection(get());
  },

  /** Pick a built-in model or one of a custom-config's models. Both
   *  `customModelId` and `model` (the model id) are part of the session's
   *  persisted config, so a single updateSettings patch covers the change. */
  setCustomModel: (id, modelArg) => {
    set((s) => {
      let nextModel: string;
      if (!id) {
        nextModel = "default";
      } else if (modelArg) {
        // Caller picked a specific model (e.g. "deepseek-v4-pro"); trust it.
        nextModel = modelArg;
      } else {
        // No model given — fall back to the config's first model so the
        // chip/dropdown shows something meaningful. If none is configured
        // (shouldn't happen for a saved config), fall back to "default".
        const cfg = s.customModels.find((m) => m.id === id);
        const first = cfg?.models.find((m) => m.id.trim())?.id ?? "default";
        nextModel = first;
      }
      return {
        customModelId: id,
        model: nextModel,
        lastModelByProvider: {
          ...s.lastModelByProvider,
          [s.providerId]: { ...rememberedEntryOf(s), model: nextModel, customModelId: id },
        },
      };
    });
    // Persist the new binding + model to the session row. We compute the
    // resolved model from the same logic as above (re-read post-set to be
    // sure) and send both fields in one patch.
    const sessionId = get().activeSessionId;
    if (sessionId) {
      const { model, customModelId } = get();
      void api.session.updateSettings({ sessionId, model, customModelId }).catch((err) => {
        console.error("updateSettings(customModel) failed:", err);
      });
    }
    // Remember the pick as the next-session default (restored at boot).
    persistComposerSelection(get());
  },

  reloadCustomModels: async () => {
    try {
      const { models } = await api.customModel.list();
      set({ customModels: models });
      // A persisted composer pick whose custom config was deleted falls back
      // to auto.
      validateComposerSelection(set, get);
    } catch (err) {
      console.error("reloadCustomModels failed:", err);
    }
  },

  setProvider: (id) => {
    // Always update the "next session" slot — new threads inherit this.
    // When switching to a *different* provider: model ids live in
    // per-provider namespaces (claude uses gateway model ids like
    // "deepseek-v4-pro"; pi uses "provider/modelId" strings), so a leftover
    // value would either render as a raw id in the chip or point at a model
    // the new provider can't resolve. Instead of snapping to "default",
    // remember the outgoing provider's selection (so switching back restores
    // it) and re-apply the target provider's last remembered model — dropped
    // back to "default" when the remembered model has since been deleted.
    // customModelId is a claude-only concept (gateway configs), so it must be
    // cleared on any switch away.
    const prevProviderId = get().providerId;
    const providerChanged = prevProviderId !== id;
    // Restore result for the target provider — kept so the session-row sync
    // below persists the SAME model the composer now shows (a row left at
    // "default"/stale would clobber the restore on the next
    // syncConfigFromSession).
    let restored: { model: string; customModelId: string | null };
    if (providerChanged) {
      const s = get();
      const nextMap = { ...s.lastModelByProvider };
      // Full outgoing snapshot — model binding AND the thinking/permission
      // slots, so switching back restores everything the user had picked.
      nextMap[prevProviderId] = rememberedEntryOf(s);
      const remembered = nextMap[id];
      restored =
        isValidRememberedModel(s, id, remembered) && remembered.model !== "default"
          ? { model: remembered.model, customModelId: remembered.customModelId }
          : { model: "default", customModelId: null };
      // effort / permissionMode are provider-namespaced too (claude's
      // acceptEdits is not a codex mode). Restore the target provider's
      // remembered slots — falling back to the current values when it has
      // none (values valid for both providers pass through) — then coerce
      // against the target's declared options so a stale remembered value
      // snaps to "default" instead of rendering as a raw foreign id.
      const coerced = coerceSlotsForProvider(
        {
          providers: s.providers,
          effort: remembered?.effort ?? s.effort,
          permissionMode: remembered?.permissionMode ?? s.permissionMode,
        },
        id,
      );
      set({ providerId: id, ...restored, ...coerced, lastModelByProvider: nextMap });
    } else {
      restored = { model: get().model, customModelId: get().customModelId };
      set({ providerId: id });
    }
    void get().refreshProviderHealth(id);
    // Remember the pick as the next-session default (restored at boot).
    persistComposerSelection(get());

    // If a blank (message-less) session is currently active, also sync the
    // change onto its session row so the provider is fixed correctly before
    // the first turn. This keeps the left-bar rows, session tabs, and the
    // titlebar thread icon (all of which read session.providerId) in sync
    // as the user picks a different SDK. A session with messages is already
    // locked — ProviderDropdown hides the chip, so we never reach here for it,
    // and we guard defensively in case the action is called directly.
    const sid = get().activeSessionId;
    if (!sid) return;
    const bucket = get().messagesBySession[sid];
    if (bucket && bucket.length > 0) return;

    const sess = findSession(get().sessionsByProject, get().archivedSessionsByProject, get().pinnedSessions, get().streamSessions, sid);
    if (!sess || sess.providerId === id) return;
    const projectId = sess.projectId;

    set((s) => {
      const patchRow = (list: Session[]): Session[] =>
        list.map((x) =>
          x.id === sid
            ? {
                ...x,
                providerId: id,
                model: restored.model,
                customModelId: restored.customModelId,
                // Persist the SAME slots the composer now shows (possibly
                // coerced above) so a later syncConfigFromSession doesn't
                // resurrect a stale cross-provider value from the row.
                effort: s.effort,
                permissionMode: s.permissionMode,
              }
            : x,
        );
      const nextByProject = { ...s.sessionsByProject };
      if (nextByProject[projectId]) {
        nextByProject[projectId] = patchRow(nextByProject[projectId]);
      }
      const nextArchived = { ...s.archivedSessionsByProject };
      if (nextArchived[projectId]) {
        nextArchived[projectId] = patchRow(nextArchived[projectId]);
      }
      // `sessions` is a derived alias of the active project's list; refresh it
      // only when it currently points at this session's project.
      const nextSessions = s.activeProjectId === projectId && nextByProject[projectId]
        ? nextByProject[projectId]
        : s.sessions;
      return { sessionsByProject: nextByProject, archivedSessionsByProject: nextArchived, sessions: nextSessions };
    });

    // Persist the provider change to the session row, along with the restored
    // model (so the row stays consistent with what the composer shows and a
    // later syncConfigFromSession doesn't clobber the restore). Fire-and-
    // forget, like the other updateSettings callers.
    void api.session
      .updateSettings(
        providerChanged
          ? {
              sessionId: sid,
              providerId: id,
              model: restored.model,
              customModelId: restored.customModelId,
              effort: get().effort,
              permissionMode: get().permissionMode,
            }
          : { sessionId: sid, providerId: id },
      )
      .catch((err) => {
        console.error("updateSettings(providerId) failed:", err);
      });
  },

  reloadProviders: async () => {
    try {
      const { providers } = await api.provider.list();
      set({ providers });
      // A persisted composer pick for a provider that no longer exists falls
      // back to the default provider + auto.
      validateComposerSelection(set, get);
      // Capabilities just arrived (or changed while the app was closed): snap
      // effort / permissionMode leftovers the active provider doesn't declare
      // onto "default" — the boot-time counterpart of setProvider's coercion.
      const s = get();
      set(coerceSlotsForProvider(s, s.providerId));
      void get().refreshProviderHealth(get().providerId);
    } catch (err) {
      console.error("reloadProviders failed:", err);
    }
  },

  reloadPiAvailableModels: async () => {
    try {
      const { models } = await api.piModels.listAvailable();
      set({ piAvailableModels: models });
      // A persisted composer pick whose pi model was deleted falls back
      // to auto.
      validateComposerSelection(set, get);
    } catch (err) {
      console.error("reloadPiAvailableModels failed:", err);
    }
  },

  reloadCodexAvailableModels: async () => {
    try {
      const { providers } = await api.codexModels.list();
      const models = providers.flatMap((p) =>
        p.models.map((m) => ({
          id: `${p.id}/${m.id}`,
          label: m.label ?? m.id,
          hint: m.hint,
          supplier: p.name,
        })),
      );
      set({ codexAvailableModels: models });
      // A persisted composer pick whose codex model was deleted falls back
      // to auto.
      validateComposerSelection(set, get);
    } catch (err) {
      console.error("reloadCodexAvailableModels failed:", err);
    }
  },

  reloadLspLanguages: async () => {
    try {
      const { languages } = await api.lsp.list();
      set({ lspLanguages: languages });
      // Java just enabled (or hydration finished with it enabled) → start
      // the import now rather than at the first openDocument.
      get().prewarmJavaLspForActiveProject();
      // When the TypeScript server is enabled, suppress Monaco's built-in
      // tsWorker diagnostics so we don't get duplicate squiggles. The setup
      // module exposes this toggle; it's a no-op if Monaco isn't loaded yet.
      try {
        const tsEnabled = languages.some((l) => l.language === "typescript" && l.enabled);
        await import("@renderer/lib/monacoSetup.js").then((m) => {
          if (typeof m.setTsWorkerDiagnosticsEnabled === "function") {
            m.setTsWorkerDiagnosticsEnabled(!tsEnabled);
          }
        });
      } catch {
        // Monaco not yet imported (no editor mounted) - skip; will be applied
        // on next reload once monacoSetup is loaded.
      }
    } catch (err) {
      console.error("reloadLspLanguages failed:", err);
    }
  },

  reloadRuntimes: async () => {
    if (!isElectron) return;
    try {
      const { runtimes } = await api.runtimes.list();
      set({ runtimes });
    } catch (err) {
      console.error("reloadRuntimes failed:", err);
    }
  },

  applyRuntimeProgress: (payload) => {
    const { runtimes } = get();
    if (runtimes.length === 0) return;
    const next = runtimes.map((rt) => {
      if (rt.agent !== payload.agent) return rt;
      if (payload.phase === "error") {
        return { ...rt, installing: false, lastError: payload.error ?? "" };
      }
      if (payload.phase === "done") {
        // Full truth (installed version / disk bytes) arrives via the
        // re-list the caller fires after the RPC resolves; mark it healthy.
        return { ...rt, installing: false, lastError: "" };
      }
      return { ...rt, installing: true, lastError: "" };
    });
    set({ runtimes: next });
  },

  prewarmJavaLspForActiveProject: () => {
    if (!isElectron) return;
    if (!get().lspLanguages.some((l) => l.language === "java" && l.enabled)) return;
    const pid = get().activeProjectId;
    const path = pid ? get().projects.find((p) => p.id === pid)?.path : undefined;
    if (!path) return;
    void api.lsp.prewarm({ workspacePath: path }).catch((err) => {
      console.debug("lsp prewarm skipped:", err);
    });
  },

  reloadSkills: async () => {
    // Resolve the active project's path. skills.list scans that root's
    // .claude/skills in addition to the user-global dir; without a project
    // there's nothing project-scoped to add (global-only would mislead the
    // menu into showing skills that may not apply), so we no-op.
    //
    // ⚠️ **旧回包会盖新状态。** 这是一条 fire-and-forget 的路(`selectProject` /
    // `addProjectFromFolder` 都不 await 它),而 `api.skills.list` 要扫盘、挺慢。快速连切
    // 两个项目时,先发的 A 那次可能**后**回来,把 B 的清单盖成 A 的项目级技能 —— `/` 菜单
    // 在 B 下列出 A 的技能。用一个序号挡:回来时若已不是最新那次,丢弃。
    const seq = ++reloadSkillsSeq;
    const pid = get().activeProjectId;
    const project = pid ? get().projects.find((p) => p.id === pid) : undefined;
    if (!project) {
      if (seq === reloadSkillsSeq) set({ skills: EMPTY_SKILLS });
      return;
    }
    try {
      const { skills } = await api.skills.list({ projectPath: project.path });
      if (seq !== reloadSkillsSeq) return; // 已有更新的一次在飞,这次的结果作废
      set({ skills: skills.length ? skills : EMPTY_SKILLS });
    } catch (err) {
      console.error("reloadSkills failed:", err);
    }
  },

  /**
   * 主动去问引擎要它的命令清单（2026-09-21）。
   *
   * ## 为什么要"主动问"，而不是等事件
   *
   * 清单的权威来源是引擎在每轮 `system/init` 里推的 `slash_commands`
   * （见 `commands.available` 的归约）。但那条路有个致命的**时机**问题：init 只在
   * **开跑一轮**时才来。而用户打开 `/` 菜单看有哪些命令，恰恰是在**还没发消息**的
   * 时候 —— 也就是清单还空着的时候。第一版就是只挂事件，界面上那一栏永远 0 条。
   *
   * 所以这里在**会话就绪时**就把清单取回来（Claude 的 `supportedCommands()` 不需要
   * 跑任何一轮就会答，而且**带说明**）。事件那条路留着，因为它是唯一能反映"引擎中途
   * 换了清单"（装了插件、动态发现技能）的来源。
   *
   * ## 失败是**安静**的
   *
   * 取不到（引擎没装、CLI 没起来）只是不显示命令，不该在界面上弹错 —— 用户没问任何
   * 关于命令的事，也没有任何操作失败。留 `console.debug` 给排查用。
   */
  reloadEngineCommands: async (providerId?: string | null) => {
    if (!providerId) return;
    const pid = get().activeProjectId;
    const project = pid ? get().projects.find((p) => p.id === pid) : undefined;
    try {
      const res = await api.provider.commands({
        providerId,
        ...(project?.path ? { cwd: project.path } : {}),
      });
      // `supported: false` 也要落进 store —— 界面据此说"这个引擎不提供命令"
      // （Pi / Codex 就是这一档），而不是显示"还没取到"。见 `ProviderCommandsResult`。
      const commands = res.commands.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        aliases: c.aliases,
      }));
      set((s) => ({
        engineCommandsByProvider: { ...s.engineCommandsByProvider, [providerId]: { supported: res.supported, commands } },
      }));
    } catch (err) {
      console.debug("reloadEngineCommands failed:", err);
    }
  },

  dismissQuestion: () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const pending = get().pendingQuestionBySession[sessionId];
    // Resolve the provider's pending Deferred as DISMISSED so the model's
    // turn CONTINUES (it sees the question was skipped and decides what to
    // do). The old behavior only cleared the local card, leaving the model
    // blocked forever waiting for answers.
    if (pending) {
      const requestId = pending.requestId ?? `sentinel_${sessionId}_${Date.now()}`;
      void api.claude
        .respondQuestion({ sessionId, requestId, answers: {}, dismissed: true })
        .catch((err) => {
          console.error("respondQuestion(dismiss) failed:", err);
        });
    }
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.pendingQuestionBySession;
      return { pendingQuestionBySession: rest };
    });
  },

  /** Submit the user's answers to the active session's pending
   *  AskUserQuestion. Resolves the provider's pending user-input Deferred
   *  via `claude:respondQuestion` so the SAME turn continues — this is the
   *  fix for the old bug where submitting answers started a *new* turn
   *  (via sendPrompt) instead of resuming the in-flight one.
   *
   *  `requestId` correlation: the question.ask event carried a requestId;
   *  we pass it back so main finds the right Deferred. Sentinel-fallback
   *  requests (no Deferred on the main side) are handled by main — it
   *  composes the answers into a follow-up prompt. Either way we clear
   *  the local pending card; if the IPC fails the card stays so the user
   *  can retry. */
  submitQuestion: async (answers, sessionIdArg) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return;
    const pending = get().pendingQuestionBySession[sessionId];
    if (!pending) return;
    const requestId = pending.requestId ?? `sentinel_${sessionId}_${Date.now()}`;
    try {
      await api.claude.respondQuestion({ sessionId, requestId, answers });
      // Only dismiss on success — a failed IPC leaves the card in place
      // so the user can retry instead of thinking they answered.
      set((s) => {
        // 等回复期间 agent 可能已经接着问了下一题 —— 只撤掉**刚答的这一张**卡片,
        // 别把新来的问题一起清掉(那样 agent 会一直等一个用户看不到的问题)。
        const current = s.pendingQuestionBySession[sessionId];
        if (current && current !== pending && current.requestId !== pending.requestId) return {};
        const { [sessionId]: _drop, ...rest } = s.pendingQuestionBySession;
        return { pendingQuestionBySession: rest };
      });
    } catch (err) {
      console.error("claude.respondQuestion failed:", err);
    }
  },

  /** Approve or deny the head of the approval queue. The IPC resolves the
   *  matching canUseTool on the main side. Only on a successful resolve do
   *  we shift the head off — a failed IPC leaves the card in place so the
   *  user can retry instead of thinking they approved something they didn't. */
  decideApproval: async (requestId, granted, always) => {
    // Find the head matching this id (defensive — UI always passes head[0]).
    const head = get().pendingApprovals.find((p) => p.requestId === requestId);
    if (!head) return;
    // Resolve the owning session from the request itself — with the side chat
    // running concurrently the foreground activeSessionId may be a DIFFERENT
    // session than the one whose approval is being answered.
    const sessionId = head.sessionId;
    try {
      await api.claude.approve({ sessionId, requestId, granted, always });
    } catch (err) {
      // Don't shift on failure; surface the error to the console so the
      // user/dev can see it without a modal interrupting the queue flow.
      console.error("claude.approve failed:", err);
      return;
    }
    set((s) => ({
      pendingApprovals: s.pendingApprovals.filter((p) => p.requestId !== requestId),
    }));
  },

  /** Submit the user's approve/reject decision on a pending ExitPlanMode
   *  plan. Calls `claude:respondPlanApproval` which resolves the provider's
   *  pending plan-approval Deferred — the SAME turn then continues (approve
   *  → SDK exits plan mode + starts executing; reject → SDK stays in plan
   *  mode, model revises). `feedback` is the user's plan-adjustment opinion
   *  from the approval sheet: on approve it's delivered to the model
   *  alongside the approval (execution incorporates it); on reject it serves
   *  as the reason. Clears the pending card on success; on failure the card
   *  stays so the user can retry. */
  submitPlanApproval: async (requestId, approved, editedPlan, reason, feedback) => {
    // Look up by requestId across ALL per-session buckets — the pending plan
    // may belong to the side chat while the foreground active session is its
    // parent (or vice versa).
    let sessionId: string | null = null;
    let pending: PlanApprovalRequestEvent | undefined;
    for (const [sid, p] of Object.entries(get().pendingPlanApprovalBySession)) {
      if (p.requestId === requestId) {
        sessionId = sid;
        pending = p;
        break;
      }
    }
    if (!pending || !sessionId) return;
    try {
      await api.claude.respondPlanApproval({ sessionId, requestId, approved, editedPlan, reason, feedback });
      set((s) => {
        const { [sessionId]: _drop, ...rest } = s.pendingPlanApprovalBySession;
        // Drop the 待审阅 badge on the inline plan block now that the user
        // has decided. On approve the adapter will follow up with a
        // plan.update phase:"ready" (block stays, freezes at turn.done);
        // on reject it emits phase:"cleared" which removes the block. Either
        // way we flip hasApproval off immediately so the badge doesn't linger.
        const list = s.messagesBySession[sessionId] ?? EMPTY_MESSAGES;
        const next = upsertLivePlanBlock(
          list,
          pending.plan,
          "ready",
          false,
          s.runningTurnStartedAt[sessionId] ?? Date.now(),
          s.runningTurnModelBySession[sessionId],
        );
        // Clear the staged editor draft now that the decision is submitted -
        // the draft only mattered while the approval was pending.
        const { [sessionId]: _dropDraft, ...restDrafts } = s.planApprovalDraftBySession;
        return {
          pendingPlanApprovalBySession: rest,
          planApprovalDraftBySession: restDrafts,
          messagesBySession: next === list
            ? s.messagesBySession
            : { ...s.messagesBySession, [sessionId]: next },
        };
      });
    } catch (err) {
      console.error("claude.respondPlanApproval failed:", err);
    }
  },

  handoffPlanApproval: async (sessionId, requestId, target, feedback) => {
    const s0 = get();
    const pending = s0.pendingPlanApprovalBySession[sessionId];
    if (!pending || pending.requestId !== requestId) return;
    // The flows below rebind the ACTIVE session's config slots and sendPrompt
    // is active-session scoped — the handoff must run from the foreground tab
    // that owns this approval sheet.
    if (sessionId !== s0.activeSessionId) return;
    // Prefer the staged editor draft (PlanViewer edits): unlike a plain
    // approve it is NOT delivered through the ExitPlanMode dialog, so the
    // kickoff prompt is its only carrier to the executing agent.
    const planText = s0.planApprovalDraftBySession[sessionId] ?? pending.plan;
    const fb = feedback?.trim() ? feedback.trim() : undefined;
    // Capture the turn anchor BEFORE interrupt() wipes it, so the badge-flip
    // below lands on the same live plan block the sheet was showing.
    const anchor = s0.runningTurnStartedAt[sessionId] ?? Date.now();
    const modelAnchor = s0.runningTurnModelBySession[sessionId];

    // End the blocked turn WITHOUT answering the ExitPlanMode dialog: the
    // abort means no request.resolved will ever arrive, so clear the local
    // pending state here (mirrors submitPlanApproval's cleanup — sheet gone,
    // 待审阅 badge dropped, staged draft released).
    await get().interrupt(sessionId);
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.pendingPlanApprovalBySession;
      const { [sessionId]: _dropDraft, ...restDrafts } = s.planApprovalDraftBySession;
      const list = s.messagesBySession[sessionId] ?? EMPTY_MESSAGES;
      const next = upsertLivePlanBlock(list, planText, "ready", false, anchor, modelAnchor);
      return {
        pendingPlanApprovalBySession: rest,
        planApprovalDraftBySession: restDrafts,
        messagesBySession: next === list
          ? s.messagesBySession
          : { ...s.messagesBySession, [sessionId]: next },
      };
    });

    const kickoff = buildPlanKickoffPrompt(planText, fb, target.kind === "remodel");
    if (target.kind === "remodel") {
      // Rebind this session's model in ONE patch. Going through the existing
      // setters is a poor fit: setCustomModel(null, id) resets model to
      // "default" (its null branch ignores the id), and setModel alone would
      // leave a stale customModelId behind — two fire-and-forget
      // updateSettings calls could also race. The inline patch avoids all
      // three and lands a single IPC.
      set((s) => ({
        model: target.model,
        customModelId: target.customModelId,
        lastModelByProvider: {
          ...s.lastModelByProvider,
          [s.providerId]: {
            ...rememberedEntryOf(s),
            model: target.model,
            customModelId: target.customModelId,
          },
        },
      }));
      void api.session
        .updateSettings({ sessionId, model: target.model, customModelId: target.customModelId })
        .catch((err) => {
          console.error("updateSettings(plan handoff remodel) failed:", err);
        });
      persistComposerSelection(get());
      // Fresh turn in the SAME thread: transcript context carries via resume,
      // only the model changed. interrupt() already cleared the running flag,
      // and sendPrompt clears the interrupt sentinel itself.
      void get().sendPrompt(kickoff);
      return;
    }
    // newSession: same project as the planning thread, executor chosen in the
    // sheet. The kickoff rides the per-session prompt queue so the existing
    // send-model guard + busy-check apply (it fires the moment the new tab
    // is idle — which a brand-new session always is).
    const sess = findSession(
      get().sessionsByProject,
      get().archivedSessionsByProject,
      get().pinnedSessions,
      get().streamSessions,
      sessionId,
    );
    const projectId = sess?.projectId ?? get().activeProjectId;
    // No resolvable project → nothing to create (startSession would no-op
    // anyway); the newSid guard below keeps the enqueue from misfiring.
    if (projectId) {
      try {
        await get().startSession(projectId, {
          providerId: target.providerId,
          model: target.model,
          customModelId: target.customModelId,
        });
      } catch (err) {
        // The planning thread is already interrupted + cleaned up; log and
        // stop here rather than surfacing an unhandled rejection (the user
        // can still send the kickoff manually if they want).
        console.error("plan handoff: startSession failed:", err);
        return;
      }
    }
    const newSid = get().activeSessionId;
    if (newSid && newSid !== sessionId) {
      // The new session renders the handoff as "note + plan card" (same
      // PlanStreamBlock the planning session showed) instead of dumping the
      // raw kickoff text — `prompt` still carries the full kickoff to the
      // model, and the plan block persists with the user message so the card
      // survives session reloads.
      const note = fb
        ? translate(get().locale, "chat.plan.kickoffNoteWithFeedback", { feedback: fb })
        : translate(get().locale, "chat.plan.kickoffNote");
      const displayBlocks: Block[] = [
        { kind: "text", text: note },
        { kind: "plan", planId: LIVE_PLAN_ID, plan: planText, phase: "ready" },
      ];
      get().enqueuePrompt(newSid, { prompt: kickoff, displayText: note, displayBlocks });
      get().drainPromptQueueIfIdle(newSid);
    }
  },

  openPlanDrawer: (sessionId, plan) => {
    // The web (phone) shell has no editor column / PlanViewer — open the
    // read-only plan view in the mobile fullscreen overlay instead. Same
    // action serves both shells so every call site stays transport-neutral.
    if (!isElectron) {
      set({ mobileViewer: { kind: "plan", plan } });
      return;
    }
    set((s) => ({
      planDrawerPlanBySession: { ...s.planDrawerPlanBySession, [sessionId]: plan },
      planTabActiveBySession: { ...s.planTabActiveBySession, [sessionId]: true },
      // Opening the plan (from a plan card / approval prompt) surfaces the
      // plan tab — in tabs displayMode that means focusing the editor view.
      ...(s.displayMode === "tabs" ? { centerTabFocus: "editor" as const } : {}),
    }));
  },
  openMobileViewer: (target) => {
    set({ mobileViewer: target });
  },
  closeMobileViewer: () => {
    set({ mobileViewer: null });
  },
  closePlanDrawer: (sessionId) => {
    set((s) => {
      const { [sessionId]: _dropPlan, ...restPlan } = s.planDrawerPlanBySession;
      const { [sessionId]: _dropActive, ...restActive } = s.planTabActiveBySession;
      const { [sessionId]: _dropDraft, ...restDrafts } = s.planApprovalDraftBySession;
      // When closing the plan tab, restore the active file to the first open
      // file (if any) so the editor column stays visible instead of hiding
      // entirely. This mirrors closing a file tab that shifts to the next.
      const pid = s.activeProjectId;
      const openFiles = pid ? s.ideOpenFilesByProject[pid] ?? [] : [];
      const restoreFile = openFiles.length > 0 ? openFiles[0] : null;
      return {
        planDrawerPlanBySession: restPlan,
        planTabActiveBySession: restActive,
        planApprovalDraftBySession: restDrafts,
        ...(pid && restoreFile
          ? { ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: restoreFile } }
          : {}),
        // Unified bar: with a file to fall back to the editor view survives
        // (keep the current focus); otherwise return to the chat view.
        centerTabFocus: restoreFile ? s.centerTabFocus : ("chat" as const),
      };
    });
  },
  setPlanTabActive: (sessionId, active) => {
    set((s) => ({
      planTabActiveBySession: { ...s.planTabActiveBySession, [sessionId]: active },
      // Activating the plan tab (tab click / restore) focuses the editor
      // view in tabs displayMode.
      ...(active && s.displayMode === "tabs"
        ? { centerTabFocus: "editor" as const }
        : {}),
    }));
  },
  setPlanApprovalDraft: (sessionId, draft) => {
    set((s) => ({
      planApprovalDraftBySession: { ...s.planApprovalDraftBySession, [sessionId]: draft },
    }));
  },
  updatePlanDrawerPlan: (sessionId, plan) => {
    set((s) => {
      // No-op if no plan tab is open for this session - avoids opening one
      // as a side effect of a stray save.
      if (s.planDrawerPlanBySession[sessionId] == null) return s;
      return {
        planDrawerPlanBySession: { ...s.planDrawerPlanBySession, [sessionId]: plan },
      };
    });
  },

  rewindTurn: async (files, targetFiles) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    if (files.length === 0) {
      // Nothing to rewind — defensive (UI shouldn't allow the click).
      return;
    }
    try {
      await api.claude.rewindTurn({ sessionId, files, targetFiles });
      // Don't optimistically clear turnFiles — wait for the `turn.rewound`
      // event from main so the UI only updates when files are actually
      // back on disk. If the IPC call returns successfully but main fails
      // partway through restore, the (smaller) restored list still
      // arrives via the event and we clear from there.
    } catch (err) {
      // **别吞掉。** `TurnFilesCard` 是 `await rewindTurn(...)` 之后无条件
      // `setDone(true)` —— 把「已撤销 ✓」画在卡上。从前这里只 `console.error`、
      // 照样 resolve,于是 IPC / 主进程那一层真失败时,用户看到"撤销成功",而文件
      // 一个字节没回滚(这是个**破坏性**动作,他不会再去看)。抛出真错,由调用方
      // 决定怎么显示 —— 它已经会用 toast 报出来。
      console.error("claude.rewindTurn failed:", err);
      throw err;
    }
  },

  revealInFileTree: (filePath) => {
    // Panel-first: switching the tab + bumping the focus nonce both matter
    // even before the tree reveal lands — the user asked to GO somewhere, so
    // make sure the destination is visible. setRightPanelTab persists the
    // tab like any manual tab click does.
    get().setRightPanelTab("files");
    set((s) => ({
      ideFocusNonce: s.ideFocusNonce + 1,
      ideTreeReveal: { filePath, nonce: (s.ideTreeReveal?.nonce ?? 0) + 1 },
    }));
  },

  refreshProviderHealth: async (providerId, options) => {
    const requestGeneration = providerHealthRequestGate.begin(providerId);
    set((s) => ({
      providerHealthById: {
        ...s.providerHealthById,
        [providerId]: { ...s.providerHealthById[providerId], loading: true, ok: null },
      },
    }));
    let health: ProviderHealthCheckResult;
    try {
      health = await api.provider.healthCheck({ providerId, force: options?.force });
    } catch (error) {
      health = {
        providerId,
        ok: false,
        code: "probe_failed",
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!providerHealthRequestGate.isLatest(providerId, requestGeneration)) return;
    set((s) => ({
      providerHealthById: {
        ...s.providerHealthById,
        [providerId]: {
          loading: false,
          ok: health.ok,
          code: health.code,
          checkedAt: health.checkedAt,
          version: health.version,
          error: health.error,
        },
      },
    }));
  },

  enqueueChatFile: (filePath) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set((s) => {
      const prev = s.chatFileQueueBySession[sessionId] ?? [];
      return {
        chatFileQueueBySession: {
          ...s.chatFileQueueBySession,
          [sessionId]: [...prev, filePath],
        },
        // The attachment lands in the composer — bring the chat view back so
        // the user sees it happen (tabs displayMode).
        ...(s.displayMode === "tabs" ? { centerTabFocus: "chat" as const } : {}),
      };
    });
  },

  drainChatFileQueue: (sessionIdArg?: string) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return [];
    const queued = get().chatFileQueueBySession[sessionId];
    if (!queued || queued.length === 0) return [];
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.chatFileQueueBySession;
      return { chatFileQueueBySession: rest };
    });
    return queued;
  },

  enqueueChatElement: (element) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set((s) => {
      const prev = s.chatElementQueueBySession[sessionId] ?? [];
      return {
        chatElementQueueBySession: {
          ...s.chatElementQueueBySession,
          [sessionId]: [...prev, element],
        },
      };
    });
  },

  drainChatElementQueue: (sessionIdArg?: string) => {
    const sessionId = sessionIdArg ?? get().activeSessionId;
    if (!sessionId) return [];
    const queued = get().chatElementQueueBySession[sessionId];
    if (!queued || queued.length === 0) return [];
    set((s) => {
      const { [sessionId]: _drop, ...rest } = s.chatElementQueueBySession;
      return { chatElementQueueBySession: rest };
    });
    return queued;
  },

  enqueuePrompt: (sessionId, item) => {
    const queued: QueuedPrompt = { ...item, id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
    set((s) => {
      const prev = s.promptQueueBySession[sessionId] ?? [];
      return {
        promptQueueBySession: {
          ...s.promptQueueBySession,
          [sessionId]: [...prev, queued],
        },
      };
    });
  },

  removeQueuedPrompt: (sessionId, id) => {
    set((s) => {
      const prev = s.promptQueueBySession[sessionId];
      if (!prev || prev.length === 0) return {};
      const next = prev.filter((q) => q.id !== id);
      return {
        promptQueueBySession: {
          ...s.promptQueueBySession,
          [sessionId]: next,
        },
      };
    });
  },

  clearPromptQueue: (sessionId) => {
    set((s) => {
      if (!s.promptQueueBySession[sessionId]) return {};
      const { [sessionId]: _drop, ...rest } = s.promptQueueBySession;
      return { promptQueueBySession: rest };
    });
  },

  // ChatPane 的 write-through 专用：自己写的东西自己知道，不碰 touch。
  saveComposerDraft: (sessionId, draft) => {
    set((s) => ({
      composerDraftBySession: { ...s.composerDraftBySession, [sessionId]: draft },
    }));
  },

  deliverComposerDraft: (sessionId, draft) => {
    set((s) => ({
      composerDraftBySession: { ...s.composerDraftBySession, [sessionId]: draft },
      composerDraftTouchBySession: {
        ...s.composerDraftTouchBySession,
        [sessionId]: (s.composerDraftTouchBySession[sessionId] ?? 0) + 1,
      },
    }));
  },

  quoteIntoComposer: (sessionId, tag) => {
    const draft = get().composerDraftBySession[sessionId];
    get().deliverComposerDraft(sessionId, {
      text: draft?.text ?? "",
      html: draft?.html ?? "",
      tags: [...(draft?.tags ?? []), tag],
    });
  },

  clearComposerDraft: (sessionId) => {
    set((s) => {
      if (!s.composerDraftBySession[sessionId]) return {};
      const { [sessionId]: _drop, ...rest } = s.composerDraftBySession;
      return { composerDraftBySession: rest };
    });
  },

  drainPromptQueueIfIdle: (sessionId) => {
    const s = get();
    // Only drain when fully idle: no running turn AND no running background
    // subagent (a backgrounded task keeps the session logically busy even
    // after the parent turn's stream closed).
    if (s.runningBySession[sessionId]) return;
    const agents = s.subagentsBySession[sessionId] ?? [];
    if (agents.some((a) => a.status === "running")) return;
    const q = s.promptQueueBySession[sessionId];
    if (!q || q.length === 0) return;
    const head = q[0];
    // Send-time model guard, checked BEFORE dropping the head: if the send
    // would be blocked (no model picked / none configured), the dropped item
    // would be lost. Keep it queued + raise the guard UI.
    if (!resolveSendModel(s)) {
      raiseModelGuard();
      return;
    }
    // Drop the head from the queue BEFORE sending so the user sees it leave
    // immediately, and so a failed send doesn't loop on the same item.
    set((st) => ({
      promptQueueBySession: {
        ...st.promptQueueBySession,
        [sessionId]: st.promptQueueBySession[sessionId]?.slice(1) ?? [],
      },
    }));
    // Reuse the normal send path: it appends the user message, flips busy,
    // and fires sendTurn. If that turn later ends with another queued item,
    // its turn.done handler will call drainPromptQueueIfIdle again — so the
    // whole queue drains one item per turn, in order. Explicit sessionId so
    // a background/side session's queue never drains into the foreground one.
    void s.sendPrompt(head.prompt, head.attachments, head.displayText, head.skillNames, head.images, head.displayBlocks, sessionId);
  },

  sendQueuedPromptNow: async (sessionId, id) => {
    const q = get().promptQueueBySession[sessionId] ?? EMPTY_PROMPT_QUEUE;
    const item = q.find((x) => x.id === id);
    if (!item) return;
    // If the session is busy (running turn or running background subagent),
    // interrupt it first so this prompt can fire immediately as a new turn.
    // interrupt() awaits the IPC and synchronously clears runningBySession +
    // demotes running subagents, so sendPrompt's busy guard lets us through.
    const agents = get().subagentsBySession[sessionId] ?? EMPTY_SUBAGENTS;
    const busy =
      get().runningBySession[sessionId] || agents.some((a) => a.status === "running");
    if (busy) {
      await get().interrupt(sessionId);
    }
    // Drop only this item; the rest of the queue is preserved.
    get().removeQueuedPrompt(sessionId, id);
    // Reuse the normal send path. sendPrompt clears the interruptedBySession
    // sentinel, so the old turn's late turn.done{interrupted} is filtered by
    // the existing race guard (sendPrompt / editAndResendMessage rely on it).
    await get().sendPrompt(item.prompt, item.attachments, item.displayText, item.skillNames, item.images, item.displayBlocks, sessionId);
  },

  reorderPromptQueue: (sessionId, newOrder) => {
    set((s) => {
      const prev = s.promptQueueBySession[sessionId];
      if (!prev || prev.length === 0) return {};
      const byId = new Map(prev.map((q) => [q.id, q]));
      const next: QueuedPrompt[] = [];
      const seen = new Set<string>();
      for (const id of newOrder) {
        const q = byId.get(id);
        if (q && !seen.has(id)) {
          next.push(q);
          seen.add(id);
        }
      }
      // Append any items not referenced in newOrder so nothing is lost.
      for (const q of prev) {
        if (!seen.has(q.id)) next.push(q);
      }
      return {
        promptQueueBySession: {
          ...s.promptQueueBySession,
          [sessionId]: next,
        },
      };
    });
  },

  /* ─────────────────── IDE right-panel actions ─────────────────── */

  setRightPanelTab: (tab) => {
    set((s) => ({ rightPanelTab: tab, rightPanelTabSeq: s.rightPanelTabSeq + 1 }));
    void api.setting.set({ key: UI_RIGHT_PANEL_TAB_SETTING_KEY, value: tab }).catch((err) => {
      console.error("setting.set(rightPanelTab) failed:", err);
    });
  },

  openSideChatPanel: () => {
    set({ rightOpen: true });
    // **切到 `flow`**（2026-09-21 改）：子对话列表现在长在「工作流运行」那张面板的
    // 下半部分，独立的「子对话」tab 已经删掉（用户要求：「之前的那个子对话 tab 就
    // 删掉了，没有了」）。这个函数的语义还是"把子对话摆到用户眼前"，只是落点换了。
    get().setRightPanelTab("flow");
    // Refresh the current main session's list if we have one (cheap; keeps
    // titles/status fresh after restarts or background changes).
    const parent = get().activeSessionId;
    if (parent) void get().hydrateSideChats(parent);
  },

  hydrateSideChats: async (parentSessionId) => {
    try {
      const { sessions } = await api.claude.listSideChats({ parentSessionId });
      set((s) => ({ sideChatsByParent: { ...s.sideChatsByParent, [parentSessionId]: sessions } }));
    } catch (err) {
      console.error("listSideChats failed:", err);
    }
  },

  createSideChat: async () => {
    const s = get();
    const parentSessionId = s.activeSessionId;
    if (!parentSessionId) return;
    // Same send-model guard as sendPrompt: no default model — an unpicked
    // model or an empty provider blocks the side chat.
    const resolvedModel = resolveSendModel(s);
    if (!resolvedModel) {
      raiseModelGuard();
      return;
    }
    // The parent main session's row carries the owning projectId (FK is
    // NOT NULL); resolve it from the loaded caches.
    const parentRow =
      s.sessionsByProject[s.activeProjectId ?? ""]?.find((x) => x.id === parentSessionId) ??
      s.pinnedSessions.find((x) => x.id === parentSessionId);
    if (!parentRow) return;
    try {
      const { session } = await api.claude.startSession({
        projectId: parentRow.projectId,
        kind: "side",
        parentSessionId,
        providerId: s.providerId,
        model: resolvedModel.model,
        effort: s.effort,
        permissionMode: s.permissionMode,
        customModelId: resolvedModel.customModelId,
      });
      set((st) => {
        const existing = st.sideChatsByParent[parentSessionId] ?? [];
        return {
          sideChatsByParent: {
            ...st.sideChatsByParent,
            // The main process reuses the parent's still-fresh "Quick ask"
            // shell when one exists — that row is already in the list, so it
            // updates in place (prepending would duplicate the React key and
            // teleport an old row to the top; the list is created_at-ordered
            // like the DB query behind hydrateSideChats). New rows land at
            // the front, matching listSideByParent's DESC order.
            [parentSessionId]: existing.some((x) => x.id === session.id)
              ? existing.map((x) => (x.id === session.id ? session : x))
              : [session, ...existing],
          },
          activeSideChatId: session.id,
          // Locally-created — or a reused shell, which by definition has no
          // messages (the first sent question rewrites the placeholder
          // title): empty bucket IS the full history (same as startSession).
          messagesBySession: { ...st.messagesBySession, [session.id]: [] },
          hasMoreMessagesBySession: { ...st.hasMoreMessagesBySession, [session.id]: false },
          historyLoadedBySession: { ...st.historyLoadedBySession, [session.id]: true },
        };
      });
    } catch (err) {
      console.error("createSideChat failed:", err);
      useToastStore.getState().push({
        kind: "error",
        title: translate(get().locale, "store.toast.createChatFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
    }
  },

  selectSideChat: async (sessionId) => {
    set({ activeSideChatId: sessionId });
    // Lazy-load persisted history (no-op when already hydrated / live).
    await get().prefetchSessionMessages(sessionId);
  },

  /**
   * 「新建子对话」—— 见接口上那段。实现上**与 `createSideChat` 共用同一段 upsert**
   * (列表插入位置、空历史桶、`historyLoaded` 三条都一样),差别只有三处:发下去的
   * `agentProfileId`/`memory`、标题不再被判定为占位符、以及**不抢右侧面板**(建完不进
   * 它的 chat 视图,用户正在打的字不被打断)。
   */
  createSubChat: async (choice) => {
    const s = get();
    const parentSessionId = s.activeSessionId;
    if (!parentSessionId) return null;
    // 「空白 + 记忆」不是一个界面上的组合(选择器里勾了记忆就把「空白」那一档关掉了)。
    // 拦在这里而不是"信任调用方":记忆是注给某个角色的背景说明,没有角色的对话带上它
    // 就是一段没有主语的背景 —— 与其悄悄注进去,不如把构造出来的组合拒掉。
    if (!choice.profile && choice.memory) {
      throw new Error("空白子对话不带记忆 —— 记忆要注给一个角色");
    }
    // 与 createSideChat / sendPrompt 同一条守卫:没选模型就不开新会话(开了也发不出
    // 第一条消息,而用户会以为它坏了)。
    const resolvedModel = resolveSendModel(s);
    if (!resolvedModel) {
      raiseModelGuard();
      return null;
    }
    const parentRow =
      s.sessionsByProject[s.activeProjectId ?? ""]?.find((x) => x.id === parentSessionId) ??
      s.pinnedSessions.find((x) => x.id === parentSessionId);
    if (!parentRow) return null;
    try {
      const { session } = await api.claude.startSession({
        projectId: parentRow.projectId,
        kind: "side",
        parentSessionId,
        providerId: s.providerId,
        model: resolvedModel.model,
        effort: s.effort,
        permissionMode: s.permissionMode,
        customModelId: resolvedModel.customModelId,
        // 只传 id,**不传内容**:档案是磁盘上的文件,内容只能有一个来源(见
        // StartSessionSchema 上那段)。主进程读不到会抛错,不静默降级成"没有角色"。
        ...(choice.profile ? { agentProfileId: choice.profile.id } : {}),
        // 记忆只在有档案时才是有意义的组合(「空白 + 记忆」不是一个界面上的选项);
        // 传上去也不会有害,但界面上给不出来的东西别从代码里造出来。
        ...(choice.profile && choice.memory ? { memory: true } : {}),
      });
      set((st) => {
        const existing = st.sideChatsByParent[parentSessionId] ?? [];
        return {
          // 插入位置与 createSideChat 逐字同款:主进程复用了空壳就原地更新,否则前插
          // (与 listSideByParent 的 DESC 一致)。
          sideChatsByParent: {
            ...st.sideChatsByParent,
            [parentSessionId]: existing.some((x) => x.id === session.id)
              ? existing.map((x) => (x.id === session.id ? session : x))
              : [session, ...existing],
          },
          // 本地刚建(或复用了一个空壳)——空桶就是完整历史。
          messagesBySession: { ...st.messagesBySession, [session.id]: [] },
          hasMoreMessagesBySession: { ...st.hasMoreMessagesBySession, [session.id]: false },
          historyLoadedBySession: { ...st.historyLoadedBySession, [session.id]: true },
        };
      });
      return session;
    } catch (err) {
      console.error("createSubChat failed:", err);
      useToastStore.getState().push({
        kind: "error",
        title: translate(get().locale, "store.toast.createChatFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  closeSideChatView: () => set({ activeSideChatId: null }),

  askInSideChat: async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const parent = get().activeSessionId;
    if (!parent) return;
    // Ensure the active side chat belongs to the CURRENT parent — the user
    // may have switched main sessions since the last one was opened (a stale
    // activeSideChatId would route the quote into another thread).
    let target = get().activeSideChatId;
    const owned =
      !!target && (get().sideChatsByParent[parent] ?? []).some((s) => s.id === target);
    if (!owned) {
      await get().createSideChat();
      target = get().activeSideChatId;
      if (!target) return; // no model configured — config dialog is up
    }
    get().openSideChatPanel();
    set((s) => ({
      sideChatSeedBySession: { ...s.sideChatSeedBySession, [target as string]: trimmed },
    }));
  },

  drainSideChatSeed: (sessionId) => {
    set((s) => {
      if (!(sessionId in s.sideChatSeedBySession)) return {};
      const next = { ...s.sideChatSeedBySession };
      delete next[sessionId];
      return { sideChatSeedBySession: next };
    });
  },

  openSubagentTranscript: (sessionId, taskId) => {
    set({ pendingSubagentView: { sessionId, taskId }, rightOpen: true });
    // `flow`（2026-09-21）：子代理转录的展开视图住在 `SideChatPanel` 里，而那个面板
    // 现在长在「工作流运行」那张面板的下半部分 —— 独立的「子对话」tab 已删。
    get().setRightPanelTab("flow");
  },

  clearPendingSubagentView: () => {
    set({ pendingSubagentView: null });
  },

  setPendingBookmarkJump: (jump) => {
    set({ pendingBookmarkJump: jump });
  },

  clearPendingBookmarkJump: () => {
    set({ pendingBookmarkJump: null });
  },

  setCustomCommandsByProject: (projectId, commands) => {
    set((s) => ({
      customCommandsByProject: { ...s.customCommandsByProject, [projectId]: commands },
    }));
    void api.setting
      .set({ key: UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY, value: JSON.stringify(get().customCommandsByProject) })
      .catch((err) => console.error("setting.set(customCommandsByProject) failed:", err));
  },

  addCustomCommand: (projectId, cmd) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    const next: CustomCommand = { ...cmd, id: `cmd-${Date.now().toString(36)}` };
    get().setCustomCommandsByProject(projectId, [...prev, next]);
  },

  updateCustomCommand: (projectId, cmd) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    get().setCustomCommandsByProject(
      projectId,
      prev.map((c) => (c.id === cmd.id ? cmd : c)),
    );
  },

  removeCustomCommand: (projectId, id) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    get().setCustomCommandsByProject(
      projectId,
      prev.filter((c) => c.id !== id),
    );
  },

  openFileInIde: (filePath, opts) => {
    const pid = get().activeProjectId;
    if (!pid) return; // no active project - nothing to scope to
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    const mode = get().ideEditorMode;
    // 打开之前，中间是不是已经在显示一份文档（可编辑文件或只读预览）—— 见函数末尾
    // 那段"例外"。必须在任何 set 之前取。
    const centerWasDocument = isCenterShowingDocument(get());
    // Normalize for case-insensitive dedup on Windows/macOS: if the file is
    // already open under a different case (e.g. LSP returns `d:\foo` but the
    // file tree stored `D:\foo`), reuse the existing path string so we don't
    // create a duplicate tab. On Linux paths are case-sensitive as-is.
    const lowerFile = filePath.toLowerCase();
    const existing = prev.find((p) => p.toLowerCase() === lowerFile);
    const canonicalPath = existing ?? filePath;
    // Navigation history: record the location being LEFT (goto-definition
    // invocation, chat link, file-tree open...) so Alt+← can come back to it.
    // Only meaningful navigation — switching to another file or an explicit
    // line reveal; re-opening the same file without a reveal doesn't move the
    // cursor and would only pollute the stack. History-driven reveals
    // (navigateBack/Forward) manage the stacks themselves.
    if (
      !navHistoryRevealing &&
      (opts?.line != null || canonicalPath !== (get().ideActiveFileByProject[pid] ?? null))
    ) {
      const outgoing = currentNavEntryFor(get);
      if (outgoing) get().pushNavHistory(outgoing);
    }
    // In "replace" mode, opening a file discards everything else - at most
    // one file is open at a time. In "tabs" mode, files accumulate (dedup:
    // re-opening an already-open file just activates it).
    const open =
      mode === "replace"
        ? [canonicalPath]
        : existing
          ? prev
          : [...prev, canonicalPath];
    const previousDisplayNames = get().ideFileDisplayNamesByProject[pid] ?? {};
    const displayNames: Record<string, string> = {};
    for (const path of open) {
      const requestedName = path === canonicalPath ? opts?.displayName?.trim() : undefined;
      const previousName = path !== canonicalPath || existing ? previousDisplayNames[path] : undefined;
      const displayName = requestedName || previousName;
      if (displayName) displayNames[path] = displayName;
    }
    // Replace mode discards every other tab — drop their cached models now
    // (background tabs get no unmount event). The currently DISPLAYED file
    // is skipped: its model is attached to the live editor; EditPane's swap
    // bookkeeping disposes it once the swap lands.
    if (mode === "replace") {
      const displayed = getDisplayedPath();
      for (const p of prev) {
        if (p !== canonicalPath && p !== displayed) disposeModel(p);
      }
    }
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode };
    // A review/diff request is an explicit intent -> force diff mode (don't
    // leave a stale "edit" the user may have toggled for a different purpose).
    if (opts?.diff) viewMode[canonicalPath] = "diff";
    // A line reveal (goto-definition / navigation history) targets source code
    // and is only consumed by the EditPane — force "edit" so a stale "diff"
    // or "preview" view-mode for this file doesn't swallow the reveal.
    else if (opts?.line != null) viewMode[canonicalPath] = "edit";
    // Files that render as a read-only preview default to "preview" on FIRST
    // open (no prior view-mode for this file): Markdown (rendered), images
    // (<img> via app-resource://), and unsupported binary types (Office docs,
    // archives, etc. - shown as a "can't preview" notice). Re-opening respects
    // the user's earlier choice (e.g. they switched to "edit") since the entry
    // already exists. A diff request above takes precedence over this default.
    else if (
      !(canonicalPath in prevViewMode) &&
      (isMarkdownPath(canonicalPath) || isImagePath(canonicalPath) || isUnsupportedPath(canonicalPath))
    ) {
      viewMode[canonicalPath] = "preview";
    }
    // A before-snapshot passed by a turn-files card (works for HISTORICAL
    // turns whose snapshot is gone from turnFilesByProject). Stashed
    // per-file so FileEditor can use it as the diff's left pane.
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore =
      opts?.diff && opts.before != null
        ? { ...prevDiffBefore, [canonicalPath]: opts.before }
        : prevDiffBefore;
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
      ideFileDisplayNamesByProject: { ...s.ideFileDisplayNamesByProject, [pid]: displayNames },
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: canonicalPath },
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
      ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
      // ⚠️ **这里不再 bump `ideFocusNonce`**（2026-09-22）。
      //
      // 那个 nonce 是给 **`revealInFileTree`**（"去文件树里定位某个文件"）用的，
      // 它的消费端会把右栏切到 **files** 页。而"打开一个文件看内容"是另一件事 ——
      // 借同一条道走，结果就是**每次双击文件，右栏都被拉到文件树那一页**，而用户
      // 要的是"中间看文件 + 侧边展开主对话"（`fileViewStore.open()` 里那套）。
      //
      // 所以打开文件时右栏怎么变，交给 `fileViewStore.open()` 那一处决定 ——
      // 它是"中间开始看一个文件"的唯一入口（硬规矩 2）。
      // Unified center bar (tabs displayMode): opening a file focuses the
      // editor so it gets the full center width. Gated on tabs mode — the
      // split layout in single mode ignores the flag, and keeping single
      // mode out of it makes a later mode switch land on the chat.
      ...(s.displayMode === "tabs" ? { centerTabFocus: "editor" as const } : {}),
      // If a line was requested (goto-definition), stash a reveal target +
      // bump the nonce so the EditPane scrolls to it once mounted/active.
      ...(opts?.line != null
        ? {
            idePendingReveal: {
              filePath: canonicalPath,
              line: opts.line,
              column: opts.column ?? 1,
            },
            ideRevealNonce: s.ideRevealNonce + 1,
          }
        : {}),
    }));
    persistIdeBuckets(get);

    /**
     * **打开文件 = 中间显示它 + 侧边展开主对话**（2026-09-22 修正）。
     *
     * 用户的原话是「双击打开文件的同时侧边栏弹出来主对话」。这三件事
     * （展开右栏、切到 `flow` 页、展开主对话）本来就写在 `fileViewStore.open()`
     * 里 —— 但那一条是"中间预览"的入口，而**双击走的是这里**（进编辑器）。
     * 于是双击时那套从没生效过，用户看到的只是右栏被别的路径顶开、落在 files 页。
     *
     * 为什么放这儿而不是让 `App.tsx` 看 nonce 去猜：右栏该显示什么，取决于
     * **用户做的是哪件事** —— `revealInFileTree`（去文件树里定位）要的是 files 页，
     * 而"看一个文件"要的是主对话。两件事共用一条 nonce 就会互相盖掉（正是之前的毛病）。
     *
     * ⚠️ **diff 不走这儿**：审查一次改动渲染在**中间**（DiffPane），右栏该保持原样
     * —— 强行拉出来纯是噪音。
     */
    if (!opts?.diff) {
      const main = get().activeSessionId;
      // **例外（2026-09-27）：主页面本来就是文档页 → 右栏保持现状。**
      //
      // 用户的原话：「如果本身主页面就已经是文档页面了，再打开其他的文档，主页面就不用
      // 在侧边栏弹出来了，右边栏保持现状就行」。"展开主对话"是为了**第一次**把中间让给
      // 文件时对话不至于没地方站；已经让出去了，再开一个文件不该再去动用户手里的右栏
      // （他可能正看着流程图 / 文件树 / 某个子对话）。
      //
      // ⚠️ 判据取的是**这次打开之前**的样子（`centerWasDocument` 在上面的 set 之前算），
      // 不然 set 落地之后中间永远"已经是文档页"，这条分支就再也进不去了。
      if (!centerWasDocument) {
        // 展开 + 切页放**同一个 set**：分两次会让右栏先以旧 tab 闪一帧。
        set((s) => ({ rightOpen: true, rightPanelTab: "flow", rightPanelTabSeq: s.rightPanelTabSeq + 1 }));
        if (main) void get().selectSideChat(main);
      }
    }
  },

  clearIdePendingReveal: () => {
    if (get().idePendingReveal) set({ idePendingReveal: null });
  },

  pushNavHistory: (entry) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const back = get().navBackByProject[pid] ?? [];
    // Dedup a consecutive identical entry (guards against double-pushes when
    // a provider and openFileInIde both try to record the same jump origin).
    const top = back[back.length - 1];
    if (top && sameNavEntry(top, entry)) return;
    set((s) => ({
      navBackByProject: { ...s.navBackByProject, [pid]: [...back, entry].slice(-NAV_HISTORY_CAP) },
      // Any new navigation invalidates the forward stack (standard back/forward semantics).
      navForwardByProject: { ...s.navForwardByProject, [pid]: [] },
    }));
  },

  navigateBack: () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const back = get().navBackByProject[pid] ?? [];
    if (back.length === 0) return;
    const target = back[back.length - 1];
    // Snapshot the location being LEFT onto the forward stack so
    // navigateForward can return here (skip when it equals the target —
    // nothing visually changes).
    const cur = currentNavEntryFor(get);
    const prevForward = get().navForwardByProject[pid] ?? [];
    const forward =
      cur && !sameNavEntry(cur, target)
        ? [...prevForward, cur].slice(-NAV_HISTORY_CAP)
        : prevForward;
    set((s) => ({
      navBackByProject: { ...s.navBackByProject, [pid]: back.slice(0, -1) },
      navForwardByProject: { ...s.navForwardByProject, [pid]: forward },
    }));
    navHistoryRevealing = true;
    try {
      get().openFileInIde(target.filePath, { line: target.line, column: target.column });
    } finally {
      navHistoryRevealing = false;
    }
  },

  navigateForward: () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const forward = get().navForwardByProject[pid] ?? [];
    if (forward.length === 0) return;
    const target = forward[forward.length - 1];
    // Mirror of navigateBack: push the location being left back onto the
    // back stack so the next Alt+← undoes this forward.
    const cur = currentNavEntryFor(get);
    const prevBack = get().navBackByProject[pid] ?? [];
    const back =
      cur && !sameNavEntry(cur, target)
        ? [...prevBack, cur].slice(-NAV_HISTORY_CAP)
        : prevBack;
    set((s) => ({
      navBackByProject: { ...s.navBackByProject, [pid]: back },
      navForwardByProject: { ...s.navForwardByProject, [pid]: forward.slice(0, -1) },
    }));
    navHistoryRevealing = true;
    try {
      get().openFileInIde(target.filePath, { line: target.line, column: target.column });
    } finally {
      navHistoryRevealing = false;
    }
  },

  closeFileInIde: (filePath, force = false) => {
    const pid = get().activeProjectId;
    if (!pid) return { closed: [], blocked: [] };
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    const idx = prev.indexOf(filePath);
    if (idx === -1) return { closed: [], blocked: [] }; // not open — nothing to do
    // 未保存的改动不能静默丢 —— 见接口上的说明。批量关闭共用一个收敛函数。
    const gate = partitionClosable([filePath], ideDirtyTracker.has, force);
    if (gate.blocked.length > 0) return gate;
    // force = 文件已经不在了(删除路径):它的脏标记也没有意义了,一并清掉,
    // 免得同名文件后来再建出来时被一条陈旧的"未保存"挡住。
    if (force) ideDirtyTracker.set(filePath, false);
    const open = prev.filter((p) => p !== filePath);
    // Active shifts to the previous file (or next, or null).
    let active = get().ideActiveFileByProject[pid] ?? null;
    if (active === filePath) {
      active = open[idx - 1] ?? open[idx] ?? null;
    }
    // Model cache: never dispose the DISPLAYED file's model here — it is
    // attached to the live editor (which may briefly differ from the active
    // file while a newly-activated file is still loading). EditPane's swap
    // bookkeeping disposes it once the swap lands and it has left the open
    // list. Background tabs get no unmount event, so dispose them here.
    if (getDisplayedPath() !== filePath) disposeModel(filePath);
    // Clean up the per-file view mode for the closed file.
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode };
    delete viewMode[filePath];
    // Clean up the per-file before-snapshot override too.
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore = { ...prevDiffBefore };
    delete diffBefore[filePath];
    set((s) => {
      // Unified center bar: when the closed file was the last one and no
      // plan tab is active, fall back to the chat view.
      const sid = s.activeSessionId;
      const planActive = !!(sid && s.planTabActiveBySession[sid]);
      return {
        ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
        ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
        ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
        centerTabFocus: active == null && !planActive ? ("chat" as const) : s.centerTabFocus,
      };
    });
    persistIdeBuckets(get);
    return { closed: [filePath], blocked: [] };
  },

  closeFilesUnderDir: (dirPath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    // Prefix used to match descendants: a trailing separator so a dir "/a/b"
    // doesn't match siblings like "/a/bb/x" (the dir itself is never an open
    // file, so we only need the descendant form here).
    const prefix = dirPath.endsWith("/") ? dirPath : dirPath + "/";
    const prevOpen = get().ideOpenFilesByProject[pid] ?? [];
    const removed = new Set(prevOpen.filter((p) => p.startsWith(prefix)));
    if (removed.size === 0 && !(get().ideExpandedDirsByProject[pid] ?? []).some((d) => d.startsWith(prefix))) {
      // Nothing to close and no expanded dirs under it — still fall through to
      // the (possibly empty) expanded-dirs cleanup below, which is cheap.
    }
    const open = prevOpen.filter((p) => !removed.has(p));
    // Active shifts away if it was under the removed dir.
    let active = get().ideActiveFileByProject[pid] ?? null;
    if (active && removed.has(active)) {
      const idx = prevOpen.indexOf(active);
      active = open[idx - 1] ?? open[idx] ?? null;
    }
    // Model cache: same displayed-file rule as closeFileInIde — dispose the
    // rest here, EditPane's swap bookkeeping owns the displayed one.
    const displayed = getDisplayedPath();
    for (const p of removed) {
      if (p !== displayed) disposeModel(p);
    }
    // Clean up per-file view-mode + diff-before for the removed paths.
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode: Record<string, FileViewMode> = {};
    for (const [k, v] of Object.entries(prevViewMode)) {
      if (!removed.has(k)) viewMode[k] = v;
    }
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore: Record<string, string> = {};
    for (const [k, v] of Object.entries(prevDiffBefore)) {
      if (!removed.has(k)) diffBefore[k] = v;
    }
    // Drop expanded-dir records under the removed dir too.
    const prevExpanded = get().ideExpandedDirsByProject[pid] ?? [];
    const expanded = prevExpanded.filter((d) => d !== dirPath && !d.startsWith(prefix));
    set((s) => {
      // Same unified-bar fallback as closeFileInIde (see there).
      const sid = s.activeSessionId;
      const planActive = !!(sid && s.planTabActiveBySession[sid]);
      return {
        ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
        ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
        ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
        ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: expanded },
        centerTabFocus: active == null && !planActive ? ("chat" as const) : s.centerTabFocus,
      };
    });
    persistIdeBuckets(get);
    // 这些文件已经被删掉了 —— 它们的脏标记随之作废。
    for (const p of removed) ideDirtyTracker.set(p, false);
  },

  renamePathInIde: (oldPath, newPath, isDir) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    if (isDir) {
      // Re-prefix every open file and expanded dir that lives under oldPath.
      const prefix = oldPath.endsWith("/") ? oldPath : oldPath + "/";
      const prevOpen = get().ideOpenFilesByProject[pid] ?? [];
      const hadDescendant = prevOpen.some((p) => p === oldPath || p.startsWith(prefix));
      const prevExpanded = get().ideExpandedDirsByProject[pid] ?? [];
      const hadExpanded = prevExpanded.some((d) => d === oldPath || d.startsWith(prefix));
      if (!hadDescendant && !hadExpanded) return; // nothing under it
      // Model cache: models are keyed by the OLD paths — dispose every one
      // except the DISPLAYED file's (its live editor swaps away first, then
      // EditPane's swap bookkeeping disposes the stale-path model).
      const displayedDir = getDisplayedPath();
      for (const p of prevOpen) {
        if (p !== displayedDir) disposeModel(p);
      }
      const open = prevOpen.map((p) => (p === oldPath ? newPath : p.startsWith(prefix) ? newPath + p.slice(oldPath.length) : p));
      let active = get().ideActiveFileByProject[pid] ?? null;
      if (active) {
        active = active === oldPath ? newPath : active.startsWith(prefix) ? newPath + active.slice(oldPath.length) : active;
      }
      const reKey = (obj: Record<string, FileViewMode> | Record<string, string>) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === oldPath) out[newPath] = v as string;
          else if (k.startsWith(prefix)) out[newPath + k.slice(oldPath.length)] = v as string;
          else out[k] = v as string;
        }
        return out;
      };
      const viewMode = reKey(get().ideFileViewModeByProject[pid] ?? {}) as Record<string, FileViewMode>;
      const diffBefore = reKey(get().ideDiffBeforeByProject[pid] ?? {});
      const expanded = prevExpanded.map((d) => (d === oldPath ? newPath : d.startsWith(prefix) ? newPath + d.slice(oldPath.length) : d));
      set((s) => ({
        ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
        ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
        ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
        ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: expanded },
      }));
      persistIdeBuckets(get);
      // 脏标记跟着路径走(旧路径的条目换成新路径),否则重命名之后那个标签的
      // "未保存"会在关不掉/不提示之间漂移。
      for (const p of prevOpen) {
        if (!ideDirtyTracker.has(p)) continue;
        ideDirtyTracker.set(p, false);
        ideDirtyTracker.set(p === oldPath ? newPath : newPath + p.slice(oldPath.length), true);
      }
      return;
    }
    // Single file rename: rewrite the single path if it's open.
    const prevOpen = get().ideOpenFilesByProject[pid] ?? [];
    const idx = prevOpen.indexOf(oldPath);
    if (idx === -1) return;
    // Model cache: dispose the old-path model unless it's the DISPLAYED file
    // (owned by EditPane's swap bookkeeping).
    if (getDisplayedPath() !== oldPath) disposeModel(oldPath);
    const open = prevOpen.slice();
    open[idx] = newPath;
    let active = get().ideActiveFileByProject[pid] ?? null;
    if (active === oldPath) active = newPath;
    const reKey = <V>(obj: Record<string, V>): Record<string, V> => {
      if (!(oldPath in obj)) return obj;
      const out: Record<string, V> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k === oldPath ? newPath : k] = v;
      }
      return out;
    };
    const viewMode = reKey(get().ideFileViewModeByProject[pid] ?? {});
    const diffBefore = reKey(get().ideDiffBeforeByProject[pid] ?? {});
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
      ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
    }));
    persistIdeBuckets(get);
    // 单文件重命名同理:脏标记跟着新路径走。
    if (ideDirtyTracker.has(oldPath)) {
      ideDirtyTracker.set(oldPath, false);
      ideDirtyTracker.set(newPath, true);
    }
  },

  closeOtherFilesInIde: (keepFilePath, force = false) => {
    const pid = get().activeProjectId;
    if (!pid) return { closed: [], blocked: [] };
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    if (!prev.includes(keepFilePath)) return { closed: [], blocked: [] };
    // 未保存的改动不能被"关闭其他"顺手丢掉 —— 它们留在打开列表里,随 `blocked` 报出去。
    const others = prev.filter((p) => p !== keepFilePath);
    const gate = partitionClosable(others, ideDirtyTracker.has, force);
    if (force) for (const p of gate.closed) ideDirtyTracker.set(p, false);
    const survivors = new Set([keepFilePath, ...(force ? [] : gate.blocked)]);
    const open = prev.filter((p) => survivors.has(p));
    // Model cache: dispose the dropped background models; the DISPLAYED one
    // (if among the dropped) is owned by EditPane's swap bookkeeping.
    const displayed = getDisplayedPath();
    for (const p of prev) {
      if (!survivors.has(p) && p !== displayed) disposeModel(p);
    }
    // Clean up per-file view-mode + diff-before for the dropped paths.
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode: Record<string, FileViewMode> = {};
    for (const p of open) if (p in prevViewMode) viewMode[p] = prevViewMode[p];
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore: Record<string, string> = {};
    for (const p of open) if (p in prevDiffBefore) diffBefore[p] = prevDiffBefore[p];
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: keepFilePath },
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
      ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
    }));
    persistIdeBuckets(get);
    return gate;
  },

  closeAllFilesInIde: (force = false) => {
    const pid = get().activeProjectId;
    if (!pid) return { closed: [], blocked: [] };
    const prev = get().ideOpenFilesByProject[pid] ?? [];
    if (prev.length === 0) return { closed: [], blocked: [] };
    // 有未保存改动的继续开着 —— 用户没打算丢它们(编辑器没有自动保存)。
    const gate = partitionClosable(prev, ideDirtyTracker.has, force);
    if (force) for (const p of gate.closed) ideDirtyTracker.set(p, false);
    const survivors = new Set(force ? [] : gate.blocked);
    const open = prev.filter((p) => survivors.has(p));
    // Model cache: dispose the dropped background models; the DISPLAYED one is
    // owned by EditPane's swap/teardown bookkeeping.
    const displayed = getDisplayedPath();
    for (const p of prev) {
      if (!survivors.has(p) && p !== displayed) disposeModel(p);
    }
    // The active file must survive — fall back to a surviving unsaved file.
    let active = get().ideActiveFileByProject[pid] ?? null;
    if (active && !survivors.has(active)) active = open[open.length - 1] ?? null;
    // View-mode / diff-before: keep only the survivors (mirrors closeFileInIde).
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode: Record<string, FileViewMode> = {};
    for (const p of open) if (p in prevViewMode) viewMode[p] = prevViewMode[p];
    const prevDiffBefore = get().ideDiffBeforeByProject[pid] ?? {};
    const diffBefore: Record<string, string> = {};
    for (const p of open) if (p in prevDiffBefore) diffBefore[p] = prevDiffBefore[p];
    set((s) => {
      // Unified-bar fallback: no files left — the plan tab may still own the
      // editor view; otherwise return to the chat.
      const sid = s.activeSessionId;
      const planActive = !!(sid && s.planTabActiveBySession[sid]);
      return {
        ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: active },
        ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
        ideDiffBeforeByProject: { ...s.ideDiffBeforeByProject, [pid]: diffBefore },
        centerTabFocus: active == null && !planActive ? ("chat" as const) : s.centerTabFocus,
      };
    });
    persistIdeBuckets(get);
    return gate;
  },

  setIdeActiveFile: (filePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    // Navigation history: switching the active file via a tab click records
    // where the user is leaving. Same-file activation (a re-click on the
    // current tab) moves nothing and must not pollute the stack; history-
    // driven reveals are excluded via the flag.
    if (
      !navHistoryRevealing &&
      filePath !== (get().ideActiveFileByProject[pid] ?? null)
    ) {
      const outgoing = currentNavEntryFor(get);
      if (outgoing) get().pushNavHistory(outgoing);
    }
    set((s) => ({
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: filePath },
      // Clicking a file tab (unified bar) focuses the editor view.
      ...(s.displayMode === "tabs" ? { centerTabFocus: "editor" as const } : {}),
    }));
    persistIdeBuckets(get);
  },

  clearIdeActiveFile: () => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => ({
      ideActiveFileByProject: { ...s.ideActiveFileByProject, [pid]: null },
      // Semantically a "hide the editor" move (titlebar toggle; the plan-tab
      // click overrides it right after by activating the plan tab). In tabs
      // displayMode this pulls the center back to the chat view.
      centerTabFocus: "chat",
    }));
    persistIdeBuckets(get);
  },

  /** Move an open file within the active project's editor tab strip.
   *  Mirrors `reorderTab` but scoped to ideOpenFilesByProject. */
  reorderIdeFile: (from, to) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const open = get().ideOpenFilesByProject[pid] ?? [];
    if (
      from === to ||
      from < 0 ||
      from >= open.length ||
      to < 0 ||
      to >= open.length
    ) {
      return;
    }
    const next = [...open];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    set((s) => ({
      ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: next },
    }));
    persistIdeBuckets(get);
  },

  setIdeFileViewMode: (filePath, mode) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prevViewMode = get().ideFileViewModeByProject[pid] ?? {};
    const viewMode = { ...prevViewMode, [filePath]: mode };
    set((s) => ({
      ideFileViewModeByProject: { ...s.ideFileViewModeByProject, [pid]: viewMode },
    }));
    // Not persisted (view mode is ephemeral — see the field doc).
  },

  setIdeEditorMode: (mode) => {
    // When switching to "replace", collapse the ACTIVE project's open-file
    // list to just the active file (if any) so the invariant "≤1 file open"
    // holds immediately for the project the user is looking at.
    if (mode === "replace") {
      const pid = get().activeProjectId;
      if (pid) {
        const active = get().ideActiveFileByProject[pid] ?? null;
        const open = active ? [active] : [];
        set((s) => ({
          ideEditorMode: mode,
          ideOpenFilesByProject: { ...s.ideOpenFilesByProject, [pid]: open },
        }));
        persistIdeBuckets(get);
      } else {
        set({ ideEditorMode: mode });
      }
    } else {
      set({ ideEditorMode: mode });
    }
    void api.setting
      .set({ key: UI_IDE_EDITOR_MODE_SETTING_KEY, value: mode })
      .catch((err) => console.error("setting.set(ideEditorMode) failed:", err));
  },

  setGitDiffOpenMode: (mode) => {
    set({ gitDiffOpenMode: mode });
    void api.setting
      .set({ key: UI_GIT_DIFF_OPEN_MODE_SETTING_KEY, value: mode })
      .catch((err) => console.error("setting.set(gitDiffOpenMode) failed:", err));
  },

  openGitDiffDialogTab: (tab) => {
    set((s) => {
      // Dedup by file path: re-clicking the same file refreshes its snapshot
      // and moves it to the end (most-recent) rather than opening a duplicate.
      const existing = s.gitDiffDialogTabs.find((t) => t.id === tab.id);
      const tabs = existing
        ? s.gitDiffDialogTabs.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
        : [...s.gitDiffDialogTabs, tab];
      return {
        gitDiffDialogTabs: tabs,
        gitDiffDialogActiveId: tab.id,
        // Opening a tab always surfaces the dialog.
        gitDiffDialogOpen: true,
      };
    });
  },

  closeGitDiffDialogTab: (id) => {
    set((s) => {
      const idx = s.gitDiffDialogTabs.findIndex((t) => t.id === id);
      if (idx === -1) return {};
      const tabs = s.gitDiffDialogTabs.filter((t) => t.id !== id);
      // If the closed tab was active, shift to an adjacent one (prefer the
      // previous; otherwise the next; otherwise none).
      let activeId = s.gitDiffDialogActiveId;
      let open = s.gitDiffDialogOpen;
      if (activeId === id) {
        activeId = tabs[idx - 1]?.id ?? tabs[idx]?.id ?? null;
        // No tabs left -> close the dialog too.
        open = tabs.length > 0;
      }
      return { gitDiffDialogTabs: tabs, gitDiffDialogActiveId: activeId, gitDiffDialogOpen: open };
    });
  },

  setGitDiffDialogActive: (id) => {
    set({ gitDiffDialogActiveId: id });
  },

  setGitDiffDialogOpen: (open) => {
    set({ gitDiffDialogOpen: open });
  },

  setGitDiffDialogViewMode: (mode) => {
    set({ gitDiffDialogViewMode: mode });
  },

  toggleDirExpanded: (dirPath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideExpandedDirsByProject[pid] ?? [];
    const open = prev.includes(dirPath) ? prev.filter((p) => p !== dirPath) : [...prev, dirPath];
    set((s) => ({
      ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: open },
    }));
    persistIdeBuckets(get);
  },

  setDirExpanded: (dirPath, open) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    const prev = get().ideExpandedDirsByProject[pid] ?? [];
    const has = prev.includes(dirPath);
    let next: string[];
    if (open && !has) next = [...prev, dirPath];
    else if (!open && has) next = prev.filter((p) => p !== dirPath);
    else return; // already in the desired state
    set((s) => ({
      ideExpandedDirsByProject: { ...s.ideExpandedDirsByProject, [pid]: next },
    }));
    persistIdeBuckets(get);
  },

  saveFileContent: async (filePath, content) => {
    try {
      // Monaco source saves and rich Markdown autosaves must be ordered for
      // the same path, even if a mode switch happens during an in-flight write.
      await textFileWrites.enqueue(filePath, content);
      return true;
    } catch (err) {
      console.error("file.writeFile failed:", err);
      return false;
    }
  },

  setGitDiffBefore: (filePath, before) => {
    get().setGitDiffPair(filePath, { before });
  },

  setGitDiffPair: (filePath, pair) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => ({
      gitDiffByProject: {
        ...s.gitDiffByProject,
        [pid]: { ...(s.gitDiffByProject[pid] ?? {}), [filePath]: pair },
      },
    }));
  },

  clearGitDiffBefore: (filePath) => {
    const pid = get().activeProjectId;
    if (!pid) return;
    set((s) => {
      const projMap = s.gitDiffByProject[pid];
      if (!projMap || !(filePath in projMap)) return {};
      const next = { ...projMap };
      delete next[filePath];
      return { gitDiffByProject: { ...s.gitDiffByProject, [pid]: next } };
    });
  },

  setCommitGenModel: (modelId) => {
    set({ commitGenModel: modelId });
    void api.setting
      .set({ key: UI_COMMIT_GEN_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(commitGenModel) failed:", err));
  },

  setCommitGenPrompt: (prompt) => {
    set({ commitGenPrompt: prompt });
    void api.setting
      .set({ key: UI_COMMIT_GEN_PROMPT_SETTING_KEY, value: prompt })
      .catch((err) => console.error("setting.set(commitGenPrompt) failed:", err));
  },

  setConflictResolveModel: (modelId) => {
    set({ conflictResolveModel: modelId });
    void api.setting
      .set({ key: UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(conflictResolveModel) failed:", err));
  },

  setTitleGenEnabled: (enabled) => {
    set({ titleGenEnabled: enabled });
    void api.setting
      .set({ key: UI_TITLE_GEN_ENABLED_SETTING_KEY, value: enabled ? "on" : "off" })
      .catch((err) => console.error("setting.set(titleGenEnabled) failed:", err));
  },

  setTitleGenModel: (modelId) => {
    set({ titleGenModel: modelId });
    void api.setting
      .set({ key: UI_TITLE_GEN_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(titleGenModel) failed:", err));
  },

  setOutputStyle: (style) => {
    set({ outputStyle: style });
    void api.setting
      .set({ key: AGENT_OUTPUT_STYLE_SETTING_KEY, value: style ?? "" })
      .catch((err) => console.error("setting.set(outputStyle) failed:", err));
  },

  toggleCollapsedGitRepo: (repoPath) => {
    set((s) => {
      const next = { ...s.collapsedGitRepos };
      if (next[repoPath]) {
        delete next[repoPath]; // remove key when expanding
      } else {
        next[repoPath] = true;
      }
      void api.setting
        .set({ key: UI_GIT_COLLAPSED_REPOS_SETTING_KEY, value: JSON.stringify(next) })
        .catch((err) => console.error("setting.set(gitCollapsedRepos) failed:", err));
      return { collapsedGitRepos: next };
    });
  },
}));

// Stable empty arrays (e.g. EMPTY_MESSAGES, EMPTY_TODOS) are exported
// directly at their declaration site (see the "Stable empty arrays" block
// above) so they can be imported individually without a re-export step.
