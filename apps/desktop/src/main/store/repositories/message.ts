/**
 * 消息 —— messages 表。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import type { MessageRecord } from "@contracts/session";
import { getDb, persist } from "../db.js";
import { log } from "@main/lib/logger.js";
import { v } from "../sessionSchema.js";
import { withStatement } from "./withStatement.js";

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
    content: parseMessageContent(r),
    createdAt: r.created_at,
  };
}

/**
 * 解析一行消息的正文。**不能裸 `JSON.parse`**:只要有一行是坏的(半截写入、外部改库),
 * 它一抛,`listBySession` 整个 reject —— 不是"少一条消息",是**整条对话打不开**。
 * 坏行降级成一张错误块(渲染端认得 `kind:"error"`),把问题明着摆出来,其余消息照常加载。
 */
function parseMessageContent(r: MessageRow): unknown {
  try {
    return JSON.parse(r.content);
  } catch (err) {
    log.warn(`messages: 第 ${r.id} 行(会话 ${r.session_id})正文不是合法 JSON,已降级显示: ${(err as Error).message}`);
    return [{ kind: "error", message: `这条消息在本地库里已损坏，读不出来（id ${r.id}）。` }];
  }
}

/** The outer IPC session ID is authoritative: never let an embedded row
 * redirect writes into another conversation's history. */
function assertMessageSession(sessionId: string, messages: readonly MessageRecord[]): void {
  if (messages.some((m) => m.sessionId !== sessionId)) {
    throw new Error("消息归属(sessionId)与当前会话不匹配，拒绝跨会话写入");
  }
}

/** For upsert/edit-and-resend, id is a GLOBAL primary key. An ON CONFLICT(id)
 * update without an ownership check would MOVE the same message into another
 * conversation. Check all row IDs before ANY mutation within this transaction.
 * A second writer in this process shares this synchronous sql.js connection. */
function assertNoMessageIdReassignment(messages: readonly MessageRecord[]): void {
  const seen = new Map<string, string>();
  const stmt = getDb().prepare("SELECT session_id FROM messages WHERE id = ?");
  withStatement(stmt, (query) => {
    for (const m of messages) {
      const previous = seen.get(m.id);
      if (previous !== undefined && previous !== m.sessionId) {
        throw new Error("同一批消息内重复 id 指向不同会话，拒绝跨会话写入");
      }
      seen.set(m.id, m.sessionId);
      query.bind([v(m.id)]);
      const found = query.step();
      if (found && (query.getAsObject() as { session_id: string }).session_id !== m.sessionId) {
        throw new Error("消息 id 已属于其他会话，拒绝覆盖或迁移历史");
      }
      query.reset();
    }
  });
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
    // Validate before DELETE: otherwise a tampered snapshot wipes the real
    // session and re-inserts the rows under the embedded foreign session ID.
    assertMessageSession(sessionId, messages);
    const db = getDb();
    db.run("BEGIN");
    try {
      db.run("DELETE FROM messages WHERE session_id = ?", [v(sessionId)]);
      const stmt = db.prepare(
        "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      withStatement(stmt, (query) => {
        for (const m of messages) {
          query.run([v(m.id), v(m.sessionId), v(m.role), v(JSON.stringify(m.content)), v(m.createdAt)]);
        }
      });
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
  upsertMany(messages: MessageRecord[], expectedSessionId?: string): void {
    if (expectedSessionId !== undefined) assertMessageSession(expectedSessionId, messages);
    if (messages.length === 0) return;
    const db = getDb();
    db.run("BEGIN");
    try {
      assertNoMessageIdReassignment(messages);
      const stmt = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           role = excluded.role,
           content = excluded.content,
           created_at = excluded.created_at`,
      );
      withStatement(stmt, (query) => {
        for (const m of messages) {
          query.run([v(m.id), v(m.sessionId), v(m.role), v(JSON.stringify(m.content)), v(m.createdAt)]);
        }
      });
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
    assertMessageSession(sessionId, messages);
    const db = getDb();
    db.run("BEGIN");
    try {
      assertNoMessageIdReassignment(messages);
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
        withStatement(stmt, (query) => {
          for (const m of messages) {
            query.run([v(m.id), v(m.sessionId), v(m.role), v(JSON.stringify(m.content)), v(m.createdAt)]);
          }
        });
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },
};
