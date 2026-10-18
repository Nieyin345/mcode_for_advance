/**
 * 会话 —— sessions 表；列定义在 sessionSchema.ts（单一事实来源）。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import type { Session, SessionTodoItem, SessionPlanDraft, SessionBookmark } from "@contracts/session";
import type { SubagentSnapshot, TurnFileEntry, TurnUsageRecord } from "@contracts/runtime";
import { normPathKey } from "@main/lib/pathNorm.js";
import { defaultProviderId } from "@main/providers/defaultProvider.js";
import { getDb, persist } from "../db.js";
import { v, safeJson, SESSION_COLUMNS, type BindValue, type SessionRow } from "../sessionSchema.js";

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
    let sql = `SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, created_at DESC, id DESC`;
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
    let sql = `SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, created_at DESC, id DESC`;
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
    // LIKE 的转义:用户输入里的 % 和 _ 是通配符,不转义就会多匹配(搜 `a_b` 命中 `axb`)。
    // 与 LibraryRepo.list / SettingRepo.keysWithPrefix 同一套写法。
    const q = `%${query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const params: BindValue[] = [v(q)];
    const limit = opts?.limit ?? 30;
    params.push(v(limit));
    const sql = `SELECT * FROM sessions WHERE archived = 0 AND kind = 'chat' AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, created_at DESC LIMIT ?`;
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
   *  SQLite 不保证有 JSON1 扩展(`json_extract` 可能直接报错)。这条路窄但确定
   *  (模式里带着收尾的双引号,所以 `p_a` 不会命中 `p_ab`)。
   *
   *  ⚠️ **`_` 是 LIKE 通配符,而档案 id 里必然有它**(每个 id 都以 `p_` 开头)。
   *  把 id 原样拼进 LIKE 模式,`p_p_one` 会连同 `p_paone` 一起命中(逐位对上:两个
   *  `_` 各吃掉一个字符)。症状是"点乙拿到甲的壳" —— `sessionStart` 的 `sameProfile`
   *  用精确 id 再判一次,于是它先拒掉甲、再**在乙明明有空壳时另建一个**(那正是本
   *  函数存在的意义失效)。所以 id 里那三个字符(`\` `%` `_`)必须先转义,再配
   *  `ESCAPE '\'` —— 与 `searchByTitle` / `LibraryRepo.list` 同一套写法。 */
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
        // 转义 id 里的 `\` `%` `_`(后两个是 LIKE 通配符),两端的 `%` 是刻意的
        // 通配符(JSON 文本的前后缀),不能转。
        const escaped = profileId.replace(/[\\%_]/g, (m) => `\\${m}`);
        where.push("agent_profile LIKE ? ESCAPE '\\'");
        params.push(v(`%"id":"${escaped}"%`));
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

  /** 自动化会话按(工作流, 项目)复用；未指定项目时返回最近使用的会话。
   *  composer_mode 存的是 workflowId。旧项目会话及历史保留，不迁移上下文。 */
  findAutomationByWorkflow(workflowId: string, projectId?: string): Session | undefined {
    return this.listAutomationsByWorkflow(workflowId).find(
      (session) => projectId === undefined || session.projectId === projectId,
    );
  },

  /** 全部项目的后台会话：重入检查不能只看最新的一条。
   *  命令工作流未必写聊天消息，因此把运行存档时间也计入最近使用排序。 */
  listAutomationsByWorkflow(workflowId: string): Session[] {
    const stmt = getDb().prepare(
      `SELECT s.* FROM sessions s
       WHERE s.kind = 'automation' AND s.composer_mode = ?
       ORDER BY MAX(s.updated_at, COALESCE(
         (SELECT MAX(r.updated_at) FROM workflow_runs r
          WHERE r.session_id = s.id AND r.workflow_id = s.composer_mode), 0)) DESC,
         s.created_at DESC, s.id DESC`,
    );
    stmt.bind([v(workflowId)]);
    const out: Session[] = [];
    while (stmt.step()) out.push(rowToSession(stmt.getAsObject() as unknown as SessionRow));
    stmt.free();
    return out;
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
  updateClaudeSessionId(id: string, claudeSessionId: string | null): void {
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
        // 【MC-013】默认引擎只有一份事实:`providers/defaultProvider.ts` 的唯一出口。
        // 从前这里写死默认引擎 id 的字面量 —— 值恰好相等,但那又是一条"默认引擎是谁"
        // 的读法;契约常量改值时它不会跟着变。
        providerId: row.provider_id ?? defaultProviderId(),
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

  /** Hard-delete a session. Child messages cascade-delete via
   *  messages.session_id ON DELETE CASCADE. Deleting a MAIN session keeps its
   *  side chats alive (their Q&A history has standalone value) — their
   *  parent_session_id is nulled here so the UI shows「主会话已删除」instead of
   *  a dangling pointer. */
  delete(id: string): void {
    const db = getDb();
    // 两条语句同进同退:DELETE 若抛错,不能留下「子会话已摘掉父指针、主会话还在」的半状态
    // (后面任何一次写都会把它落盘)。
    db.run("BEGIN");
    try {
      db.run("UPDATE sessions SET parent_session_id = NULL, updated_at = ? WHERE parent_session_id = ?", [
        v(Date.now()),
        v(id),
      ]);
      db.run("DELETE FROM sessions WHERE id = ?", [v(id)]);
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
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
    const db = getDb();
    db.run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, vals);
    // ── MC-048 ──
    // 目标会话不存在时 `UPDATE … WHERE id = ?` **一行都打不中**,却既不报错也不
    // 影响行数 —— 从前这条路径是**静默成功**:只提供普通字段(model / effort /
    // permissionMode / workflowId…)时,handler 不查会话在不在,手机上删掉的会话再
    // 改设置会回一个假 `ok:true`,桌面端也一句提示都没有(它本该弹成一句话)。
    // sql.js 的 `getRowsModified()` 就是**上一条语句**实际改动的行数:0 = 会话没了。
    // 这里明着失败,让上层 handler 如实报出去(手机 → `ok:false`,桌面 → IPC 拒绝)。
    // 注意:改到相同的值(以及只运行起来没实际变化的 UPDATE)仍然返回 1,所以这条
    // 判据只挑"行根本不存在",不会把合法的空转更新误判成失败。
    if (db.getRowsModified() === 0) {
      throw new Error(`updateSettings: unknown session ${id}`);
    }
    persist();
  },
};
