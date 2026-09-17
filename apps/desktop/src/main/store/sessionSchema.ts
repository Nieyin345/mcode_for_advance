/**
 * sessions 表的**单一事实来源**。
 *
 * 以前这份数据散在四处,加一个字段要同步改四处,错一处就是**静默写错列**:
 *
 *   1. `db.ts` 的 CREATE TABLE 列定义;
 *   2. `db.ts` 的 addColumnIfMissing 兼容段(老库 ALTER);
 *   3. `repositories.ts` 的 SessionRepo.create —— 28 个列名 + 28 个 `?` + 28 个
 *      `v(...)` **位置对位**,列名和值错一位,数据就写进别的列,没有任何报错;
 *   4. `repositories.ts` 的 rowToSession —— 一列一行读出来。
 *
 * 现在四处全部从 {@link SESSION_COLUMNS} 生成:CREATE TABLE、ALTER 循环、INSERT
 * 的列名/占位符/绑定值、行读取,谁都不再手抄列名。**加字段的动作变成:在本文件
 * 的数组里加一项**(并想清楚它该不该进 `inCreate`),其他地方自动跟上。
 *
 * 约定:
 *  - `inCreate: true`  —— 初版建表就有的列,老库天然携带,不走 ALTER;
 *  - `inCreate: false` —— 后来加的列,CREATE TABLE 不含它,迁移时靠
 *    addColumnIfMissing 补(db.ts 的兼容段循环本数组生成,顺序即历史顺序,
 *    别打乱 —— 虽然语义上无所谓,但保持与老迁移日志一致便于人工比对)。
 *
 * `def` 同时服务于 CREATE 和 ALTER(SQLite 的 ADD COLUMN 语法与之相容;
 * addColumnIfMissing 会给标识符加双引号,`group` 这类关键字列名才安全 ——
 * sessions 没有这种名字,但别破坏这个前提)。
 */
import type {
  Session,
  SessionTodoItem,
  SessionPlanDraft,
  SessionBookmark,
} from "@contracts/session";
import type { ContextSnapshot, SubagentSnapshot, TurnFileEntry, TurnUsageRecord } from "@contracts/runtime";

/* sql.js binds `?` params positionally as an array. Values must be
 * string | number | Uint8Array | null — booleans/undefined aren't accepted,
 * so we normalize values before binding. Nulls are passed through.
 * (原来在 repositories.ts,sessionSchema 的 bind/read 也要用,就搬到了这里。) */
export type BindValue = string | number | Uint8Array | null;
export function v(x: unknown): BindValue {
  if (x === undefined || x === null) return null;
  if (typeof x === "boolean") return x ? 1 : 0;
  return x as BindValue;
}

export function safeJson(x: unknown): unknown {
  if (typeof x !== "string") return x;
  try { return JSON.parse(x); } catch { return x; }
}

/** 从 stmt.getAsObject() 拿到的一行。列名由 SESSION_COLUMNS 决定,这里不再
 *  逐列声明(那又是一份要同步的清单)—— 读取端的类型安全由 read 里的 cast 负责。 */
export type SessionRow = Record<string, BindValue>;

interface SessionColumn {
  /** 数据库列名(snake_case)。 */
  name: string;
  /** 列定义:类型 + 约束 + 默认值。CREATE 与 ALTER 共用这一份。 */
  def: string;
  /** 是否属于初版 CREATE TABLE(false = 老库要走 ALTER 兼容段)。 */
  inCreate: boolean;
  /** 对应 Session 的字段名(camelCase),rowToSession 的输出键。 */
  key: keyof Session;
  /** Session 对象 → 绑定值(INSERT 用)。序列化成 JSON 的字段在这里做。 */
  bind: (s: Session) => BindValue;
  /** 数据库行 → Session 字段值(读取用)。反序列化/枚举归一在这里做。 */
  read: (row: SessionRow) => unknown;
}

export const SESSION_COLUMNS: readonly SessionColumn[] = [
  /* ── 初版建表就有的 14 列(顺序 = 原 CREATE TABLE,别打乱) ─────────────── */
  { name: "id", def: "TEXT PRIMARY KEY", inCreate: true, key: "id",
    bind: (s) => v(s.id), read: (r) => r.id },
  { name: "project_id", def: "TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE", inCreate: true, key: "projectId",
    bind: (s) => v(s.projectId), read: (r) => r.project_id },
  { name: "provider_id", def: "TEXT NOT NULL DEFAULT 'claude-sdk'", inCreate: true, key: "providerId",
    bind: (s) => v(s.providerId), read: (r) => r.provider_id ?? "claude-sdk" },
  { name: "claude_session_id", def: "TEXT", inCreate: true, key: "claudeSessionId",
    bind: (s) => v(s.claudeSessionId), read: (r) => r.claude_session_id ?? null },
  { name: "title", def: "TEXT NOT NULL", inCreate: true, key: "title",
    bind: (s) => v(s.title), read: (r) => r.title },
  { name: "status", def: "TEXT NOT NULL", inCreate: true, key: "status",
    bind: (s) => v(s.status), read: (r) => r.status as Session["status"] },
  { name: "model", def: "TEXT NOT NULL", inCreate: true, key: "model",
    bind: (s) => v(s.model), read: (r) => r.model },
  { name: "effort", def: "TEXT NOT NULL DEFAULT 'default'", inCreate: true, key: "effort",
    bind: (s) => v(s.effort), read: (r) => r.effort as Session["effort"] },
  { name: "permission_mode", def: "TEXT NOT NULL", inCreate: true, key: "permissionMode",
    bind: (s) => v(s.permissionMode), read: (r) => r.permission_mode as Session["permissionMode"] },
  { name: "custom_model_id", def: "TEXT", inCreate: true, key: "customModelId",
    bind: (s) => v(s.customModelId), read: (r) => r.custom_model_id ?? null },
  { name: "archived", def: "INTEGER NOT NULL DEFAULT 0", inCreate: true, key: "archived",
    bind: (s) => v(s.archived ? 1 : 0), read: (r) => !!r.archived },
  // Pin timestamp (NULL = not pinned). Nullable so unpinned rows carry no
  // value; listByProject orders by it DESC (SQLite puts NULLs last in DESC)
  // to float pinned sessions to the top.
  { name: "pinned_at", def: "INTEGER", inCreate: true, key: "pinnedAt",
    bind: (s) => v(s.pinnedAt), read: (r) => r.pinned_at ?? null },
  { name: "created_at", def: "INTEGER NOT NULL", inCreate: true, key: "createdAt",
    bind: (s) => v(s.createdAt), read: (r) => r.created_at },
  { name: "updated_at", def: "INTEGER NOT NULL", inCreate: true, key: "updatedAt",
    bind: (s) => v(s.updatedAt), read: (r) => r.updated_at },

  /* ── 后来加的 14 列(顺序 = 原 addColumnIfMissing 兼容段,别打乱) ────────── */
  { name: "context_snapshot", def: "TEXT", inCreate: false, key: "contextSnapshot",
    bind: (s) => v(s.contextSnapshot ? JSON.stringify(s.contextSnapshot) : null),
    read: (r) => (r.context_snapshot ? safeJson(r.context_snapshot) : null) as ContextSnapshot | null },
  // Capsule state (todos / subagents / plan draft) persisted so the
  // top-right status capsule reloads on session reopen. JSON-serialized,
  // nullable — same shape as context_snapshot.
  { name: "todos", def: "TEXT", inCreate: false, key: "todos",
    bind: (s) => v(s.todos ? JSON.stringify(s.todos) : null),
    read: (r) => (r.todos ? safeJson(r.todos) : null) as SessionTodoItem[] | null },
  { name: "subagents", def: "TEXT", inCreate: false, key: "subagents",
    bind: (s) => v(s.subagents ? JSON.stringify(s.subagents) : null),
    read: (r) => (r.subagents ? safeJson(r.subagents) : null) as SubagentSnapshot[] | null },
  { name: "plan_draft", def: "TEXT", inCreate: false, key: "planDraft",
    bind: (s) => v(s.planDraft ? JSON.stringify(s.planDraft) : null),
    read: (r) => (r.plan_draft ? safeJson(r.plan_draft) : null) as SessionPlanDraft | null },
  // Per-turn modified-files snapshot (the "本轮修改" card). JSON blob of
  // TurnFileEntry[]; null after a rewind or for sessions that never edited.
  { name: "turn_files", def: "TEXT", inCreate: false, key: "turnFiles",
    bind: (s) => v(s.turnFiles ? JSON.stringify(s.turnFiles) : null),
    read: (r) => (r.turn_files ? safeJson(r.turn_files) : null) as TurnFileEntry[] | null },
  // User-placed message bookmarks (capsule + timeline markers). JSON blob of
  // SessionBookmark[]; null for sessions with no bookmarks.
  { name: "bookmarks", def: "TEXT", inCreate: false, key: "bookmarks",
    bind: (s) => v(s.bookmarks ? JSON.stringify(s.bookmarks) : null),
    read: (r) => (r.bookmarks ? safeJson(r.bookmarks) : null) as SessionBookmark[] | null },
  // Final subagent transcripts of the most recent turn (side-panel viewer).
  // JSON blob of Record<toolUseId, TranscriptBlock[]>; cleared at
  // the start of each new turn.
  { name: "subagent_transcripts", def: "TEXT", inCreate: false, key: "subagentTranscripts",
    bind: (s) => v(s.subagentTranscripts ? JSON.stringify(s.subagentTranscripts) : null),
    read: (r) => (r.subagent_transcripts ? safeJson(r.subagent_transcripts) : null) as Session["subagentTranscripts"] },
  // Per-turn token/cost history. JSON array of TurnUsageRecord; appended at
  // each turn-end so the context-stats history popover survives restart.
  { name: "usage_history", def: "TEXT", inCreate: false, key: "usageHistory",
    bind: (s) => v(s.usageHistory ? JSON.stringify(s.usageHistory) : null),
    read: (r) => (r.usage_history ? safeJson(r.usage_history) : null) as TurnUsageRecord[] | null },
  // Session role discriminator ('chat' / 'side' / 'node' / 'automation'). 'chat' is
  // the default so pre-migration rows and all existing creation paths stay main
  // sessions. rowToSession 这端是**四值**归一:任何不认识的 kind 都归 "chat"。
  //
  // ⚠️ **漏一个值的表现是"隐藏会话冒进左栏"**(自动化后台会话混进对话列表),而它在
  // 库里看不出错 —— 左栏那些查询本来就按 `kind = 'chat'` 过滤,归一漏了的话那一行会被
  // 当成 chat 从而被列出来。所以加新 kind 时**这一行必须同时加**。
  { name: "kind", def: "TEXT NOT NULL DEFAULT 'chat'", inCreate: false, key: "kind",
    bind: (s) => v(s.kind),
    read: (r) =>
      r.kind === "side"
        ? "side"
        : r.kind === "node"
          ? "node"
          : r.kind === "automation"
            ? "automation"
            : "chat" },
  // Side-chat / node sessions 的宿主会话。不设 DB 级 FK —— 删主会话时由
  // SessionRepo 手工置 NULL(Q&A 历史要保留),级联反而会删掉它们。
  { name: "parent_session_id", def: "TEXT", inCreate: false, key: "parentSessionId",
    bind: (s) => v(s.parentSessionId), read: (r) => r.parent_session_id ?? null },
  // Isolated-agent-session environment: 'worktree' rows run their turns in a
  // detached git worktree (created on first turn, path backfilled) instead of
  // the project root. 'local' keeps every pre-migration row as-is.
  { name: "env_mode", def: "TEXT NOT NULL DEFAULT 'local'", inCreate: false, key: "envMode",
    bind: (s) => v(s.envMode ?? "local"),
    read: (r) => (r.env_mode === "worktree" ? "worktree" : "local") },
  { name: "worktree_path", def: "TEXT", inCreate: false, key: "worktreePath",
    bind: (s) => v(s.worktreePath ?? null), read: (r) => r.worktree_path ?? null },
  // Worktree FORM intent (only read while env_mode='worktree' and the path is
  // still NULL): 'branch' materializes on a generated mcode/* branch, NULL or
  // 'detached' keeps the classic detached checkout. Stops mattering once the
  // worktree exists — the form is self-evident from the checkout.
  { name: "wt_style", def: "TEXT", inCreate: false, key: "wtStyle",
    bind: (s) => v(s.wtStyle ?? null),
    read: (r) => (r.wt_style === "branch" ? "branch" : r.wt_style === "detached" ? "detached" : null) },
  // ⚠️ **列名在撒谎**:composer_mode 里存的是 workflowId(历史遗留,列先于
  // 改名存在)。改名要走一次迁移,现在不动 —— 读/写两端都已经在这一处收口,
  // 将来改名只碰本文件。
  { name: "composer_mode", def: "TEXT NOT NULL DEFAULT 'default'", inCreate: false, key: "workflowId",
    bind: (s) => v(s.workflowId ?? "default"),
    read: (r) => (r.composer_mode as Session["workflowId"]) ?? "default" },
];

/** CREATE TABLE 语句由 inCreate 列生成。db.ts 的 migrate() 大 SQL 模板里插值,
 *  列顺序与数组里 inCreate 子集的顺序一致(= 历史上的建表顺序)。 */
export function sessionsCreateSql(): string {
  return `CREATE TABLE IF NOT EXISTS sessions (\n${SESSION_COLUMNS.filter((c) => c.inCreate)
    .map((c) => `  "${c.name}" ${c.def}`)
    .join(",\n")}\n  )`;
}
