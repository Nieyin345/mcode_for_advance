/**
 * 资料库笔记 —— library_notes 表。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import type { LibraryNote } from "@contracts/library";
import { getDb, persist } from "../db.js";
import { v } from "../sessionSchema.js";
import { makeId } from "./makeId.js";

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
