/**
 * Renderer → Main 的会话/项目/消息 RPC 入参 schema(PERMISSION_MODES 也在 —
 * StartSession / UpdateSessionSettings 的 permissionMode 字段用)。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。每个 schema 同时导出 `...Input` 类型,
 * 是沿用整个文件的既定约定。
 */

import { z } from "zod";
import type { SessionBookmark, MessageRecord } from "../session.js";
import type { UserInputAnswers } from "../provider.js";

/**
 * Permission modes are now open strings (see `PermissionMode` in runtime.ts).
 * This constant is kept for backward compatibility and for the claude-sdk
 * provider's own validation. The IPC schemas below use `z.string()` so any
 * provider can declare its own mode set via `ProviderCapabilities`.
 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;
/** Legacy schema - still validates claude's 6 modes. Used only where we need
 *  to constrain to claude's set (e.g. the claude-sdk provider internals). */
export const PermissionModeSchema = z.enum(PERMISSION_MODES);

/* ──────────────────────────  Renderer → Main (RPC)  ────────────────────────── */

export const StartSessionSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  /** Provider id — which AI backend to use. Defaults to "claude-sdk". */
  providerId: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().default("default"),
  permissionMode: z.string().default("default"),
  /** Id of a custom-model config to bind to this session (omit/null = built-in). */
  customModelId: z.string().nullable().optional(),
  /** Session role: "chat" (default, normal left-bar session) or "side"
   *  (side-chat Q&A session owned by the right-panel ask tab). Side sessions
   *  always create a fresh row — the createOrReuse fresh-row logic doesn't
   *  apply to them. */
  kind: z.enum(["chat", "side"]).default("chat"),
  /** For kind="side": the main session this Q&A thread belongs to. Enables
   *  traceability (one main session → many side chats). Ignored for chat. */
  parentSessionId: z.string().optional(),
  /** Working-environment intent for the new session. "worktree" records that
   *  the session's turns should run in an isolated checkout — the worktree
   *  itself is created when the FIRST turn is sent (intent-first,
   *  materialize-late), so unused sessions never leave empty worktrees
   *  behind. Only meaningful for kind="chat". */
  envMode: z.enum(["local", "worktree"]).optional(),
  /** Worktree FORM for envMode="worktree": "branch" materializes on a
   *  generated `mcode/*` branch (durable named commits — feature work),
   *  "detached" (default) keeps the classic detached checkout (experimental
   *  verification). Ignored for local sessions. */
  wtStyle: z.enum(["detached", "branch"]).optional(),
  /** BIND to an existing managed worktree directory instead of creating a
   *  fresh one: the new session shares the checkout (and its dependencies)
   *  of an already-materialized worktree session — "continue working in the
   *  same directory with a fresh thread". Must name a directory some OTHER
   *  session already references (main validates); ignored otherwise. Only
   *  meaningful together with envMode="worktree". */
  worktreePath: z.string().optional(),
  /** kind="side" + 一份代理档案:这个子对话**是谁**。
   *
   *  **只传 id**(`p_xxxx`),主进程按它去 `<数据根>/workflows/agents/` 读那份档案。
   *  刻意不把 `name` / `instruction` 走 IPC 传过来:那样渲染端就成了"指令的第二个来
   *  源地",而档案是**磁盘上的文件**、用户会在编辑器里直接改它 —— 两个来源迟早分家。
   *
   *  读不到、类型不对、参数过不了校验时**明确失败**(handler 抛错),不退回"建一个没有
   *  角色的空会话":那会让用户拿到一个看着建成了、实际没有角色的对话,而他完全没有线索。 */
  agentProfileId: z.string().optional(),
  /** kind="side" + 「档案+记忆」:建会话时把记忆库的一份快照挂进去(第一轮带上)。
   *
   *  ⚠️ **只是"要不要挂"的意图,具体内容由主进程现取** —— 与 `agentProfileId` 那边
   *  "渲染端不提供内容"同一条规矩。快照的取法见 `applyAgentProfileToSession`。
   *
   *  不给、给 false = 不注记忆。**「空白」和「不带记忆的档案」是两件事**,前者连
   *  `agentProfileId` 都没有,后者有指令只是不注记忆 —— 别把它们合成一个。 */
  memory: z.boolean().optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionSchema>;

/** List a main session's side chats (kind="side", parent = the given id),
 *  newest first — hydrates the right-panel ask tab's list view. */
export const ListSideChatsSchema = z.object({ parentSessionId: z.string() });
export type ListSideChatsInput = z.infer<typeof ListSideChatsSchema>;

/** One user-attached image sent inline with the turn (base64, no data: prefix).
 *  Media types match the Anthropic image-block allowlist (jpeg/png/gif/webp) —
 *  the Pi provider accepts the same values. The 6M-char cap keeps the decoded
 *  bytes under Anthropic's ~5MB-per-image API limit. */
export const SendTurnImageSchema = z.object({
  /** Base64-encoded image bytes (no data: prefix). */
  data: z.string().min(1).max(6_000_000),
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
});
export type SendTurnImage = z.infer<typeof SendTurnImageSchema>;

/** 会话 / 这一轮选的工作流 id。
 *
 *  **开放字符串,不是枚举** —— 内置的那六个(`BUILTIN_WORKFLOW_IDS`)只是一个子集,
 *  用户还能自建(`wf_` 前缀)。校验只保证"非空";**认不认识这个 id 由 host 决定**:
 *  不认识就当作"没有流程",而不是报错。理由与节点类型同源 —— 一份别人分享来的工作流
 *  引用了他没装的类型时,不该让整个会话打不开。 */
export const WorkflowIdSchema = z.string().min(1);

/** 取工作流 id,兼容旧字段名 `composerMode`。
 *
 *  **为什么要留这个别名**:手机端可能还开着改版前加载的页面,而 zod 对**没声明的键
 *  是静默丢掉**的 —— 那会表现成"模式突然不生效了",不报错、也不易查。留着它,旧字段
 *  只是过时,不会失灵。 */
export function workflowIdFromInput(input: {
  workflowId?: string;
  composerMode?: string;
}): string | undefined {
  return input.workflowId ?? input.composerMode;
}

export const SendTurnSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  attachments: z.array(z.string()).optional(),
  /** User-attached images inlined into the provider request as base64 content
   *  blocks (NOT paths — the model server can't read the local filesystem).
   *  Sent alongside `prompt`; an image-only turn passes an empty prompt. */
  images: z.array(SendTurnImageSchema).max(20).optional(),
  /** Override session-scoped settings for this turn (reflects current UI state). */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  /** 这一轮用的工作流。**刻意不折进 `prompt`** —— 会话标题是从 `prompt` 派生的,
   *  折进去会让标题变成流程正文。见 main/orchestration/prompt.ts。 */
  workflowId: WorkflowIdSchema.optional(),
  /** 旧字段名,**接受一个版本**。手机端可能还开着改版前加载的页面,而 zod 对没声明
   *  的键是**静默丢掉**的 —— 那会表现成"模式突然不生效了",不报错、也不易查。
   *  handler 里取 `input.workflowId ?? input.composerMode`。 */
  composerMode: WorkflowIdSchema.optional(),
  /** Override the session's bound custom model for this turn. null = clear
   *  (use built-in credential discovery); a string = bind to that config. */
  customModelId: z.string().nullable().optional(),
  /** Per-turn provider override. Normally the session's providerId is
   *  fixed at creation, but the UI can pass the active providerId here so
   *  the in-memory session is patched before RuntimeManager resolves the
   *  backend. Used as a per-turn override (NOT persisted — the session
   *  row's providerId stays as it was). */
  providerId: z.string().optional(),
  /** Skill names picked via composer skill pills this turn (no leading "/").
   *  Forwarded to the provider as the SDK `skills` allowlist so the model's
   *  Skill tool can reach them (stream-json input doesn't parse /name). */
  skills: z.array(z.string()).optional(),
  /** The sender's local user message (id / createdAt / display blocks).
   *  When present, the host echoes it to every client as a `user.message`
   *  RuntimeEvent so the prompt's bubble appears on the OTHER devices in
   *  real time (the sender dedupes by id — it already appended locally).
   *  Optional so older/foreign callers keep working (no echo, no dupes). */
  userMessage: z
    .object({
      id: z.string().min(1),
      createdAt: z.number(),
      blocks: z.array(z.unknown()),
      /** Set only when this send is an EDIT of an earlier user message
       *  (editAndResendMessage). Carries the id of the message being
       *  replaced so every OTHER client can truncate its own store at that
       *  message before appending the re-sent bubble — keeping their in-memory
       *  tail (and their turn.done persistence of it) consistent with the
       *  originator's truncation. Absent for a normal first send. */
      editedMessageId: z.string().optional(),
    })
    .optional(),
});
export type SendTurnInput = z.infer<typeof SendTurnSchema>;

export const InterruptSchema = z.object({ sessionId: z.string() });
export type InterruptInput = z.infer<typeof InterruptSchema>;

/**
 * 往**正在跑的那一轮**里塞一句话(生成过程中插话)。
 *
 * 只收文本:`max(2000)` 是一个**防手滑**的上界(这条路没有附件、没有图片,也没有
 * "太长就分成几条"的机制)。真要写长文,那本来就该是新开一轮,不是插话。
 */
export const InjectSchema = z.object({
  sessionId: z.string(),
  text: z.string().min(1).max(2000),
});
export type InjectInput = z.infer<typeof InjectSchema>;

export const ApproveSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  granted: z.boolean(),
  always: z.boolean().optional(),
});
export type ApproveInput = z.infer<typeof ApproveSchema>;

/* Answer to an AskUserQuestion. `requestId` matches the question.ask event.
 * Each value is one question's answer: option label (string), labels
 * (string[] for multi-select), or null (skipped). See UserInputAnswers.
 * `dismissed: true` means the user closed the question card without
 * answering — main resolves the provider's pending Deferred as dismissed so
 * the model's turn continues instead of blocking forever. */
export const RespondQuestionSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  dismissed: z.boolean().optional(),
});
export type RespondQuestionInput = {
  sessionId: string;
  requestId: string;
  answers: UserInputAnswers;
  dismissed?: boolean;
};

/* User's decision on a pending ExitPlanMode plan-approval request. `requestId`
 * matches the plan.approval_request event. The decision fields (approved /
 * editedPlan / reason) mirror PlanApprovalDecision in provider.ts; we spell
 * them out here so zod's inferred type matches without a circular import. */
export const RespondPlanApprovalSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  approved: z.boolean(),
  editedPlan: z.string().optional(),
  reason: z.string().optional(),
  /* User's plan-adjustment feedback from the approval sheet. Attached to the
   * decision: on approve it's delivered to the model alongside the approval
   * (execution should incorporate it); on reject it doubles as the reason. */
  feedback: z.string().optional(),
});
export type RespondPlanApprovalInput = z.infer<typeof RespondPlanApprovalSchema>;

/* Rewind a turn: restore the given files to their `before` state. The
 * renderer passes the explicit TurnFileEntry[] (the card's own frozen
 * list), so this works for BOTH the latest turn (entries from the live
 * snapshot) and any historical turn (entries persisted on the message),
 * AND for a session reopened after restart (entries rehydrated from the
 * DB) — none of those cases depend on the in-memory FileSnapshot being
 * present. Main resolves each path against the session's cwd and refuses
 * any path that escapes it (path-traversal guard).
 *
 * `targetFiles`: the requested path set, forwarded onto the
 * `turn.rewound` event so the renderer can locate the exact card to
 * mark `rewound: true`. Always present — the card is never removed,
 * only marked, for both latest-turn and historical rewinds. */
export const RewindTurnSchema = z.object({
  sessionId: z.string(),
  files: z.array(
    z.object({
      filePath: z.string(),
      kind: z.enum(["modified", "created"]),
      adds: z.number(),
      dels: z.number(),
      before: z.string(),
    }),
  ),
  targetFiles: z.array(z.string()),
});
export type RewindTurnInput = z.infer<typeof RewindTurnSchema>;

/* Per-session settings update (model / effort / permissionMode / customModelId).
 * Only the fields present in the payload are persisted; omitted fields are
 * left as-is. */
export const UpdateSessionSettingsSchema = z.object({
  sessionId: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  workflowId: WorkflowIdSchema.optional(),
  /** 旧字段名,接受一个版本 —— 理由见上面 SendTurnSchema 那段。 */
  composerMode: WorkflowIdSchema.optional(),
  customModelId: z.string().nullable().optional(),
  /** Provider id (e.g. "claude-sdk"). Only honored while the session has no
   *  messages yet — once a turn has run the provider is fixed at creation, so
   *  the main handler rejects this field for non-empty sessions. */
  providerId: z.string().optional(),
  /** Working-environment intent flip (composer chip). Only meaningful while
   *  the session is un-materialized (no worktreePath yet) — the main-side
   *  updateSettings writes it, materialization later locks the environment. */
  envMode: z.enum(["local", "worktree"]).optional(),
  /** Worktree FORM flip (composer chip) — same un-materialized-only contract
   *  as envMode. null clears the intent back to the detached default (used
   *  when flipping the session to local so no stale intent lingers). */
  wtStyle: z.enum(["detached", "branch"]).nullable().optional(),
  /** Directory re-aim (new-session panel's directory switcher): move a FRESH
   *  local session to another project. The main handler honors it only while
   *  the session has no messages and no materialized worktree, and only onto
   *  an existing non-archived project — otherwise the whole call rejects and
   *  nothing changes. */
  projectId: z.string().optional(),
});
export type UpdateSessionSettingsInput = z.infer<typeof UpdateSessionSettingsSchema>;

export const CreateProjectSchema = z.object({
  // **不许空**。空 `path` 经 `norm("")` 会解析成进程的**当前工作目录** —— 于是应用起
  // 来的那个目录(打包后可能是 `/` 或安装目录)被登记成一个"已知项目根",`pathGuard`
  // 的包含性判定从此对它放行。`RenameProjectSchema` 一直是 `.min(1)`,这条没有是不对称。
  name: z.string().min(1).max(200),
  path: z.string().min(1),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

/* Project / session lifecycle: archive (soft-delete, restorable) and delete
 * (hard, cascading — projects take their sessions+messages with them via the
 * DB's ON DELETE CASCADE). */
export const DeleteProjectSchema = z.object({ id: z.string() });
export const ArchiveProjectSchema = z.object({ id: z.string(), archived: z.boolean() });
/* Assign a project to a group (left-bar "grouped" view). `group` is null to
 * remove the project from any group. Group names are free-form strings; the
 * store trims and clamps the length before sending. */
export const SetProjectGroupSchema = z.object({
  id: z.string(),
  group: z.string().max(50).nullable(),
});
export type SetProjectGroupInput = z.infer<typeof SetProjectGroupSchema>;
/* Persist the user's drag-to-reorder. The renderer sends the full ordered
 * list of project ids as they should appear; the main process writes
 * sort_order = index for each row. Sending the whole list (rather than a
 * from/to pair) keeps the operation atomic and avoids drift when rows were
 * deleted (leaving gaps in sort_order). */
export const ReorderProjectsSchema = z.object({
  orderedIds: z.array(z.string()),
});
export type ReorderProjectsInput = z.infer<typeof ReorderProjectsSchema>;
/* Pin/unpin a project. Pinned projects float above the left bar's project
 * tree (and out of their group) in a dedicated section, most recent pin
 * first — the project-level counterpart of PinSessionSchema. */
export const PinProjectSchema = z.object({ id: z.string(), pinned: z.boolean() });
export type PinProjectInput = z.infer<typeof PinProjectSchema>;
/* Rename a project (user-edited display name). Display-only: the project's
 * path — the functional key used for cwd / path guards — is never touched.
 * Mirrors RenameSessionSchema's trim-and-clamp contract. */
export const RenameProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
});
export type RenameProjectInput = z.infer<typeof RenameProjectSchema>;
export const DeleteSessionSchema = z.object({ id: z.string() });
export const ArchiveSessionSchema = z.object({ id: z.string(), archived: z.boolean() });

/* Pin/unpin a session (project-scoped: pinned sessions sort to the top of
 * their project's list, most recent pin first). */
export const PinSessionSchema = z.object({ id: z.string(), pinned: z.boolean() });
export type PinSessionInput = z.infer<typeof PinSessionSchema>;

/* Replace a session's full bookmark list. The renderer owns the whole list
 * (single-digit cardinality) and sends the complete array on every add /
 * remove — an incremental protocol would be overkill. Excerpt is clamped in
 * the renderer before sending; the schema still bounds it to keep rows
 * defensive against hand-crafted payloads. */
export const SessionBookmarkSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  excerpt: z.string().max(400),
  // Optional (not just nullable) so bookmark lists persisted before the
  // rename feature existed parse unchanged.
  title: z.string().max(80).nullable().optional(),
  role: z.enum(["user", "assistant"]),
  createdAt: z.number().int().nonnegative(),
});
export const UpdateBookmarksSchema = z.object({
  id: z.string(),
  bookmarks: z.array(SessionBookmarkSchema),
});
export type UpdateBookmarksInput = z.infer<typeof UpdateBookmarksSchema>;

/* Rename a session (user-edited title). Title is clamped to a sane length;
 * empty/whitespace-only is rejected by the min(1) on the trimmed value (the
 * store trims before sending). */
export const RenameSessionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
});
export type RenameSessionInput = z.infer<typeof RenameSessionSchema>;

/* Open a path in the OS file manager. The main handler refuses any path that
 * isn't an exact match for a known project root, so the renderer can't ask it
 * to open arbitrary locations. */
export const OpenPathSchema = z.object({ path: z.string() });
export type OpenPathInput = z.infer<typeof OpenPathSchema>;

/* Reveal a file or directory in the OS file manager (Finder / Explorer),
 * selecting it. Unlike `shell.openPath`, this accepts any path that resolves
 * inside a known project root (not just the root itself) - the main handler
 * enforces the same project-root containment check as the file handlers. Used
 * by the file-tree context menu's "Reveal in Explorer" action. */
export const ShowItemInFolderSchema = z.object({ path: z.string() });
export type ShowItemInFolderInput = z.infer<typeof ShowItemInFolderSchema>;

/** Open a file with the OS's default associated application (e.g. .docx in
 *  Word, .pdf in Preview). Accepts any path that resolves inside a known,
 *  non-archived project root - the same containment rule as
 *  `shell.showItemInFolder`. Used by the editor's "unsupported file" pane to
 *  let the user open binary files the editor can't preview. */
export const OpenFileSchema = z.object({ path: z.string() });
export type OpenFileInput = z.infer<typeof OpenFileSchema>;

/** List a project's sessions with optional pagination + archived filter.
 *  The left-bar tree loads the first `limit` (default 5) non-archived LOCAL
 *  threads and appends the next page on "load more"; the archived bin requests
 *  `archived: true` (unpaginated). `hasMore` / `total` let the UI decide
 *  whether to render the "load more" affordance. `worktree` narrows the query
 *  by worktree binding: "exclude" = local threads only (the tree's paginated
 *  list — worktree threads are fetched separately so they never eat into the
 *  5-row first page), "only" = worktree-bound threads only (the tree's
 *  worktree groups, fetched in full — a directory holds few threads). */
export const ProjectSessionsSchema = z.object({
  projectId: z.string(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
  worktree: z.enum(["exclude", "only"]).optional(),
});
export type ProjectSessionsInput = z.infer<typeof ProjectSessionsSchema>;

/** Cross-project aggregate of non-archived chat sessions, newest-first —
 *  the stream sidebar's flat "全部项目" list. Same paging contract as
 *  project.sessions (offset + hasMore/total), just without the projectId
 *  filter — unless an optional scope narrows it: the sidebar's scope switch
 *  must also re-scope `hasMore` / `total`, or the bottom "显示更多" button
 *  keeps counting the unfiltered aggregate after the user switches
 *  projects. */
export const SessionListAllSchema = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  /** Project scope: only rows whose project_id is in this list. A plain
   *  project scope sends one id, a group scope its member ids. Absent =
   *  all projects. */
  projectIds: z.array(z.string()).optional(),
  /** Worktree-checkout scope: only sessions bound to that isolated
   *  checkout, as a normalized path key (renderer's normWorktreeKey form —
   *  main compares with its normPathKey twin, since stored paths and
   *  porcelain output differ in separators/casing surface). */
  worktreeKey: z.string().optional(),
});
export type SessionListAllInput = z.infer<typeof SessionListAllSchema>;

/** The node sessions of one conversation — one row per graph step that has ever
 *  run, newest-touched first.
 *
 *  Deliberately scoped to a single conversation rather than cross-project: a
 *  node session is *how you get back to a step of one graph*, so the caller
 *  always has the conversation in hand. There is no paging — a graph has tens
 *  of steps, not thousands. */
export const SessionListNodesSchema = z.object({
  /** The conversation whose graph spawned them (they hang off it as
   *  `parentSessionId`). */
  sessionId: z.string(),
});
export type SessionListNodesInput = z.infer<typeof SessionListNodesSchema>;

/** 这个对话里**有没有一格留下过会话** —— 看板靠它决定摆不摆"接着说"那个入口。
 *
 *  为什么要单独一条,而不是让调用方把节点会话列出来自己判空:看板每次打开都要问一遍
 *  (进程重启后看板是空的,而库里有行),列几十行只为回答一个是非题,且那条路要跨
 *  IPC 把整行搬过来。 */
export const SessionHasNodesSchema = z.object({
  sessionId: z.string(),
});
export type SessionHasNodesInput = z.infer<typeof SessionHasNodesSchema>;

/** Cross-project session search by title substring. The unified Ctrl+K search
 *  palette uses this to list threads across the whole workspace (not just the
 *  active project's loaded page). Matches non-archived sessions only. */
export const SessionSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});
export type SessionSearchInput = z.infer<typeof SessionSearchSchema>;

/** One cross-session bookmark hit for the Ctrl+K palette. Carries the owning
 *  session's identity so the palette can open it, plus the bookmark itself
 *  (excerpt = the selected text at add time, title = the user rename). */
export interface BookmarkSearchResult {
  bookmark: SessionBookmark;
  sessionId: string;
  sessionTitle: string;
  projectId: string;
}

/** Cross-session bookmark search (title + excerpt substring). Scans the
 *  bookmarks JSON column of non-archived chat sessions — bookmark data is
 *  small (single-digit entries per session), so an in-memory filter over the
 *  non-null rows is fine at workspace scale. */
export const BookmarkSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});
export type BookmarkSearchInput = z.infer<typeof BookmarkSearchSchema>;

/* A persisted message: content is opaque JSON (text/thinking/tool_use blocks).
 * P2's renderer serializes its ChatMessage.blocks array here.
 * We use z.custom<unknown>() for content: zod treats z.unknown()/z.any() as
 * optional in its inferred type, which would mismatch MessageRecord.content
 * (required `unknown`). z.custom() preserves the exact type we give it. */
export const MessageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.custom<unknown>((v) => v !== undefined, "content is required"),
  createdAt: z.number(),
});

export const SessionMessagesSchema = z.object({
  sessionId: z.string(),
  /** Page size. Omit for the legacy unpaginated path (all rows). */
  limit: z.number().int().positive().optional(),
  /** Cursor: fetch the page strictly older than this (createdAt, id) pair.
   *  Omit on the first page (most recent). */
  beforeCreatedAt: z.number().optional(),
  beforeId: z.string().optional(),
});
export type SessionMessagesInput = z.infer<typeof SessionMessagesSchema>;

/**
 * 把一段对话分叉成新的一段(右键左栏的对话 → 复制一份)。
 *
 * 只多一个 `title`,而且**由渲染端给**:新对话要叫什么是一句界面文案(中文「X 副本」/
 * 英文「X (copy)」),而主进程那一侧没有 i18n —— 那边写死一句中文,英文界面里就会冒出
 * 一句中文。会话标题本来就是用户数据(重命名那条路也是渲染端传下来的),这里同一条。
 */
export const ForkSessionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
});
export type ForkSessionInput = z.infer<typeof ForkSessionSchema>;

export const SaveMessagesSchema = z.object({
  sessionId: z.string(),
  /** Full message snapshot for the session — replaces whatever is stored. */
  messages: z.array(MessageRecordSchema),
});
/**
 * We type `messages` against the domain MessageRecord rather than z.infer,
 * because zod renders z.unknown()/z.any() content as optional, which would
 * mismatch MessageRecord.content (required). The schema still validates shape
 * at runtime; the type is asserted to match the domain model.
 */
export type SaveMessagesInput = { sessionId: string; messages: MessageRecord[] };

/** Incremental message persist — upserts the given rows by id, leaving all
 *  other rows for the session untouched. Use for additive / localized changes
 *  (a turn's new messages, a turn-files card attached to a trailing message).
 *  Prefer this over {@link SaveMessagesSchema} when only a few rows changed —
 *  it avoids the O(N) DELETE+re-INSERT of a full snapshot. */
export const UpsertMessagesSchema = z.object({
  sessionId: z.string(),
  messages: z.array(MessageRecordSchema),
});
export type UpsertMessagesInput = { sessionId: string; messages: MessageRecord[] };

/** Edit-and-resend persist: delete every message at or after the cursor
 *  (createdAt, id) and insert the given replacement rows in one transaction.
 *  This is paginated-history-safe — older rows not loaded in renderer memory
 *  are preserved, whereas {@link SaveMessagesSchema} would wipe them. */
export const TruncateAndInsertMessagesSchema = z.object({
  sessionId: z.string(),
  cursorCreatedAt: z.number(),
  cursorId: z.string(),
  messages: z.array(MessageRecordSchema),
});
export type TruncateAndInsertMessagesInput = {
  sessionId: string;
  cursorCreatedAt: number;
  cursorId: string;
  messages: MessageRecord[];
};

