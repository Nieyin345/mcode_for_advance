/**
 * 项目 —— proj_ —— 项目与工作区根。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import type { Project } from "@contracts/session";
import { getDb, persist } from "../db.js";
import { v } from "../sessionSchema.js";
import { withStatement } from "./withStatement.js";

/* ─────────────────────────────── Projects ─────────────────────────────── */

/** Only a foreign-key owner for projectless event-automation sessions.
 * Never expose its cwd as a user's project / trusted project root. */
export const SYSTEM_AUTOMATION_PROJECT_ID = "proj_internal_automation";

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
    const nextOrder = withStatement(nextOrderStmt, (query) => {
      query.step();
      return (query.getAsObject() as { next: number }).next;
    });
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
    return withStatement(stmt, (query) => {
      const out: Project[] = [];
      while (query.step()) {
        const row = query.getAsObject() as unknown as ProjectRow;
        if (row.id !== SYSTEM_AUTOMATION_PROJECT_ID) out.push(rowToProject(row));
      }
      return out;
    });
  },

  /** Root paths of all persisted projects, served from an in-memory cache.
   *  Use in guard checks that only need the path set (known-root match /
   *  containment) instead of {@link list} — the file tree calls these on
   *  every expand. Callers needing other fields (archived, group, …) must
   *  use {@link list}; mutations re-populate the cache lazily. */
  listPaths(): string[] {
    if (!rootPathsCache) rootPathsCache = ProjectRepo.list().map((p) => p.path);
    // This list is an authorization input for pathGuard. Never expose the
    // shared mutable cache to a caller that can splice a root or inject one.
    return rootPathsCache.slice();
  },

  get(id: string): Project | undefined {
    const db = getDb();
    const stmt = db.prepare("SELECT * FROM projects WHERE id = ?");
    return withStatement(stmt, (query) => {
      query.bind([v(id)]);
      const found = query.step();
      const row = found ? (query.getAsObject() as unknown as ProjectRow) : undefined;
      return row ? rowToProject(row) : undefined;
    });
  },

  /** Hard-delete a project. Child sessions + messages cascade-delete via the
   *  sessions.project_id / messages.session_id ON DELETE CASCADE constraints
   *  (PRAGMA foreign_keys = ON is set in initDb). */
  delete(id: string): void {
    // An accidental / forged project-delete must not cascade-delete background
    // automation sessions and all their workflow run history.
    if (id === SYSTEM_AUTOMATION_PROJECT_ID) return;
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

  /** 只改**隐藏系统项目**(无项目自动化的 FK 占位行)的路径 —— 用户项目的路径按设计
   *  永远不动,所以这里不提供通用的 setPath。老版本把宿主 `process.cwd()` 存了进去,
   *  打包后那是 `/` 或安装目录;automationRunner 发现不一致时用它校正。 */
  setSystemAutomationPath(path: string): void {
    getDb().run("UPDATE projects SET path = ? WHERE id = ?", [v(path), v(SYSTEM_AUTOMATION_PROJECT_ID)]);
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
    // A duplicate ID silently rewrites one project's sort_order twice and
    // leaves two unrelated projects with the same order. Validate before
    // opening the transaction or changing persistent sorting data.
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new Error("项目排序包含重复 id，已拒绝修改顺序");
    }
    const db = getDb();
    db.run("BEGIN");
    try {
      const stmt = db.prepare("UPDATE projects SET sort_order = ? WHERE id = ?");
      withStatement(stmt, (query) => {
        for (let i = 0; i < orderedIds.length; i++) {
          query.run([v(i), v(orderedIds[i])]);
        }
      });
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
    rootPathsCache = null;
  },
};
