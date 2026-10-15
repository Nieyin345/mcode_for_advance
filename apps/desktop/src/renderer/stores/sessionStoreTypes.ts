/**
 * `sessionStore` 的**类型层** —— 从 `sessionStore.ts` 整块搬出（2026-10-15）。
 *
 * ## 为什么单独一个文件
 *
 * 这些接口在 `sessionStore.ts` 里占 **约 2050 行（22%）**，其中 `SessionState`
 * 自己一段就 1688 行。它们是**纯类型、零运行时**，与下面 6061 行的 action 实现
 * 没有结构关系 —— 读「store 里有什么」不该先翻过两千行接口。
 *
 * ## 为什么不是「按域拆 store」
 *
 * 见 `docs/design/sessionStore-领域划界.md`：164 个 state 字段**全部**被外部文件
 * 引用（`model` 被 87 个文件读），拆成多个 store 会制造 164 个跨 store import。
 * 而 state 字面量只占 1.7%。**该搬的是类型，不是 state。**
 *
 * ## 消费者不受影响
 *
 * `sessionStore.ts` 用 `export type { ... } from "./sessionStoreTypes.js"` 转发，
 * 所以从 `@renderer/stores/sessionStore.js` import 类型的那 144 个文件一行不用改。
 */

import { Accelerator, AutoArchiveConfig, BrowserDevicePreset, BrowserOrientation, ChatDensity, CustomCommand, DisplayMode, FileViewMode, GestureSequence, GestureSettings, GitDiffOpenMode, GitWorktreeInfo, IdeEditorMode, LeftBarMode, LspLanguageState, PickedElement, ProjectGroupsMeta, ProjectView, ProviderHealthStatusCode, ProviderInfo, RightPanelTab, RuntimeAgentState, RuntimeProgressPayload, ShortcutBindings, SkillInfo, VoiceEngine } from "@contracts/ipc";
import { ApprovalRequestEvent, AskUserQuestionItem, ContextSnapshot, EffortLevel, EngineCommandInfo, NodeArtifact, NodeExecutionRecord, PermissionMode, PlanApprovalRequestEvent, PlanUpdateEvent, RuntimeEvent, SubagentSnapshot, TranscriptBlock, TurnUsageRecord, WorkflowChoiceOption, WorkflowNodeResultEvent } from "@contracts/runtime";
import { AttachmentKind, ContentTag } from "@renderer/lib/contentTag.js";
import { BuiltinModelOption, UserInputAnswers } from "@contracts/provider";
import { CustomModelPublic } from "@contracts/customModel";
import { EditorThemeChoice, EditorThemeId } from "@renderer/lib/editorThemes.js";
import { IdeCloseResult } from "@renderer/lib/ideDirty.js";
import { NavEntry } from "@renderer/lib/editorNav.js";
import { Project, Session, SessionBookmark } from "@contracts/session";
import { ThemeStyle } from "@contracts/theme";
import { TurnFileEntry } from "@renderer/lib/turnFiles.js";

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
  /** 【UI-014】上一次导航/返回/刷新被业务层**明确拒绝**的原因。`{ok:false}` 时置上,
   *  成功导航时清空 —— 地址栏据此显示可读错误,不再"先改 URL、失败后什么都不说"。 */
  navError?: string;
}

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
  | { kind: "attachment"; preview: string; content: string; attachmentKind?: AttachmentKind; filePath?: string }
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
      /** 【MC-002】撤销**部分**完成时带失败的/冲突的文件名 —— 有它就不算"整轮已撤销"。
       *
       *  从前只要收到 `turn.rewound` 且路径集匹配,就把卡片标成 `rewound: true`(画
       *  「已撤销」)、并在是最近一轮时**清空本轮文件桶** —— 哪怕主进程报告有文件没还原
       *  或有冲突没动。那是在对用户说"整轮回滚了",而磁盘上只有一部分回去(破坏性动作,
       *  他不会再去核)。现在:只有 `failed`/`conflicts` 都为空才走 `rewound`;否则记下
       *  这些文件名,卡片渲染成"部分撤销"、**保留撤销入口**(让用户能重试),且**不清**
       *  本轮文件桶(那些文件还在磁盘上,不是"本轮已结束")。 */
      rewindPartial?: { failed: string[]; conflicts: string[] };
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
  attachmentKind?: AttachmentKind;
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
  /** 加密密钥表（`customModelKeys`）读出过损坏内容。
   *
   *  为真时 {@link customModels} 会**显得比实际少**（读不出来的当没有），所以
   *  设置页要显示"密钥表损坏"——否则用户会以为自己的配置凭空消失了。
   *  main 侧算好下发（`customModel.list` 的 `storeInvalid`），渲染端不自己判断。 */
  customModelsStoreInvalid: boolean;
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
  /** 视觉中继模型（报告 D10 / Q1）：会话背后的模型没有视觉输入时，图片交给这个
   *  用户挑定的、有视觉的模型转述成文字。取值形状与 {@link titleGenModel} 完全
   *  一致（`"@claude"` / `"@claude:<别名>"` / `"configId:modelId"`）；null = 未配置
   *  → 能力不生效。Persisted in the settings table. */
  visionRelayModel: string | null;
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
    attachments?: { preview: string; content: string; attachmentKind?: AttachmentKind; filePath?: string }[],
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
    attachments?: { preview: string; content: string; attachmentKind?: AttachmentKind; filePath?: string }[],
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
  rewindTurn: (files: TurnFileEntry[], targetFiles: string[]) => Promise<{ restored: string[]; failed: string[]; conflicts: string[] }>;

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
  /**
   * 把**已结束**的子代理从名册里清掉（`running` 的一律留着）。
   *
   * 从 2026-10-10 起右栏「任务列表」页把跑完的子代理也列出来（可回看转录），
   * 而主进程那边**刻意按会话保留**它们（见 `RuntimeManager` 的 `rt.lastSubagents`）——
   * 跑到第 N 轮时那份名册里可能堆着几十条很早以前的。这个动作给用户一个"收掉"的出口。
   *
   * ⚠️ **只动渲染端的内存副本，不写库、也不通知主进程。** 下一次 `subagent.update`
   * （主进程重播整份名册，或新的一轮）会把它们**再带回来** —— 这是刻意的取舍：
   * 真去改主进程的持久化语义是另一件事（那一份还喂着聊天流的活动区），
   * 而这个按钮解决的是"列表里堆着几十条看不见的旧记录"这个眼前的观感问题。
   * 按钮的 tooltip 会说清楚这一点，不让用户以为它永久删了什么。
   */
  clearFinishedSubagents: () => void;
  /**
   * 停掉某一个正在跑的子代理（右栏「任务列表」页那一行的停止按钮）。
   *
   * 与 `interrupt` 的粒度不同：那个停整轮，这个只停一个分身。停不成（已经跑完了、
   * 这个引擎没这个能力）是**正常结果**，弹一条信息提示，不是错误 —— 同 `injectPrompt`
   * 的口径。
   */
  stopSubagent: (sessionId: string, taskId: string) => Promise<void>;
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
  /** Set the model used for vision relay (null = capability off). Persists. */
  setVisionRelayModel: (modelId: string | null) => void;
  /** Set the Claude output style (null = CLI default). Persists. */
  setOutputStyle: (style: string | null) => void;
  /** Toggle a git repo card's collapsed state. Persists. */
  toggleCollapsedGitRepo: (repoPath: string) => void;
}
