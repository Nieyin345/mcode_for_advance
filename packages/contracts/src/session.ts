/**
 * Session domain types — projects, sessions, and messages persisted in SQLite.
 */
import type {
  PermissionMode,
  SessionStatus,
  EffortLevel,
  ContextSnapshot,
  SubagentSnapshot,
  TranscriptBlock,
  PlanUpdateEvent,
  TurnFileEntry,
  TurnUsageRecord,
} from "./runtime.js";

/** A single todo item (mirrors the renderer's TodoItem; kept here so the
 *  persisted Session row is typed on both sides of the IPC boundary). */
export interface SessionTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/** Plan-mode draft snapshot persisted with the session. Same shape as
 *  PlanDraft in the renderer store and PlanUpdateEvent's payload. */
export interface SessionPlanDraft {
  plan: string;
  phase: PlanUpdateEvent["phase"];
}

/** A user-placed bookmark on a chat message (message-level anchor). The
 *  excerpt is the text the user had selected when adding the bookmark —
 *  display-only, used to recognize the entry in lists; jump targeting goes
 *  through `messageId` alone. Bookmarks whose message was later removed
 *  (edit-resend truncation / compact) are kept and shown as stale until the
 *  user deletes them. */
export interface SessionBookmark {
  id: string;
  messageId: string;
  excerpt: string;
  /** User-defined display name (rename). null/empty = lists show the
   *  excerpt instead. `excerpt` itself is NEVER rewritten by a rename — it
   *  stays the whitespace-normalized anchor the jump uses to re-find the
   *  selected text in the rendered DOM for the precise highlight. */
  title: string | null;
  role: "user" | "assistant";
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  /** Absolute filesystem path that claude will use as cwd. */
  path: string;
  /** Soft-delete flag: archived projects are hidden from the main tree and
   *  live in the "archived" section; they can be restored or hard-deleted. */
  archived: boolean;
  /** Optional user-assigned group name. Projects sharing the same non-null
   *  group are clustered under a collapsible group header in the left bar's
   *  "grouped" view. null/undefined in the flat view or when ungrouped. */
  group?: string | null;
  /** User-reorderable position within the left bar. Lower sorts first;
   *  created_at is the tiebreaker for projects with equal sort_order (e.g.
   *  pre-migration rows, which all default to 0). New projects are appended
   *  with MAX(sort_order)+1 so they land at the end. */
  sortOrder: number;
  /** Pin timestamp (ms epoch) when the user pinned this project to the top of
   *  the left bar; null = not pinned. Pinned projects leave the flat list /
   *  their group and render in a dedicated pinned section above the tree
   *  (most recent pin first) until unpinned — mirroring sessions' pinnedAt.
   *  sort_order is NOT touched by pinning, so unpinning returns the project
   *  to its drag-order position. */
  pinnedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  /** The provider powering this session. Defaults to "claude-sdk". */
  providerId: string;
  /** claude's own session id, used for `--resume`. Null until first turn. */
  claudeSessionId: string | null;
  /** Session role. Four kinds, and the difference that matters is **who drives
   *  it and whether the user sees it**:
   *
   *  - `"chat"` — a normal session, listed in the left bar, driven by the user.
   *  - `"side"` — a side-chat Q&A session (right-panel ask tab), also driven by
   *    the user but kept out of every list.
   *  - `"node"` — a workflow-graph **node**: a hidden sub-session the host
   *    scheduler spawns to run one step of a graph. The user never drives it and
   *    never sees it in a list; it exists so a node gets its own concurrent
   *    turn, its own approval bookkeeping and its own persisted transcript
   *    (see `main/orchestration/`). Its interactive events are re-addressed to
   *    the parent conversation, so a node's question pops up in the chat.
   *  - `"automation"` — the hidden session a **backend automation** runs in
   *    (see `main/orchestration/automationRunner.ts`): one per automation,
   *    found by `workflowId`, reused across runs. Also invisible in every list,
   *    and — unlike a node — it has **no conversation to ask**: nobody is
   *    watching, so its approvals/questions are auto-declined (fail-closed,
   *    see `RuntimeManager.autoDeclineIfUnattended`) and its run history is the
   *    only thing the user ever reads back. */
  kind: "chat" | "side" | "node" | "automation";
  /** For non-`chat` sessions: the main session this one hangs off.
   *
   *  `side` — the Q&A thread's origin, for traceability. Nulled (not cascaded)
   *  when the parent is deleted, because the history has standalone value.
   *  `node` — the conversation whose graph spawned it. Nulled the same way.
   *  `automation` — **null**: a backend automation belongs to a *workflow*, not
   *  to a conversation (its workflowId is what identifies it). */
  parentSessionId: string | null;
  /** For `kind === "node"` only: **图上的哪一格**跑在这个会话里. Null for every
   *  other kind.
   *
   *  Why it has to be its own field: `parentSessionId` says which conversation
   *  a node session hangs off, but a conversation's graph has *many* nodes and
   *  each one needs its own persistent session. Without this, two node
   *  sessions of the same conversation are indistinguishable in the DB — so
   *  "come back tomorrow and keep talking to that step" has nothing to look
   *  the step up by, and every run would have to create a fresh throwaway
   *  session.
   *
   *  The pair `(parentSessionId, nodeId)` is the key. A node's id is generated
   *  when the graph is built and lives in the saved workflow, so **renaming,
   *  moving or re-wiring a node keeps it**; deleting a node and drawing a new
   *  one mints a new id, which is correct — that is a different step. */
  nodeId: string | null;
  /**
   * 这个对话**是谁** —— 建对话时挑的那份代理档案。
   *
   * `name` 是它的标题,`instruction` 是**每一轮都带**的角色提示词。null = 没有角色
   * (「空白」那一路:纯对话,不额外说什么它是什么)。
   *
   * ## 为什么存快照,不存一个 id
   *
   * 档案是用户随时可改可删的文件(`<数据根>/workflows/agents/<id>.json`)。
   * 只存 id、每轮现读的话:同一个对话今天用第 2 版、明天用第 3 版,而上下文是连续的 ——
   * 「它昨天说过的话」和「它今天是谁」对不上,用户看不出发生过什么。所以**建会话那一刻
   * 抄一份进来**,之后这个对话就活在这一份上;`id` 只是记着它当初从哪份档案来的。
   *
   * ⚠️ 代价:**改了档案,已经开出去的对话不跟着变**。这是刻意的 —— 想要新的就再建一个
   * 子对话。与**节点**那一侧正相反:节点每轮现取(`paramsForProfile`),因为它本来就是
   * "跑一次算一次"的东西。
   *
   * 形状是 `agentProfile.ts` 的 `SessionAgentProfileRef`;这里写成内联对象而不是 import
   * 那个接口,是为了不让 session.ts 反向依赖 agentProfile.ts(那个文件已经 import 了
   * nodeType,再牵进 session 会绕成一圈)。
   */
  agentProfile?: {
    id: string;
    name: string;
    instruction: string;
  } | null;
  title: string;
  status: SessionStatus;
  /** Model alias or full name ("default" = let claude pick). → --model. */
  model: string;
  /** Reasoning effort ("default" = don't pass --effort). → --effort. */
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /** 这个会话用的工作流。**开放字符串** —— 内置的那六个 id,或用户自建的 `wf_`。
   *  像模型 / 权限那样**跟着会话存**,切回一个会话时它还在原来那个流程上。
   *  "default" = 不追加任何流程。 */
  workflowId: string;
  /** Id of the user's custom-model config bound to this session (null = use
   *  built-in credential discovery). Set when the user picks a custom model
   *  in the composer; persisted so a resumed session keeps its endpoint. */
  customModelId: string | null;
  /** Soft-delete flag: archived sessions are hidden from the main tree and
   *  live in the "archived" section; they can be restored or hard-deleted. */
  archived: boolean;
  /** Pin timestamp (ms epoch) when the user pinned this session to the top of
   *  its project's session list; null = not pinned. Pinned sessions sort above
   *  unpinned ones (most recent pin first) within their project only. */
  pinnedAt: number | null;
  /** Normalized ContextSnapshot from the most recent token-usage.updated
   *  event, serialized as JSON. Null for sessions that never saw a turn. */
  contextSnapshot: ContextSnapshot | null;
  /** Capsule state persisted so the top-right status pill reloads on
   *  session reopen. Each is null for sessions that never produced the
   *  corresponding activity. JSON-serialized in the DB. */
  todos: SessionTodoItem[] | null;
  subagents: SubagentSnapshot[] | null;
  planDraft: SessionPlanDraft | null;
  /** Per-turn token/cost breakdown, appended at each turn-end. Survives
   *  restart so the context-stats history popover shows all turns. */
  usageHistory: TurnUsageRecord[] | null;
  /** Files touched by the most recent turn (persisted so the "本轮修改" card
   *  survives a session reopen). Null for sessions that never saw a file edit.
   *  Cleared (set to null) after a rewind. JSON-serialized in the DB. */
  turnFiles: TurnFileEntry[] | null;
  /** Working environment of this session's turns. "worktree" = turns run in
   *  an isolated git worktree instead of the project root, so parallel
   *  sessions never stomp on each other's working tree. Recorded as INTENT at
   *  session creation; the worktree is materialized (and `worktreePath`
   *  backfilled) when the first turn is sent. Undefined (= "local") for all
   *  pre-existing rows. */
  envMode?: "local" | "worktree";
  /** Worktree FORM, only read while envMode="worktree" and un-materialized:
   *  "branch" materializes the worktree on a generated `mcode/*` branch
   *  (commits are named and durable — real feature work), "detached" (the
   *  default, also NULL/absent) materializes the classic detached checkout
   *  (experimental verification; merge-back then discard). Pure intent — once
   *  materialized the form is self-evident from the checkout itself, and this
   *  field stops mattering. */
  wtStyle?: "detached" | "branch" | null;
  /** Absolute path of this session's worktree once materialized. Null while
   *  still intent-only and for local sessions forever. Persisted so a
   *  restarted app keeps routing the session's turns into the worktree. */
  worktreePath?: string | null;
  /** User-placed message bookmarks (persisted so the capsule + timeline
   *  markers survive a session reopen). Null for sessions with no bookmarks.
   *  JSON-serialized in the DB. */
  bookmarks: SessionBookmark[] | null;
  /** Final subagent transcripts of the most recent turn, keyed by the
   *  spawning Task tool_use id (same keys as SubagentSnapshot.toolUseId).
   *  Persisted so the side-panel subagent viewer still works after a session
   *  reopen; cleared when a new turn starts (mirrors the roster cycle).
   *  Null for sessions that never ran subagents. JSON-serialized in the DB. */
  subagentTranscripts: Record<string, TranscriptBlock[]> | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  /** Content stored as JSON: text blocks, tool_use, tool_result, etc. */
  content: unknown;
  createdAt: number;
}

/** Input to start a new session turn. */
export interface TurnInput {
  sessionId: string;
  prompt: string;
  /** File paths attached via @file references. */
  attachments?: string[];
}

/** A user's decision on an approval request. */
export interface ApprovalDecision {
  sessionId: string;
  requestId: string;
  granted: boolean;
  /** If true, remember the decision for this tool type this session. */
  always?: boolean;
}
