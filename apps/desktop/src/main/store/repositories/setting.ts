/**
 * 设置 —— settings 键值表 —— 全应用共用的一张 KV。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import { getDb, persist } from "../db.js";
import { v, type BindValue } from "../sessionSchema.js";

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

  /** 一次 upsert 多个键 —— **同一事务 + 只 `persist()` 一次**(它重写整个库文件)。
   *
   *  【MC-083 残余】给"主键 + 它的 `.last-good` 备份必须同时落盘"这类成对写用:
   *  分两个 `set` 会各 `persist()` 一次,中间断电/中断就可能只写进主键、备份还留在旧值
   *  (`SettingRepo.set` 一次点击即整库重写,这里要的是"要么都写、要么都不写")。
   *  写入收进一个事务:任一项抛错就 ROLLBACK,不留半套;提交成功才落盘、才返回。
   *  与 `applySettingsImport`(settingsTransfer)同一取舍——那边管导入的整批回滚,这里
   *  只管少而确定的成对写(不另造一套写库逻辑:同款 upsert 语句)。 */
  setMany(entries: ReadonlyArray<readonly [string, string]>): void {
    if (entries.length === 0) return;
    const db = getDb();
    db.run("BEGIN");
    try {
      for (const [key, value] of entries) {
        db.run(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [v(key), v(value)],
        );
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },

  /** 按前缀列 key。给"一族按 id 分开存的小状态"清理用(见 `automationEventOrigin.ts`
   *  的 `automation.eventChain.<sessionId>`:每次运行写一行,从前没有任何一处删得掉)。 */
  keysWithPrefix(prefix: string): string[] {
    const db = getDb();
    // ⚠️ 这是**双引号字符串**,所以 `'\\'` 到了运行时正好是 `'\'` —— 一个反斜杠,
    // 也就是 SQL 要的那个**单字符**转义符。写成 `'\\\\'` 的话运行时是两个,SQLite
    // 当场拒绝(`ESCAPE expression must be a single character`),而唯一的调用方
    // `sweepEventChains` 把异常 catch 成一行 warn —— 清理于是**一次都没跑成过**,
    // `automation.eventChain.*` 只增不减,而这张表每写一次都要重写整个库文件。
    // (下面 `findMany` 那两处是模板字符串,`\\` 同样只转出一个反斜杠,两边一致。)
    const stmt = db.prepare("SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\'");
    // `_` 与 `%` 在 LIKE 里是通配符,前缀里出现就会多匹配 —— 转义掉。
    stmt.bind([v(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)]);
    const out: string[] = [];
    while (stmt.step()) out.push(String((stmt.getAsObject() as { key: BindValue }).key));
    stmt.free();
    return out;
  },

  /** 删一个 key(没有也不算错)。 */
  delete(key: string): void {
    getDb().run("DELETE FROM settings WHERE key = ?", [v(key)]);
    persist();
  },

  /** 一次删掉一批(只 `persist()` 一次 —— 它重写整个库文件)。 */
  deleteMany(keys: readonly string[]): void {
    if (keys.length === 0) return;
    const db = getDb();
    // 同 LibraryRepo.delete:多行删除要么全成、要么全不成,不留半状态。
    db.run("BEGIN");
    try {
      for (const key of keys) db.run("DELETE FROM settings WHERE key = ?", [v(key)]);
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    persist();
  },
};
