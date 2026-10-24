// ───────────────────────────────────────────────────────────────────────────
// 职责分区（2026-10-15）
//
// 本文件保留会话/项目骨架及旧调用方兼容入口；T66 已把 Browser、Git diff、
// 项目自定义命令迁到独立 Zustand store。下面其余对象仍按「域」分区，
// 分区名前缀（A–M / 0）与清单来自 docs/design/sessionStore-领域划界.md
// 的「附：13 个域」一节。每个域块前有一行注释头：
//
//     // ─────────────── F 编辑器 / IDE ───────────────
//
// 规矩：**新加 action 必须落在某个分区里。** 不许随手追加到文件末尾或
// 任意位置 —— 那样这个文件会重新退化成「什么都往里塞」的杂物间，而它
// 正是 6061 行 action 里平均只碰 3.5 个成员、140 个只碰 ≤2 个的原因：
// 不是逻辑纠缠，是缺归档。先归位，再谈别的。
//
// T66 采用逐域迁移：三个独立 store 负责真实状态和动作；旧 SessionState
// 字段/动作仍由 sessionStoreDomainBridge 兼容同步，以免跨域消费方突变。
// 后续只有等剩余调用方切走，才可以移除兼容字段；消息/回合大段逻辑
// 仍属于会话主干，拆它需另开任务（见 tasks/T66-session-store-split.md）。
//
// 分区不改变任何行为：它只是注释边界。分区内成员的**顺序**是历史顺序，
// 未按域重排（重排会改动代码行，本约束不允许）。
// ───────────────────────────────────────────────────────────────────────────
import { create } from "zustand";
import { useBrowserStore } from "./browserStore.js";
import { useGitStore } from "./gitStore.js";
import { connectSessionStoreDomains } from "./sessionStoreDomainBridge.js";
import { useCustomCommandsStore } from "./customCommandsStore.js";
import type { Project, Session, SessionBookmark } from "@contracts/session";
import type { SessionRunningSnapshotEvent, TurnFilesEvent, CompactResultEvent, TurnRewoundEvent, RuntimeEvent, NodeArtifact, NodeExecutionRecord, PermissionMode, EffortLevel, AskUserQuestionItem, ApprovalRequestEvent, PlanApprovalRequestEvent, PlanUpdateEvent, WorkflowNodeResultEvent, WorkflowChoiceOption, SubagentSnapshot, TranscriptBlock, ContextSnapshot, TurnUsageRecord, EngineCommandInfo } from "@contracts/runtime";
import type { TurnFileEntry } from "@renderer/lib/turnFiles.js";
import type { AttachmentKind, ContentTag } from "@renderer/lib/contentTag.js";
import { type NavEntry } from "@renderer/lib/editorNav.js";
import { disposeModel, getDisplayedPath } from "@renderer/lib/editorModelCache.js";
import { ideDirtyTracker, partitionClosable, type IdeCloseResult } from "@renderer/lib/ideDirty.js";
import { basename } from "@renderer/lib/path.js";
import type { CustomModelPublic } from "@contracts/customModel";
import { api } from "@renderer/lib/api.js";
import { textFileWrites } from "@renderer/lib/markdownFileWrites.js";
import { isElectron } from "@renderer/lib/platform.js";
import { normWorktreeKey } from "@renderer/lib/worktree.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
import { DEFAULT_GESTURE_SETTINGS } from "@renderer/lib/gestures.js";
import { DEFAULT_EDITOR_THEME_CHOICE, parseEditorThemeChoice, type EditorThemeChoice, type EditorThemeId } from "@renderer/lib/editorThemes.js";
import { DISPLAY_MODE_SETTING_KEY, TAB_BAR_MULTI_ROW_SETTING_KEY, LEFTBAR_MODE_SETTING_KEY, THEME_STYLE_SETTING_KEY, UI_LOCALE_SETTING_KEY, DEFAULT_PROVIDER_ID, UI_CHAT_FONT_SIZE_SETTING_KEY, UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY, UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY, WORKFLOW_MAX_PARALLEL_SETTING_KEY, UI_USER_MSG_COLOR_SETTING_KEY, UI_ACCENT_COLOR_SETTING_KEY, UI_RIGHT_PANEL_TAB_SETTING_KEY, UI_VOICE_LANG_SETTING_KEY, UI_VOICE_ENGINE_SETTING_KEY, UI_VOICE_MIC_PERMISSION_SETTING_KEY, UI_VOICE_MODEL_DIR_SETTING_KEY, UI_IDE_OPEN_FILES_SETTING_KEY, UI_IDE_ACTIVE_FILE_SETTING_KEY, UI_IDE_EXPANDED_DIRS_SETTING_KEY, UI_IDE_EDITOR_MODE_SETTING_KEY, UI_GIT_DIFF_OPEN_MODE_SETTING_KEY, UI_COMMIT_GEN_MODEL_SETTING_KEY, UI_COMMIT_GEN_PROMPT_SETTING_KEY, UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY, UI_COMPOSER_MODEL_SETTING_KEY, UI_TITLE_GEN_ENABLED_SETTING_KEY, UI_TITLE_GEN_MODEL_SETTING_KEY, UI_VISION_RELAY_MODEL_SETTING_KEY, AGENT_OUTPUT_STYLE_SETTING_KEY, UI_GIT_COLLAPSED_REPOS_SETTING_KEY, UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY, UI_PANE_WIDTHS_SETTING_KEY, UI_PANE_LAYOUT_SETTING_KEY, UI_PROJECT_VIEW_SETTING_KEY, UI_PROJECT_GROUPS_SETTING_KEY, UI_LAST_PROJECT_SETTING_KEY, UI_LAST_SESSION_SETTING_KEY, UI_STREAM_SCOPE_SETTING_KEY, UI_SHORTCUTS_SETTING_KEY, UI_GESTURES_SETTING_KEY, UI_CHAT_DENSITY_SETTING_KEY, UI_REDUCE_MOTION_SETTING_KEY, UI_SHELL_SETTING_KEY, UI_EDITOR_THEME_SETTING_KEY, AUTO_ARCHIVE_SETTING_KEY, DEFAULT_AUTO_ARCHIVE_CONFIG, parseAutoArchiveConfig, SESSION_WORKTREE_DEFAULT_SETTING_KEY, WORKTREE_NAMES_SETTING_KEY, PROJECT_COLORS_SETTING_KEY, ShortcutBindingsSchema, GestureSettingsSchema, RightPanelTabSchema, type AutoArchiveConfig, type DisplayMode, type LeftBarMode, type Locale, type VoiceEngine, type GestureSettings, type GestureSequence, type ChatDensity, type ReduceMotion, type ShellPreference, type ProjectView, type GitWorktreeInfo, type ProjectGroupsMeta, type RightPanelTab, type IdeEditorMode, type GitDiffOpenMode, type FileViewMode, type CustomCommand, type SkillInfo, type ProviderInfo, type ProviderHealthCheckResult, type ProviderHealthStatusCode, type ShortcutBindings, type Accelerator, type LspLanguageState, type LspStateChangedPayload, type RuntimeAgentState, type RuntimeProgressPayload, type PickedElement, type BrowserDevicePreset, type BrowserOrientation } from "@contracts/ipc";
import type { ThemeStyle } from "@contracts/theme";
// 【ARC-005 V1】外壳偏好的默认值 + 防卫式解析(叶子模块,只 import 契约)。
import { DEFAULT_SHELL_PREF, parseShellPref } from "@renderer/components/shell/shellPrefs.js";
import { parsePaneDock } from "@renderer/components/layout/paneDock.js";
import { DEFAULT_PANE_LAYOUT, LAYOUT_PRESETS, clampLayout, copyPaneLayout, movePane, moveHostedPane, hostedPaneContent, withHostedPaneContent, setPaneSizePct, withPaneContent } from "@renderer/components/layout/paneLayout.js";
import { createCoalescedPaneWriter, mayApplyPaneHydration, withoutLocallyEditedPaneFields } from "./paneWidthWriteQueue.js";
import { parseSavedPaneLayout } from "./paneLayoutPrefs.js";

import type { BuiltinModelOption, UserInputAnswers } from "@contracts/provider";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { inAppToastAllowed } from "@renderer/lib/notifPrefsCache.js";
import { withViewTransition } from "@renderer/lib/viewTransition.js";
// Pure helpers live in sessionStoreHelpers.ts (split for file size; see its header).
import { CONTENT_FROZEN_EVENTS, EMPTY_BOOKMARKS, EMPTY_CODEX_MODELS, EMPTY_CUSTOM_MODELS, EMPTY_LAST_MODEL_BY_PROVIDER, EMPTY_MESSAGES, EMPTY_PI_MODELS, EMPTY_PROMPT_QUEUE, EMPTY_PROVIDERS, EMPTY_SESSIONS, EMPTY_SKILLS, EMPTY_SUBAGENTS, IDE_BUCKETS_PERSIST_DEBOUNCE_MS, LEFT_WIDTH_PCT_DEFAULT, LIVE_PLAN_ID, MESSAGE_PAGE_SIZE, NAV_HISTORY_CAP, PROVIDER_HEALTH_STALE_MS, RESYNC_AFTER_TURN_DELAY_MS, RGB_TRIPLET_RE, SESSION_PAGE_SIZE, STREAM_PAGE_SIZE, WIDE_PANEL_PCT_DEFAULT, WORKFLOW_MAX_PARALLEL_DEFAULT_RENDERER, WORKTREE_SESSIONS_FETCH_LIMIT, appendDelta, appendTurnCardBlock, applyDeltaEntries, applySessionDeletedState, applySessionPinnedState, avgIntervalMs, buildPlanKickoffPrompt, centerRightRowWidth, clampBottomTerminalHeight, clampEditorWidthPct, clampFontSize, clampLeftWidthPct, clampPasteTagThresholdChars, clampRightPanelFontSize, clampRightWidth, clampWidePanelPct, clampWorkflowMaxParallel, clearSessionDeltas, clearUpstreamIssue, coerceSlotsForProvider, commandNameForLocalOutput, currentNavEntryFor, deltaArrivals, deltaBuf, demotePreviousLatestTurnFiles, extractImagesFromToolResult, fetchProjectSessionBuckets, findOpenTurnLastAssistant, findSession, freezeLatestTurnFilesBlock, freezeOrPrunePlanBlocks, fromRecords, hasErrorInCurrentTurn, hasSelectableModel, hydrateBookmarks, hydrateCapsule, hydrateContextSnapshot, hydrateSubagentTranscripts, hydrateTurnFiles, hydrateUsageHistory, isCenterShowingDocument, isImagePath, isMarkdownPath, isPathWithinRoot, isSessionChatOnScreen, isSideChatSession, isUnsupportedPath, isValidRememberedModel, parseCustomCommandsByProject, patchSessionInCache, patchSessionRowBookmarks, pendingInterruptDone, persistComposerSelection, providerHealthRequestGate, recordDeltaArrival, reduceApprovalRequest, reduceGitChanged, reduceModeChange, reducePlanApprovalRequest, reducePlanUpdate, reduceProjectsChanged, reduceQuestionAsk, reduceRequestResolved, reduceSessionChanged, reduceSessionDeleted, reduceSettingChanged, reduceSubagentTranscript, reduceSubagentUpdate, reduceTodoUpdate, reduceTokenUsageUpdated, reduceUpstreamIssue, reduceUserMessage, reduceWorkflowNodeChoice, reduceWorkflowNodeProgress, reduceWorkflowNodeResult, reduceWorkflowNodeTranscript, reduceWorkflowNodeUsage, rememberedEntryOf, removeProjectFromState, resolveSendModel, resyncAfterTurn, sameNavEntry, sortPinnedByRecency, splitSessionSections, streamScopeQuery, surfaceRejectedCustomModelSend, syncConfigFromSession, syncLandedSessionIfChanged, toRecords, upsertLivePlanBlock, upsertLiveTurnFilesBlock, validateComposerSelection, worktreeFetchSeq } from "./sessionStoreHelpers.js";
export type { BrowserTab, MobileViewerTarget, Block, TurnMeta, QueuedPrompt, PromptAttachment, PlanHandoffTarget, PromptImage, ComposerDraft, ChatMessage, TodoItem, PlanDraft, GitDiffDialogTab, EnvChoice, SessionState } from "./sessionStoreTypes.js";
import type { Block, BrowserTab, ChatMessage, PromptImage, QueuedPrompt, SessionState } from "./sessionStoreTypes.js";
export { BOTTOM_TERMINAL_HEIGHT_MAX, BOTTOM_TERMINAL_HEIGHT_MIN, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, EDITOR_WIDTH_PCT_MAX, EDITOR_WIDTH_PCT_MIN, EMPTY_BOOKMARKS, EMPTY_CHAT_QUEUE, EMPTY_ELEMENT_QUEUE, EMPTY_MESSAGES, EMPTY_PLAN, EMPTY_PROMPT_QUEUE, EMPTY_SUBAGENTS, EMPTY_TODOS, EMPTY_TURN_FILES, EMPTY_USAGE, LEFT_WIDTH_PCT_DEFAULT, LEFT_WIDTH_PCT_MAX, LEFT_WIDTH_PCT_MIN, PASTE_TAG_THRESHOLD_CHARS_MAX, PASTE_TAG_THRESHOLD_CHARS_MIN, RIGHT_PANEL_FONT_SIZE_MAX, RIGHT_PANEL_FONT_SIZE_MIN, RIGHT_SHARE_MAX, RIGHT_WIDTH_MIN, WIDE_PANEL_PCT_DEFAULT, WIDE_PANEL_PCT_MAX, WIDE_PANEL_PCT_MIN, WORKFLOW_MAX_PARALLEL_DEFAULT_RENDERER, clampBottomTerminalHeight, clampEditorWidthPct, clampFontSize, clampLeftWidthPct, clampPasteTagThresholdChars, clampRightPanelFontSize, clampRightWidth, clampWidePanelPct, clampWorkflowMaxParallel, isCenterShowingDocument, selectActiveEnvPath } from "./sessionStoreHelpers.js";


/** True while a navigateBack/navigateForward reveal is running. openFileInIde
 *  and setIdeActiveFile record the outgoing location into the back stack on
 *  user-initiated navigation; a history-driven reveal must NOT record (the
 *  history actions manage both stacks themselves). Set/cleared synchronously
 *  around the openFileInIde call. */
let navHistoryRevealing = false;














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

/**
 * 【UI-039】每会话的补拉代次。同会话**新**一次 `resyncSessionMessages` 发起时自增;旧回包回来
 * 时代次不匹配 → **不得 commit**(否则断线重连时 A 旧请求迟到会把 B 新请求刚恢复的新消息
 * 覆盖回旧正文)。只挡"更老的补拉被更晚的覆盖",与 live delta / turn.done 的既有判据并存。
 */
const resyncGeneration = new Map<string, number>();

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
type PanePersistedField = "leftWidthPct" | "rightWidth" | "rightDock" | "paneLayout" | "bottomTerminalHeight" | "editorWidthPct";
let paneLayoutRevision = 0; // incremented for every local drag/reset/dock action
let initialPaneLayoutRevision = 0; // captured before first-paint and deferred settings reads
const paneLayoutLocalEdits = new Set<PanePersistedField>();
// Debounce reduces normal drag traffic; this single-flight writer additionally
// prevents a slow, older IPC write from completing *after* a newer layout
// save and putting the old dock/width back in settings on next boot.
const paneWidthWriter = createCoalescedPaneWriter(
  () => useSessionStore.getState(),
  (s: SessionState) => api.setting.set({
    key: UI_PANE_LAYOUT_SETTING_KEY,
    value: JSON.stringify({
      paneLayout: s.paneLayout,
      leftPct: s.leftWidthPct,
      right: s.rightWidth,
      dock: s.rightDock,
      bottomTerminal: s.bottomTerminalHeight,
      editor: s.editorWidthPct,
    }),
  }),
  (err) => {
    console.error("setting.set(paneWidths) failed:", err);
    // Docking and resizing are explicit user settings. Do not silently let
    // an apparently successful UI change revert on the next application boot.
    reportSettingSaveFailed(err);
  },
);
function schedulePaneWidthPersist(_get: () => SessionState, field: PanePersistedField): void {
  paneLayoutRevision++;
  paneLayoutLocalEdits.add(field);
  if (paneWidthPersistTimer) clearTimeout(paneWidthPersistTimer);
  paneWidthPersistTimer = setTimeout(() => {
    paneWidthPersistTimer = null;
    void paneWidthWriter.request();
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
  pushToast: (kind: "info" | "warning" | "error", title: string, body?: string, dedupeKey?: string) => void;
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
        // 【MC-002】只有**整轮都还原成功**(没有失败、没有冲突)才算"已撤销";否则是
        // **部分撤销** —— 卡片要如实区分,并把没动的那些文件名记下来。
        const failed = e.failedFiles ?? [];
        const conflicts = e.conflicts ?? [];
        const partial = failed.length > 0 || conflicts.length > 0;
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
              // 只有全部成功才清本轮桶;部分撤销时文件仍在盘上,桶要留着。
              if (b.isLatestTurn && !partial) rewoundLatest = true;
              if (partial) return { ...b, rewindPartial: { failed, conflicts } };
              // 【MC-002】整轮成功 —— 除了置 `rewound`,还要**清掉上一次遗留的
              // `rewindPartial`**:否则重试成功后卡片会同时画「部分撤销 N/M」与
              // 「已撤销」两个徽标(那个 stale 的 partial 是上一轮失败留下的)。
              return { ...b, rewound: true, rewindPartial: undefined };
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

/**
 * 会话 / 项目**行操作**(改名、归档、删除、置顶、分组)落库失败时报给用户。
 *
 * 为什么在 store 层就地收口(而不是逐个调用点补 `.catch`):这些动作的**桌面端调用点
 * 几乎全是裸 `void storeAction(...)`** —— `LeftBar` / `StreamSidebar` / `SideChatPanel` /
 * `SessionDirectoryChip` 都是。而主进程在"那行已不在 / zod 校验失败 / IO 失败"时会**抛**
 * (`session not found` / `project not found`),渲染端又**没有**全局 `unhandledrejection`
 * 监听:抛出去只落进 unhandled rejection —— 用户点了「删除」、那一行还在,屏幕上**一个字
 * 都没有**("点了没反应"那一类)。手机抽屉早就用 `reportActionFailure` 补了同一课
 * (见 `MobileSessionDrawer`),但桌面侧**每一个调用点**都补一遍既散、又必然漏
 * (`SessionDirectoryChip` 那两处就是明证)。这些动作只有一个实现,就在这里统一收口 ——
 * 与 `reportSettingSaveFailed` 同一条"用户显式做的操作落库失败要说出来"的规矩。
 *
 * **吞掉(而不是 rethrow)是有意的**:两个 `await renameSession(...)` 的调用点
 * (`LeftBar` / `StreamSidebar` 的 `RenameDialog.onSubmit`)只把 await 当"这次提交结束了",
 * 失败时若继续抛出,紧随其后的 `setRenaming(null)` 就不跑了 —— 对话框会卡在屏幕上。
 * 收口后它们照常闭合,并收到一条 toast(与手机侧行为一致)。(toastStore 按标题去重,
 * 连续失败不会刷屏。)
 */
function reportSessionOpFailed(err: unknown): void {
  useToastStore.getState().push({
    kind: "error",
    title: translate(useSessionStore.getState().locale, "store.toast.sessionOpFailed"),
    body: err instanceof Error ? err.message : String(err),
  });
}

/** 回答 Agent 提问 / 审批工具调用 / 审批计划 —— 三处把回执递给主进程失败。
 *
 *  三处都**故意不撤销卡片**(`submitQuestion` / `decideApproval` /
 *  `submitPlanApproval` 的注释都写了原因:留着让用户重试,别让他以为已经答了)。但
 *  从前失败只 `console.error`:用户点「提交」、卡片纹丝不动、屏幕上**一个字都没有**
 *  —— 渲染端没有全局 `unhandledrejection`,这跟"点了没反应"是同一类。卡片留着能重试
 *  是对的一半,另一半是**得说一句**。`title` 由调用方按卡片类型给(toastStore 按标题
 *  去重,同一张卡的连续重试不会刷屏)。 */
function reportInteractionFailed(titleKey: MessageId, err: unknown): void {
  useToastStore.getState().push({
    kind: "error",
    title: translate(useSessionStore.getState().locale, titleKey),
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
  // ─────────────── F 编辑器 / IDE ───────────────
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

  // ─────────────── A 会话与项目骨架 ───────────────
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
  // ─────────────── I 布局（纯 UI） ───────────────
  displayMode: "tabs",
  // Tab strips wrap onto multiple rows instead of horizontal scrolling.
  // Persisted under `ui.tabBarMultiRow`; init() overwrites from the DB.
  // Default false = the classic single scrolling row.
  tabBarMultiRow: false,
  // Left-bar view: classic project tree is the default; init() overwrites
  // from the persisted ui.leftBarMode preference.
  // ─────────────── J 应用级 UI 外壳 ───────────────
  leftBarMode: "tree",
  // UI theme style (orthogonal to light/dark). Default "classic"; init()
  // overwrites from the persisted ui.themeStyle preference.
  // ─────────────── K 设置镜像（落库偏好） ───────────────
  themeStyle: "classic",
  // Center focus for the unified tab bar (`tabs` displayMode). UI-only.
  // ─────────────── I 布局（纯 UI） ───────────────
  centerTabFocus: "chat",
  // UI language. Persisted in `settings` table; init() overwrites from the
  // DB. "zh" is the default (and the pre-i18n behavior) so existing users see
  // no change until they opt into English.
  // ─────────────── K 设置镜像（落库偏好） ───────────────
  locale: "zh",
  // Session auto-archive rules. Persisted as JSON in `settings`; initDeferred
  // hydrates. Disabled by default so existing users opt in.
  autoArchiveConfig: { ...DEFAULT_AUTO_ARCHIVE_CONFIG, overrides: {} },
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // "comfortable" so existing users see no change until they opt in.
  chatDensity: "comfortable",
  reduceMotion: "system",
  // 【ARC-005 V1】界面外壳偏好。默认 "classic" = 现有外观(默认值从 shellPrefs
  // 取,保证 store / 解析器 / smoke 看到的是同一份);init() 从 `ui.shell`
  // (设备本地键)覆盖。任何取值都不卸载工作区子树(见 ClassicShell)。
  shellPref: DEFAULT_SHELL_PREF,
  // Persisted in `settings` table; init() overwrites from the DB. Default
  // "flat" so existing users see no change until they opt into grouping.
  // ─────────────── A 会话与项目骨架 ───────────────
  projectView: "flat",
  // Per-group metadata (color + order). Empty until init() hydrates from the
  // `ui.projectGroups` JSON blob; groups not present here fall back to default
  // color and first-appearance order.
  groupMeta: {},
  // Persisted in `settings` table; init() overwrites from the DB. Defaults
  // mirror the CSS var defaults in styles.css (14px = text-sm).
  // ─────────────── K 设置镜像（落库偏好） ───────────────
  chatFontSize: 15,
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
  // ─────────────── B 会话内容（消息 / 回合） ───────────────
    messagesBySession: {},
    hasMoreMessagesBySession: {},
    loadingMessagesBySession: {},
    loadingOlderBySession: {},
    historyLoadedBySession: {},
  runningBySession: {},
  // ─────────────── L 引擎与模型 ───────────────
  engineCommandsByProvider: {},
  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  runningTurnStartedAt: {},
  waitingBranchesBySession: {},
  runningTurnModelBySession: {},
  turnErrorBySession: {},
  // Stream sidebar cache: empty + dirty so the first mount fetches.
  // ─────────────── A 会话与项目骨架 ───────────────
  streamSessions: [],
  streamHasMore: false,
  streamTotal: 0,
  streamDirty: true,
  // Stream scope filter: unfiltered until init() hydrates the persisted
  // ui.streamScope choice.
  streamScope: null,
  worktreeInfoByRepo: {},
  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  interruptedBySession: {},
  turnIncompleteBySession: {},
  upstreamIssueBySession: {},
  unreadBySession: {},
  // ─────────────── J 应用级 UI 外壳 ───────────────
  isWindowFocused: true,
  // ─────────────── L 引擎与模型 ───────────────
  providerHealthById: {},
  // ─────────────── J 应用级 UI 外壳 ───────────────
  settingsOpen: false,
  settingsSection: null,
  settingsFocusWorkflowId: null,
  // 【MC-045】主动导航请求的**修订号** —— 设置页已打开时再来一次
  // `setSettingsOpen(true, section)`,光看 `settingsSection` 分不清"新请求"
  // 与"上次打开遗留的旧值";修订号每次显式带 section 的调用 +1,设置页据此
  // 消费一次请求并把 `active` 切过去。关闭(=reset)时归零。
  settingsNavRevision: 0,
  modelConfigPromptOpen: false,
  modelGuardPulse: 0,
  commandPaletteOpen: false,
  // File search dialog (opened from the Files panel search button / Cmd+Shift+F
  // / command palette). Pure in-memory, mirrors commandPaletteOpen.
  searchDialogOpen: false,
  // Layout panel visibility — lifted from App.tsx useState. Right panel
  // starts hidden by default (the titlebar toggle / command palette reopens
  // it). NOT persisted.
  // ─────────────── I 布局（纯 UI） ───────────────
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
  // ─────────────── J 应用级 UI 外壳 ───────────────
  mobileViewer: null,
  // ─────────────── H 浏览器面板 ───────────────
  browserTabCount: 0,
  browserDeviceToolbarOpen: false,
  browserTabs: [],
  browserActiveTabId: null,
  pendingBrowserUrl: null,
  browserViewSuppressed: 0,
  // Draggable pane sizes. Persisted as one JSON blob (UI_PANE_WIDTHS_SETTING_KEY);
  // init() hydrates + clamps. These defaults match the original hardcoded
  // widths so the first-run layout is unchanged.
  // ─────────────── I 布局（纯 UI） ───────────────
  leftWidthPct: LEFT_WIDTH_PCT_DEFAULT,
  rightWidth: 360,
  rightDock: "right",
  paneLayout: DEFAULT_PANE_LAYOUT,
  bottomTerminalHeight: 280,
  editorWidthPct: 50,
  // ─────────────── L 引擎与模型 ───────────────
  permissionMode: "default",
  workflowId: "default",
    envChoice: "local",
  providerId: DEFAULT_PROVIDER_ID,
  model: "default",
  customModelId: null,
  lastModelByProvider: EMPTY_LAST_MODEL_BY_PROVIDER,
  customModels: EMPTY_CUSTOM_MODELS,
  customModelsStoreInvalid: false,
  providers: EMPTY_PROVIDERS,
  piAvailableModels: EMPTY_PI_MODELS,
  codexAvailableModels: EMPTY_CODEX_MODELS,
  skills: EMPTY_SKILLS,
  effort: "high",
  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  todosBySession: {},
  // ─────────────── C 待决交互（问答 / 审批 / 计划） ───────────────
  planBySession: {},
  planDrawerPlanBySession: {},
  planTabActiveBySession: {},
  planApprovalDraftBySession: {},
  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  subagentsBySession: {},
  subagentTranscriptsBySession: {},
  workflowNodeTranscripts: {},
  contextSnapshotBySession: {},
  usageHistoryBySession: {},
  // ─────────────── C 待决交互（问答 / 审批 / 计划） ───────────────
  pendingQuestionBySession: {},
  pendingApprovals: [],
  pendingPlanApprovalBySession: {},
  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  turnFilesBySession: {},
  bookmarksBySession: {},
  // ─────────────── D 撰写区（composer） ───────────────
  chatFileQueueBySession: {},
  chatElementQueueBySession: {},
  promptQueueBySession: {},
  composerDraftBySession: {},
  // Side chat (right-panel ask tab). Lists hydrate on demand per parent.
  // ─────────────── E 侧聊 / 子聊 ───────────────
  sideChatsByParent: {},
  activeSideChatId: null,
  sideChatSeedBySession: {},
  // ─────────────── D 撰写区（composer） ───────────────
  composerDraftTouchBySession: {},
  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  pendingSubagentView: null,
  pendingBookmarkJump: null,
  // IDE right-panel. Editor state is per-project (keyed by projectId);
  // init() hydrates from the settings table. rightPanelTab / ideEditorMode
  // are global user prefs.
  // ─────────────── I 布局（纯 UI） ───────────────
  rightPanelTab: "files",
  rightPanelTabSeq: 0,
  // ─────────────── M 项目级自定义命令 ───────────────
  customCommandsByProject: {},
  // ─────────────── F 编辑器 / IDE ───────────────
  ideOpenFilesByProject: {},
  ideFileDisplayNamesByProject: {},
  ideActiveFileByProject: {},
  ideFileViewModeByProject: {},
  ideEditorMode: "tabs",
  // ─────────────── G Git ───────────────
  gitDiffOpenMode: "center",
  gitDiffDialogTabs: [],
  gitDiffDialogActiveId: null,
  gitDiffDialogOpen: false,
  gitDiffDialogViewMode: "single",
  // ─────────────── F 编辑器 / IDE ───────────────
  ideExpandedDirsByProject: {},
  // ─────────────── G Git ───────────────
  gitDiffByProject: {},
  ideDiffBeforeByProject: {},
  commitGenModel: null,
  commitGenPrompt: "",
  conflictResolveModel: null,
  // ─────────────── K 设置镜像（落库偏好） ───────────────
  titleGenEnabled: false,
  titleGenModel: null,
  visionRelayModel: null,
  outputStyle: null,
  // ─────────────── G Git ───────────────
  collapsedGitRepos: {} as Record<string, boolean>,
  // ─────────────── F 编辑器 / IDE ───────────────
  ideFocusNonce: 0,
  ideTreeReveal: null,
  idePendingReveal: null,
  ideRevealNonce: 0,
  navBackByProject: {},
  navForwardByProject: {},
  lspLanguages: [] as LspLanguageState[],
  lspLoadError: null as string | null,
  // ─────────────── L 引擎与模型 ───────────────
  runtimes: [] as RuntimeAgentState[],
  // ─────────────── F 编辑器 / IDE ───────────────
  lspPhasesByWorkspace: {} as Record<string, { phase: "starting" | "running" | "stopped" | "importing"; error?: string; detail?: string }>,

  /** True once `init()` has started, to guard against React StrictMode's
   *  double-effect in dev (which would otherwise fire init twice). */
  // ─────────────── 0 生命周期（init） ───────────────
  _initStarted: false,

  init: async () => {
    // StrictMode guard: dev runs effects twice. The second call would re-fetch
    // everything and (worse) race with the first. Bail out silently.
    if (get()._initStarted) return;
    set({ _initStarted: true });
    // A user can resize/dock while deferred settings are still loading. Do not
    // apply an older saved layout over a newer local choice when that resolves.
    initialPaneLayoutRevision = paneLayoutRevision;
    paneLayoutLocalEdits.clear();

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
          UI_SHELL_SETTING_KEY,
          UI_PROJECT_VIEW_SETTING_KEY,
          UI_PROJECT_GROUPS_SETTING_KEY,
          UI_LAST_PROJECT_SETTING_KEY,
          UI_LAST_SESSION_SETTING_KEY,
          UI_STREAM_SCOPE_SETTING_KEY,
          UI_PANE_LAYOUT_SETTING_KEY,
          UI_PANE_WIDTHS_SETTING_KEY,
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

    // Pane docking and resize geometry affect the first visible workspace
    // frame and native browser placement. Restore them with the FIRST settings
    // batch, never after the pane/Monaco/Chromium tree has already mounted.
    const firstPaintLayout = parseSavedPaneLayout(fp[UI_PANE_WIDTHS_SETTING_KEY]);
    const canonicalPrefs = parseSavedPaneLayout(fp[UI_PANE_LAYOUT_SETTING_KEY]);
    const canonicalCorrupt = !!fp[UI_PANE_LAYOUT_SETTING_KEY] &&
      (!canonicalPrefs || !canonicalPrefs.paneLayout || !!canonicalPrefs.repaired?.length);
    const restoredPrefs = canonicalCorrupt ? { dock: "right" as const, paneLayout: DEFAULT_PANE_LAYOUT }
      : canonicalPrefs ?? firstPaintLayout;
    if (canonicalCorrupt) {
      // Corruption must be visible to the user; never use partial untrusted geometry.
      useToastStore.getState().push({
        kind: "warning",
        title: translate(get().locale, "store.toast.paneLayoutRepaired"),
      });
    }
    if (restoredPrefs) {
      const parsedLayout = canonicalCorrupt ? DEFAULT_PANE_LAYOUT :
        canonicalPrefs?.paneLayout ??
        movePane(DEFAULT_PANE_LAYOUT, "right", restoredPrefs.dock, 0);
      const patch: Partial<SessionState> = {
        rightDock: parsedLayout.placements.find(p => p.id === "right")?.side === "left" ? "left" : "right",
        paneLayout: parsedLayout,
        // Legacy two-way dock remains authoritative only when migrating once.
        ...(firstPaintLayout && !canonicalPrefs ? { rightDock: firstPaintLayout.dock } : {}),
      };
      if (restoredPrefs.leftPct !== undefined) {
        patch.leftWidthPct = clampLeftWidthPct(restoredPrefs.leftPct);
      }
      if (restoredPrefs.right !== undefined) {
        const leftPct = paneLayoutLocalEdits.has("leftWidthPct")
          ? get().leftWidthPct
          : restoredPrefs.leftPct ?? get().leftWidthPct;
        patch.rightWidth = clampRightWidth(
          restoredPrefs.right,
          centerRightRowWidth(get().leftOpen, leftPct),
        );
      }
      if (restoredPrefs.bottomTerminal !== undefined) {
        patch.bottomTerminalHeight = clampBottomTerminalHeight(restoredPrefs.bottomTerminal);
      }
      if (restoredPrefs.editor !== undefined) {
        patch.editorWidthPct = clampEditorWidthPct(restoredPrefs.editor);
      }
      const next = mayApplyPaneHydration(initialPaneLayoutRevision, paneLayoutRevision)
        ? patch
        : withoutLocallyEditedPaneFields(patch, paneLayoutLocalEdits);
      if (Object.keys(next).length > 0) set(next);
    } else if (fp[UI_PANE_WIDTHS_SETTING_KEY]) {
      // Do not echo corrupt setting contents (may include user-defined data).
      console.warn("apply(paneWidths): invalid saved layout ignored");
    }

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

    // 【ARC-005 M1】reduceMotion 在首帧前应用一次 —— 与 chatDensity 同一条流水线:
    // 读 settings 表、写 <html data-reduce-motion>。属性缺失 = 跟随系统。
    try {
      const rm = fp[UI_REDUCE_MOTION_SETTING_KEY];
      if (rm === "system" || rm === "on" || rm === "off") {
        set({ reduceMotion: rm });
      }
    } catch (err) {
      console.error("apply(reduceMotion) failed:", err);
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

    // 【ARC-005 V1】界面外壳偏好("classic" 默认 | "workspace")。与 chatDensity
    // 同一条首屏流水线;任何取值都不卸载工作区子树,所以这里只写 store。
    // 解析统一走 shellPrefs.parseShellPref(坏值回落默认,不炸)。
    try {
      const value = fp[UI_SHELL_SETTING_KEY];
      if (value != null) set({ shellPref: parseShellPref(value) });
    } catch (err) {
      console.error("apply(shellPref) failed:", err);
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
          UI_VISION_RELAY_MODEL_SETTING_KEY,
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
      const visionRelayModelRaw = ds[UI_VISION_RELAY_MODEL_SETTING_KEY];

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
      set({ visionRelayModel: visionRelayModelRaw || null });
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

  // ─────────────── A 会话与项目骨架 ───────────────
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
    // 【ARC-005 V2】切换会话时用 View Transition 做快照过渡（上游共享元素
    // 过渡的 Mcode 版）。只包**同步的 set** —— 历史加载在下面异步进行，
    // 不能进快照，否则会拍到"加载中"。不支持该 API / 减少动效时同步执行。
    withViewTransition(() => {
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
  // ─────────────── B 会话内容（消息 / 回合） ───────────────
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
  // ─────────────── A 会话与项目骨架 ───────────────
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
    try {
      await api.project.delete({ id });
    } catch (err) {
      console.error("project.delete failed:", err);
      reportSessionOpFailed(err);
      return;
    }
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

  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  resyncSessionMessages: async (sessionId) => {
    if (get().runningBySession[sessionId]) return;
    // 【UI-039】登记本次补拉的代次。同会话若已有更晚的补拉发起,那次会再自增 —— 本回包
    // commit 前要确认自己仍是**最新**代次,否则丢弃(不让旧历史覆盖刚恢复的新消息)。
    const generation = (resyncGeneration.get(sessionId) ?? 0) + 1;
    resyncGeneration.set(sessionId, generation);
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
      // 【UI-039】这段时间里同会话又发起了更晚的补拉 → 我这个回包已过时,丢弃。
      if (resyncGeneration.get(sessionId) !== generation) return s;
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
  // ─────────────── A 会话与项目骨架 ───────────────
  archiveProject: async (id, archived) => {
    let project: Project;
    try {
      ({ project } = await api.project.archive({ id, archived }));
    } catch (err) {
      console.error("project.archive failed:", err);
      reportSessionOpFailed(err);
      return;
    }
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
    try {
      await api.session.delete({ id });
    } catch (err) {
      console.error("session.delete failed:", err);
      reportSessionOpFailed(err);
      return;
    }
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
    let session: Session;
    try {
      ({ session } = await api.session.archive({ id, archived }));
    } catch (err) {
      console.error("session.archive failed:", err);
      reportSessionOpFailed(err);
      return;
    }
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
    let session: Session;
    try {
      ({ session } = await api.session.rename({ id, title }));
    } catch (err) {
      console.error("session.rename failed:", err);
      reportSessionOpFailed(err);
      return;
    }
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
    let session: Session;
    try {
      ({ session } = await api.session.pin({ id, pinned }));
    } catch (err) {
      console.error("session.pin failed:", err);
      reportSessionOpFailed(err);
      return;
    }
    // Pinning MOVES the row: out of the project's active window and into the
    // global pinned section above the project tree (unpinning moves it back).
    // The shared state builder also runs for the cross-client
    // `session.changed` echo, so this stays idempotent. streamDirty either
    // way — pin state decides which stream section (pinned block vs live
    // list) renders the row.
    set((s) => ({ ...applySessionPinnedState(s, session), streamDirty: true }));
  },

  // ─────────────── B 会话内容（消息 / 回合） ───────────────
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
    const pushToast = (kind: "info" | "warning" | "error", title: string, body?: string, dedupeKey?: string) => {
      if (isSideChatSession(sid, get())) return;
      if (isSessionChatOnScreen(sid, get())) return;
      if (!get().isWindowFocused) return;
      // 设置 → 消息通知:「前台时弹提示」/ 按项目静音 / 免打扰时段。
      const st = get();
      const projectId = Object.keys(st.sessionsByProject).find((pid) =>
        st.sessionsByProject[pid]?.some((x) => x.id === sid),
      );
      if (!inAppToastAllowed(projectId)) return;
      // 【UI-036】把稳定身份(dedupeKey=事件 id)透传下去,让**不同**审批各出一张,同事件重发才去重。
      useToastStore.getState().push({ kind, title, body, sessionId: sid, ...(dedupeKey !== undefined ? { dedupeKey } : {}) });
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

  // ─────────────── J 应用级 UI 外壳 ───────────────
  setSettingsOpen: (open, section, focusWorkflowId) => {
    set(
      open
        ? {
            settingsOpen: true,
            settingsSection: section ?? null,
            settingsFocusWorkflowId: focusWorkflowId ?? null,
            // 【MC-045】只对**带 section 的显式导航**递增 —— 普通的齿轮打开
            // (无 section)不该把用户从当前栏目弹回首页。设置页已打开时再来
            // 一次带 section 的调用(跨面板深链)也走这里,修订号变化 = 新请求。
            settingsNavRevision: section
              ? get().settingsNavRevision + 1
              : get().settingsNavRevision,
          }
        : { settingsOpen: false, settingsSection: null, settingsFocusWorkflowId: null, settingsNavRevision: 0 },
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
  // ─────────────── I 布局（纯 UI） ───────────────
  setLeftOpen: (open) => {
    // While wide-panel (3:7) mode is on the left sidebar must stay closed —
    // guard in the store so no caller/command can open it.
    if (open && get().widePanelOpen) return;
    set({ leftOpen: open });
  },
  setRightOpen: (open) => {
    const s = get();
    // A 0%-width pane may be reopened from the existing titlebar toggle.
    if (open && s.paneLayout.placements.find(p => p.id === "right")?.sizePct === 0) {
      set({ rightOpen: true, paneLayout: setPaneSizePct(s.paneLayout, "right", 30) });
      schedulePaneWidthPersist(get, "paneLayout");
    } else set({ rightOpen: open });
  },
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
  // ─────────────── H 浏览器面板 ───────────────
  setBrowserTabCount: (...args: Parameters<SessionState["setBrowserTabCount"]>) => useBrowserStore.getState().setBrowserTabCount(...args),
  setBrowserDeviceToolbarOpen: (...args: Parameters<SessionState["setBrowserDeviceToolbarOpen"]>) => useBrowserStore.getState().setBrowserDeviceToolbarOpen(...args),
  suppressBrowserView: (...args: Parameters<SessionState["suppressBrowserView"]>) => useBrowserStore.getState().suppressBrowserView(...args),
  setBrowserTabs: (...args: Parameters<SessionState["setBrowserTabs"]>) => useBrowserStore.getState().setBrowserTabs(...args),
  setBrowserActiveTabId: (...args: Parameters<SessionState["setBrowserActiveTabId"]>) => useBrowserStore.getState().setBrowserActiveTabId(...args),
  addBrowserTab: (...args: Parameters<SessionState["addBrowserTab"]>) => useBrowserStore.getState().addBrowserTab(...args),
  removeBrowserTab: (...args: Parameters<SessionState["removeBrowserTab"]>) => useBrowserStore.getState().removeBrowserTab(...args),
  patchBrowserTab: (...args: Parameters<SessionState["patchBrowserTab"]>) => useBrowserStore.getState().patchBrowserTab(...args),
  openUrlInBrowser: (...args: Parameters<SessionState["openUrlInBrowser"]>) => useBrowserStore.getState().openUrlInBrowser(...args),
  adoptAgentBrowserTab: (...args: Parameters<SessionState["adoptAgentBrowserTab"]>) => useBrowserStore.getState().adoptAgentBrowserTab(...args),

  // ── Draggable pane sizes ──
  // adjust* apply an incremental delta (from the drag handle) to the current
  // value, clamp, and set synchronously (instant UI). The DB write is
  // debounced so a drag (many mousemove events) only hits the settings table
  // once after the user stops. reset* restore the defaults (double-click).
  // ─────────────── I 布局（纯 UI） ───────────────
  adjustLeftWidthPct: (deltaPct) => {
    // The divider sits to the RIGHT of the sidebar, so dragging it right
    // (delta>0) widens the sidebar — no sign flip (unlike the right-bar /
    // bottom-terminal dividers). delta is already in percentage points; the
    // caller converted px via the container width.
    const next = clampLeftWidthPct(get().leftWidthPct + deltaPct);
    set({ leftWidthPct: next });
    schedulePaneWidthPersist(get, "leftWidthPct");
  },
  setRightDock: (dock) => {
    const side = parsePaneDock(dock);
    if (get().rightDock === side && get().paneLayout.placements.find(p => p.id === "right")?.side === side) return;
    set({ rightDock: side, paneLayout: moveHostedPane(get().paneLayout, side, 0) });
    paneLayoutLocalEdits.add("paneLayout");
    schedulePaneWidthPersist(get, "rightDock");
  },
  moveLayoutPane: (id, side, order) => {
    const next = id === "right" ? moveHostedPane(get().paneLayout, side, order)
      : movePane(get().paneLayout, id, side, order);
    const rightSide = next.placements.find(p => p.id === "right")?.side;
    set({ paneLayout: next, rightDock: rightSide === "left" ? "left" : "right" });
    paneLayoutLocalEdits.add("rightDock");
    schedulePaneWidthPersist(get, "paneLayout");
  },
  setLayoutPaneContent: (id, content) => {
    const next = id === "right" ? withHostedPaneContent(get().paneLayout, content)
      : withPaneContent(get().paneLayout, id, content);
    set({ paneLayout: next });
    schedulePaneWidthPersist(get, "paneLayout");
  },
  setPaneRightSizePct: (pct, containerWidth, persist = true) => {
    if (!Number.isFinite(pct) || !Number.isFinite(containerWidth) || containerWidth <= 0) return;
    const s = get();
    const paneLayout = setPaneSizePct(s.paneLayout, "right", pct);
    const width = clampRightWidth(pct * containerWidth / 100,
      centerRightRowWidth(s.leftOpen, s.leftWidthPct));
    set({ paneLayout, rightWidth: width });
    // Protect live pointer edits from an earlier deferred hydration too.
    paneLayoutLocalEdits.add("paneLayout");
    paneLayoutLocalEdits.add("rightWidth");
    // Live drag updates are synchronous but are not saved until pointerup.
    if (persist) {
      schedulePaneWidthPersist(get, "paneLayout");
    }
  },
  applyPaneLayoutPreset: (preset) => {
    if (get().widePanelOpen) get().setWidePanelOpen(false);
    const base = preset === "default" ? DEFAULT_PANE_LAYOUT : LAYOUT_PRESETS[preset];
    const currentContent = hostedPaneContent(get().paneLayout);
    const paneLayout = currentContent?.kind === "flow" || currentContent?.kind === "document"
      ? withHostedPaneContent(clampLayout(copyPaneLayout(base)), currentContent)
      : clampLayout(copyPaneLayout(base));
    const leftPct = paneLayout.placements.find(p => p.id === "left")?.sizePct ?? 0;
    const rightPct = paneLayout.placements.find(p => p.id === "right")?.sizePct ?? 30;
    const leftOpen = leftPct > 0;
    set({
      paneLayout, rightDock: "right", rightOpen: true, leftOpen,
      leftWidthPct: leftPct,
      rightWidth: clampRightWidth(
        centerRightRowWidth(leftOpen, leftPct) * rightPct / 100,
        centerRightRowWidth(leftOpen, leftPct),
      ),
    });
    paneLayoutLocalEdits.add("rightWidth");
    paneLayoutLocalEdits.add("rightDock");
    paneLayoutLocalEdits.add("leftWidthPct");
    schedulePaneWidthPersist(get, "paneLayout");
  },
  adjustRightWidth: (deltaPx) => {
    const s = get();
    const next = clampRightWidth(
      s.rightWidth - deltaPx,
      centerRightRowWidth(s.leftOpen, s.leftWidthPct),
    );
    set({ rightWidth: next });
    schedulePaneWidthPersist(get, "rightWidth");
  },
  setRightWidthPx: (px) => {
    // 【T02】双击 50/50 吸附：直接设定，不经 delta。
    // `clampRightWidth` 仍然生效（它守的是 min 240 / max 80% 分享），
    // 这里只是绕开「delta → dockResizeDelta → -deltaPx」这条会双重取反的链路。
    const s = get();
    const next = clampRightWidth(px, centerRightRowWidth(s.leftOpen, s.leftWidthPct));
    set({ rightWidth: next });
    schedulePaneWidthPersist(get, "rightWidth");
  },
  adjustBottomTerminalHeight: (deltaPx) => {
    // Divider sits on TOP of the terminal. Dragging the handle DOWN (delta>0)
    // pushes it toward the terminal, so the terminal SHRINKS — same sign flip
    // as the right-bar divider. Drag UP (delta<0) to grow it.
    const next = clampBottomTerminalHeight(get().bottomTerminalHeight - deltaPx);
    set({ bottomTerminalHeight: next });
    schedulePaneWidthPersist(get, "bottomTerminalHeight");
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
    schedulePaneWidthPersist(get, "editorWidthPct");
  },
  resetLeftWidthPct: () => {
    set({ leftWidthPct: LEFT_WIDTH_PCT_DEFAULT });
    schedulePaneWidthPersist(get, "leftWidthPct");
  },
  resetRightWidth: () => {
    set({ rightWidth: 360 });
    schedulePaneWidthPersist(get, "rightWidth");
  },
  resetBottomTerminalHeight: () => {
    set({ bottomTerminalHeight: 280 });
    schedulePaneWidthPersist(get, "bottomTerminalHeight");
  },
  resetEditorWidthPct: () => {
    set({ editorWidthPct: 50 });
    schedulePaneWidthPersist(get, "editorWidthPct");
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

  // ─────────────── J 应用级 UI 外壳 ───────────────
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

  // ─────────────── K 设置镜像（落库偏好） ───────────────
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

  // ─────────────── A 会话与项目骨架 ───────────────
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
  // ─────────────── I 布局（纯 UI） ───────────────
  setCenterTabFocus: (focus) => {
    set({ centerTabFocus: focus });
  },

  /** Update the UI language. Same immediate-flip + fire-and-forget-persist
   *  pattern as setDisplayMode. Also mirrors the choice onto
   *  <html lang> so assistive tech + font selection follow the UI language.
   *
   *  【MC-026 复核·外观即时生效】落盘失败要**把界面语言退回去**：从前失败只弹
   *  toast，整页文案已经换成新语言、用户以为改好了，重启才静默弹回 —— 与字号
   *  那两个 setter 同一条"看起来成功"的失败。只回滚自己那次写的值。 */
  // ─────────────── K 设置镜像（落库偏好） ───────────────
  setLocale: async (locale) => {
    const previous = get().locale;
    set({ locale });
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    try {
      await api.setting.set({ key: UI_LOCALE_SETTING_KEY, value: locale });
    } catch (err) {
      console.error("setting.set(locale) failed:", err);
      if (get().locale === locale) {
        set({ locale: previous });
        document.documentElement.lang = previous === "en" ? "en" : "zh-CN";
      }
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
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
    }
  },

  /** 【ARC-005 M1】更新减弱动效偏好。与 setChatDensity 同一条
   *  immediate-flip + fire-and-forget-persist 流水线;属性由 useChatAppearance 应用。 */
  setReduceMotion: async (mode) => {
    set({ reduceMotion: mode });
    try {
      await api.setting.set({ key: UI_REDUCE_MOTION_SETTING_KEY, value: mode });
    } catch (err) {
      console.error("setting.set(reduceMotion) failed:", err);
      reportSettingSaveFailed(err);
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

  /** 【ARC-005 V1】切换界面外壳偏好。Same immediate-flip + fire-and-forget-persist
   *  pattern as setDisplayMode;App 订阅 `shellPref` 决定渲染 ClassicShell 还是
   *  (未来的)WorkspaceShell。写的是设备本地键 `ui.shell`(见 settingsSync)。 */
  setShellPref: async (pref) => {
    set({ shellPref: pref });
    try {
      await api.setting.set({ key: UI_SHELL_SETTING_KEY, value: pref });
    } catch (err) {
      console.error("setting.set(shellPref) failed:", err);
      reportSettingSaveFailed(err);
    }
  },

  /** Toggle the left-bar project view between flat and grouped. Same
   *  immediate-flip + fire-and-forget-persist pattern as setDisplayMode. */
  // ─────────────── A 会话与项目骨架 ───────────────
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
    let project: Project;
    try {
      ({ project } = await api.project.setGroup({ id, group }));
    } catch (err) {
      console.error("project.setGroup failed:", err);
      reportSessionOpFailed(err);
      return;
    }
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
  },

  /** Rename a project (display-only). The returned project replaces the
   *  stale copy in state — every consumer (left bar, archive bin, settings
   *  project pickers) reads the same `projects` array and follows along. */
  renameProject: async (id, name) => {
    let project: Project;
    try {
      ({ project } = await api.project.rename({ id, name }));
    } catch (err) {
      console.error("project.rename failed:", err);
      reportSessionOpFailed(err);
      return;
    }
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? project : p)) }));
  },

  /** Pin/unpin a project. The row's POSITION changes (pinned section vs
   *  flat list / group), and the authoritative ordering lives in the DB's
   *  list query — rather than hand-maintaining that order in the renderer,
   *  refetch the whole (small) list after the write. */
  setProjectPinned: async (id, pinned) => {
    try {
      await api.project.setPinned({ id, pinned });
      const { projects } = await api.project.list();
      set({ projects });
    } catch (err) {
      console.error("project.setPinned failed:", err);
      reportSessionOpFailed(err);
    }
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
      useToastStore.getState().push({
        kind: "error",
        title: translate(useSessionStore.getState().locale, "layout.projectReorderFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
      try {
        const { projects } = await api.project.list();
        set({ projects });
      } catch {
        // 连重读都失败:保持乐观顺序(总比清空强),让下一条 projects.changed 收口。
      }
    }
  },

  // ─────────────── K 设置镜像（落库偏好） ───────────────
  setChatFontSize: async (px) => {
    const clamped = clampFontSize(px);
    // 【MC-026 复核·外观即时生效】乐观改 + 落盘；**落盘失败要把界面退回真实值**。
    // 从前失败只弹 toast：字号已经按新值渲染，用户以为改好了，重启才静默弹回 ——
    // 正是"看起来成功"的那种失败。回滚只回**自己那次**写的值（若另一次更新的
    // 写入已经落地，别把新值也一起冲掉）。
    const previous = get().chatFontSize;
    set({ chatFontSize: clamped });
    try {
      await api.setting.set({
        key: UI_CHAT_FONT_SIZE_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(chatFontSize) failed:", err);
      if (get().chatFontSize === clamped) set({ chatFontSize: previous });
      reportSettingSaveFailed(err);
    }
  },

  setRightPanelFontSize: async (px) => {
    const clamped = clampRightPanelFontSize(px);
    // 同 setChatFontSize：失败回滚到这次写入前的值（不覆盖更新的成功写入）。
    const previous = get().rightPanelFontSize;
    set({ rightPanelFontSize: clamped });
    try {
      await api.setting.set({
        key: UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY,
        value: String(clamped),
      });
    } catch (err) {
      console.error("setting.set(rightPanelFontSize) failed:", err);
      if (get().rightPanelFontSize === clamped) set({ rightPanelFontSize: previous });
      reportSettingSaveFailed(err);
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
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
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
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
    }
  },

  setVoiceLang: async (lang) => {
    set({ voiceLang: lang });
    try {
      await api.setting.set({ key: UI_VOICE_LANG_SETTING_KEY, value: lang });
    } catch (err) {
      console.error("setting.set(voiceLang) failed:", err);
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
    }
  },

  setVoiceEngine: async (engine) => {
    set({ voiceEngine: engine });
    try {
      await api.setting.set({ key: UI_VOICE_ENGINE_SETTING_KEY, value: engine });
    } catch (err) {
      console.error("setting.set(voiceEngine) failed:", err);
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
    }
  },

  setVoiceMicPermission: async (perm) => {
    set({ voiceMicPermission: perm });
    try {
      await api.setting.set({ key: UI_VOICE_MIC_PERMISSION_SETTING_KEY, value: perm });
    } catch (err) {
      console.error("setting.set(voiceMicPermission) failed:", err);
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
    }
  },

  setVoiceModelDir: async (dir) => {
    set({ voiceModelDir: dir });
    try {
      await api.setting.set({ key: UI_VOICE_MODEL_DIR_SETTING_KEY, value: dir });
    } catch (err) {
      console.error("setting.set(voiceModelDir) failed:", err);
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
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
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
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
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
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
      reportSettingSaveFailed(err);
      reportSettingSaveFailed(err);
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
  // ─────────────── L 引擎与模型 ───────────────
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

  /** 重新读自定义模型清单。**返回失败原因(null = 成功)** —— 设置面板据此把"读失败"
   *  与"还没有配置"分开显示,并把主进程给的原因原样摆到界面上(【MC-026 复核】从前失败
   *  只 console,面板画成空列表 + 让用户照着重建设置)。返回值只加不改:现有调用方忽略
   *  返回值,行为不变。 */
  reloadCustomModels: async (): Promise<string | null> => {
    try {
      const { models, storeInvalid } = await api.customModel.list();
      set({ customModels: models, customModelsStoreInvalid: storeInvalid });
      // A persisted composer pick whose custom config was deleted falls back
      // to auto.
      validateComposerSelection(set, get);
      return null;
    } catch (err) {
      console.error("reloadCustomModels failed:", err);
      return err instanceof Error ? err.message : String(err);
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

  // ─────────────── F 编辑器 / IDE ───────────────
  reloadLspLanguages: async () => {
    try {
      const { languages } = await api.lsp.list();
      // 清错误与写列表放在同一次 set 里:成功即恢复,面板的「加载失败」横幅随
      // 之消失(重试路径就靠这一句)。
      set({ lspLanguages: languages, lspLoadError: null });
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
      // **失败要说出来。** 从前这里只 console.error:面板空列表 → 永远转
      // 「加载 LSP 状态…」,用户分不清"在读"与"坏了"。错误进 store,面板渲染
      // 错误横幅 + 重试;上一次成功的列表保留(一次瞬时失败不抹掉它)。
      console.error("reloadLspLanguages failed:", err);
      set({ lspLoadError: err instanceof Error ? err.message : String(err) });
    }
  },

  // ─────────────── L 引擎与模型 ───────────────
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

  // ─────────────── F 编辑器 / IDE ───────────────
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

  // ─────────────── L 引擎与模型 ───────────────
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

  // ─────────────── C 待决交互（问答 / 审批 / 计划） ───────────────
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
          // 卡片下面就被收掉了 —— 回执没送到的话,用户能重试的入口一起没了、模型还在等。
          reportInteractionFailed("store.toast.questionDismissFailed", err);
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
      reportInteractionFailed("store.toast.questionReplyFailed", err);
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
    let receipt: { status?: string; requestId?: string } | undefined;
    try {
      receipt = await api.claude.approve({ sessionId, requestId, granted, always });
    } catch (err) {
      // Don't shift on failure; the card stays so the user can retry. But say so
      // — a click that leaves the queue untouched and prints nothing reads as a
      // dead button (there is no global unhandledrejection handler here).
      reportInteractionFailed("store.toast.approvalFailed", err);
      return;
    }
    // 【UI-035】只有主进程**确实 resolved** 了那个 Deferred(accepted)才清卡。从前任何正常
    // resolve 都清卡 —— 审批已过期/已被另一设备响应时(`not_found`),主进程其实没受理,界面却
    // 消去卡片,像本次确认成功了。stale 时保留卡片并提示原因,由用户重新决策或刷新。
    // 兼容旧/桩返回 `undefined`(视作已受理,保持既有行为),只对**明确的**非 accepted 回执拦截。
    if (receipt !== undefined && receipt.status !== "accepted") {
      reportInteractionFailed("store.toast.approvalExpired", new Error(String(receipt.status)));
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
      const receipt = await api.claude.respondPlanApproval({ sessionId, requestId, approved, editedPlan, reason, feedback });
      // 【UI-035】计划审批也只有主进程**确实 resolved** 才清卡与草稿 —— 过期/已被响应时
      // 保留待审卡与编辑草稿(不因过期无声销毁用户的编辑稿),并提示原因。
      // 兼容旧/桩返回 `undefined`(视作已受理),只对**明确的**非 accepted 回执拦截。
      if (receipt !== undefined && receipt.status !== "accepted") {
        reportInteractionFailed("store.toast.approvalExpired", new Error(String(receipt.status)));
        return;
      }
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
      reportInteractionFailed("store.toast.planApprovalFailed", err);
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
  // ─────────────── J 应用级 UI 外壳 ───────────────
  openMobileViewer: (target) => {
    set({ mobileViewer: target });
  },
  closeMobileViewer: () => {
    set({ mobileViewer: null });
  },
  // ─────────────── C 待决交互（问答 / 审批 / 计划） ───────────────
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

  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  rewindTurn: async (files, targetFiles) => {
    const sessionId = get().activeSessionId;
    // 【MC-002】没有会话 = 没法撤销,**不是**"撤销了 0 个文件"。空结果会让卡片画
    // 「已撤销 ✓」。把目标文件全列进 failed,让"什么都没做"如实可见。
    if (!sessionId) return { restored: [], failed: files.map((f) => f.filePath), conflicts: [], unrestorable: [] };
    if (files.length === 0) {
      // Nothing to rewind — defensive (UI shouldn't allow the click).
      return { restored: [], failed: [], conflicts: [], unrestorable: [] };
    }
    try {
      const res = await api.claude.rewindTurn({ sessionId, files, targetFiles });
      // Don't optimistically clear turnFiles — wait for the `turn.rewound`
      // event from main so the UI only updates when files are actually
      // back on disk. The `failed` list is surfaced by the caller (card)
      // so a partial rewind is never shown as if it were whole.
      return res;
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

  // ─────────────── F 编辑器 / IDE ───────────────
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

  // ─────────────── L 引擎与模型 ───────────────
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

  // ─────────────── D 撰写区（composer） ───────────────
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

  // ─────────────── I 布局（纯 UI） ───────────────
  setRightPanelTab: (tab) => {
    set((s) => ({ rightPanelTab: tab, rightPanelTabSeq: s.rightPanelTabSeq + 1 }));
    void api.setting.set({ key: UI_RIGHT_PANEL_TAB_SETTING_KEY, value: tab }).catch((err) => {
      console.error("setting.set(rightPanelTab) failed:", err);
    });
  },

  // ─────────────── E 侧聊 / 子聊 ───────────────
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

  // ─────────────── B 会话内容（消息 / 回合） ───────────────
  openSubagentTranscript: (sessionId, taskId) => {
    set({ pendingSubagentView: { sessionId, taskId }, rightOpen: true });
    // `tasks`（2026-10-10）：原生子代理的展开视图现在住在「任务列表」页
    // （`ide/TaskListPanel`）—— 和终端、工作流节点同一页。2026-09-21 到 2026-10-10
    // 之间它落在 `flow`，因为当时长在 `SideChatPanel` 里；那一页现在只管对话。
    get().setRightPanelTab("tasks");
  },

  clearPendingSubagentView: () => {
    set({ pendingSubagentView: null });
  },

  clearFinishedSubagents: () => {
    // 每个会话**各自**处理：有的会话那一格可能已经空了（`deleteSession` 那条路会把整个键删掉），
    // 所以不能假设 `subagentsBySession[sid]` 一直都在。
    set((s) => {
      const next: typeof s.subagentsBySession = {};
      let touched = false;
      for (const [sid, list] of Object.entries(s.subagentsBySession)) {
        const kept = (list ?? []).filter((a) => a && a.status === "running");
        // 全清空了就把这个键收掉，不留一个空数组（与 `deleteSession` 那边的口径一致）。
        if (kept.length > 0) next[sid] = kept;
        if (kept.length !== (list ?? []).length) touched = true;
      }
      return touched ? { subagentsBySession: next } : {};
    });
  },

  stopSubagent: async (sessionId, taskId) => {
    const { locale } = get();
    try {
      const { stopped } = await api.claude.stopTask({ sessionId, taskId });
      // **没停成不是错误**（已经跑完了 / 这个引擎没这个能力 / 这一轮已收尾）——
      // 用 info 而不是 error：弹一条红字会把"它刚好跑完了"说成"出错了"。
      if (!stopped) {
        useToastStore.getState().push({
          kind: "info",
          title: translate(locale, "store.toast.stopSubagentNoop"),
        });
      }
      // 停成了**不在这里改名册** —— 引擎会发 `task_notification`，
      // `subagent.update` 把状态改成 `killed`，由那条事件走同一份既有通路。
      // 自己抢先改一次会让"谁说了算"出现两处。
    } catch (err) {
      useToastStore.getState().push({
        kind: "error",
        title: translate(locale, "store.toast.stopSubagentFailed"),
        body: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setPendingBookmarkJump: (jump) => {
    set({ pendingBookmarkJump: jump });
  },

  clearPendingBookmarkJump: () => {
    set({ pendingBookmarkJump: null });
  },

  // ─────────────── M 项目级自定义命令 ───────────────
  setCustomCommandsByProject: (...args: Parameters<SessionState["setCustomCommandsByProject"]>) => useCustomCommandsStore.getState().setCustomCommandsByProject(...args),

  addCustomCommand: (...args: Parameters<SessionState["addCustomCommand"]>) => useCustomCommandsStore.getState().addCustomCommand(...args),

  updateCustomCommand: (...args: Parameters<SessionState["updateCustomCommand"]>) => useCustomCommandsStore.getState().updateCustomCommand(...args),

  removeCustomCommand: (...args: Parameters<SessionState["removeCustomCommand"]>) => useCustomCommandsStore.getState().removeCustomCommand(...args),

  // ─────────────── F 编辑器 / IDE ───────────────
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

  // ─────────────── G Git ───────────────
  setGitDiffOpenMode: (...args: Parameters<SessionState["setGitDiffOpenMode"]>) => useGitStore.getState().setGitDiffOpenMode(...args),

  openGitDiffDialogTab: (...args: Parameters<SessionState["openGitDiffDialogTab"]>) => useGitStore.getState().openGitDiffDialogTab(...args),

  closeGitDiffDialogTab: (...args: Parameters<SessionState["closeGitDiffDialogTab"]>) => useGitStore.getState().closeGitDiffDialogTab(...args),

  setGitDiffDialogActive: (...args: Parameters<SessionState["setGitDiffDialogActive"]>) => useGitStore.getState().setGitDiffDialogActive(...args),

  setGitDiffDialogOpen: (...args: Parameters<SessionState["setGitDiffDialogOpen"]>) => useGitStore.getState().setGitDiffDialogOpen(...args),

  setGitDiffDialogViewMode: (...args: Parameters<SessionState["setGitDiffDialogViewMode"]>) => useGitStore.getState().setGitDiffDialogViewMode(...args),

  // ─────────────── F 编辑器 / IDE ───────────────
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

  // ─────────────── G Git ───────────────
  setGitDiffBefore: (...args: Parameters<SessionState["setGitDiffBefore"]>) => useGitStore.getState().setGitDiffBefore(...args),

  setGitDiffPair: (...args: Parameters<SessionState["setGitDiffPair"]>) => useGitStore.getState().setGitDiffPair(...args),

  clearGitDiffBefore: (...args: Parameters<SessionState["clearGitDiffBefore"]>) => useGitStore.getState().clearGitDiffBefore(...args),

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

  // ─────────────── K 设置镜像（落库偏好） ───────────────
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

  setVisionRelayModel: (modelId) => {
    set({ visionRelayModel: modelId });
    void api.setting
      .set({ key: UI_VISION_RELAY_MODEL_SETTING_KEY, value: modelId ?? "" })
      .catch((err) => console.error("setting.set(visionRelayModel) failed:", err));
  },

  setOutputStyle: (style) => {
    set({ outputStyle: style });
    void api.setting
      .set({ key: AGENT_OUTPUT_STYLE_SETTING_KEY, value: style ?? "" })
      .catch((err) => console.error("setting.set(outputStyle) failed:", err));
  },

  // ─────────────── G Git ───────────────
  toggleCollapsedGitRepo: (...args: Parameters<SessionState["toggleCollapsedGitRepo"]>) => useGitStore.getState().toggleCollapsedGitRepo(...args),
}));

connectSessionStoreDomains(useSessionStore);

// Stable empty arrays (e.g. EMPTY_MESSAGES, EMPTY_TODOS) are exported
// directly at their declaration site (see the "Stable empty arrays" block
// above) so they can be imported individually without a re-export step.
