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
import { SessionRepo } from "@main/store/repositories.js";
import { SESSION_COLUMNS } from "@main/store/sessionSchema.js";
import type { Session } from "@contracts/session";

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
  -- 旧版会话插件名单和长任务已退役，但升级不得清除历史资料。
  ALTER TABLE sessions ADD COLUMN active_plugin_names TEXT;
  UPDATE sessions SET active_plugin_names = '["legacy-plugin"]' WHERE id = 'sess_old';
  CREATE TABLE long_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    iterations INTEGER NOT NULL DEFAULT 0,
    max_iterations INTEGER NOT NULL,
    note TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  INSERT INTO long_tasks (id, session_id, project_id, goal, status, max_iterations, started_at, updated_at)
    VALUES ('ltask_old', 'sess_old', 'proj_old', '旧任务', 'running', 20, 1000, 1000);
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
eq("旧会话插件名单仍在原列，不再投映进 Session", valueOf(d, "SELECT active_plugin_names FROM sessions WHERE id='sess_old'"), '["legacy-plugin"]');
check("旧插件名单不会出现在 SessionRepo.get 的返回值里", !("activePluginNames" in (SessionRepo.get("sess_old") ?? {})));
eq("旧长任务行仍在，不再自动改写状态", valueOf(d, "SELECT status FROM long_tasks WHERE id='ltask_old'"), "running");

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
eq("library_items.entry_mode 补成默认", valueOf(d, "SELECT entry_mode FROM library_items WHERE id='item_old'"), "attached");
check("library_items.file_path 在老行上是 NULL", valueOf(d, "SELECT file_path FROM library_items WHERE id='item_old'") === null);

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
for (const c of ["volume", "issue", "page", "publisher", "kind", "entry_mode", "file_path"]) {
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
  eq("磁盘上的旧插件名单未被销毁", valueOf(fresh, "SELECT active_plugin_names FROM sessions WHERE id='sess_old'"), '["legacy-plugin"]');
  eq("磁盘上的旧长任务未被销毁", valueOf(fresh, "SELECT goal FROM long_tasks WHERE id='ltask_old'"), "旧任务");
  fresh.close();
}

// ⑥ 外键关系没断
eq(
  "messages 还能 join 上 sessions",
  valueOf(d, "SELECT s.title FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id='msg_old'"),
  "老对话",
);

// ⑦ **全字段 round-trip**(SessionRepo.create → get)。
//
// 这是防「INSERT 列名/占位符/绑定值位置错位」的那道闸:每个字段塞一个**互不相同**
// 的哨兵值,整行写进去再整行读回来,任何一个字段串了列,断言当场红。以前 INSERT
// 是手抄 28 个列名 + 28 个 `?` + 28 个 `v(...)`,错一位没有任何报错 —— 数据悄悄
// 写进别的列;现在虽然列名和值已从同一个数组生成、结构上错不了,但只要有人改
// sessionSchema 时漏了某列的 bind/read,或哪天绕开单一来源手写 SQL,这里就会抓住。
console.log("db-migrate-smoke: 全字段 round-trip …");
{
  // 每个字段都用**别的字段没用过**的值,串列必然导致值对不上。
  const full = {
    id: "sess_full",
    projectId: "proj_old",
    providerId: "pi-sdk",
    claudeSessionId: "cs-full-1",
    kind: "side",
    parentSessionId: "sess_old",
    title: "全字段对话",
    status: "active",
    model: "test-model-full",
    effort: "high",
    permissionMode: "bypassPermissions",
    workflowId: "wf-roundtrip",
    customModelId: "cm-full-1",
    archived: true,
    pinnedAt: 4242,
    contextSnapshot: { sentinel: "ctx-snap" },
    todos: [{ sentinel: "todos" }],
    subagents: [{ sentinel: "subagents" }],
    planDraft: { sentinel: "plan-draft" },
    turnFiles: [{ sentinel: "turn-files" }],
    usageHistory: [{ sentinel: "usage-hist" }],
    bookmarks: [{ sentinel: "bookmarks" }],
    subagentTranscripts: { tu_1: [{ sentinel: "sub-tx" }] },
    envMode: "worktree",
    worktreePath: "C:/wt-full",
    wtStyle: "branch",
    createdAt: 1111,
    updatedAt: 2222,
  } as unknown as Session;

  SessionRepo.create(full);
  const back = SessionRepo.get("sess_full");
  check("round-trip: 能读回来", back !== undefined);
  if (back) {
    eq("round-trip id", back.id, "sess_full");
    eq("round-trip projectId", back.projectId, "proj_old");
    eq("round-trip providerId", back.providerId, "pi-sdk");
    eq("round-trip claudeSessionId", back.claudeSessionId, "cs-full-1");
    eq("round-trip kind", back.kind, "side");
    eq("round-trip parentSessionId", back.parentSessionId, "sess_old");
    eq("round-trip title", back.title, "全字段对话");
    eq("round-trip status", back.status, "active");
    eq("round-trip model", back.model, "test-model-full");
    eq("round-trip effort", back.effort, "high");
    eq("round-trip permissionMode", back.permissionMode, "bypassPermissions");
    eq("round-trip workflowId(composer_mode 列)", back.workflowId, "wf-roundtrip");
    eq("round-trip customModelId", back.customModelId, "cm-full-1");
    check("round-trip archived", back.archived === true);
    eq("round-trip pinnedAt", back.pinnedAt, 4242);
    // JSON 字段比较序列化后的形状(读回来是 parse 过的对象,逐键断言太啰嗦)。
    for (const [label, a, b] of [
      ["contextSnapshot", back.contextSnapshot, { sentinel: "ctx-snap" }],
      ["todos", back.todos, [{ sentinel: "todos" }]],
      ["subagents", back.subagents, [{ sentinel: "subagents" }]],
      ["planDraft", back.planDraft, { sentinel: "plan-draft" }],
      ["turnFiles", back.turnFiles, [{ sentinel: "turn-files" }]],
      ["usageHistory", back.usageHistory, [{ sentinel: "usage-hist" }]],
      ["bookmarks", back.bookmarks, [{ sentinel: "bookmarks" }]],
      ["subagentTranscripts", back.subagentTranscripts, { tu_1: [{ sentinel: "sub-tx" }] }],
    ] as const) {
      check(`round-trip ${label}`, JSON.stringify(a) === JSON.stringify(b), a);
    }
    eq("round-trip envMode", back.envMode, "worktree");
    eq("round-trip worktreePath", back.worktreePath, "C:/wt-full");
    eq("round-trip wtStyle", back.wtStyle, "branch");
    eq("round-trip createdAt", back.createdAt, 1111);
    eq("round-trip updatedAt", back.updatedAt, 2222);
  }
  // 结构守门：SESSION_COLUMNS 恰好覆盖现行列；旧库额外的退役插件列故意保留
  // 在物理表里，但不再迁移、读写、发送。不能为了通过断言而 DROP 历史列。
  const dbCols: string[] = [];
  {
    const stmt = d.prepare("SELECT name FROM pragma_table_info('sessions')");
    while (stmt.step()) dbCols.push((stmt.getAsObject() as { name: string }).name);
    stmt.free();
  }
  const defCols = SESSION_COLUMNS.map((c) => c.name).sort();
  const currentCols = dbCols.filter((name) => name !== "active_plugin_names");
  check(
    "SESSION_COLUMNS 与现行表结构列数一致（不销毁旧插件列）",
    currentCols.length === defCols.length,
    { currentCols: currentCols.length, defCols: defCols.length },
  );
  check(
    "SESSION_COLUMNS 与现行表结构列名一致",
    JSON.stringify(currentCols.slice().sort()) === JSON.stringify(defCols),
  );
  eq("常规新会话写入不覆盖旧会话的插件资料", valueOf(d, "SELECT active_plugin_names FROM sessions WHERE id='sess_old'"), '["legacy-plugin"]');
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
