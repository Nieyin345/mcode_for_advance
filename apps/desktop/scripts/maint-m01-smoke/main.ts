/**
 * MAINT-2026-09 / M01 独占探针套件 —— `main/store/**` 的数据完整性。
 *
 * 只属于 M01 这一个对话(见 docs/parallel-maintenance/PLAN.md §1 的写入边界)。
 * 它**不替代** db-migrate-smoke / db-persistence-smoke:那两套分别盯"老库升级"
 * 与"写盘失败的保全与重试";这一套盯的是另外三件事:
 *
 *  1. **导出之后外键还在不在** —— 不是只看 `PRAGMA foreign_keys` 这个开关的数值
 *     (db-persistence-smoke 已经看过一次),而是**真的删一行、看级联有没有发生**。
 *     sql.js 的 `db.export()` 会重置连接状态;开关读回 1 但级联其实没触发,是这条
 *     路上最贵的一种静默失败(删了条目、挂在它下面的行还在)。所以每一条 FK 边
 *     都在一次真实落盘**之后**才验。
 *  2. **关闭 → 重开之后数据一致** —— 关库、重开,逐表核对行数与字段。
 *  3. **重启把上次没跑完的 workflow_runs 标成 interrupted**,且这一步按 db.ts 的
 *     注释**不单独落盘**(磁盘上仍是 running,下次启动照样会标对)。
 *
 * 数据根是临时目录(见 stubs/dataRoot.ts:没设环境变量直接抛)。不碰真实用户库、
 * 不连网、不起 Electron。
 *
 * Run: scripts/maint-m01-smoke/run.sh
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { armFault, clearFault, faultHits } from "../db-persistence-smoke/stubs/fs.js";
import { dataRoot, DATA_DB_FILENAME } from "@main/lib/dataRoot.js";
import { initDb, getDb, flushDb, closeDb, persist, awaitDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, MessageRepo } from "@main/store/repositories.js";
import type { Project, Session } from "@contracts/session";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function count(sql: string, params: unknown[] = []): number {
  const stmt = getDb().prepare(sql);
  stmt.bind(params as never);
  stmt.step();
  const n = Number(stmt.get()[0]);
  stmt.free();
  return n;
}
function scalar(sql: string, params: unknown[] = []): unknown {
  const stmt = getDb().prepare(sql);
  stmt.bind(params as never);
  const found = stmt.step();
  const value = found ? stmt.get()[0] : undefined;
  stmt.free();
  return value;
}
function fkOn(): boolean {
  return getDb().exec("PRAGMA foreign_keys")[0]?.values[0]?.[0] === 1;
}

const now = Date.now();
const project = (id: string): Project => ({
  id, name: id, path: `/tmp/${id}`, archived: false, group: null,
  sortOrder: 0, pinnedAt: null, createdAt: now, updatedAt: now,
});
const session = (id: string, projectId: string, extra: Partial<Session> = {}): Session => ({
  id, projectId, providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
  parentSessionId: null, nodeId: null, agentProfile: null, title: id, status: "idle",
  model: "default", effort: "default", permissionMode: "default", workflowId: "default",
  customModelId: null, archived: false, pinnedAt: null, contextSnapshot: null,
  todos: null, subagents: null, planDraft: null, usageHistory: null, turnFiles: null,
  subagentTranscripts: null, bookmarks: null, createdAt: now, updatedAt: now, ...extra,
} as Session);

console.log("maint-m01-smoke: 起一个全新的临时库 …");
await initDb();
check("新建库:外键开关为 ON", fkOn());

/* ── 1. 铺一份覆盖每条 FK 边的数据 ───────────────────────────────────────── */
ProjectRepo.create(project("p1"));
SessionRepo.create(session("s1", "p1"));
SessionRepo.create(session("s1_side", "p1", { kind: "side", parentSessionId: "s1" }));
MessageRepo.replaceAll("s1", [
  { id: "m1", sessionId: "s1", role: "user", content: [], createdAt: now },
  { id: "m2", sessionId: "s1", role: "assistant", content: [], createdAt: now + 1 },
] as never);

const db = getDb();
db.run("INSERT INTO workflow_runs (id, session_id, workflow_id, status, awaiting_node, payload, created_at, updated_at) VALUES ('r1','s1','wf','running','', '{}', ?, ?)", [now, now]);
db.run("INSERT INTO library_items (id, title, entry_mode, added_at, updated_at) VALUES ('i1','A','attached',?,?)", [now, now]);
db.run("INSERT INTO library_items (id, title, entry_mode, added_at, updated_at) VALUES ('i2','B','attached',?,?)", [now, now]);
db.run("INSERT INTO library_collections (id, name, kind, created_at) VALUES ('c1','root','paper',?)", [now]);
db.run("INSERT INTO library_collections (id, name, kind, parent_id, created_at) VALUES ('c2','child','paper','c1',?)", [now]);
db.run("INSERT INTO library_collection_items (collection_id, item_id, added_at) VALUES ('c1','i1',?)", [now]);
db.run("INSERT INTO library_notes (id, item_id, content, origin, created_at, updated_at) VALUES ('n1','i1','x','user',?,?)", [now, now]);
db.run("INSERT INTO library_item_links (id, item_id, target_item_id, created_at) VALUES ('l1','i2','i1',?)", [now]);
db.run("INSERT INTO library_item_links (id, item_id, target_path, created_at) VALUES ('l2','i1','/tmp/x',?)", [now]);

/* ── 2. 真实落盘一次(这一步会调 db.export()),然后才验级联 ───────────────── */
flushDb();
const dbFile = join(dataRoot(), DATA_DB_FILENAME);
check("落盘:库文件已生成", existsSync(dbFile));
check("落盘后:外键开关仍为 ON", fkOn());

// 2a. 每条 FK 边都**真的删一行**看级联,而不是只读开关。
db.run("DELETE FROM library_items WHERE id = 'i1'");
eq("导出后级联:library_collection_items 随条目删除", count("SELECT COUNT(*) FROM library_collection_items WHERE item_id='i1'"), 0);
eq("导出后级联:library_notes 随条目删除", count("SELECT COUNT(*) FROM library_notes WHERE item_id='i1'"), 0);
eq("导出后级联:library_item_links.target_item_id 随目标条目删除", count("SELECT COUNT(*) FROM library_item_links WHERE id='l1'"), 0);
eq("导出后级联:library_item_links.item_id 随来源条目删除", count("SELECT COUNT(*) FROM library_item_links WHERE id='l2'"), 0);

flushDb();
db.run("DELETE FROM library_collections WHERE id = 'c1'");
eq("导出后级联:分类自引用 parent_id 级联删子分类", count("SELECT COUNT(*) FROM library_collections WHERE id='c2'"), 0);

/* ── 3. SessionRepo.delete:子会话保留并断开,消息级联 ─────────────────────── */
flushDb();
SessionRepo.delete("s1");
eq("删主会话:messages 级联删除", count("SELECT COUNT(*) FROM messages WHERE session_id='s1'"), 0);
eq("删主会话:workflow_runs 级联删除", count("SELECT COUNT(*) FROM workflow_runs WHERE session_id='s1'"), 0);
eq("删主会话:side 子会话保留", count("SELECT COUNT(*) FROM sessions WHERE id='s1_side'"), 1);
eq("删主会话:side 子会话的 parent_session_id 置空", scalar("SELECT parent_session_id FROM sessions WHERE id='s1_side'"), null);

/* ── 4. 删项目:整棵子树级联(仍在一次导出之后) ──────────────────────────── */
ProjectRepo.create(project("p2"));
SessionRepo.create(session("s2", "p2"));
MessageRepo.replaceAll("s2", [{ id: "m3", sessionId: "s2", role: "user", content: [], createdAt: now }] as never);
db.run("INSERT INTO workflow_runs (id, session_id, workflow_id, status, awaiting_node, payload, created_at, updated_at) VALUES ('r2','s2','wf','running','', '{}', ?, ?)", [now, now]);
flushDb();
ProjectRepo.delete("p2");
eq("删项目:sessions 级联删除", count("SELECT COUNT(*) FROM sessions WHERE project_id='p2'"), 0);
eq("删项目:messages 二级级联删除", count("SELECT COUNT(*) FROM messages WHERE session_id='s2'"), 0);
eq("删项目:workflow_runs 二级级联删除", count("SELECT COUNT(*) FROM workflow_runs WHERE id='r2'"), 0);

/* ── 5. 协程化 persist 之后不留暂存文件 ─────────────────────────────────── */
ProjectRepo.create(project("p3"));
persist();
await new Promise((r) => setTimeout(r, 400));
const leftovers = readdirSync(dataRoot()).filter((f) => f.includes(".persist-"));
eq("成功保存后不遗留 .persist-*.tmp 暂存文件", leftovers.length, 0, );
check("协程化 persist 真的写到了盘上", existsSync(dbFile));

/* ── 6. 关闭 → 重开:数据一致、外键仍开、未完成的运行被标成 interrupted ───── */
db.run("INSERT INTO workflow_runs (id, session_id, workflow_id, status, awaiting_node, payload, created_at, updated_at) VALUES ('r3','s1_side','wf','running','', '{}', ?, ?)", [now, now]);
flushDb();
closeDb();
await initDb();
check("重开:外键开关为 ON", fkOn());
eq("重开:项目行数一致", count("SELECT COUNT(*) FROM projects"), 2); // p1, p3
eq("重开:会话保留", count("SELECT COUNT(*) FROM sessions WHERE id='s1_side'"), 1);
eq("重开:上次未完成的运行被标成 interrupted", scalar("SELECT status FROM workflow_runs WHERE id='r3'"), "interrupted");
eq("重开:library_items 只剩 i2", count("SELECT COUNT(*) FROM library_items"), 1);

/* ── 7. 再关再开一次:interrupted 不会被改回、也没有重复行 ─────────────────── */
closeDb();
await initDb();
eq("二次重开:interrupted 保持幂等", scalar("SELECT status FROM workflow_runs WHERE id='r3'"), "interrupted");
eq("二次重开:没有重复的项目行", count("SELECT COUNT(*) FROM projects"), 2);
check("二次重开:外键开关为 ON", fkOn());
closeDb();

/* ── 8. initDb 必须走 dataRoot 的 dbPath() 安全网,而不是自己 join ──────────── */
// 曾经 db.ts 自己 `join(dataRoot(), DATA_DB_FILENAME)`,把 dbPath() 那道安全网绕过了:
// 搬迁失败(老库还在 userData、新位置没有)时会新建一个**空库**,用户以为记录全丢了。
{
  const dbSrc = readFileSync(resolve(process.cwd(), "src/main/store/db.ts"), "utf8");
  check("initDb 调用 dataRoot 的 dbPath() 解析器", /resolveDbPath\(\)/.test(dbSrc));
  check("initDb 不再自行拼接数据库路径", !/dbPath\s*=\s*join\(/.test(dbSrc));
}

/* ── 9. 迁移失败必须 fail-closed,且故障解除后能干净重试(MC-019) ──────────────
 *
 * 从前 `initDb()` 在开库之后**立刻**把句柄赋给模块级 `db`,随后才 `migrate()` ——
 * 迁移一抛,`db` 已非 null 而 `dbReadyPromise` 已 reject;再调 `initDb()` 会因
 * `if (db)` 返回那个**半迁移**的句柄,`getDb()` 也照样把它交出去。现在改成:先用
 * **局部**句柄开库 + 跑 PRAGMA + 迁移,全过关之后才发布 `db`;任何一步失败都关库、
 * 清状态,下一次调用能干净重试。
 *
 * 故障精确落在 migrate **中途**:把库文件写成**不是 sqlite** 的垃圾字节 —— sql.js 的
 * `new SQL.Database(bytes)` 不抛,要到第一次 `run()`(migrate 里第一个 `CREATE TABLE`)
 * 才抛 `file is not a database`。这正是"半初始化数据库"那个窗口。
 */
console.log("\nmaint-m01-smoke: 迁移失败 fail-closed + 可重试 …");
{
  const { writeFileSync, rmSync } = await import("node:fs");
  const corruptPath = join(dataRoot(), DATA_DB_FILENAME);

  // 库先关掉、文件清掉,再把垃圾字节写进去。
  closeDb();
  rmSync(corruptPath, { force: true });
  writeFileSync(corruptPath, Buffer.from("not a sqlite database — MC-019 corruption fixture"));

  // 9a. 首次 initDb 必须 reject(迁移失败),失败后 getDb() 不能交出半迁移的句柄。
  let init1Err: unknown = null;
  try { await initDb(); } catch (e) { init1Err = e; }
  check("★ 迁移失败时 initDb reject", init1Err !== null, String(init1Err));
  check(
    "★ 失败后 getDb() 仍然抛(不把半迁移句柄暴露给调用方)",
    (() => { try { getDb(); return false; } catch { return true; } })(),
  );

  // 9b. **再调 initDb 不能静默返回那个坏句柄。** 这是 MC-019 的核心:从前 `if (db)`
  //     会返回一个"成功"的 db(其实是半迁移的),现在必须仍旧 reject(可重试)。
  let init2Returned = false;
  let init2Err: unknown = null;
  try { await initDb(); init2Returned = true; } catch (e) { init2Err = e; }
  check(
    "★ 失败后再调 initDb 不会静默返回坏句柄(仍 reject,可重试)",
    !init2Returned && init2Err !== null,
    { init2Returned, err: String(init2Err) },
  );

  // 9c. awaitDb() 不能永久停在一个已 reject 的 promise 上(否则本进程里再也重试不了)。
  let awaitErr: unknown = null;
  try { await awaitDb(); } catch (e) { awaitErr = e; }
  check("★ 失败后 awaitDb() 不永久停在 rejected promise 上", awaitErr === null, String(awaitErr));

  // 9d. **故障解除**:清掉坏文件,initDb 应能恢复(新建空库),且库可用。
  rmSync(corruptPath, { force: true });
  await initDb();
  check("★ 故障解除后 initDb 恢复成功(新建空库)", !!getDb());
  check("恢复后外键开关为 ON", fkOn());
  ProjectRepo.create(project("p_recover"));
  flushDb();
  check("恢复后库文件落到了临时数据根(能正常落盘)", existsSync(corruptPath));
  eq("恢复后的库可读写", count("SELECT COUNT(*) FROM projects WHERE id='p_recover'"), 1);
  closeDb();
}

/* ── 10. 迁移落盘必须是 durable 的:磁盘失败 + 重试,不许产出「内存 ready / 磁盘没写」 ──
 *
 * 【MC-019 · 第 16 轮复核】§9 覆盖的是"迁移中途 SQL 失败"。这一节盯的是**另一格**:
 * 迁移本身的 SQL 全过了,但**把它落盘**那一步在磁盘上坏了(写/fsync/rename 失败)。
 *
 * 从前的写法:migrate 只置位 `migrateNeedsPersist`,`initDb` 在发布句柄之后用**协程化的**
 * `persist()` 落盘 —— 排一个 microtask,失败还会被吞掉转成后台重试。后果是 `initDb()`
 * 已经 resolve(= 对外宣布"库就绪",`awaitDb()` 从此返回已就绪)、内存里也是**新结构**,
 * 可磁盘上仍旧是老结构,而"迁移落盘失败了"这件事调用方一个字都看不到。若此刻进程被杀,
 * 新版代码用新列去查老库就是 `no such column` —— 台账点名的那种"内存 ready / 磁盘未 ready"。
 *
 * 现在:initDb 在发布句柄之后走**同一份** durable 同步写盘(`persistNowOrThrow`,与退出
 * 前落盘、workflow durable 闸门同源)。写成功才 resolve;写失败即抛出、落进 §9 那个 catch,
 * 把 db/dbPath/dbReadyPromise 清回 null,initDb **reject**。故障解除后重试能干净重来。
 *
 * 造一个**老结构**的库文件(缺后来补的列)才能让 migrate 真的有结构变更可落盘;故障精确
 * 落在把新结构写回磁盘那一步(见 db-persistence-smoke/stubs/fs.ts 的 write 注入)。
 */
console.log("\nmaint-m01-smoke: 迁移落盘 durable —— 磁盘失败不许留「内存 ready / 磁盘未 ready」 …");
{
  const { writeFileSync, rmSync } = await import("node:fs");
  const dbFile = join(dataRoot(), DATA_DB_FILENAME);

  closeDb();
  rmSync(dbFile, { force: true });

  // 老结构:三张核心表,**没有** provider_id / kind / env_mode / composer_mode 等后补列。
  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, claude_session_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL, permission_mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO projects VALUES ('p_legacy', '老项目', 'C:/legacy', 1, 1);
  `);
  const legacyBytes = legacy.export();
  legacy.close();
  writeFileSync(dbFile, Buffer.from(legacyBytes));

  const columnOnDisk = (column: string): boolean => {
    const fresh = new SQL.Database(new Uint8Array(readFileSync(dbFile)));
    try {
      const stmt = fresh.prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = ?");
      stmt.bind([column]);
      const found = stmt.step();
      stmt.free();
      return found;
    } finally { fresh.close(); }
  };
  check("前置:老库磁盘上没有 provider_id 列(迁移真的有事可做)", !columnOnDisk("provider_id"));

  // 10a. 迁移的 SQL 会成功,但把它写回磁盘那一步坏掉 → initDb 必须 reject。
  armFault(dbFile, "write");
  let init1Err: unknown = null;
  try { await initDb(); } catch (e) { init1Err = e; }
  clearFault();
  check("★ 迁移落盘失败时 initDb 必须 reject(不许假报就绪)", init1Err !== null, String(init1Err));
  check("★ 故障确实击中了数据库写入", faultHits > 0);
  check(
    "★ 落盘失败后 getDb() 仍抛:绝无「内存 ready / 磁盘未 ready」的句柄",
    (() => { try { getDb(); return false; } catch { return true; } })(),
  );

  // 10b. 磁盘文件必须**逐字节**还是那份老库(rename 从未发生),老结构原样在。
  check("★ 磁盘文件逐字节未变(没被半写的迁移结果污染)", readFileSync(dbFile).equals(Buffer.from(legacyBytes)));
  check("★ 磁盘上仍是老结构(没有 provider_id 这种新列)", !columnOnDisk("provider_id"));
  eq("磁盘上老数据一行不少", (() => {
    const fresh = new SQL.Database(new Uint8Array(readFileSync(dbFile)));
    try {
      const stmt = fresh.prepare("SELECT name FROM projects WHERE id='p_legacy'");
      stmt.step();
      const name = String(stmt.get()[0]);
      stmt.free();
      return name;
    } finally { fresh.close(); }
  })(), "老项目");

  // 10c. awaitDb() 不许永久停在 rejected promise 上(否则本进程里再也重试不了)。
  let awaitErr: unknown = null;
  try { await awaitDb(); } catch (e) { awaitErr = e; }
  check("★ 落盘失败后 awaitDb() 不永久停在 rejected promise 上", awaitErr === null, String(awaitErr));

  // 10d. 故障解除后重试:initDb 成功,且新结构**真的落到了磁盘**(不只是内存里有)。
  await initDb();
  check("★ 故障解除后 initDb 恢复成功", !!getDb());
  check("恢复后外键开关为 ON", fkOn());
  check("★ 重试成功之后新结构确实落到了磁盘(迁移 durable)", columnOnDisk("provider_id"));
  check("恢复后磁盘上老数据仍在", (() => {
    try { return scalar("SELECT name FROM projects WHERE id='p_legacy'") === "老项目"; }
    catch { return false; }
  })());
  closeDb();
}

console.log(`\nmaint-m01-smoke: ${checks - failures}/${checks} checks passed`);
if (failures > 0) { console.error(`maint-m01-smoke: ${failures} FAILED`); process.exit(1); }

