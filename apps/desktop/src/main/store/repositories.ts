/**
 * Repository functions over the three SQLite tables. Each function does the
 * camelCase (domain) ↔ snake_case (column) translation so callers stay in
 * domain types. Synchronous (sql.js queries are sync); writes trigger a coalesced
 * flush to disk via `persist()`.
 *
 * Replaces the P1 in-memory Maps (memoryStore.ts). The two call sites are
 * ipc/projects.ts and ipc/claude.ts.
 */
import type {
  Project,
  Session,
  MessageRecord,
  SessionTodoItem,
  SessionPlanDraft,
  SessionBookmark,
} from "@contracts/session";
import type { ContextSnapshot, SubagentSnapshot, TurnFileEntry, TurnUsageRecord } from "@contracts/runtime";
import type { LongTask } from "@contracts/longTask";
import type { WorkflowDoc } from "@contracts/workflow";
import type {
  LibraryItem,
  LibraryAuthor,
  LibraryItemType,
  LibraryCollection,
  LibraryNote,
  LibraryItemLink,
  LibraryLinkView,
  InstitutionProfile,
  DownloadJob,
  DownloadStatus,
  PdfState,
} from "@contracts/library";
import { basename } from "node:path";
import { normPathKey } from "@main/lib/pathNorm.js";
import { getDb, persist } from "./db.js";
// sessions 表的列定义/绑定/读取全在 sessionSchema.ts(单一事实来源)。
// v / safeJson / BindValue / SessionRow 也住在那儿 —— 仓库其余部分沿用。
import { v, safeJson, SESSION_COLUMNS, type BindValue, type SessionRow } from "./sessionSchema.js";

/* sql.js binds `?` params positionally as an array. Values must be
 * string | number | Uint8Array | null — booleans/undefined aren't accepted,
 * so we normalize values before binding. Nulls are passed through. */

/* ─────────────────────────────── Projects ─────────────────────────────── */

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  archived: number;
  group: string | null;
  sort_order: number;
  pinned_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    archived: !!r.archived,
    // Normalize empty string / undefined (pre-migration rows) to null so the
    // renderer only ever sees null | <non-empty group name>.
    group: r.group && r.group.length > 0 ? r.group : null,
    sortOrder: r.sort_order ?? 0,
    pinnedAt: r.pinned_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* Root-path cache for the per-call guard checks. The files/git/lsp IPC
 * handlers re-derive "is this a known project root" on every renderer call
 * (file-tree expand, editor read, …), which used to mean a full projects-table
 * scan each time. The path set only changes via create/delete, but every
 * mutator drops the cache anyway — free, and future-proof against rows moving
 * in through new code paths. */
let rootPathsCache: string[] | null = null;

export const ProjectRepo = {
  create(p: Project): void {
    const db = getDb();
    // Append the new project at the end: MAX(sort_order)+1. COALESCE handles
    // the empty-table case (MAX returns NULL → -1 → next is 0). Computed here
    // (not passed in) so callers don't have to reason about ordering.
    const nextOrderStmt = db.prepare(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects",
    );
    nextOrderStmt.step();
    const nextOrder = (nextOrderStmt.getAsObject() as { next: number }).next;
    nextOrderStmt.free();
    db.run(
      "INSERT INTO projects (id, name, path, archived, `group`, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        v(p.id),
        v(p.name),
        v(p.path),
        v(p.archived ? 1 : 0),
        v(p.group ?? null),
        v(nextOrder),
        v(p.createdAt),
        v(p.updatedAt),
      ],
    );
    persist();
    rootPathsCache = null;
  },

  list(): Project[] {
    const db = getDb();
    // Pinned projects float to the top (most recent pin first); unpinned rows
    // keep their drag order. `(pinned_at IS NULL)` yields 0/1 so pinned rows
    // (0) sort ahead — same trick as the sessions pinned_at ordering.
    const stmt = db.prepare(
      "SELECT * FROM projects ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, sort_order ASC, created_at ASC",
    );
    const out: Project[] = [];
    while (stmt.step()) out.push(rowToProject(stmt.getAsObject() as unknown as ProjectRow));
    stmt.free();
    return out;
  },

  /** Root paths of all persisted projects, served from an in-memory cache.
   *  Use in guard checks that only need the path set (known-root match /
   *  containment) instead of {@link list} — the file tree calls these on
   *  every expand. Callers needing other fields (archived, group, …) must
   *  use {@link list}; mutations re-populate the cache lazily. */
  listPaths(): string[] {
    if (!rootPathsCache) rootPathsCache = ProjectRepo.list().map((p) => p.path);
    return rootPathsCache;
  },

  get(id: string): Project | undefined {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM projects WHERE id = ?");
    stmt.bind([v(id)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as ProjectRow) : undefined;
    stmt.free();
    return row ? rowToProject(row) : undefined;
  },

  /** Hard-delete a project. Child sessions + messages cascade-delete via the
   *  sessions.project_id / messages.session_id ON DELETE CASCADE constraints
   *  (PRAGMA foreign_keys = ON is set in initDb). */
  delete(id: string): void {
    getDb().run("DELETE FROM projects WHERE id = ?", [v(id)]);
    persist();
    rootPathsCache = null;
  },

  /** Set the archived (soft-delete) flag. */
  setArchived(id: string, archived: boolean): void {
    getDb().run("UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?", [
      v(archived ? 1 : 0),
      v(Date.now()),
      v(id),
    ]);
    persist();
    rootPathsCache = null;
  },

  /** Assign a project to a group. Pass null to remove it from any group.
   *  `group` is a column name in SQLite so it must be backtick-quoted. */
  setGroup(id: string, group: string | null): void {
    getDb().run("UPDATE projects SET `group` = ?, updated_at = ? WHERE id = ?", [
      v(group ?? null),
      v(Date.now()),
      v(id),
    ]);
    persist();
    rootPathsCache = null;
  },

  /** Rename a project (display-only; the path is never touched). */
  rename(id: string, name: string): void {
    getDb().run("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?", [
      v(name),
      v(Date.now()),
      v(id),
    ]);
    persist();
    rootPathsCache = null;
  },

  /** Pin/unpin a project: pinned rows write the current timestamp (most
   *  recent pin sorts first), unpinned rows write NULL. Mirrors
   *  SessionRepo.setPinned — sort_order is left alone so unpinning returns
   *  the project to its drag-order position, and `updated_at` is not bumped
   *  (pinning is metadata, not activity). */
  setPinned(id: string, pinned: boolean): void {
    getDb().run("UPDATE projects SET pinned_at = ? WHERE id = ?", [
      v(pinned ? Date.now() : null),
      v(id),
    ]);
    persist();
    rootPathsCache = null;
  },

  /** Rewrite sort_order for every id in `orderedIds` (index = position).
   *  Accepts the full ordered list so the operation is idempotent and
   *  self-healing — gaps from prior deletes collapse on the next reorder.
   *  Unknown ids in the input are skipped (the UPDATE matches nothing); ids
   *  absent from the input keep their old sort_order. Mirrors the
   *  MessageRepo.replaceAll transaction pattern. */
  reorder(orderedIds: string[]): void {
    const db = getDb();
    db.run("BEGIN");
    try {
      const stmt = db.prepare("UPDATE projects SET sort_order = ? WHERE id = ?");
      for (let i = 0; i < orderedIds.length; i++) {
        stmt.run([v(i), v(orderedIds[i])]);
      }
      stmt.free();
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
    rootPathsCache = null;
  },
};

/* ─────────────────────────────── Sessions ─────────────────────────────── */

// SessionRow 类型与每一列的 bind/read 都在 sessionSchema.ts —— 这里不再维护
// 第二份列清单。rowToSession / SessionRepo.create 由 SESSION_COLUMNS 生成。

/** 行 → Session。逐列调用 sessionSchema.ts 里定义的 read(枚举归一 / JSON 反
 *  序列化都在那份定义里),不再手写字段映射 —— 新列只改 sessionSchema。 */
function rowToSession(r: SessionRow): Session {
  const out: Record<string, unknown> = {};
  for (const col of SESSION_COLUMNS) out[col.key] = col.read(r);
  return out as unknown as Session;
}

export const SessionRepo = {
  create(s: Session): void {
    // 列名、占位符、绑定值全部由 SESSION_COLUMNS 生成 —— 列名和值来自同一个
    // 数组项,位置对位错位从此在结构上不可能发生(以前这里手抄 28 个列名 +
    // 28 个 `?` + 28 个 `v(...)`,错一位就是静默写错列)。
    const cols = SESSION_COLUMNS.map((c) => c.name).join(", ");
    const marks = SESSION_COLUMNS.map(() => "?").join(", ");
    getDb().run(
      `INSERT INTO sessions (${cols}) VALUES (${marks})`,
      SESSION_COLUMNS.map((c) => c.bind(s)),
    );
    persist();
  },

  /** List sessions for a project, most recently active first.
   *
   *  The active list (`opts.archived === false`) EXCLUDES pinned sessions —
   *  they render in the left bar's global pinned section (see
   *  {@link SessionRepo.listPinned}) instead of under their project. The
   *  remaining rows sort by `updated_at DESC` — a session floats to the top
   *  whenever it is touched (new message, title/status change, snapshot
   *  save, …) — with ties falling back to `created_at DESC` for a stable
   *  order. `opts.limit` / `opts.offset` paginate (used by the left-bar tree,
   *  which loads the first page and appends on "load more"). `opts.archived`
   *  filters by the soft-delete flag: omit for all (pinned included), `false`
   *  for the active thread list (pinned excluded), `true` for the archived
   *  bin (pinned included — a pinned-then-archived row stays visible there).
   *  `opts.worktree` narrows by worktree binding ("exclude" = local threads
   *  only, "only" = worktree-bound only) so the tree's paginated list and its
   *  worktree groups can be fetched independently. */
  listByProject(
    projectId: string,
    opts?: { limit?: number; offset?: number; archived?: boolean; worktree?: "exclude" | "only" },
  ): Session[] {
    const db = getDb();
    // Side-chat sessions are managed by the right-panel ask tab keyed by
    // parent session — never by the left-bar project list (any mode).
    const where = ["project_id = ?", "kind = 'chat'"];
    const params: BindValue[] = [v(projectId)];
    if (opts?.archived !== undefined) {
      where.push("archived = ?");
      params.push(opts.archived ? 1 : 0);
    }
    if (opts?.worktree === "exclude") {
      where.push("worktree_path IS NULL");
    } else if (opts?.worktree === "only") {
      where.push("worktree_path IS NOT NULL");
    }
    // Pinned sessions are EXCLUDED from the active list — they render in the
    // left bar's global "pinned" section above the project tree instead of
    // under their project. The archived bin (and the unfiltered "all" mode)
    // still includes them so a pinned-then-archived row stays visible there.
    if (opts?.archived === false) {
      where.push("pinned_at IS NULL");
    }
    let sql = `SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, created_at DESC`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(v(opts.limit));
      if (opts?.offset !== undefined) {
        sql += " OFFSET ?";
        params.push(v(opts.offset));
      }
    }
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
  },

  /**
   * 这个项目下**所有**会话的 id(分页用的 `countByProject` 同款过滤口径)。
   *
   * ⚠️ 存在的理由只有一个:删项目时要在**真正删之前**拿到这批 id。删完之后
   * `ON DELETE CASCADE` 已经把行带走了,那时候再想把每个会话的收尾做掉就没地方问了
   * (见 `ipc/projects.ts` 的 `PROJECT_DELETE`,以及 `SESSION_DELETE` 上那句"不能省")。
   *
   * 这里**不**按 `kind = 'chat'` 收窄 —— `SESSION_DELETE` 对什么会话都得收尾,
   * 侧边问答也一样。`listByProject` 那句 `kind = 'chat'` 是**左侧列表**的口径
   * (侧栏问答由右栏管理,不进项目树),拿它当"该收尾的会话"会漏掉侧栏那些。
   */
  listIdsByProject(projectId: string): string[] {
    const db = getDb();
    const stmt = db.prepare("SELECT id FROM sessions WHERE project_id = ?");
    stmt.bind([v(projectId)]);
    const out: string[] = [];
    while (stmt.step()) out.push(String((stmt.getAsObject() as { id: string }).id));
    stmt.free();
    return out;
  },

  /** Count sessions for a project, optionally filtered by archived flag and
   *  worktree binding. Used to compute `hasMore` for pagination. Matches
   *  {@link listByProject}'s filters: the active count (`archived === false`)
   *  excludes pinned sessions so it lines up with what the paginated active
   *  list returns, and the `worktree` filter must mirror the list's or the
   *  pagination math counts rows the list will never return. */
  countByProject(
    projectId: string,
    archived?: boolean,
    worktree?: "exclude" | "only",
  ): number {
    const db = getDb();
    const where = ["project_id = ?", "kind = 'chat'"];
    const params: BindValue[] = [v(projectId)];
    if (archived !== undefined) {
      where.push("archived = ?");
      params.push(archived ? 1 : 0);
    }
    if (archived === false) {
      where.push("pinned_at IS NULL");
    }
    if (worktree === "exclude") {
      where.push("worktree_path IS NULL");
    } else if (worktree === "only") {
      where.push("worktree_path IS NOT NULL");
    }
    const stmt = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${where.join(" AND ")}`);
    stmt.bind(params);
    stmt.step();
    const n = (stmt.getAsObject() as { n: number }).n;
    stmt.free();
    return n;
  },

  /** All pinned non-archived sessions across every project, most recent pin
   *  first. Powers the left bar's global pinned section, which hoists pinned
   *  threads out of their project's list and shows them above the project
   *  tree (the renderer resolves each row's owning project name locally). */
  listPinned(): Session[] {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM sessions WHERE archived = 0 AND pinned_at IS NOT NULL AND kind = 'chat' ORDER BY pinned_at DESC",
    );
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
  },

  /** Cross-project aggregate of non-archived chat sessions, newest-first —
   *  the stream sidebar's flat "全部项目" list. Mirrors {@link listByProject}'s
   *  active-list semantics (pinned EXCLUDED — pinned threads render in the
   *  stream's pinned block, exactly as the tree hoists them into its global
   *  pinned section), same updated_at DESC / created_at DESC order.
   *
   *  Optional scope filters (the sidebar's scope switch re-scopes pagination,
   *  so `hasMore`/`total` must count the scoped set, not the aggregate):
   *  `projectIds` narrows to those projects (SQL IN); `worktreeKey` narrows
   *  to sessions bound to that checkout — matched in JS via normPathKey
   *  (stored paths and the renderer's normalized key differ in separator /
   *  casing surface), which rules out SQL LIMIT/OFFSET: the full match is
   *  materialized first, then sliced. */
  listAll(opts?: {
    limit?: number;
    offset?: number;
    projectIds?: string[];
    worktreeKey?: string;
  }): Session[] {
    const db = getDb();
    if (opts?.projectIds && opts.projectIds.length === 0) return [];
    const where = ["archived = 0", "pinned_at IS NULL", "kind = 'chat'"];
    const params: BindValue[] = [];
    if (opts?.projectIds) {
      where.push(`project_id IN (${opts.projectIds.map(() => "?").join(", ")})`);
      for (const id of opts.projectIds) params.push(v(id));
    }
    const wtKey = opts?.worktreeKey;
    if (wtKey !== undefined) where.push("worktree_path IS NOT NULL");
    let sql = `SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, created_at DESC`;
    if (wtKey === undefined && opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(v(opts.limit));
      if (opts?.offset !== undefined) {
        sql += " OFFSET ?";
        params.push(v(opts.offset));
      }
    }
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const out: Session[] = [];
    while (stmt.step()) {
      const s = rowToSession(stmt.getAsObject() as unknown as SessionRow);
      if (wtKey !== undefined && (!s.worktreePath || normPathKey(s.worktreePath) !== wtKey)) continue;
      out.push(s);
    }
    stmt.free();
    if (wtKey !== undefined) {
      const offset = opts?.offset ?? 0;
      return opts?.limit !== undefined ? out.slice(offset, offset + opts.limit) : out.slice(offset);
    }
    return out;
  },

  /** Count matching {@link listAll}'s filter — the aggregate `total` for
   *  stream pagination. Takes the same scope filters so a scoped view's
   *  "show more" counts its own set. */
  countAll(opts?: { projectIds?: string[]; worktreeKey?: string }): number {
    const db = getDb();
    if (opts?.projectIds && opts.projectIds.length === 0) return 0;
    const where = ["archived = 0", "pinned_at IS NULL", "kind = 'chat'"];
    const params: BindValue[] = [];
    if (opts?.projectIds) {
      where.push(`project_id IN (${opts.projectIds.map(() => "?").join(", ")})`);
      for (const id of opts.projectIds) params.push(v(id));
    }
    const wtKey = opts?.worktreeKey;
    if (wtKey !== undefined) where.push("worktree_path IS NOT NULL");
    const stmt = db.prepare(`SELECT * FROM sessions WHERE ${where.join(" AND ")}`);
    stmt.bind(params);
    let n = 0;
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as { worktree_path: string | null };
      if (wtKey !== undefined && (!row.worktree_path || normPathKey(row.worktree_path) !== wtKey)) {
        continue;
      }
      n++;
    }
    stmt.free();
    return n;
  },

  /** Cross-project title-substring search (Ctrl+K unified search). Scans all
   *  non-archived sessions across every project, newest first. Desktop-scale
   *  session counts make a full-table LIKE scan cheap; no FTS index needed. */
  searchByTitle(query: string, opts?: { limit?: number }): Session[] {
    const db = getDb();
    const q = `%${query.trim()}%`;
    const params: BindValue[] = [v(q)];
    const limit = opts?.limit ?? 30;
    params.push(v(limit));
    const sql = `SELECT * FROM sessions WHERE archived = 0 AND kind = 'chat' AND title LIKE ? ORDER BY updated_at DESC, created_at DESC LIMIT ?`;
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
  },

  /** Cross-session bookmark search for the Ctrl+K palette: substring match
   *  over each bookmark's title (user rename) + excerpt (the selected text at
   *  add time). The bookmarks column is a small JSON array per session, so
   *  pull the non-null rows (most-recently-active first) and filter in
   *  memory — sql.js LIKE over the raw JSON string would also match keys /
   *  unrelated fields. */
  searchBookmarks(
    query: string,
    opts?: { limit?: number },
  ): Array<{ bookmark: SessionBookmark; sessionId: string; sessionTitle: string; projectId: string }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const limit = opts?.limit ?? 30;
    const stmt = getDb().prepare(
      "SELECT id, project_id, title, bookmarks FROM sessions WHERE archived = 0 AND kind = 'chat' AND bookmarks IS NOT NULL ORDER BY updated_at DESC",
    );
    const out: Array<{
      bookmark: SessionBookmark;
      sessionId: string;
      sessionTitle: string;
      projectId: string;
    }> = [];
    outer: while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as {
        id: string;
        project_id: string;
        title: string;
        bookmarks: string;
      };
      const list = safeJson(row.bookmarks);
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (!raw || typeof raw !== "object") continue;
        const bm = raw as SessionBookmark;
        const hay = `${bm.title ?? ""} ${bm.excerpt ?? ""}`.toLowerCase();
        if (hay.includes(q)) {
          out.push({ bookmark: bm, sessionId: row.id, sessionTitle: row.title, projectId: row.project_id });
          if (out.length >= limit) break outer;
        }
      }
    }
    stmt.free();
    return out;
  },

  /** Non-archived, unpinned sessions across ALL projects whose `updated_at`
   *  is older than `cutoffMs`. Candidate feed for the auto-archiver, which
   *  applies the per-project thresholds on top; pinned sessions are excluded
   *  here because they are never auto-archived regardless of staleness. */
  listStale(cutoffMs: number): Session[] {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM sessions WHERE archived = 0 AND pinned_at IS NULL AND kind = 'chat' AND updated_at < ?",
    );
    stmt.bind([v(cutoffMs)]);
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
  },

  get(id: string): Session | undefined {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
    stmt.bind([v(id)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as SessionRow) : undefined;
    stmt.free();
    return row ? rowToSession(row) : undefined;
  },

  /** Newest still-fresh session of a project — the "new session" button
   *  reuses this row instead of stacking empty ones (see
   *  `createOrReuseSession` in lib/sessionStart.ts). "Fresh" = still on the
   *  default title (the first sent message auto-renames the row, so a default
   *  title means it was never used), idle, unarchived and unpinned (pinned
   *  rows live in the left bar's global pinned section, not the project
   *  list, so "move it to the top" wouldn't apply to them). */
  findFreshByProject(projectId: string): Session | undefined {
    const db = getDb();
    const stmt = db.prepare(
      `SELECT * FROM sessions
       WHERE project_id = ? AND archived = 0 AND pinned_at IS NULL
         AND kind = 'chat' AND status = 'idle' AND title = 'New session'
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    );
    stmt.bind([v(projectId)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as SessionRow) : undefined;
    stmt.free();
    return row ? rowToSession(row) : undefined;
  },

  /** Newest still-fresh side chat of a parent — the ask tab's "new chat"
   *  button reuses this row instead of stacking empty ones (same rule as
   *  findFreshByProject: a row the first question never landed in is an empty
   *  shell, so refocusing it beats creating another one).
   *
   *  ## 「还没发过言」的判据是**有没有消息**,不是标题
   *
   *  这个判据以前写作 `title = 'Quick ask'`(占位标题 = 第一条消息还没来)。带角色那两档
   *  之后它**不再成立**:「档案」那一档的标题**就是档案名**(`sessionStart.ts` 里那段 ——
   *  用户挑的是"它叫这个、它是这个角色",不该被第一句话覆盖掉),所以那个壳的标题永远不是
   *  `Quick ask`,按标题判就永远认不出它曾经被复用 —— 结果是每点一次都多一个空壳。
   *
   *  换成 `NOT EXISTS(messages …)` 是**同一件事的直接写法**:"还没发过言"本来就是"没有
   *  消息"。行为差异只有一处:一条**空白正文**的消息(标题因此没被改写)以前会被当成
   *  "空壳"复用,现在不会 —— 那种壳确实已经用过了,不复用是对的。
   *
   *  ## `profileId` 收窄
   *
   *  「空白」「档案甲」「档案甲+记忆」都是同一个 kind、同一套空壳判据,不按角色收窄的话,
   *  点「档案甲」会拿到上一次点「空白」留下的那个壳,而**壳上看不出角色对不对**(建完就
   *  打开了,用户只会发现"它不是那个角色")。`null` = 「空白」那一路(只跟同样没有角色的
   *  壳复用),`undefined` = 不收窄。
   *
   *  ⚠️ 判据是**在 JSON 文本里找 `"id":"<id>"`**,不是解析 JSON —— sql.js 装的这版
   *  SQLite 不保证有 JSON1 扩展(`json_extract` 可能直接报错),而档案 id 的字符集被
   *  `AGENT_PROFILE_ID_RE` 限死在 `[a-z0-9_]`,塞不进 LIKE 的通配符。这条路窄但确定
   *  (模式里带着收尾的双引号,所以 `p_a` 不会命中 `p_ab`)。 */
  findFreshSideByParent(
    parentSessionId: string,
    profileId?: string | null,
  ): Session | undefined {
    const db = getDb();
    const where = [
      "kind = 'side'",
      "parent_session_id = ?",
      "status = 'idle'",
      // 「还没发过言」—— 见上面那一段:这是标题判据的直接写法。
      "NOT EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id)",
    ];
    const params: BindValue[] = [v(parentSessionId)];
    if (profileId !== undefined) {
      if (profileId === null) {
        where.push("agent_profile IS NULL");
      } else {
        where.push("agent_profile LIKE ?");
        params.push(v(`%"id":"${profileId}"%`));
      }
    }
    const stmt = db.prepare(
      `SELECT * FROM sessions WHERE ${where.join(" AND ")}
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    );
    stmt.bind(params);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as SessionRow) : undefined;
    stmt.free();
    return row ? rowToSession(row) : undefined;
  },

  /** List a main session's side chats (kind='side', parent = the given id),
   *  newest first. Powers the right-panel ask tab's list view. Unlike the
   *  left-bar list this orders by `created_at` — side chats are immutable
   *  Q&A threads, so creation order is the natural reading order (updated_at
   *  would shuffle the list whenever an old thread's status flips).
   *
   *  ⚠️ **「新建子对话」建出来的那些也在这里。** 它们同样是 kind='side'、同样挂在
   *  parent 上(见 A 决定:不为它们新加一种 kind)—— 于是右侧问答页签的列表里会同时
   *  出现"随手问一句"和"带角色的子对话",靠标题区分。这是**知道的代价**,不是漏掉:
   *  新加一种 kind 要动的地方(读归一、十几处 `kind='chat'` 钉法、枚举)远比多出来的
   *  几行多,而它们本来就是一个东西 —— 挂在父对话上的、用户自己开的、不进左栏的会话。 */
  listSideByParent(parentSessionId: string): Session[] {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM sessions WHERE kind = 'side' AND parent_session_id = ? ORDER BY created_at DESC",
    );
    stmt.bind([v(parentSessionId)]);
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
  },

  /** 一个对话里**跑过的每一步**各自的会话(`kind='node'`),最近碰过的在前。
   *
   *  这是节点会话**唯一**会被列出来的地方 —— 别的查询一律钉 `kind = 'chat'`(左边栏
   *  不该出现图上的节点),所以"列得出来"和"不漏进列表"两件事不冲突,靠的就是这里
   *  显式收口。
   *
   *  按 `updated_at` 排:用户最可能想回去说话的那一步,是他最近碰过的。
   *  不排 `created_at` —— 图上的先后顺序在**图**里,不在这张表里,拿建行时间冒充
   *  执行顺序会误导(改了图、重跑过之后尤其明显)。
   *
   *  没有分页:一张图是几十格,不是几千。 */
  listNodesByParent(parentSessionId: string): Session[] {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM sessions WHERE kind = 'node' AND parent_session_id = ? ORDER BY updated_at DESC, created_at DESC",
    );
    stmt.bind([v(parentSessionId)]);
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
  },

  /** 这个对话里有没有一格**留下过会话**。
   *
   *  看板的一句话答案:有 → "接着说"那条路走得通(哪怕进程重启过、看板是空的);
   *  没有 → 别摆那个入口(摆一个点开是空的按钮比不摆更让人困惑)。
   *
   *  做成 `EXISTS` 而不是"列出全部再判空":调用方问的只是有没有,不需要那几十行。
   *  口径与 {@link listNodesByParent} **一字不差**(同一个 `kind` 收窄),否则会出现
   *  "说有"而列出来是空的。 */
  hasNodeSessions(parentSessionId: string): boolean {
    const stmt = getDb().prepare(
      "SELECT 1 FROM sessions WHERE kind = 'node' AND parent_session_id = ? LIMIT 1",
    );
    stmt.bind([v(parentSessionId)]);
    const found = stmt.step();
    stmt.free();
    return found;
  },

  /** 这条自动化(`kind='automation'`)的隐藏会话。没有返回 undefined。
   *
   *  每条自动化**只留一个**后台会话:触发器每次 `fire()` 都先来这里取,取不到才建。
   *  于是"跑第十次"不会在库里堆出十个会话,而是同一个会话里第十轮 —— 上下文也是
   *  连续的(见 `automationRunner` 里的 D10)。
   *
   *  ⚠️ 归属那一列叫 `composer_mode`(列名在撒谎,它存的是 workflowId —— 见
   *  {@link SESSION_COLUMNS} 里那一条的注释)。所以这里写的是 `composer_mode`,不是
   *  `workflow_id`。
   *
   *  不可能有多条:同一 workflowId 只会被 `create()` 建一次(拿之前先查)。真出现多条
   *  时取最新的那条 —— 老的那条会变成孤儿(里面有历史消息,不删)。 */
  findAutomationByWorkflow(workflowId: string): Session | undefined {
    const db = getDb();
    const stmt = db.prepare(
      `SELECT * FROM sessions
       WHERE kind = 'automation' AND composer_mode = ?
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    );
    stmt.bind([v(workflowId)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as SessionRow) : undefined;
    stmt.free();
    return row ? rowToSession(row) : undefined;
  },

  /** 这个对话里**跑在 `nodeId` 那一格**的会话(`kind='node'`)。没有返回 undefined。
   *
   *  身份是 `(parent_session_id, node_id)`:对话说"属于谁",node_id 说"哪一格"。
   *  节点 id 建图时生成、存在工作流里,所以改标题 / 挪位置 / 连边都不影响它。
   *
   *  跑图时先来这里取,取不到才建(见 `orchestration/runner.ts` 的 `nodeSessionOf`)——
   *  于是一个对话里每一步只留一个会话,而不是每跑一次堆一个。
   *
   *  加 `node_id` 之前建的行是 `node_id IS NULL`,这里永远选不中 —— 它们是认不回来
   *  的孤儿,留着不删(里面有历史消息)。
   *
   *  不可能有多条:(同一对话, 同一节点)只会被 `create()` 建一次(拿之前先查)。
   *  真出现多条时取最新的那条。
   */
  findNodeByNodeId(parentSessionId: string, nodeId: string): Session | undefined {
    const db = getDb();
    const stmt = db.prepare(
      `SELECT * FROM sessions
       WHERE kind = 'node' AND parent_session_id = ? AND node_id = ?
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    );
    stmt.bind([v(parentSessionId), v(nodeId)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as SessionRow) : undefined;
    stmt.free();
    return row ? rowToSession(row) : undefined;
  },

  /** Persist claude's own session id so future turns can --resume. */
  updateClaudeSessionId(id: string, claudeSessionId: string): void {
    getDb().run("UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?", [
      v(claudeSessionId),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /**
   * 把一条自动化会话的发起会话记下来(守望起跑,见 `automationRunner.startWatch`)。
   *
   * 传 null = 抹掉 —— 与删除发起会话时那趟 `parent_session_id = NULL`(见本文件
   * 「主会话已删除」那段)是同一个语义:解析不到发起会话时,「注入到发起会话」
   * 那一步就该**明确失败**,而不是悄悄发到上一条会话里。
   */
  setParentSessionId(id: string, parentSessionId: string | null): void {
    getDb().run("UPDATE sessions SET parent_session_id = ?, updated_at = ? WHERE id = ?", [
      v(parentSessionId),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /**
   * 以某条会话为发起会话的那条自动化会话(`kind='automation'`)。守望面板的
   * 「上一次还在跑」按它查(见 `automationRunner.activeWatchOf`)。
   *
   * 只有守望起跑会把发起会话写到自动化会话上,所以这一查今天最多命中一条 ——
   * 按 `parent_session_id` 建不了索引也不碍事(全表扫一条 kind 过滤,同
   * `findAutomationByWorkflow`)。
   */
  findAutomationByOrigin(parentSessionId: string): Session | undefined {
    const db = getDb();
    const stmt = db.prepare(
      `SELECT * FROM sessions
       WHERE kind = 'automation' AND parent_session_id = ?
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    );
    stmt.bind([v(parentSessionId)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as SessionRow) : undefined;
    stmt.free();
    return row ? rowToSession(row) : undefined;
  },

  /** Backfill the materialized worktree path (first-turn materialization).
   *  Written BEFORE the turn is dispatched so a crash between creation and
   *  turn-start still leaves the session pointing at its worktree. */
  updateWorktreePath(id: string, worktreePath: string): void {
    getDb().run("UPDATE sessions SET worktree_path = ?, updated_at = ? WHERE id = ?", [
      v(worktreePath),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Degenerate a session back to local (its worktree was removed): null
   *  the worktreePath AND reset envMode to "local". Resetting the mode is
   *  the load-bearing half — with envMode left at "worktree", the next turn
   *  would hit resolveSessionCwd's un-materialized branch and silently
   *  create a NEW worktree instead of running in the project root the user
   *  was shown. History is kept. */
  clearWorktreePath(id: string): void {
    getDb().run(
      "UPDATE sessions SET worktree_path = NULL, env_mode = 'local' WHERE id = ?",
      [v(id)],
    );
    persist();
  },

  /** Session counts per worktree path (GROUP BY over the non-null rows) —
   *  feeds the worktree manager's orphan detection ("no session references
   *  this path anymore → safe to clean up"). */
  worktreeReferenceCounts(): Record<string, number> {
    const stmt = getDb().prepare(
      "SELECT worktree_path AS path, COUNT(*) AS n FROM sessions WHERE worktree_path IS NOT NULL GROUP BY worktree_path",
    );
    const out: Record<string, number> = {};
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as { path: string; n: number };
      out[row.path] = row.n;
    }
    stmt.free();
    return out;
  },

  /** All distinct materialized worktree paths (the session-environment
   *  roots). Feeds the path guards' "second legal root" — worktree sessions
   *  may operate inside their isolated checkout even though it sits outside
   *  every registered project. */
  listWorktreeRoots(): string[] {
    const stmt = getDb().prepare(
      "SELECT DISTINCT worktree_path FROM sessions WHERE worktree_path IS NOT NULL",
    );
    const out: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as { worktree_path: string };
      if (row.worktree_path) out.push(row.worktree_path);
    }
    stmt.free();
    return out;
  },

  /** All sessions (any kind/state) whose worktree_path points at the given
   *  directory. Powers the removal guard ("a running turn blocks worktree
   *  deletion"). Compared in JS with separator/case normalization — git's
   *  porcelain may echo the path in a different surface form than the one
   *  we stored at creation time. */
  listByWorktreePath(worktreePath: string): Session[] {
    const target = normPathKey(worktreePath);
    const stmt = getDb().prepare("SELECT * FROM sessions WHERE worktree_path IS NOT NULL");
    const out: Session[] = [];
    while (stmt.step()) {
      const s = rowToSession(stmt.getAsObject() as unknown as SessionRow);
      if (s.worktreePath && normPathKey(s.worktreePath) === target) out.push(s);
    }
    stmt.free();
    return out;
  },

  updateTitle(id: string, title: string): void {
    getDb().run("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", [v(title), v(Date.now()), v(id)]);
    persist();
  },

  updateStatus(id: string, status: Session["status"]): void {
    getDb().run("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?", [v(status), v(Date.now()), v(id)]);
    persist();
  },

  /** Persist the latest context-usage snapshot for a session. */
  updateSnapshot(id: string, snapshot: unknown): void {
    getDb().run("UPDATE sessions SET context_snapshot = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(snapshot)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the latest todo list (claude's TodoWrite) for a session. */
  updateTodos(id: string, todos: SessionTodoItem[]): void {
    getDb().run("UPDATE sessions SET todos = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(todos)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the latest subagent roster for a session. */
  updateSubagents(id: string, agents: SubagentSnapshot[]): void {
    getDb().run("UPDATE sessions SET subagents = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(agents)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the latest plan-mode draft for a session. */
  updatePlanDraft(id: string, plan: SessionPlanDraft): void {
    getDb().run("UPDATE sessions SET plan_draft = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(plan)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the most recent turn's modified-files snapshot (the "本轮修改"
   *  card). Pass null to clear it (e.g. after a rewind) so the card doesn't
   *  reappear on session reopen. */
  updateTurnFiles(id: string, files: TurnFileEntry[] | null): void {
    getDb().run("UPDATE sessions SET turn_files = ?, updated_at = ? WHERE id = ?", [
      v(files ? JSON.stringify(files) : null),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the per-turn token/cost history. Appended at each turn-end so
   *  the context-stats history popover survives restart. */
  updateUsageHistory(id: string, history: TurnUsageRecord[]): void {
    getDb().run("UPDATE sessions SET usage_history = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(history)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Replace the session's full bookmark list (renderer sends the complete
   *  array on every add/remove — single-digit cardinality, no incremental
   *  protocol needed). Empty array = "has bookmarks column but none left". */
  updateBookmarks(id: string, bookmarks: SessionBookmark[]): void {
    getDb().run("UPDATE sessions SET bookmarks = ?, updated_at = ? WHERE id = ?", [
      v(JSON.stringify(bookmarks)),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Persist the current turn's subagent transcripts (full map replace —
   *  the adapter emits replace-semantics per-agent arrays, RuntimeManager
   *  keeps the merged map). Pass null to clear (new turn starting). */
  updateSubagentTranscripts(id: string, transcripts: Session["subagentTranscripts"]): void {
    getDb().run("UPDATE sessions SET subagent_transcripts = ?, updated_at = ? WHERE id = ?", [
      v(transcripts ? JSON.stringify(transcripts) : null),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Light full-table scan for cross-session usage stats: fetches only the
   *  provider id + custom-model binding + usage history of sessions that have
   *  one. Rows with an unparseable history blob are skipped (safeJson returns
   *  the raw string — the Array.isArray guard drops it). */
  listUsageRows(): Array<{
    id: string;
    kind: string;
    providerId: string;
    customModelId: string | null;
    usageHistory: TurnUsageRecord[];
  }> {
    const stmt = getDb().prepare(
      "SELECT id, kind, provider_id, custom_model_id, usage_history FROM sessions WHERE usage_history IS NOT NULL",
    );
    const out: Array<{
      id: string;
      kind: string;
      providerId: string;
      customModelId: string | null;
      usageHistory: TurnUsageRecord[];
    }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as {
        id: string;
        kind: string | null;
        provider_id: string | null;
        custom_model_id: string | null;
        usage_history: string | null;
      };
      const parsed = safeJson(row.usage_history);
      if (!Array.isArray(parsed)) continue;
      out.push({
        id: row.id,
        kind: row.kind ?? "chat",
        providerId: row.provider_id ?? "claude-sdk",
        customModelId: row.custom_model_id ?? null,
        usageHistory: parsed as TurnUsageRecord[],
      });
    }
    stmt.free();
    return out;
  },

  /** Persist which custom-model config this session is bound to (null = built-in). */
  updateCustomModelId(id: string, customModelId: string | null): void {
    getDb().run("UPDATE sessions SET custom_model_id = ?, updated_at = ? WHERE id = ?", [
      v(customModelId),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /**
   * Persist the conversation's plugin binding. `null` / an empty list clears
   * the binding back to the legacy unrestricted state. Names are de-duplicated
   * in first-seen order; install/enable validity is checked when each turn is
   * assembled, so this state can never resurrect an uninstalled/disabled plugin.
   */
  updateActivePluginNames(id: string, names: string[] | null): void {
    const normalized = names ? [...new Set(names.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()))] : [];
    getDb().run("UPDATE sessions SET active_plugin_names = ?, updated_at = ? WHERE id = ?", [
      v(normalized.length > 0 ? JSON.stringify(normalized) : null),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Hard-delete a session. Child messages cascade-delete via
   *  messages.session_id ON DELETE CASCADE. Deleting a MAIN session keeps its
   *  side chats alive (their Q&A history has standalone value) — their
   *  parent_session_id is nulled here so the UI shows「主会话已删除」instead of
   *  a dangling pointer. */
  delete(id: string): void {
    const db = getDb();
    db.run("UPDATE sessions SET parent_session_id = NULL, updated_at = ? WHERE parent_session_id = ?", [
      v(Date.now()),
      v(id),
    ]);
    db.run("DELETE FROM sessions WHERE id = ?", [v(id)]);
    persist();
  },

  /** Set the archived (soft-delete) flag. */
  setArchived(id: string, archived: boolean): void {
    getDb().run("UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?", [
      v(archived ? 1 : 0),
      v(Date.now()),
      v(id),
    ]);
    persist();
  },

  /** Pin/unpin a session within its project: pinned rows write the current
   *  timestamp (most recent pin sorts first), unpinned rows write NULL.
   *  Does NOT bump `updated_at` — pinning is metadata, not activity, so it
   *  doesn't disturb the activity ordering of the unpinned group. */
  setPinned(id: string, pinned: boolean): void {
    getDb().run("UPDATE sessions SET pinned_at = ? WHERE id = ?", [
      v(pinned ? Date.now() : null),
      v(id),
    ]);
    persist();
  },

  /** Update session-scoped settings (model, effort, permissionMode,
   *  customModelId, providerId, project re-aim). */
  updateSettings(
    id: string,
    patch: { model?: string; effort?: string; permissionMode?: string; workflowId?: string; customModelId?: string | null; providerId?: string; envMode?: string; wtStyle?: string | null; worktreePath?: string | null; projectId?: string },
  ): void {
    const sets: string[] = [];
    const vals: BindValue[] = [];
    if (patch.model !== undefined) { sets.push("model = ?"); vals.push(v(patch.model)); }
    if (patch.effort !== undefined) { sets.push("effort = ?"); vals.push(v(patch.effort)); }
    if (patch.permissionMode !== undefined) { sets.push("permission_mode = ?"); vals.push(v(patch.permissionMode)); }
    if (patch.workflowId !== undefined) { sets.push("composer_mode = ?"); vals.push(v(patch.workflowId)); }
    if (patch.customModelId !== undefined) { sets.push("custom_model_id = ?"); vals.push(v(patch.customModelId)); }
    if (patch.providerId !== undefined) { sets.push("provider_id = ?"); vals.push(v(patch.providerId)); }
    // Directory re-aim (new-session panel's switcher). The FRESH-ONLY guard
    // lives in the IPC handler; this is just the write.
    if (patch.projectId !== undefined) { sets.push("project_id = ?"); vals.push(v(patch.projectId)); }
    // Working-environment intent (fresh-row re-aim at "new session"). Only
    // meaningful while the row is still un-materialized; later writes are
    // ignored by the callers.
    if (patch.envMode !== undefined) { sets.push("env_mode = ?"); vals.push(v(patch.envMode)); }
    // Worktree-form intent, same un-materialized-only contract as envMode.
    // null clears a stale intent (row flipped back to local).
    if (patch.wtStyle !== undefined) { sets.push("wt_style = ?"); vals.push(v(patch.wtStyle)); }
    // null clears a leftover bind (fresh row re-aimed back at local).
    if (patch.worktreePath !== undefined) { sets.push("worktree_path = ?"); vals.push(v(patch.worktreePath)); }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    vals.push(v(Date.now()), v(id));
    getDb().run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, vals);
    persist();
  },
};

/* ─────────────────────────────── Messages ─────────────────────────────── */

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string; // JSON string
  created_at: number;
}

function rowToMessage(r: MessageRow): MessageRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as MessageRecord["role"],
    content: JSON.parse(r.content),
    createdAt: r.created_at,
  };
}

export const MessageRepo = {
  /**
   * Cheap existence probe: does the session hold ANY persisted message?
   * Backs the updateSettings freshness guard (the directory re-aim is only
   * for threads that haven't started yet) without pulling message bodies.
   */
  hasAny(sessionId: string): boolean {
    const db = getDb();
    const stmt = db.prepare("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1");
    stmt.bind([v(sessionId)]);
    const found = stmt.step();
    stmt.free();
    return found;
  },

  /**
   * Replace all messages for a session with the given snapshot. The renderer
   * sends the full ChatMessage[] at turn boundaries (turn.done / error); we
   * wipe and re-insert in one transaction so the table always reflects the
   * last-complete view. Simple and avoids per-delta write churn.
   */
  replaceAll(sessionId: string, messages: MessageRecord[]): void {
    const db = getDb();
    db.run("BEGIN");
    try {
      db.run("DELETE FROM messages WHERE session_id = ?", [v(sessionId)]);
      const stmt = db.prepare(
        "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const m of messages) {
        stmt.run([v(m.id), v(m.sessionId), v(m.role), v(JSON.stringify(m.content)), v(m.createdAt)]);
      }
      stmt.free();
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },

  /**
   * List messages for a session.
   *
   * - No opts: legacy full-list behavior (every row, ascending). Used by code
   *   paths that still want the complete history (e.g. initial schema loads).
   * - With opts: cursor-paginated. The most recent `limit` rows are returned
   *   ascending; pass `beforeCreatedAt` + `beforeId` (the oldest already-loaded
   *   row's timestamp + id) to fetch the page above it. The `(created_at, id)`
   *   tiebreaker guards against ms-collisions when many messages share a
   *   timestamp. `hasMore` is true when more older rows remain.
   */
  listBySession(
    sessionId: string,
    opts?: { limit?: number; beforeCreatedAt?: number; beforeId?: string },
  ): { messages: MessageRecord[]; hasMore: boolean } {
    const limit = opts?.limit;
    const before = opts?.beforeCreatedAt;
    const beforeId = opts?.beforeId;
    const db = getDb();

    // Unpaginated path — keep the historical shape for callers that haven't
    // opted in (they get all rows and ignore `hasMore`).
    if (limit == null) {
      const stmt = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC");
      stmt.bind([v(sessionId)]);
      const out: MessageRecord[] = [];
      while (stmt.step()) out.push(rowToMessage(stmt.getAsObject() as unknown as MessageRow));
      stmt.free();
      return { messages: out, hasMore: false };
    }

    // 取数一律降序:多取的那一条(判 `hasMore` 用的探针)**永远在降序结果的末尾**
    // —— 它是紧挨着窗口下面那一条,也就是比这一页更老的一条。丢掉末尾、剩下的反转
    // 成升序,就是这一页。
    //
    // ⚠️ 这里踩过(`rows.slice(1)`):`slice(1)` 丢的是**开头**,而降序结果的开头是
    // 这一页**最新**的那条。症状分两种,都不显眼:
    //   - 第一页:返回的是最老的 n 条而不是最新的 n 条,而且 `hasMore` 报 true,
    //     界面于是"打开一段长对话看到的是它的开头";
    //   - 往上翻页:每页都漏掉紧挨着游标的那一条,连翻几页之后越漏越多
    //     (实测 450 条的对话只翻出 400 条,丢的 50 条正好散在页边界上)。
    // 两个分支的形状是一样的,所以两处都要 `slice(0, -1)`。
    const fetchN = limit + 1;
    const rows: MessageRecord[] = [];
    if (before == null || beforeId == null) {
      // 第一页 = 最新的 n+1 条。
      const stmt = db.prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      );
      stmt.bind([v(sessionId), v(fetchN)]);
      while (stmt.step()) rows.push(rowToMessage(stmt.getAsObject() as unknown as MessageRow));
      stmt.free();
    } else {
      // 游标支:游标 `(beforeCreatedAt, beforeId)` 指向**已加载那一段最老的那条**
      // (渲染端传的是 `list[0]`,见 sessionStore 的 `loadOlderMessages`),要取的是比
      // 它**更老**的一整页 —— 所以是 `created_at < 游标` 的降序前 n+1 条。
      //
      // Tiebreaker: (created_at, id) so rows with identical createdAt still
      // page cleanly without skipping or duplicating.
      const stmt = db.prepare(
        `SELECT * FROM messages WHERE session_id = ?
         AND (created_at < ? OR (created_at = ? AND id < ?))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      );
      stmt.bind([v(sessionId), v(before), v(before), v(beforeId), v(fetchN)]);
      while (stmt.step()) rows.push(rowToMessage(stmt.getAsObject() as unknown as MessageRow));
      stmt.free();
    }
    const hasMore = rows.length === fetchN;
    const page = hasMore ? rows.slice(0, -1) : rows;
    page.reverse();
    return { messages: page, hasMore };
  },

  /** Incremental upsert: insert-or-update the given messages by primary key.
   *  Unlike {@link replaceAll}, this leaves all other rows for the session
   *  untouched, so callers that only changed a few messages don't pay the
   *  O(N) DELETE+re-INSERT cost of a full snapshot write.
   *
   *  Use this when the change set is additive or a localized mutation (e.g.
   *  a turn appended a few rows, or a turn-files card was attached to the
   *  trailing assistant message). Use {@link replaceAll} when rows must be
   *  truncated (edit-and-resend, rewind mutations that remove history). */
  upsertMany(messages: MessageRecord[]): void {
    if (messages.length === 0) return;
    const db = getDb();
    db.run("BEGIN");
    try {
      const stmt = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           role = excluded.role,
           content = excluded.content,
           created_at = excluded.created_at`,
      );
      for (const m of messages) {
        stmt.run([v(m.id), v(m.sessionId), v(m.role), v(JSON.stringify(m.content)), v(m.createdAt)]);
      }
      stmt.free();
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },

  /** Delete every message at or after a cursor (createdAt, id) and insert the
   *  given replacement rows in one transaction. This is the paginated-history-
   *  safe form of "edit and resend": it truncates the suffix the user is
   *  branching from (including rows that may not be loaded in renderer memory
   *  because they were never paginated in) and writes only the new messages,
   *  so unloaded older history survives.
   *
   *  The (createdAt, id) tiebreaker matches the pagination cursor semantics in
   *  {@link listBySession}: "at or after" means `created_at > cursor.createdAt`
   *  OR (`created_at = cursor.createdAt` AND `id >= cursor.id`). */
  truncateFromAndInsert(
    sessionId: string,
    cursor: { createdAt: number; id: string },
    messages: MessageRecord[],
  ): void {
    const db = getDb();
    db.run("BEGIN");
    try {
      db.run(
        `DELETE FROM messages WHERE session_id = ?
         AND (created_at > ? OR (created_at = ? AND id >= ?))`,
        [v(sessionId), v(cursor.createdAt), v(cursor.createdAt), v(cursor.id)],
      );
      if (messages.length > 0) {
        const stmt = db.prepare(
          `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id,
             role = excluded.role,
             content = excluded.content,
             created_at = excluded.created_at`,
        );
        for (const m of messages) {
          stmt.run([v(m.id), v(m.sessionId), v(m.role), v(JSON.stringify(m.content)), v(m.createdAt)]);
        }
        stmt.free();
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },
};

/* ─────────────────────────────── Settings ──────────────────────────────── */
/* Generic key-value store for app preferences (e.g. the configured claude CLI
 * path). Keeps us from adding a table per setting. */

export const SettingRepo = {
  get(key: string): string | null {
    const db = getDb();
    const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    stmt.bind([v(key)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as { value: BindValue }) : undefined;
    stmt.free();
    return row ? String(row.value) : null;
  },

  /** Read multiple keys in one pass. sql.js is synchronous so this is a single
   *  tick — cheaper for the renderer than N parallel `setting.get` round-trips
   *  (one IPC instead of N). Missing keys map to `null`. */
  getMany(keys: string[]): Record<string, string | null> {
    const db = getDb();
    const out: Record<string, string | null> = {};
    const stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    for (const k of keys) {
      stmt.bind([v(k)]);
      const found = stmt.step();
      out[k] = found ? String((stmt.getAsObject() as { value: BindValue }).value) : null;
      stmt.reset();
    }
    stmt.free();
    return out;
  },

  /** Upsert a setting value. */
  set(key: string, value: string): void {
    getDb().run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [v(key), v(value)],
    );
    persist();
  },
};

/* ──────────────────────────────── 工作流 ───────────────────────────────── */

/** 工作流表里的一行。
 *
 * **这一层只管存储** —— 与代码里那六个内置工作流的合并、以及「恢复默认」的语义,
 * 都在 `main/orchestration/` 里做。放在这里会让"删一行"这种存储操作背上业务含义,
 * 而调用方会以为自己在做存储。 */
export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  /** true = 这一行是对某个内置工作流的覆盖(不是用户新建的)。 */
  builtin: boolean;
  doc: WorkflowDoc;
  updatedAt: number;
}

function rowToWorkflow(r: Record<string, BindValue>): WorkflowRow {
  return {
    id: String(r.id),
    name: String(r.name),
    description: r.description === null ? null : String(r.description),
    icon: r.icon === null ? null : String(r.icon),
    builtin: Number(r.builtin) === 1,
    // payload 是我们自己写进去的 WorkflowDoc。解析失败说明文件被外部改坏了 ——
    // 不抛异常(那会让整个列表打不开),退化成一份空文档,让它至少能被看见和删掉。
    doc: parseWorkflowDoc(String(r.payload)),
    updatedAt: Number(r.updated_at),
  };
}

function parseWorkflowDoc(raw: string): WorkflowDoc {
  try {
    return JSON.parse(raw) as WorkflowDoc;
  } catch {
    return { id: "", name: "", nodes: [], edges: [], builtin: false, updatedAt: 0 };
  }
}

function getWorkflowRow(id: string): WorkflowRow | null {
  const stmt = getDb().prepare("SELECT * FROM workflows WHERE id = ?");
  stmt.bind([v(id)]);
  const found = stmt.step();
  const row = found ? (stmt.getAsObject() as Record<string, BindValue>) : null;
  stmt.free();
  return row ? rowToWorkflow(row) : null;
}

export const WorkflowRepo = {
  /** 全部行(用户对内置的覆盖 + 用户自建的)。内置的默认版不在这个表里。 */
  list(): WorkflowRow[] {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM workflows ORDER BY sort_order ASC, created_at ASC",
    );
    const out: WorkflowRow[] = [];
    while (stmt.step()) out.push(rowToWorkflow(stmt.getAsObject() as Record<string, BindValue>));
    stmt.free();
    return out;
  },

  get: getWorkflowRow,

  /** 写入或覆盖一行。`doc.id` 就是主键 —— 对内置工作流来说,写一行就是"覆盖它的默认版"。 */
  save(doc: WorkflowDoc): void {
    const db = getDb();
    // 用局部函数而不是 `this.get` —— 对象字面量的方法一旦被解构,`this` 就断了。
    const existing = getWorkflowRow(doc.id);
    // 新建的排在最后(和 projects 的 sort_order 同一条规则);覆盖时保持原位。
    let sortOrder = 0;
    if (existing === null) {
      const stmt = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM workflows");
      stmt.step();
      sortOrder = Number((stmt.getAsObject() as { next: BindValue }).next);
      stmt.free();
    }
    const now = Date.now();
    db.run(
      `INSERT INTO workflows (id, name, description, icon, builtin, payload, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name        = excluded.name,
         description = excluded.description,
         icon        = excluded.icon,
         payload     = excluded.payload,
         updated_at  = excluded.updated_at`,
      [
        v(doc.id),
        v(doc.name),
        v(doc.description ?? null),
        v(doc.icon ?? null),
        v(doc.builtin),
        v(JSON.stringify(doc)),
        v(sortOrder),
        v(now),
        v(now),
      ],
    );
    persist();
  },

  /** 删掉一行。**删掉对某个内置工作流的覆盖,就等于「恢复默认」** —— 代码里的
   *  默认版立刻回来,不需要在表里另存一份原版。 */
  remove(id: string): void {
    getDb().run("DELETE FROM workflows WHERE id = ?", [v(id)]);
    persist();
  },
};

/* ────────────────────────── 工作流的运行(续跑) ────────────────────────── */

/**
 * 一次运行的结局。
 *
 * 前两个是"活着的时候"写的,后三个是收尾写的,`interrupted` 则是**只有下次启动
 * 才写得出来**的一种 —— 上一次进程死的时候它还在跑(见 `db.ts` 的 `migrate`)。
 * 和 `cancelled` 分开是因为它们是两句不同的话:"你按了停止"和"上次断在这儿了"。
 */
export type WorkflowRunStatus = "running" | "interrupted" | "success" | "failed" | "cancelled";

export interface WorkflowRunRow {
  id: string;
  sessionId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  /** 正停在哪几格等用户拍板。一个都没在等就是空数组。 */
  awaiting: string[];
  /** JSON 的 `RunSnapshot`。**这一层不认识它** —— 形状归 `orchestration/runStore.ts`,
   *  这里只负责原样存取(同 `workflows.payload` 对 `WorkflowDoc` 的做法)。 */
  payload: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowRunDbRow {
  id: string;
  session_id: string;
  workflow_id: string;
  status: string;
  awaiting_node: string | null;
  payload: string;
  created_at: number;
  updated_at: number;
}

/**
 * `awaiting_node` 那一列是**逗号分隔的一串节点 id**(见 `resumableFor`)。
 *
 * 空串和 NULL 都收成空数组 —— 库里两种都可能出现(没在等的运行写的是空数组,它
 * `join` 出来就是空串;老一点的行可能是 NULL)。
 */
function splitAwaiting(raw: string | null): string[] {
  if (raw === null) return [];
  return raw.split(",").filter((s) => s.length > 0);
}

export const WorkflowRunRepo = {
  /**
   * 把这次运行**此刻的样子**写下来(第一次写就是建行)。开跑、每步定案、停在岔路口、
   * 收尾,四处都走它 —— 分成 insert/update 两个入口的话,"这一行到底建出来没有"就有
   * 两个答案,而漏建的那一条路只会在重启之后才暴露。
   *
   * `created_at` 只在第一次写时定下(upsert 的 DO UPDATE 不碰它),所以它是"这次
   * 运行什么时候开始的"。
   */
  save(args: {
    id: string;
    sessionId: string;
    workflowId: string;
    status: WorkflowRunStatus;
    payload: string;
    /** 正停在等用户的那些节点。见 `WorkflowRunRow.awaiting`。 */
    awaiting: readonly string[];
  }): void {
    const now = Date.now();
    getDb().run(
      `INSERT INTO workflow_runs
         (id, session_id, workflow_id, status, awaiting_node, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status        = excluded.status,
         awaiting_node = excluded.awaiting_node,
         payload       = excluded.payload,
         updated_at    = excluded.updated_at`,
      [
        v(args.id),
        v(args.sessionId),
        v(args.workflowId),
        v(args.status),
        v(args.awaiting.join(",")),
        v(args.payload),
        v(now),
        v(now),
      ],
    );
    persist();
  },

  /** 某个对话里的一条运行。没有返回 null。 */
  get(id: string): WorkflowRunRow | null {
    const stmt = getDb().prepare("SELECT * FROM workflow_runs WHERE id = ?");
    stmt.bind([v(id)]);
    const found = stmt.step();
    const row = found ? (stmt.getAsObject() as unknown as WorkflowRunDbRow) : null;
    stmt.free();
    return row ? rowToWorkflowRun(row) : null;
  },

  /**
   * 某个会话的**运行历史**,新的在前(自动化页要显示"最近几次")。
   *
   * 与 {@link resumableFor} 的区别是它**不挑状态**:那个只找"被中断且正等着某一步"
   * 的(续跑用),这个把所有运行都列出来(看历史用)。`payload` 照样原样返回 ——
   * 折叠成"每步的结局与摘要"是编排层的事(见 `orchestration/runStore.ts` 的
   * `decodeSnapshot`),这一层不认识那个形状。
   */
  listForSession(sessionId: string, limit: number): WorkflowRunRow[] {
    const stmt = getDb().prepare(
      `SELECT * FROM workflow_runs
        WHERE session_id = ?
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
    );
    stmt.bind([v(sessionId), v(limit)]);
    const out: WorkflowRunRow[] = [];
    while (stmt.step()) {
      out.push(rowToWorkflowRun(stmt.getAsObject() as unknown as WorkflowRunDbRow));
    }
    stmt.free();
    return out;
  },

  /**
   * 某个对话里、**正停在 `nodeId` 这一格**且被中断的那次运行。
   *
   * ## 为什么按节点查,而不是"最近一次被中断的运行"
   *
   * 用户点的是**某一张卡片**,而那张卡片属于哪一次运行是确定的。只按会话取最近一条
   * 的话,一个对话里跑过两轮之后,点第一轮那张旧卡会去续第二轮 —— 而它们问的根本不是
   * 同一件事。
   *
   * ## `awaiting_node` 是一张**列表**(逗号分隔)
   *
   * 两处岔路口可以同时就绪,于是两条都在等人(见 `RunState.awaiting`)—— 存单个的话,
   * 用户点**先停下的那一处**会看到"这条选择已经不适用了"。
   *
   * 所以这里是"取出这个对话里所有被中断的,再在 JS 里找"而不是一条 SQL 的等值匹配。
   * 代价可以忽略:`pruneSession` 把每个对话的行数压到十行以内,而这段代码一次点击才
   * 跑一遍 —— 拿它换一条能读懂的查询是划算的。
   *
   * 取最新的一条:同一格可以断过好几次(续一次、又断一次)。
   */
  resumableFor(sessionId: string, nodeId: string): WorkflowRunRow | null {
    const stmt = getDb().prepare(
      `SELECT * FROM workflow_runs
        WHERE session_id = ? AND status = 'interrupted'
        ORDER BY updated_at DESC`,
    );
    stmt.bind([v(sessionId)]);
    const rows: WorkflowRunRow[] = [];
    while (stmt.step()) {
      rows.push(rowToWorkflowRun(stmt.getAsObject() as unknown as WorkflowRunDbRow));
    }
    stmt.free();
    return rows.find((r) => r.awaiting.includes(nodeId)) ?? null;
  },

  /** 一个对话只留最近 `keep` 次运行。**开跑时清一次** —— 运行行会一直堆下去,而
   *  除了"最后一次能续跑的"以外,别的都只是历史。
   *
   *  `id` 那个次序是**并列时的决胜**:`created_at` 是毫秒,两次运行撞在同一毫秒上
   *  虽然少见但不是不可能(测试里就撞),而并列时 SQLite 返回哪几条是没保证的 ——
   *  同一个库两次跑出不同的结果,排查时会被自己误导。 */
  pruneSession(sessionId: string, keep: number): void {
    getDb().run(
      `DELETE FROM workflow_runs
        WHERE session_id = ?
          AND id NOT IN (
            SELECT id FROM workflow_runs
             WHERE session_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?
          )`,
      [v(sessionId), v(sessionId), v(keep)],
    );
    persist();
  },
};

function rowToWorkflowRun(r: WorkflowRunDbRow): WorkflowRunRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    workflowId: r.workflow_id,
    status: r.status as WorkflowRunStatus,
    awaiting: splitAwaiting(r.awaiting_node),
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ──────────────────────────────── 文献库 ───────────────────────────────── */

/** 生成带前缀的本地 id。与 customModel 的 `cm_...` 同构,前缀区分实体类型,
 *  便于在日志与错误信息里一眼看出这是什么。 */
function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把用户/AI 给的标识符规范化成存储形态。
 *  DOI:去 `https://doi.org/` 前缀、去空白、小写(DOI 大小写不敏感)。
 *  空串一律转 null —— 否则唯一索引会把「空串」当成一个真实值,导致第二条无 DOI
 *  的记录插入失败。 */
export function normalizeDoi(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  return s ? s.toLowerCase() : null;
}

/** arXiv ID:去 `arXiv:` 前缀与 `arxiv.org/abs/` 前缀,去版本号后缀(v1/v2),
 *  统一小写。去版本号是刻意的 —— 同一篇的 v1 与 v2 应当算同一条记录。 */
export function normalizeArxivId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, "");
  s = s.replace(/^arxiv:/i, "");
  s = s.replace(/\.pdf$/i, "");
  s = s.replace(/v\d+$/i, "");
  s = s.trim().toLowerCase();
  return s || null;
}

interface LibraryItemRow {
  id: string;
  kind: string | null;
  doi: string | null;
  arxiv_id: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  volume: string | null;
  issue: string | null;
  page: string | null;
  publisher: string | null;
  abstract: string | null;
  type: string;
  language: string | null;
  url: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  md_path: string | null;
  source: string | null;
  license: string | null;
  entry_mode: string | null;
  file_path: string | null;
  added_at: number;
  updated_at: number;
}

function rowToLibraryItem(r: LibraryItemRow): LibraryItem {
  return {
    id: r.id,
    // kind 列已退役（2026-09-24）：保留在库里但不再读写 —— 行为按扩展名分派。
    doi: r.doi ?? undefined,
    arxivId: r.arxiv_id ?? undefined,
    title: r.title,
    authors: (safeJson(r.authors) as LibraryAuthor[] | undefined) ?? [],
    year: r.year ?? undefined,
    venue: r.venue ?? undefined,
    volume: r.volume ?? undefined,
    issue: r.issue ?? undefined,
    page: r.page ?? undefined,
    publisher: r.publisher ?? undefined,
    abstract: r.abstract ?? undefined,
    type: (r.type as LibraryItemType) || "article",
    language: r.language ?? undefined,
    url: r.url ?? undefined,
    pdfPath: r.pdf_path ?? undefined,
    pdfSha256: r.pdf_sha256 ?? undefined,
    mdPath: r.md_path ?? undefined,
    source: r.source ?? undefined,
    license: r.license ?? undefined,
    // 老库 ALTER 出来的行全是 DEFAULT 'attached' —— 旧的文献流本来就是"文件在库里",
    // 语义正好对上。认不出(entry_mode 被手工改成别的)也按 attached:保守的那个方向。
    entryMode: r.entry_mode === "linked" ? "linked" : "attached",
    filePath: r.file_path ?? undefined,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
  };
}

/** 列表筛选条件。`collectionId === undefined` 表示不限集合;`null` 保留给
 *  「不属于任何集合」这种未来可能的智能视图,当前与 undefined 同义。 */
export interface LibraryListFilter {
  collectionId?: string | null;
  query?: string;
  /** 按 PDF 可用性筛。`none` 用于快速找「还没下到 PDF」的条目。
   *
   *  ⚠️ **这里引用 `PdfState`,不要再抄一份联合类型。** 原来它是一份手抄的名单,
   *  而 `PdfState` 加了 `not_found` 之后这一份没跟上 —— 于是筛选面板里根本没有
   *  这一档,`pdfStateClause` 的 `not_found` 分支连调都调不到。类型别名是唯一
   *  不会漂的写法。 */
  pdfState?: PdfState;
  limit?: number;
  offset?: number;
}

/** PDF 状态在 SQL 里的等价条件(与 `derivePdfState` 的语义保持一致)。
 *  单独抽出来是为了让 list 的 WHERE 拼接与 count 复用同一份判据。
 *
 *  ⚠️ **每一档都必须显式列出,`default` 不许回落成 `1=1`。**
 *  这里原来有个 `default: return "1=1"` 兜底,而 switch 里漏了 `not_found`
 *  —— 于是按「找不到来源」筛会返回**整个库**。谁也不会发现:列表看起来是满的,
 *  只是那条筛选没有生效。而这个函数签名的入参类型就是 `PdfState`,加一档状态
 *  时 TS 不会提醒这里的 switch 少了一个 case(`default` 把缺口吃掉了)。
 *  现在 default 抛出来,漏一档是当场一条错误,不是某天一个筛不对的列表。
 *
 *  两侧"哪几档"的名单在 `lib/pdfState.ts` 的 `PDF_STATE_ORDER`,
 *  `pdf-state-smoke` 拿同一组夹具走一遍 TS、走一遍真 SQL 逐档比对。 */
function pdfStateClause(state: NonNullable<LibraryListFilter["pdfState"]>): string {
  const jobStatus = "(SELECT j.status FROM download_jobs j WHERE j.item_id = i.id)";
  switch (state) {
    case "ready":
      return "i.pdf_path IS NOT NULL";
    // 没有文件、也没有**有效**的任务行。`done` 要算进来:`derivePdfState` 把
    // 「任务说完成了但没有文件」(文件被外部删了)判成 none,让用户重下 ——
    // 只认 `jobStatus IS NULL` 的话这条会掉出所有档,在界面上变成一个既不属于
    // 「缺 PDF」也不属于任何筛选的幽灵。
    case "none":
      return `i.pdf_path IS NULL AND (${jobStatus} IS NULL OR ${jobStatus} = 'done')`;
    case "queued":
      return `i.pdf_path IS NULL AND ${jobStatus} = 'pending'`;
    case "downloading":
      return `i.pdf_path IS NULL AND ${jobStatus} = 'running'`;
    case "needs_login":
      return `i.pdf_path IS NULL AND ${jobStatus} = 'needs_login'`;
    // ★ 这一档原先**不存在**,上面那个 default 把它静默吃掉了。
    case "not_found":
      return `i.pdf_path IS NULL AND ${jobStatus} = 'not_found'`;
    case "failed":
      return `i.pdf_path IS NULL AND ${jobStatus} IN ('failed','rate_limited')`;
    default: {
      // 到了这里说明 `PdfState` 加了新状态而上面没跟。宁可炸,不可筛错。
      const never: never = state;
      throw new Error(`pdfStateClause 漏了一档 PDF 状态:${String(never)}`);
    }
  }
}

export const LibraryRepo = {
  /** 按条件列出条目。`query` 在标题/作者/摘要/期刊上做大小写不敏感的子串匹配。
   *  注意:这是**元数据**检索;正文全文检索走 ripgrep(见 main/library/fulltext.ts),
   *  因为 sql.js 不含 FTS5。 */
  list(filter: LibraryListFilter = {}): { items: LibraryItem[]; total: number } {
    const db = getDb();
    const where: string[] = [];
    const params: BindValue[] = [];

    if (filter.collectionId) {
      where.push(
        "i.id IN (SELECT ci.item_id FROM library_collection_items ci WHERE ci.collection_id = ?)",
      );
      params.push(v(filter.collectionId));
    }
    if (filter.query?.trim()) {
      // LIKE 的转义:用户输入里的 % 和 _ 是通配符,必须转义才能当字面量搜
      const needle = `%${filter.query.trim().toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(
        `(LOWER(i.title) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(i.authors,'')) LIKE ? ESCAPE '\\'
          OR LOWER(IFNULL(i.abstract,'')) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(i.venue,'')) LIKE ? ESCAPE '\\')`,
      );
      params.push(v(needle), v(needle), v(needle), v(needle));
    }
    if (filter.pdfState) {
      where.push(pdfStateClause(filter.pdfState));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM library_items i ${whereSql}`);
    countStmt.bind(params);
    countStmt.step();
    const total = Number((countStmt.getAsObject() as { n: number }).n ?? 0);
    countStmt.free();

    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    const stmt = db.prepare(
      `SELECT i.* FROM library_items i ${whereSql} ORDER BY i.added_at DESC LIMIT ? OFFSET ?`,
    );
    stmt.bind([...params, v(limit), v(offset)]);
    const items: LibraryItem[] = [];
    while (stmt.step()) items.push(rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow));
    stmt.free();
    return { items, total };
  },

  /**
   * 全部条目 —— **不分页**。
   *
   * 与 `list()` 只差一点:`list` 有 200 条的默认上限(左栏那棵树就是按页拉的),
   * 而**给 AI 的那份清单必须是全量**。少几条比慢一点糟得多:模型会以为库里就这些,
   * 用户也看不出少了什么,而两边都不会报错。
   * （原 `listByKind`：kind 退役后没有"按库"的口径，全量返回，调用方自行按分类过滤。）
   */
  listAllItems(): LibraryItem[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items ORDER BY added_at DESC");
    stmt.bind([]);
    const out: LibraryItem[] = [];
    while (stmt.step()) out.push(rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow));
    stmt.free();
    return out;
  },

  /**
   * 每个库内路径被多少条记录引用着(pdf / md / 通用文件三列都算)。
   *
   * 「彻底删除」靠它判断一个文件还有没有别人在用,而**它不能由 `list()` 拼出来**:
   * `list` 有 200 条的默认上限,拿它当"全库"用,大库上就会漏判 —— 漏判的后果是
   * 删掉另一条记录的 PDF。
   *
   * 为什么真的会共用:PDF 按内容哈希寻址,**同一篇先用 DOI 导、又用 arXiv ID 导了
   * 一次**就是两条记录指向同一个路径。删掉其中一条时那个文件必须留下。
   *
   * ## ⚠️ `file_path` 这一列非数不可
   *
   * 通用条目(`entryMode` 那条流)的文件落在 `file_path` 上,不是 pdf/md。少了这一列,
   * 「彻底删除」在删 attached 副本时看到的是一张**不完整的引用表**:两条记录指着同一份
   * 副本时,删除方会以为自己是唯一的引用者,把文件端走 —— 而另一条记录还在库里,
   * 它从此指向一个不存在的文件(预览、打开、转录全部报"文件不在了")。
   *
   * **`linked` 的 `file_path` 是库外的绝对路径**,它也会被数进来。这是对的、且必须的:
   * 同一条库外路径被两条记录引用时,删掉其中一条同样不该动它(而且那份根本不是库管的,
   * 见 `ipc/library.ts` 的 `dropAbs`)。
   *
   * 数的是**记录的条数**而不是"有效引用数":一行 `file_path` 是 NULL 的行不该把计数
   * 抬起来(bump 里已经挡了空值),否则一条没有文件的记录会让别人以为"还有人在用"。
   */
  pathRefCounts(): Map<string, number> {
    const db = getDb();
    const stmt = db.prepare("SELECT pdf_path, md_path, file_path FROM library_items");
    const out = new Map<string, number>();
    const bump = (p: unknown) => {
      if (typeof p !== "string" || !p) return;
      out.set(p, (out.get(p) ?? 0) + 1);
    };
    while (stmt.step()) {
      const row = stmt.getAsObject() as { pdf_path: unknown; md_path: unknown; file_path: unknown };
      bump(row.pdf_path);
      bump(row.md_path);
      bump(row.file_path);
    }
    stmt.free();
    return out;
  },

  get(id: string): LibraryItem | null {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items WHERE id = ?");
    stmt.bind([v(id)]);
    const found = stmt.step();
    const row = found ? rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow) : null;
    stmt.free();
    return row;
  },

  /** 按 DOI / arXiv ID 查已有条目 —— 入库前查重与下载前判重的唯一入口。 */
  findByDoi(doi: string): LibraryItem | null {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items WHERE doi = ?");
    stmt.bind([v(normalized)]);
    const found = stmt.step();
    const row = found ? rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow) : null;
    stmt.free();
    return row;
  },

  findByArxivId(arxivId: string): LibraryItem | null {
    const normalized = normalizeArxivId(arxivId);
    if (!normalized) return null;
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items WHERE arxiv_id = ?");
    stmt.bind([v(normalized)]);
    const found = stmt.step();
    const row = found ? rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow) : null;
    stmt.free();
    return row;
  },

  /** 按 DOI 优先、arXiv 其次查重。两条都能命中时优先 DOI(它是更权威的标识)。 */
  findExisting(ids: { doi?: string | null; arxivId?: string | null }): LibraryItem | null {
    if (ids.doi) {
      const byDoi = LibraryRepo.findByDoi(ids.doi);
      if (byDoi) return byDoi;
    }
    if (ids.arxivId) return LibraryRepo.findByArxivId(ids.arxivId);
    return null;
  },

  /** 按 PDF 内容的 sha256 查。
   *
   *  导入本地 PDF 时必须先查这个:那一批文件常常**没有** DOI/arXiv 可匹配(所以
   *  findExisting 会返回 null),但同一份 PDF 导两次是完全可能的。内容寻址让它们
   *  落到同一个 papers 路径上,这里再把「同内容」认出来,就不会多出一条重复条目。 */
  findByPdfSha(sha256: string): LibraryItem | null {
    if (!sha256) return null;
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items WHERE pdf_sha256 = ? LIMIT 1");
    stmt.bind([v(sha256)]);
    const found = stmt.step();
    const row = found ? rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow) : null;
    stmt.free();
    return row;
  },

  /**
   * 新增或更新一条文献。
   *
   * 查重后**只补空字段**,不覆盖已有值 —— 用户/AI 补的元数据不该被一次重新检索冲掉。
   * 返回落库后的完整记录。
   */
  upsert(input: {
    id?: string;
    doi?: string | null;
    arxivId?: string | null;
    title?: string;
    authors?: LibraryAuthor[];
    year?: number;
    venue?: string;
    volume?: string;
    issue?: string;
    page?: string;
    publisher?: string;
    abstract?: string;
    type?: LibraryItemType;
    language?: string;
    url?: string;
    source?: string;
    license?: string;
    /** 通用文件条目的落法。省略 = attached(旧的文献流就是这个语义)。 */
    entryMode?: "linked" | "attached";
    /** 通用文件路径:attached 相对库根 / linked 外部绝对路径(可为目录)。 */
    filePath?: string | null;
  }): LibraryItem {
    const db = getDb();
    const now = Date.now();
    const doi = normalizeDoi(input.doi);
    const arxivId = normalizeArxivId(input.arxivId);
    const existing = LibraryRepo.findExisting({ doi, arxivId });

    if (existing) {
      // 只填空,不覆盖:已有值可能是用户手工修正过的。
      // **kind 不在这里改** —— 同一篇 PDF 被再次导入到别的库时,命中的是已有条目,
      // 把它搬到那个库会让用户原来那份凭空消失。要搬得走显式的「移动」动作。
      db.run(
        `UPDATE library_items SET
           title = CASE WHEN (title IS NULL OR title = '') THEN ? ELSE title END,
           authors = CASE WHEN (authors IS NULL OR authors = '' OR authors = '[]') THEN ? ELSE authors END,
           year = COALESCE(year, ?),
           venue = COALESCE(venue, ?),
           volume = COALESCE(volume, ?),
           issue = COALESCE(issue, ?),
           page = COALESCE(page, ?),
           publisher = COALESCE(publisher, ?),
           abstract = CASE WHEN (abstract IS NULL OR abstract = '') THEN ? ELSE abstract END,
           type = COALESCE(?, type),
           language = COALESCE(language, ?),
           url = COALESCE(url, ?),
           doi = COALESCE(doi, ?),
           arxiv_id = COALESCE(arxiv_id, ?),
           updated_at = ?
         WHERE id = ?`,
        [
          v(input.title ?? ""),
          v(input.authors?.length ? JSON.stringify(input.authors) : null),
          v(input.year), v(input.venue),
          v(input.volume), v(input.issue), v(input.page), v(input.publisher),
          v(input.abstract ?? ""),
          v(input.type), v(input.language), v(input.url),
          v(doi), v(arxivId), v(now), v(existing.id),
        ],
      );
      persist();
      return LibraryRepo.get(existing.id)!;
    }

    const id = input.id ?? makeId("li");
    db.run(
      `INSERT INTO library_items
         (id, doi, arxiv_id, title, authors, year, venue, volume, issue, page, publisher,
          abstract, type, language, url, source, license, entry_mode, file_path, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v(id), v(doi), v(arxivId), v(input.title ?? "(无标题)"),
        v(input.authors?.length ? JSON.stringify(input.authors) : null),
        v(input.year), v(input.venue),
        v(input.volume), v(input.issue), v(input.page), v(input.publisher),
        v(input.abstract),
        v(input.type ?? "article"), v(input.language), v(input.url),
        v(input.source), v(input.license),
        v(input.entryMode ?? "attached"), v(input.filePath ?? null), v(now), v(now),
      ],
    );
    persist();
    return LibraryRepo.get(id)!;
  },

  /** 写入 PDF 落盘结果。`sha256` 一并存下,便于内容寻址与去重审计。 */
  setPdf(id: string, pdfRelPath: string, sha256: string): void {
    getDb().run("UPDATE library_items SET pdf_path = ?, pdf_sha256 = ?, updated_at = ? WHERE id = ?", [
      v(pdfRelPath), v(sha256), v(Date.now()), v(id),
    ]);
    persist();
  },

  /**
   * 按通用文件路径找一条 `linked` 条目(通用导入器的去重口)。
   *
   * 只服务 `linked`:它的 `file_path` 存的是**用户给的那个绝对路径原样**,所以有键可查。
   * `attached` 存的是 `<库根>/files/<条目 id>-<原名>` —— **id 是新建时才生成的**,
   * 落盘之前算不出来,而且库里不记来源路径,所以那一支没有可查的键(理由见
   * `fileImport.ts` 的 `findExisting`)。
   *
   * 直查而不是 `list()`:后者有 200 条上限(超了就翻不到,于是"重复导入"静默变成
   * "又建了一条"),而且要 `SELECT i.*` 拉回整表 —— 一次拖进 200 个文件就是 200 次
   * 全表读。这里按列查,走得上索引。
   */
  findLinkedByPath(absPath: string): LibraryItem | undefined {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM library_items WHERE entry_mode = 'linked' AND file_path = ? LIMIT 1",
    );
    stmt.bind([v(absPath)]);
    const found = stmt.step()
      ? rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow)
      : undefined;
    stmt.free();
    return found;
  },

  /** 写通用文件路径(attached 的相对库根路径;linked 不走这里,建条目时就带上)。 */
  setFilePath(id: string, relPath: string): void {
    getDb().run("UPDATE library_items SET file_path = ?, updated_at = ? WHERE id = ?", [
      v(relPath), v(Date.now()), v(id),
    ]);
    persist();
  },

  /**
   * 转换情况统计:总数 / 已转 Markdown / 还没转。
   *
   * 给设置页的「批量检测」用。**在 SQL 里数**而不是把全库拉进渲染端再数 ——
   * 库上千篇时那是几 MB 的 IPC 流量换一个数字。
   */
  conversionStats(): { total: number; converted: number; pending: number } {
    const db = getDb();
    const countOf = (sql: string): number => {
      const stmt = db.prepare(sql);
      stmt.step();
      const n = Number((stmt.getAsObject() as { n: number }).n ?? 0);
      stmt.free();
      return n;
    };
    const total = countOf("SELECT COUNT(*) AS n FROM library_items");
    const converted = countOf(
      "SELECT COUNT(*) AS n FROM library_items WHERE md_path IS NOT NULL AND md_path <> ''",
    );
    return { total, converted, pending: Math.max(0, total - converted) };
  },

  /** 写入 Markdown 转换产物(供 ripgrep 全文检索)。 */
  /** 改标题。目前只给笔记用:用户在应用内编辑正文、改了 `# 标题` 时同步列表行。 */
  setTitle(id: string, title: string): void {
    getDb().run("UPDATE library_items SET title = ?, updated_at = ? WHERE id = ?", [
      v(title), v(Date.now()), v(id),
    ]);
    persist();
  },

  /** 换掉这一条的来源地址。
   *  真正会用到的场景只有一个:导入时拿到的是 doi.org 落地页,下载前查到开放获取的
   *  PDF 直链之后把它写回去 —— 下次下载、以及详情页上那个"打开原文"的链接,都该是
   *  能直接用的那个。 */
  setUrl(id: string, url: string): void {
    getDb().run("UPDATE library_items SET url = ?, updated_at = ? WHERE id = ?", [
      v(url), v(Date.now()), v(id),
    ]);
    persist();
  },

  setMarkdown(id: string, mdRelPath: string): void {
    getDb().run("UPDATE library_items SET md_path = ?, updated_at = ? WHERE id = ?", [
      v(mdRelPath), v(Date.now()), v(id),
    ]);
    persist();
  },

  /** 从库中移除记录。磁盘文件由调用方决定是否删除 —— repo 不碰文件系统。 */
  delete(ids: string[]): void {
    if (ids.length === 0) return;
    const db = getDb();
    const stmt = db.prepare("DELETE FROM library_items WHERE id = ?");
    for (const id of ids) stmt.run([v(id)]);
    stmt.free();
    persist();
  },

  /** 按 id 批量取 —— 给「AI 读某个 collection」的上下文拼装用。 */
  getMany(ids: string[]): LibraryItem[] {
    if (ids.length === 0) return [];
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_items WHERE id = ?");
    const out: LibraryItem[] = [];
    for (const id of ids) {
      stmt.bind([v(id)]);
      if (stmt.step()) out.push(rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow));
      stmt.reset();
    }
    stmt.free();
    return out;
  },

  /** 某个集合内的全部条目(按加入时间倒序)。
   *
   *  ⚠️ **只看这一层,不递归** —— 分类是树(`parent_id`),而"哪些条目会跟着这个分类
   *  一起消失"要连子分类一起算。那种要用 {@link listByCollectionTree}。 */
  listByCollection(collectionId: string): LibraryItem[] {
    const db = getDb();
    const stmt = db.prepare(
      `SELECT i.* FROM library_items i
       JOIN library_collection_items ci ON ci.item_id = i.id
       WHERE ci.collection_id = ?
       ORDER BY ci.added_at DESC`,
    );
    stmt.bind([v(collectionId)]);
    const out: LibraryItem[] = [];
    while (stmt.step()) out.push(rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow));
    stmt.free();
    return out;
  },

  /**
   * 某个集合**以及它整棵子树**里的全部条目。
   *
   * ## 为什么与 `listByCollection` 是两个方法,而不是给它加个 `recursive` 开关
   *
   * 两个调用方的语义是**真的不同**,不是同一个问题的两种答案:
   *
   *  - 「打开这个分类,看看里面有什么」→ `listByCollection`(这一层)。左栏点一下
   *    「方法」只该看到直接挂在「方法」上的那些;把子分类里的也摊进来,用户会以为
   *    这个分类里凭空多了一堆东西。
   *  - 「删掉这个分类,哪些条目会跟着没归属」→ 本方法。子分类是**跟着一起被 CASCADE
   *    删掉的**,它们里面的成员关系也一起没了 —— 只看这一层就会漏掉一整棵子树,
   *    那些条目从此既不在任何分类里、也没被收进回收站(见 `library/trash.ts` 文件头
   *    警告的那种"界面上找不回来的僵尸记录")。
   *
   * ## 实现
   *
   * 递归 CTE。**实测 sql.js 支持 `WITH RECURSIVE`**(它是 SQLite 的编译期特性,不是
   * 扩展),所以不需要在 JS 里一层层 BFS —— 那种写法要在应用层复刻一遍"树"的概念,
   * 而树的真相在 `parent_id` 那一列上。
   *
   * `UNION`(不是 `UNION ALL`)顺带挡掉数据被写坏时的环(`a → b → a`):那种情况下
   * `UNION ALL` 会一直递归下去把进程挂死。`parent_id` 上的外键不防环。
   */
  listByCollectionTree(collectionId: string): LibraryItem[] {
    const db = getDb();
    const stmt = db.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM library_collections WHERE id = ?
         UNION
         SELECT c.id FROM library_collections c JOIN subtree s ON c.parent_id = s.id
       )
       SELECT i.* FROM library_items i
       JOIN library_collection_items ci ON ci.item_id = i.id
       WHERE ci.collection_id IN (SELECT id FROM subtree)
       ORDER BY ci.added_at DESC`,
    );
    stmt.bind([v(collectionId)]);
    const out: LibraryItem[] = [];
    while (stmt.step()) out.push(rowToLibraryItem(stmt.getAsObject() as unknown as LibraryItemRow));
    stmt.free();
    return out;
  },

  /** 库内条目总数(界面概览用)。 */
  count(): number {
    const db = getDb();
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM library_items");
    stmt.step();
    const n = Number((stmt.getAsObject() as { n: number }).n ?? 0);
    stmt.free();
    return n;
  },
};

/* ──────────────────────────────── 集合 ─────────────────────────────────── */

interface CollectionRow {
  id: string;
  name: string;
  kind: string | null; // 退役列：仍在库里，不再读写
  group_id: string | null;
  prompt: string | null;
  parent_id: string | null;
  sort_order: number;
  created_at: number;
}

function rowToCollection(r: CollectionRow): LibraryCollection {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt ?? undefined,
    groupId: r.group_id ?? undefined,
    parentId: r.parent_id ?? null,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
    // 「是不是回收站」不是一列,而是由设置键 + 名字推出来的(见 trash.ts)。这里
    // 没有那个信息,而且也不该有 —— trash.ts 依赖本模块,反过来 import 会成环。
    // 真正标上它的是主进程返回分类列表那一层(`ipc/library.ts`)。
    isTrash: false,
  };
}

export const CollectionRepo = {
  /** 列全部分类（kind 退役后没有"按库列"的口径；归属经 `groupId`，渲染端自行过滤）。 */
  list(): LibraryCollection[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM library_collections ORDER BY sort_order ASC, created_at ASC");
    stmt.bind([]);
    const out: LibraryCollection[] = [];
    while (stmt.step()) out.push(rowToCollection(stmt.getAsObject() as unknown as CollectionRow));
    stmt.free();
    return out;
  },

  /**
   * 名字是否已被占用。
   *
   * **同一个库内唯一** —— 用户可能在论文库里有个「方法」分类,在笔记库里也想有一个;
   * 那是两棵互不相干的树,重名不会让人分不清。但同一个库内的重名要挡掉:库名会出现在
   * 上下文 chip、右侧面板标题、「+」菜单的选择器里,那些地方只显示名字。
   *
   * 比较用「去首尾空白 + 忽略大小写」:用户眼里 "ANN" 和 "ann" 是同一个名字。
   */
  isNameTaken(name: string, exceptId?: string): boolean {
    const norm = name.trim().toLowerCase();
    if (!norm) return false;
    return CollectionRepo.list().some(
      (c) => c.id !== exceptId && c.name.trim().toLowerCase() === norm,
    );
  },

  create(
    name: string,
    parentId: string | null = null,
    groupId?: string,
    prompt?: string,
  ): LibraryCollection {
    // 兜底守卫。渲染端已做即时校验,这里防的是绕过 UI 的调用(如将来的 AI 工具)。
    if (CollectionRepo.isNameTaken(name)) {
      throw new Error(`已经有叫「${name.trim()}」的分类了`);
    }
    const db = getDb();
    const id = makeId("lc");
    /**
     * 追加到末尾：取同级当前最大 `sort_order` + 1（**同库内**同级）。
     *
     * ⚠️ **2026-09-21 曾改成 `MIN - 1`（插到最前），当天就回退了。**
     * 当时我把用户的「新建的应该在 collection 最上面」理解成"插到最前"，但那个
     * `MIN - 1` 会让**已有分类的相对顺序也倒过来**（后建的排前面）——
     * `library-move-smoke` 的「落在新那一层的末尾」当场抓到：原来"一、二"，
     * 变成了"二、一"。用户澄清他没说过要改这个。
     *
     * 教训：让"新建的排最前"若要做，得是"新的插到 0，旧的依次后移"，
     * 而不是"取当前最小值减一"——后者颠覆了既有顺序。
     */
    const maxStmt = db.prepare(
      parentId
        ? "SELECT IFNULL(MAX(sort_order), -1) AS m FROM library_collections WHERE parent_id = ?"
        : "SELECT IFNULL(MAX(sort_order), -1) AS m FROM library_collections WHERE parent_id IS NULL",
    );
    maxStmt.bind(parentId ? [v(parentId)] : []);
    maxStmt.step();
    const nextOrder = Number((maxStmt.getAsObject() as { m: number }).m ?? -1) + 1;
    maxStmt.free();

    db.run(
      "INSERT INTO library_collections (id, name, kind, group_id, prompt, parent_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [v(id), v(name.trim()), v("retired"), v(groupId ?? null), v(prompt ?? null), v(parentId), v(nextOrder), v(Date.now())],
    );
    persist();
    return {
      id,
      name: name.trim(),
      ...(prompt ? { prompt } : {}),
      ...(groupId ? { groupId } : {}),
      parentId,
      sortOrder: nextOrder,
      createdAt: Date.now(),
      // 同上:回收站标记由主进程返回分类列表时统一标,这里没有那个信息
      isTrash: false,
    };
  },

  /** 改名。返回是否成功 —— 重名时返回 false,调用方负责提示用户。 */
  rename(id: string, name: string): boolean {
    const current = CollectionRepo.list().find((c) => c.id === id);
    if (!current) return false;
    if (CollectionRepo.isNameTaken(name, id)) return false;
    getDb().run("UPDATE library_collections SET name = ? WHERE id = ?", [v(name.trim()), v(id)]);
    persist();
    return true;
  },

  /** 写「给 AI 的说明」。空串 = 清空(清单里就不再注入这一层)。 */
  setPrompt(id: string, prompt: string | null): void {
    getDb().run("UPDATE library_collections SET prompt = ? WHERE id = ?", [
      v(prompt && prompt.trim().length > 0 ? prompt.trim() : null), v(id),
    ]);
    persist();
  },

  /** 删除集合。子集合与成员关系由外键 CASCADE 一并清理;**文献本身不受影响**
   *  —— 集合只是分组,删组不该删文献。 */
  delete(id: string): void {
    getDb().run("DELETE FROM library_collections WHERE id = ?", [v(id)]);
    persist();
  },

  /**
   * 把一个集合移到别处 —— 改父级,和/或调同级的次序。左栏拖拽 / 右键「移动到…」的落点。
   *
   * 失败时把原因**原文**返回,调用方直接摆给用户看 —— 不另造一套说法。
   * 四种移不动:找不到它自己 / 找不到新父级 / 会成环 / 目标位置重名。
   *
   * ## 为什么环必须显式判
   *
   * `parent_id` 上的外键**不防环**(见 `listByCollectionTree` 那段说明 —— 那边用
   * `UNION` 而不是 `UNION ALL` 才没被挂死)。于是"把 A 移到自己下面"在 SQL 层是
   * 完全合法的写,而后患是那一棵子树从库里所有遍历里消失:界面上它整块不见了,
   * 用户以为东西没了。
   *
   * 判法两种:查目标的**祖先链**里有没有自己(向上),或查自己的**后代集**里有没有
   * 目标(向下)。**向上走更省** —— 祖先链通常只有几层,后代集要遍历整棵子树。
   * 所以这里从目标出发往上走,走到 `null` 到头。`guard` 是坏数据兜底:真有环时
   * 不许这个循环把主进程挂死(宁可拒绝这次移动)。
   *
   * ## 重名判据:这里**只判同一层**,比 create/rename 宽松(刻意)
   *
   * `create` / `rename` 走 `isNameTaken`,那是**同库内全局唯一**。这里用同层唯一。
   * 差别只在"移动"这条路上宽松,理由是用户视角的:把「方法」从根目录拖进「第一章」
   * 下面时,若根目录另有一个「方法」,按全局判重会被拒;但两个「方法」现在处在**不同
   * 的父级下**,左栏上是两棵互不相干的分支,用户完全分得清。硬拒的话他唯一的出路是
   * 改名,而那个名字本来就是他想要的。
   *
   * ⚠️ 这确实是**两套口径**。真要统一得连 `create` 一起放宽,而那会改掉"同库内不许
   * 重名"这条既有约束(库名会出现在上下文 chip、右栏标题、选择器里,那些地方只看得到
   * 名字)—— 不在这次改动的范围内,所以这里如实写出这个不一致,而不是假装没有。
   *
   * ## 次序怎么排
   *
   * 挪过去之后**追加到新那一层的末尾**:先把目标层的兄弟按 `sort_order` 排好,再把
   * 自己插到最末,然后**整层重写** `sort_order` 为 0..n-1。
   *
   * 整层重写而不是"搬动别人腾位置":结果与顺序一一对应,也不会在中间态留下两个同号的
   * 兄弟。代价是这一层有 k 个兄弟就写 k 行 —— 分类是几十条的量级,不值得为它优化。
   *
   * ## 为什么签名里**没有**"落到第几位"
   *
   * 契约 `CollectionMoveSchema` 上原本有个 `index`(同级落点),已经砍掉,这里也跟着
   * 砍了 —— 留着形参而没人传,下一个人会以为"拖动排序"已经有了。
   *
   * 砍它的原因是它**算不对**:`index` 数的是"除自己之外"的兄弟,而同层内挪动时
   * 用户心里的位置是含自己的 —— 往右拖一位要传 `index+1`。这种差一位的坑,少一个
   * 入口就少一处;而现在界面没有任何一条路需要它(候选落点里自己与自己的子树都被
   * 挑掉了,没有"原地调序"这个动作)。挪过去一律**追加到新那一层的末尾**。
   */
  move(
    id: string,
    parentId: string | null | undefined,
  ): { ok: true } | { ok: false; error: string } {
    const all = CollectionRepo.list();
    const current = all.find((c) => c.id === id);
    if (!current) return { ok: false, error: "这个分类已经不在了" };

    // 只调次序时父级不变;传了值就用新值(显式的 null = 移到最外层)
    const nextParent = parentId === undefined ? current.parentId : parentId;

    if (nextParent !== null) {
      const target = all.find((c) => c.id === nextParent);
      if (!target) return { ok: false, error: "目标分类已经不在了" };
      if (target.id === id) {
        return { ok: false, error: "不能把一个分类移到它自己下面" };
      }
      let cursor: string | null = target.parentId;
      let guard = 0;
      while (cursor !== null && guard < 10_000) {
        if (cursor === id) {
          return { ok: false, error: "不能把一个分类移到它自己的子分类下面" };
        }
        cursor = all.find((c) => c.id === cursor)?.parentId ?? null;
        guard += 1;
      }
    }

    // 同层重名(见上面的说明:这里刻意只判同一层)
    const norm = current.name.trim().toLowerCase();
    const clash = all.some(
      (c) =>
        c.id !== id &&
        (c.parentId ?? null) === nextParent &&
        c.name.trim().toLowerCase() === norm,
    );
    if (clash) return { ok: false, error: "目标位置已经有同名的分类了" };

    const siblings = CollectionRepo.list()
      .filter((c) => (c.parentId ?? null) === nextParent && c.id !== id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    // 追加到末尾(见上面"为什么签名里没有落到第几位")
    siblings.push({ ...current, parentId: nextParent } as LibraryCollection);

    const db = getDb();
    db.run("BEGIN");
    try {
      db.run("UPDATE library_collections SET parent_id = ? WHERE id = ?", [v(nextParent), v(id)]);
      const stmt = db.prepare("UPDATE library_collections SET sort_order = ? WHERE id = ?");
      for (let i = 0; i < siblings.length; i++) stmt.run([v(i), v(siblings[i]!.id)]);
      stmt.free();
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
    return { ok: true };
  },

  /** 把一批文献加入/移出某集合。已存在时重复加入是幂等的。 */
  assign(collectionId: string, itemIds: string[], add: boolean): void {
    if (itemIds.length === 0) return;
    const db = getDb();
    const now = Date.now();
    db.run("BEGIN");
    try {
      if (add) {
        const stmt = db.prepare(
          `INSERT INTO library_collection_items (collection_id, item_id, added_at) VALUES (?, ?, ?)
           ON CONFLICT(collection_id, item_id) DO NOTHING`,
        );
        for (const itemId of itemIds) stmt.run([v(collectionId), v(itemId), v(now)]);
        stmt.free();
      } else {
        const stmt = db.prepare(
          "DELETE FROM library_collection_items WHERE collection_id = ? AND item_id = ?",
        );
        for (const itemId of itemIds) stmt.run([v(collectionId), v(itemId)]);
        stmt.free();
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },

  /** 每条文献所属的集合 id 列表 —— 详情面板展示与「批量归组」用。 */
  collectionsOfItem(itemId: string): string[] {
    const db = getDb();
    const stmt = db.prepare("SELECT collection_id FROM library_collection_items WHERE item_id = ?");
    stmt.bind([v(itemId)]);
    const out: string[] = [];
    while (stmt.step()) {
      out.push(String((stmt.getAsObject() as { collection_id: string }).collection_id));
    }
    stmt.free();
    return out;
  },
};

/* ────────────────────────────── 机构认证入口 ───────────────────────────── */

interface InstitutionRow {
  id: string;
  name: string;
  login_url: string | null;
  domains: string | null;
  proxy_prefix: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

function rowToInstitution(r: InstitutionRow): InstitutionProfile {
  return {
    id: r.id,
    name: r.name,
    loginUrl: r.login_url ?? undefined,
    domains: (safeJson(r.domains) as string[] | undefined) ?? [],
    proxyPrefix: r.proxy_prefix ?? undefined,
    notes: r.notes ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const InstitutionRepo = {
  list(): InstitutionProfile[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM institution_profiles ORDER BY created_at ASC");
    const out: InstitutionProfile[] = [];
    while (stmt.step()) out.push(rowToInstitution(stmt.getAsObject() as unknown as InstitutionRow));
    stmt.free();
    return out;
  },

  /** 新增或更新一个入口档案。⚠️ 这里**不存任何凭据** —— 登录态在浏览器分区里。 */
  save(input: {
    id?: string;
    name: string;
    loginUrl?: string;
    domains?: string[];
    proxyPrefix?: string;
    notes?: string;
  }): InstitutionProfile {
    const db = getDb();
    const now = Date.now();
    const domains = JSON.stringify(input.domains ?? []);

    if (input.id) {
      db.run(
        `UPDATE institution_profiles SET name = ?, login_url = ?, domains = ?, proxy_prefix = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
        [v(input.name), v(input.loginUrl), v(domains), v(input.proxyPrefix), v(input.notes), v(now), v(input.id)],
      );
      persist();
      const stmt = db.prepare("SELECT * FROM institution_profiles WHERE id = ?");
      stmt.bind([v(input.id)]);
      stmt.step();
      const row = rowToInstitution(stmt.getAsObject() as unknown as InstitutionRow);
      stmt.free();
      return row;
    }

    const id = makeId("inst");
    db.run(
      `INSERT INTO institution_profiles (id, name, login_url, domains, proxy_prefix, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [v(id), v(input.name), v(input.loginUrl), v(domains), v(input.proxyPrefix), v(input.notes), v(now), v(now)],
    );
    persist();
    return {
      id,
      name: input.name,
      loginUrl: input.loginUrl,
      domains: input.domains ?? [],
      proxyPrefix: input.proxyPrefix,
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    };
  },

  delete(id: string): void {
    getDb().run("DELETE FROM institution_profiles WHERE id = ?", [v(id)]);
    persist();
  },
};

/* ────────────────────────────── 下载任务 ───────────────────────────────── */

interface JobRow {
  id: string;
  item_id: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToJob(r: JobRow): DownloadJob {
  return {
    id: r.id,
    itemId: r.item_id,
    status: (r.status as DownloadStatus) || "pending",
    attempts: r.attempts ?? 0,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const DownloadJobRepo = {
  list(): DownloadJob[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM download_jobs ORDER BY updated_at DESC");
    const out: DownloadJob[] = [];
    while (stmt.step()) out.push(rowToJob(stmt.getAsObject() as unknown as JobRow));
    stmt.free();
    return out;
  },

  /** 按状态取任务(下载器取 pending 队列用)。 */
  listByStatus(status: DownloadStatus): DownloadJob[] {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM download_jobs WHERE status = ? ORDER BY created_at ASC");
    stmt.bind([v(status)]);
    const out: DownloadJob[] = [];
    while (stmt.step()) out.push(rowToJob(stmt.getAsObject() as unknown as JobRow));
    stmt.free();
    return out;
  },

  getByItem(itemId: string): DownloadJob | null {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM download_jobs WHERE item_id = ?");
    stmt.bind([v(itemId)]);
    const found = stmt.step();
    const row = found ? rowToJob(stmt.getAsObject() as unknown as JobRow) : null;
    stmt.free();
    return row;
  },

  /** 排入队列。已有任务则重置为 pending(用户手动重下时不该被旧状态挡住),
   *  但**保留 attempts** —— 它记录的是历史重试次数,用于退避策略。 */
  enqueue(itemId: string): DownloadJob {
    const db = getDb();
    const now = Date.now();
    const existing = DownloadJobRepo.getByItem(itemId);
    if (existing) {
      db.run("UPDATE download_jobs SET status = 'pending', error = NULL, updated_at = ? WHERE item_id = ?", [
        v(now), v(itemId),
      ]);
      persist();
      return { ...existing, status: "pending", error: undefined, updatedAt: now };
    }
    const id = makeId("dj");
    db.run(
      "INSERT INTO download_jobs (id, item_id, status, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)",
      [v(id), v(itemId), v(now), v(now)],
    );
    persist();
    return { id, itemId, status: "pending", attempts: 0, createdAt: now, updatedAt: now };
  },

  /**
   * 把**上次运行遗留**的 running 任务打回 pending。返回打回了多少条。
   *
   * 下载是主进程里的异步操作,进程一退,正在跑的那次就地蒸发 —— 但数据库里那条
   * 记录会永远停在 "running"。界面上表现为「一直显示下载中,永远不动」,而且队列
   * 也不会再捡起它(`processDownloadQueue` 只取 pending)。
   *
   * 启动时调一次即可。打回 pending 而**不是**标失败:这些任务从没真正下成过,
   * 重试才是对的;`attempts` 也保持不变,免得退避策略把它当成"已经试过很多次"。
   */
  resetStale(): number {
    const stale = DownloadJobRepo.listByStatus("running").length;
    if (stale === 0) return 0;
    getDb().run(
      "UPDATE download_jobs SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'running'",
      [v(Date.now())],
    );
    persist();
    return stale;
  },

  /** 更新任务状态。`bumpAttempts` 仅在真正发起过一次下载时传 true。 */
  setStatus(itemId: string, status: DownloadStatus, error?: string, bumpAttempts = false): void {
    const now = Date.now();
    getDb().run(
      `UPDATE download_jobs SET status = ?, error = ?, attempts = attempts + ?, updated_at = ? WHERE item_id = ?`,
      [v(status), v(error), v(bumpAttempts ? 1 : 0), v(now), v(itemId)],
    );
    persist();
  },

  /** 清掉某条文献的任务(文献被删除时用;外键 CASCADE 也会兜底)。 */
  deleteByItem(itemId: string): void {
    getDb().run("DELETE FROM download_jobs WHERE item_id = ?", [v(itemId)]);
    persist();
  },
};

/* ──────────────────────────────── 条目笔记 ─────────────────────────────── */
/* 读文献时随手记的小段文字,挂在条目上。与「笔记库」的条目是两回事:
   那边一条 = 一篇 Markdown 文件,这边一条 = 某个条目下的一句话。
   表在建库时就有了(见 db.ts),这里只补上读写。 */

interface NoteRow {
  id: string;
  item_id: string;
  content: string;
  origin: string | null;
  created_at: number;
  updated_at: number;
}

function rowToNote(r: NoteRow): LibraryNote {
  return {
    id: r.id,
    itemId: r.item_id,
    content: r.content,
    origin: r.origin === "ai" ? "ai" : "user",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const NoteRepo = {
  /** 某个条目下的笔记。最近改过的排前面 —— 刚记的通常在找它。 */
  listByItem(itemId: string): LibraryNote[] {
    const stmt = getDb().prepare(
      "SELECT * FROM library_notes WHERE item_id = ? ORDER BY updated_at DESC",
    );
    stmt.bind([v(itemId)]);
    const out: LibraryNote[] = [];
    while (stmt.step()) out.push(rowToNote(stmt.getAsObject() as unknown as NoteRow));
    stmt.free();
    return out;
  },

  /** 新建或改写一条。带 id 就改(不存在则当作新建,免得前端状态过期时报错)。
   *  `origin` 只在**新插入**时生效 —— 改一条已有的不会改它的来源(用户改过的
   *  AI 摘要仍然是一次 AI 摘要,反过来也一样)。默认 `user`。 */
  save(input: { id?: string; itemId: string; content: string; origin?: "user" | "ai" }): void {
    const db = getDb();
    const now = Date.now();
    if (input.id) {
      const exists = db.prepare("SELECT id FROM library_notes WHERE id = ?");
      exists.bind([v(input.id)]);
      const found = exists.step();
      exists.free();
      if (found) {
        db.run("UPDATE library_notes SET content = ?, updated_at = ? WHERE id = ?", [
          v(input.content), v(now), v(input.id),
        ]);
        persist();
        return;
      }
    }
    db.run(
      "INSERT INTO library_notes (id, item_id, content, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [v(makeId("ln")), v(input.itemId), v(input.content), v(input.origin ?? "user"), v(now), v(now)],
    );
    persist();
  },

  /** 删一条。**返回它原来挂在哪个条目上** —— 调用方要拿那个条目的新列表,
   *  而删完就查不到了。找不到时返回 null。 */
  delete(id: string): string | null {
    const db = getDb();
    const stmt = db.prepare("SELECT item_id FROM library_notes WHERE id = ?");
    stmt.bind([v(id)]);
    const found = stmt.step();
    const itemId = found ? (stmt.getAsObject() as { item_id: string }).item_id : null;
    stmt.free();
    if (!itemId) return null;
    db.run("DELETE FROM library_notes WHERE id = ?", [v(id)]);
    persist();
    return itemId;
  },
};

/* ──────────────────────────────── 长期任务 ─────────────────────────────── */
/* 见 contracts/src/longTask.ts 与 main/longtask/taskRunner.ts。落库的意义:
   状态条要能扛住重启(重启 sweep 会把 running 标成 stopped),运行历史要能翻。 */

interface LongTaskRow {
  id: string;
  session_id: string;
  project_id: string;
  goal: string;
  status: string;
  iterations: number;
  max_iterations: number;
  note: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
}

function rowToLongTask(r: LongTaskRow): LongTask {
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    goal: r.goal,
    status: (r.status as LongTask["status"]) || "running",
    iterations: r.iterations ?? 0,
    maxIterations: r.max_iterations,
    note: r.note,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

export const LongTaskRepo = {
  /** 按开始时间倒序,翻某个会话的历史(当前那条通常在最前)。
   *
   *  `started_at` 只到毫秒,而 id 是 `ltask_<时间>_<随机>` —— 同一毫秒建的两条,
   *  按 id 排等于按随机串排。所以用 `rowid` 兜底:SQLite 的隐式插入序,**后插的更大**,
   *  这才是"谁更新"的正确答案(见下面 {@link latestOf} 那条一样的注释)。 */
  listBySession(sessionId: string): LongTask[] {
    const stmt = getDb().prepare(
      "SELECT rowid AS _seq, * FROM long_tasks WHERE session_id = ? ORDER BY started_at DESC, _seq DESC",
    );
    stmt.bind([v(sessionId)]);
    const out: LongTask[] = [];
    while (stmt.step()) out.push(rowToLongTask(stmt.getAsObject() as unknown as LongTaskRow));
    stmt.free();
    return out;
  },

  /** 会话的当前任务:最新一条(不管状态)。没有则 null。
   *
   *  ⚠️ **兜底的必须是 `rowid`,不能是 `id`。** id 里带的是时间 + **随机**串,所以
   *  "同一毫秒建的两条谁在后"按 id 排是随机的 —— 长跑脚本里连着建两个任务时,有一半
   *  机会"最新一条"返回的是**旧那条**。这不是理论上的:长期任务的 stop 靠它找残留的
   *  `running` 行,拿错了就报"这个会话没有进行中的长期任务"(见 `taskRunner.stop`)。
   *  `rowid` 是 SQLite 的隐式插入序,后插的一定更大,与"谁更新"同义。 */
  latestOf(sessionId: string): LongTask | null {
    const stmt = getDb().prepare(
      "SELECT rowid AS _seq, * FROM long_tasks WHERE session_id = ? ORDER BY started_at DESC, _seq DESC LIMIT 1",
    );
    stmt.bind([v(sessionId)]);
    const found = stmt.step();
    const row = found ? rowToLongTask(stmt.getAsObject() as unknown as LongTaskRow) : null;
    stmt.free();
    return row;
  },

  get(id: string): LongTask | null {
    const stmt = getDb().prepare("SELECT * FROM long_tasks WHERE id = ?");
    stmt.bind([v(id)]);
    const found = stmt.step();
    const row = found ? rowToLongTask(stmt.getAsObject() as unknown as LongTaskRow) : null;
    stmt.free();
    return row;
  },

  create(input: { sessionId: string; projectId: string; goal: string; maxIterations: number }): LongTask {
    const db = getDb();
    const now = Date.now();
    const task: LongTask = {
      id: makeId("ltask_"),
      sessionId: input.sessionId,
      projectId: input.projectId,
      goal: input.goal,
      status: "running",
      iterations: 0,
      maxIterations: input.maxIterations,
      note: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    db.run(
      "INSERT INTO long_tasks (id, session_id, project_id, goal, status, iterations, max_iterations, note, started_at, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [v(task.id), v(task.sessionId), v(task.projectId), v(task.goal), v(task.status),
       v(task.iterations), v(task.maxIterations), v(task.note), v(task.startedAt), v(task.updatedAt), v(task.finishedAt)],
    );
    persist();
    return task;
  },

  /** 收尾:状态 + 说明 + finished_at 一把写。running → 终态、以及 iterations 推进都走它。 */
  finish(id: string, status: LongTask["status"], note: string | null): LongTask | null {
    const db = getDb();
    const now = Date.now();
    db.run(
      "UPDATE long_tasks SET status = ?, note = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      [v(status), v(note), v(status === "running" ? null : now), v(now), v(id)],
    );
    persist();
    return LongTaskRepo.get(id);
  },

  /** 推进轮数计数(每轮 turn.done 后 +1)。 */
  bumpIterations(id: string): LongTask | null {
    const db = getDb();
    db.run("UPDATE long_tasks SET iterations = iterations + 1, updated_at = ? WHERE id = ?", [
      v(Date.now()), v(id),
    ]);
    persist();
    return LongTaskRepo.get(id);
  },

  /** 只改 note(不碰状态/时间戳之外的字段)—— 续轮被 sendTurn 拒掉这类中间态用。 */
  setNote(id: string, note: string | null): LongTask | null {
    getDb().run("UPDATE long_tasks SET note = ?, updated_at = ? WHERE id = ?", [
      v(note), v(Date.now()), v(id),
    ]);
    persist();
    return LongTaskRepo.get(id);
  },
};

/* ─────────────────────────────── 条目关联 ─────────────────────────────── */
/* 见 contracts/src/library.ts 的 `LibraryItemLink`,以及 db.ts 里那张表的注释。
   形状是「一条条目 → 一批目标」,不是两两配对。 */

interface LinkRow {
  id: string;
  item_id: string;
  target_item_id: string | null;
  target_path: string | null;
  created_at: number;
}

function rowToLink(r: LinkRow): LibraryItemLink {
  return {
    id: r.id,
    itemId: r.item_id,
    // 两列恰好有一列非空(表上有 CHECK)。读的时候按同一个规则还原成可选字段。
    ...(r.target_item_id !== null ? { targetItemId: r.target_item_id } : {}),
    ...(r.target_path !== null ? { targetPath: r.target_path } : {}),
    createdAt: r.created_at,
  };
}

export const LibraryLinkRepo = {
  /**
   * 这条条目关联出去的全部目标,**以及指向它的那些**(反向)。
   *
   * 两个方向一起给,是因为界面上「关联」区要能双向看见:用户给 A 挂了 B,
   * 打开 B 的时候也该看到"它被 A 关联着" —— 否则他会在 B 上再挂一次 A,
   * 而那是同一条关系的两个方向。
   *
   * 返回里 `direction` 说明每一条是从哪边看过去的。
   */
  linksOf(itemId: string): Array<LibraryItemLink & { direction: "out" | "in" }> {
    const db = getDb();
    const out: Array<LibraryItemLink & { direction: "out" | "in" }> = [];
    const stmt = db.prepare(
      "SELECT * FROM library_item_links WHERE item_id = ? OR target_item_id = ?",
    );
    stmt.bind([v(itemId), v(itemId)]);
    while (stmt.step()) {
      const link = rowToLink(stmt.getAsObject() as unknown as LinkRow);
      out.push({ ...link, direction: link.itemId === itemId ? "out" : "in" });
    }
    stmt.free();
    return out;
  },

  /**
   * 加一条关联。**幂等** —— 已经存在就返回那一条,不报错、不产生第二行
   * (唯一索引也挡着;这里先查一次是为了拿到既有行的 id 给调用方)。
   *
   * `target` 两选一:给 `targetItemId` 就是关联库内条目,给 `targetPath` 就是关联
   * 库外文件。两个都给或都不给都抛 —— 表上的 CHECK 也会拦,但在这里抛能给出
   * 说得清的话(而不是一句 SQLite 约束错误)。
   */
  add(
    itemId: string,
    target: { targetItemId: string } | { targetPath: string },
  ): LibraryItemLink {
    const hasItem = "targetItemId" in target;
    const hasPath = "targetPath" in target;
    if (hasItem === hasPath) {
      throw new Error("关联的目标要么是库内条目、要么是库外路径,不能两个都给或都不给");
    }
    const db = getDb();
    const existing = db.prepare(
      hasItem
        ? "SELECT * FROM library_item_links WHERE item_id = ? AND target_item_id = ?"
        : "SELECT * FROM library_item_links WHERE item_id = ? AND target_path = ?",
    );
    existing.bind([v(itemId), v(hasItem ? target.targetItemId : target.targetPath)]);
    if (existing.step()) {
      const found = rowToLink(existing.getAsObject() as unknown as LinkRow);
      existing.free();
      return found;
    }
    existing.free();

    const link: LibraryItemLink = {
      id: makeId("ll"),
      itemId,
      ...(hasItem ? { targetItemId: target.targetItemId } : { targetPath: target.targetPath }),
      createdAt: Date.now(),
    };
    db.run(
      "INSERT INTO library_item_links (id, item_id, target_item_id, target_path, created_at) VALUES (?, ?, ?, ?, ?)",
      [v(link.id), v(link.itemId), v(link.targetItemId ?? null), v(link.targetPath ?? null), v(link.createdAt)],
    );
    persist();
    return link;
  },

  /** 解除一条关联(按关联行自己的 id)。返回是否真的删掉了。 */
  remove(linkId: string): boolean {
    const db = getDb();
    const before = db.prepare("SELECT id FROM library_item_links WHERE id = ?");
    before.bind([v(linkId)]);
    const exists = before.step();
    before.free();
    if (!exists) return false;
    db.run("DELETE FROM library_item_links WHERE id = ?", [v(linkId)]);
    persist();
    return true;
  },

  /**
   * 一批条目**各自**有几条关联 —— 左栏行尾那个徽标要的数字。
   *
   * ## 为什么必须是一条批量 RPC,而不是渲染端逐条调 `linksOf`
   *
   * 左栏一屏能挂几十上百条,逐条发的话就是几十次 IPC,而且每次都要把整张
   * `library_item_links` 扫一遍(`linksOf` 的 WHERE 是 `item_id = ? OR
   * target_item_id = ?`,两列都带索引但仍是两次查)。这一条**一次查完**整批。
   *
   * 计数口径与 `linksOf` **逐字一致**:进/出两个方向都算(用户给 A 挂了 B,
   * 那么在 A 和 B 的左边栏都该看到一个 1)—— 否则徽标说 0、点进去有 1 条,
   * 那种"数字对不上"是最容易被当成 bug 的一类。
   *
   * 没关联的条目**不出现在返回里**(不是 0),调用方用 `?? 0` 兜 —— 返回一整份
   * 全是 0 的对象在库大起来时纯属浪费。
   */
  countsOf(itemIds: readonly string[]): Record<string, number> {
    const ids = [...new Set(itemIds.filter((id) => id.length > 0))];
    const counts: Record<string, number> = {};
    if (ids.length === 0) return counts;
    const db = getDb();
    const marks = ids.map(() => "?").join(",");
    // 一条 SQL 两个方向各数一次:UNION ALL 之后按 id 分组。
    // 不写成两条查询再在 JS 里合并 —— 同一条关联的两头都要 +1,合并逻辑放在
    // SQL 里更不容易写错(而且走的是同一次扫描)。
    const stmt = db.prepare(
      `SELECT owner, COUNT(*) AS n FROM (
         SELECT item_id AS owner FROM library_item_links WHERE item_id IN (${marks})
         UNION ALL
         SELECT target_item_id AS owner FROM library_item_links WHERE target_item_id IN (${marks})
       ) GROUP BY owner`,
    );
    stmt.bind([...ids.map((x) => v(x)), ...ids.map((x) => v(x))]);
    while (stmt.step()) {
      const r = stmt.getAsObject() as { owner: unknown; n: unknown };
      const owner = r.owner === null || r.owner === undefined ? "" : String(r.owner);
      if (owner) counts[owner] = Number(r.n);
    }
    stmt.free();
    return counts;
  },

  /**
   * 界面上「关联」区的那些行 —— 关联本身 + **另一头**的摘要,一次查好。
   *
   * 为什么不在渲染端逐条拉:`linksOf` 的行有方向,另一头可能是条目、可能是路径,
   * 而条目还可能已经被删了(关联会级联走,但反向那一侧的历史行未必)。主进程一次
   * 查完,渲染端只管画。
   *
   * `suppressedReason` 由主进程填(它才拿得到屏蔽规则)——
   * 这里留空,由 `ipc/library.ts` 补上。
   */
  viewsOf(itemId: string): LibraryLinkView[] {
    const db = getDb();
    const out: LibraryLinkView[] = [];
    // 一次拿全部关联行,再按方向挑"另一头"。条目标题**批量**查(一次 IN),
    // 免得十个关联发十条 SQL。
    const rows = LibraryLinkRepo.linksOf(itemId);
    const otherIds = rows
      .map((l) => (l.itemId === itemId ? l.targetItemId : l.itemId))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    const titles = new Map<string, string>();
    if (otherIds.length > 0) {
      const stmt = db.prepare(
        `SELECT id, title FROM library_items WHERE id IN (${otherIds.map(() => "?").join(",")})`,
      );
      stmt.bind(otherIds.map((x) => v(x)));
      while (stmt.step()) {
        const r = stmt.getAsObject() as { id: string; title: string };
        titles.set(String(r.id), String(r.title));
      }
      stmt.free();
    }

    for (const link of rows) {
      const isOut = link.direction === "out";
      const otherItemId = isOut ? link.targetItemId : link.itemId;
      const otherPath = isOut ? link.targetPath : undefined;
      const title = otherItemId
        ? (titles.get(otherItemId) ?? "")
        : otherPath
          ? basename(otherPath)
          : "";
      out.push({
        id: link.id,
        direction: link.direction,
        ...(otherItemId ? { otherItemId } : {}),
        ...(otherPath ? { otherPath } : {}),
        title,
        // 库内条目能挂进对话(与手动挂同一种键);库外路径没有可挂的东西 ——
        // 它是"用户桌面上的一个文件",要挂得先导入,那是另一条路。
        ...(otherItemId ? { attachKey: `i:${otherItemId}` } : {}),
        createdAt: link.createdAt,
      });
    }
    return out;
  },
  /**
   * 一批条目各自的关联视图 —— `viewsOf` 的批量版,**一次查完**。
   *
   * 给「删除前预览」用:那个弹窗要画的是"每个文档一组勾选",而它可能一次带几十条
   * (用户原话「可以批量删除」)。逐条 `viewsOf` 的话每次都要把整张
   * `library_item_links` 扫两遍(`linksOf` 的 WHERE 是 `item_id = ? OR
   * target_item_id = ?`),几十条就是上百次查询。
   *
   * 口径与 `viewsOf` **逐字一致**(方向、另一头的标题、`attachKey`)—— 两处不一致
   * 会表现成"预览里说有 3 条,删的时候按 2 条处理"这种对不上的数。所以这一支的
   * 行整形直接复用同一段代码,不是照着重写一遍。
   *
   * 返回**以 id 为键的字典**(不是数组):调用方按条目查,而不在的条目自然落到
   * 空数组(调用方 `?? []`),省得两边都做一次对齐。
   */
  viewsOfMany(itemIds: readonly string[]): Record<string, LibraryLinkView[]> {
    const out: Record<string, LibraryLinkView[]> = {};
    for (const id of itemIds) out[id] = [];
    const db = getDb();
    const ids = [
      ...new Set(itemIds.filter((id) => id.length > 0)),
    ];
    if (ids.length === 0) return out;
    const marks = ids.map(() => "?").join(",");
    // 一条 SQL 把两个方向的行都捞出来:出边(`item_id IN`)与入边(`target_item_id IN`)。
    // 两个方向都要,理由与 `linksOf` 一样 —— 用户给 A 挂了 B,打开 B 也该看见。
    const stmt = db.prepare(
      `SELECT * FROM library_item_links WHERE item_id IN (${marks}) OR target_item_id IN (${marks})`,
    );
    stmt.bind([...ids.map((x) => v(x)), ...ids.map((x) => v(x))]);
    const rows: LinkRow[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as LinkRow);
    stmt.free();

    // 另一头的标题批量查(一次 IN)—— 与 `viewsOf` 同一条理由:几十条关联发几十条
    // SQL 是这一条 RPC 存在的意义所在。要查的 id 是**行里出现过的全部**,不只是被问
    // 的那一批:入边的"另一头"就是 `item_id`,它可能不在被问的名单里。
    const wanted = [
      ...new Set(
        rows
          .flatMap((r) => [r.item_id, r.target_item_id])
          .filter((x): x is string => typeof x === "string" && x.length > 0),
      ),
    ];
    const titles = new Map<string, string>();
    if (wanted.length > 0) {
      const t = db.prepare(
        `SELECT id, title FROM library_items WHERE id IN (${wanted.map(() => "?").join(",")})`,
      );
      t.bind(wanted.map((x) => v(x)));
      while (t.step()) {
        const r = t.getAsObject() as { id: string; title: string };
        titles.set(String(r.id), String(r.title));
      }
      t.free();
    }

    const idSet = new Set(ids);
    for (const link of rows) {
      // 这一行属于**哪个**被问的条目:出边归 `item_id`,入边归 `target_item_id`。
      // 两侧都在问的那一批里时(用户一次删 A 和 B,而 A→B 有一条关联)**两边的
      // 列表里都该有它** —— 各自看过去都确实有这一条。
      const owners: Array<{ owner: string; isOut: boolean }> = [];
      if (idSet.has(link.item_id)) owners.push({ owner: link.item_id, isOut: true });
      if (link.target_item_id && idSet.has(link.target_item_id)) {
        owners.push({ owner: link.target_item_id, isOut: false });
      }
      for (const { owner, isOut } of owners) {
        const otherItemId = isOut ? link.target_item_id : link.item_id;
        const otherPath = isOut ? link.target_path : undefined;
        // ⚠️ 入边时"另一头"是 `item_id`,而那一行可能同时有 `target_path` 吗?
        // 不会:表上的 CHECK 保证两列恰好一列非空,而这一行既然入边成立,它就是
        // "那个人 → 我",我必然是**条目**那一侧。所以 `otherPath` 只在出边出现。
        const title = otherItemId ? (titles.get(otherItemId) ?? "") : otherPath ? basename(otherPath) : "";
        out[owner]!.push({
          id: link.id,
          direction: isOut ? "out" : "in",
          ...(otherItemId ? { otherItemId } : {}),
          ...(otherPath ? { otherPath } : {}),
          title,
          ...(otherItemId ? { attachKey: `i:${otherItemId}` } : {}),
          createdAt: link.created_at,
        });
      }
    }
    return out;
  },
};
