/**
 * Headless smoke for 数据库的**升级路径**(`main/store/db.ts` 的 `migrate()` 里
 * `addColumnIfMissing` 那一段)。
 *
 * ## 它验的是什么
 *
 * `CREATE TABLE IF NOT EXISTS` **改不了已存在的表** —— 老用户的库是老结构,新列全靠
 * 这一段一条条 `ALTER` 补出来。而 run-store-smoke 走的是"新建空库"那条路(建表语句
 * 里列本来就是全的),**兼容段一行都没执行过**。这一段错了,表现是升级用户一启动就
 * `no such column` 崩掉,全新安装的人却完全测不出来。
 *
 * 所以这里**手工造一个老结构的库文件**(没有后来加的那 20 多列,只插一行老数据),
 * 让 `initDb()` 自己走一遍迁移,然后断言:
 *
 *  1. **老数据一行不少、一个字段不变** —— 迁移是加列,不是重建;
 *  2. 补出来的 `NOT NULL DEFAULT` 列在老行上**真的有默认值**(`provider_id` /
 *     `kind` / `env_mode` / `composer_mode` …)。ALTER TABLE 加列时 SQLite 会用
 *     默认值填已有行 —— 但前提是 DDL 里写对了;写漏一个 DEFAULT,老行读到的是
 *     NULL,渲染端拿到 `session.kind === null` 就开始走奇怪的分支;
 *  3. 可空列在老行上是 **NULL**,不是空串;
 *  4. **迁移立刻落了盘** —— migrate() 末尾 `schemaChanged` 时会 persist(见 db.ts
 *     注释:不落盘的话,磁盘上还是老结构,排查时会被误导)。这里把磁盘文件**重新
 *     打开**验证,不信任内存里的那个句柄;
 *  5. 外键关系没断(messages 还能 join 上 sessions)。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(见 `stubs/`),run.sh 用 `mktemp -d`
 * 建的目录,跑完就删。**不是 `~/Mcode`** —— `initDb()` 在不存在的路径上会新建空库,
 * 指错了就是拿一个空库盖掉用户的聊天记录。
 *
 * Run: scripts/db-migrate-smoke/run.sh
 */
import initSqlJs, { type Database } from "sql.js/dist/sql-asm.js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot, DATA_DB_FILENAME } from "@main/lib/dataRoot.js";
import { initDb, getDb } from "@main/store/db.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** PRAGMA table_info 里有没有这一列。 */
function hasColumn(d: Database, table: string, column: string): boolean {
  const stmt = d.prepare("SELECT name FROM pragma_table_info(?) WHERE name = ?");
  stmt.bind([table, column]);
  const ok = stmt.step();
  stmt.free();
  return ok;
}

/** 一行一列。老库断言全是单值查询,不值得为此建一层映射。 */
function valueOf(d: Database, sql: string): unknown {
  const stmt = d.prepare(sql);
  stmt.step();
  const row = stmt.get();
  stmt.free();
  return row[0];
}

// ── 第一步:手工造一个"老版本"的库 ──────────────────────────────────────
// 结构就是 `migrate()` 兼容段动手之前的样子:三张核心表,**没有**后来加的列;
// workflows / workflow_runs / library_* / institution_profiles / download_jobs
// 这些后加的表整个不存在(老库里就没有),由 migrate() 的 CREATE TABLE IF NOT
// EXISTS 自己建出来。
console.log("db-migrate-smoke: 造老结构的库 …");
const SQL = await initSqlJs();
const old = new SQL.Database();
old.run(`
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    claude_session_id TEXT,
    title             TEXT NOT NULL,
    status            TEXT NOT NULL,
    model             TEXT NOT NULL,
    permission_mode   TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE library_items (
    id          TEXT PRIMARY KEY,
    doi         TEXT,
    arxiv_id    TEXT,
    title       TEXT NOT NULL,
    authors     TEXT,
    year        INTEGER,
    venue       TEXT,
    abstract    TEXT,
    type        TEXT NOT NULL DEFAULT 'article',
    language    TEXT,
    url         TEXT,
    pdf_path    TEXT,
    pdf_sha256  TEXT,
    md_path     TEXT,
    source      TEXT,
    license     TEXT,
    added_at    INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_library_items_doi ON library_items(doi) WHERE doi IS NOT NULL;

  INSERT INTO projects VALUES ('proj_old', '老项目', 'C:/research', 1000, 1000);
  INSERT INTO sessions VALUES ('sess_old', 'proj_old', 'eng_old', '老对话', 'active', 'claude-sonnet-4', 'bypassPermissions', 1000, 1000);
  INSERT INTO messages VALUES ('msg_old', 'sess_old', 'user', '第一句话', 1000);
  INSERT INTO settings VALUES ('migrated_from', 'pre-columns');
  INSERT INTO library_items (id, doi, title, added_at, updated_at) VALUES ('item_old', '10.1234/old', '老论文', 1000, 1000);
`);
const oldBytes = old.export();
old.close();

const root = dataRoot();
mkdirSync(root, { recursive: true });
writeFileSync(join(root, DATA_DB_FILENAME), Buffer.from(oldBytes));

// ── 第二步:initDb() 自己走一遍迁移(打开磁盘文件 → migrate → 必要时落盘) ──
console.log("db-migrate-smoke: initDb() 走迁移 …");
await initDb();

console.log("db-migrate-smoke: 断言 …");
const d = getDb();

// ① 老数据还在、字段没动
eq("老 project 的 name 不变", valueOf(d, "SELECT name FROM projects WHERE id='proj_old'"), "老项目");
eq("老 session 的 title 不变", valueOf(d, "SELECT title FROM sessions WHERE id='sess_old'"), "老对话");
eq("老 session 的 model 不变", valueOf(d, "SELECT model FROM sessions WHERE id='sess_old'"), "claude-sonnet-4");
eq("老 message 的 content 不变", valueOf(d, "SELECT content FROM messages WHERE id='msg_old'"), "第一句话");
eq("老 library 条目的 title 不变", valueOf(d, "SELECT title FROM library_items WHERE id='item_old'"), "老论文");

// ② 补出来的 NOT NULL DEFAULT 列,老行上要有默认值
eq("sessions.provider_id 补成默认", valueOf(d, "SELECT provider_id FROM sessions WHERE id='sess_old'"), "claude-sdk");
eq("sessions.effort 补成默认", valueOf(d, "SELECT effort FROM sessions WHERE id='sess_old'"), "default");
eq("sessions.archived 补成默认", valueOf(d, "SELECT archived FROM sessions WHERE id='sess_old'"), 0);
eq("sessions.kind 补成默认", valueOf(d, "SELECT kind FROM sessions WHERE id='sess_old'"), "chat");
eq("sessions.env_mode 补成默认", valueOf(d, "SELECT env_mode FROM sessions WHERE id='sess_old'"), "local");
eq("sessions.composer_mode 补成默认", valueOf(d, "SELECT composer_mode FROM sessions WHERE id='sess_old'"), "default");
eq("projects.archived 补成默认", valueOf(d, "SELECT archived FROM projects WHERE id='proj_old'"), 0);
eq("projects.sort_order 补成默认", valueOf(d, "SELECT sort_order FROM projects WHERE id='proj_old'"), 0);
eq("library_items.kind 补成默认", valueOf(d, "SELECT kind FROM library_items WHERE id='item_old'"), "paper");

// ③ 可空列是 NULL,不是空串
for (const col of [
  "context_snapshot", "todos", "subagents", "plan_draft", "custom_model_id",
  "pinned_at", "turn_files", "bookmarks", "subagent_transcripts",
  "usage_history", "parent_session_id", "worktree_path", "wt_style",
]) {
  check(`sessions.${col} 在老行上是 NULL`, valueOf(d, `SELECT ${col} FROM sessions WHERE id='sess_old'`) === null);
}
check("projects.group 在老行上是 NULL", valueOf(d, "SELECT [group] FROM projects WHERE id='proj_old'") === null);
check("library_items.volume 在老行上是 NULL", valueOf(d, "SELECT volume FROM library_items WHERE id='item_old'") === null);

// ④ 结构真的补齐了(列都在,不只是数据能查)
const NEW_SESSION_COLS = [
  "effort", "provider_id", "context_snapshot", "todos", "subagents", "plan_draft",
  "custom_model_id", "archived", "pinned_at", "turn_files", "bookmarks",
  "subagent_transcripts", "usage_history", "kind", "parent_session_id",
  "env_mode", "worktree_path", "wt_style", "composer_mode",
];
for (const c of NEW_SESSION_COLS) check(`sessions.${c} 列存在`, hasColumn(d, "sessions", c));
for (const c of ["archived", "group", "sort_order", "pinned_at"]) {
  check(`projects.${c} 列存在`, hasColumn(d, "projects", c));
}
for (const c of ["volume", "issue", "page", "publisher", "kind"]) {
  check(`library_items.${c} 列存在`, hasColumn(d, "library_items", c));
}

// ⑤ 迁移**立刻落盘**:重新打开磁盘上的文件验证,不信任内存句柄
{
  const freshSql = await initSqlJs();
  const fresh = new freshSql.Database(new Uint8Array(readFileSync(join(root, DATA_DB_FILENAME))));
  for (const c of ["provider_id", "kind", "env_mode", "composer_mode"]) {
    check(`磁盘文件里 sessions.${c} 列存在`, hasColumn(fresh, "sessions", c));
  }
  eq("磁盘文件里老数据还在", valueOf(fresh, "SELECT title FROM sessions WHERE id='sess_old'"), "老对话");
  fresh.close();
}

// ⑥ 外键关系没断
eq(
  "messages 还能 join 上 sessions",
  valueOf(d, "SELECT s.title FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id='msg_old'"),
  "老对话",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
