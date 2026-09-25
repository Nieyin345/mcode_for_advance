/**
 * SQLite persistence layer (sql.js / WASM-compiled-to-asm.js).
 *
 * Why sql.js instead of better-sqlite3? better-sqlite3 is a native addon and
 * its prebuilt binary didn't match Electron's ABI on this machine, with no
 * MSVC toolchain to rebuild it. sql.js is pure JavaScript (we use the asm.js
 * build so there's not even a .wasm to load), so it runs anywhere with zero
 * native compilation — clone and `pnpm dev` works for everyone.
 *
 * Trade-off: the database lives in memory and we flush it to a file on writes
 * (see `persist()`). For our workload (session/message rows, low write rate)
 * this is instant and the file is always consistent.
 */
import { app } from "electron";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js/dist/sql-asm.js";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { log } from "@main/lib/logger.js";
import { dataRoot, migrateLegacyIntoDataRoot, DATA_DB_FILENAME } from "@main/lib/dataRoot.js";
import { SESSION_COLUMNS, sessionsCreateSql } from "./sessionSchema.js";

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let dbPath: string | null = null;
/** 本次 `migrate()` 是否真的加过列。声明在模块顶部(而不是函数旁边)是为了不依赖
 *  「模块体先跑完、再调用 migrate」这个顺序 —— 那样只要将来有人在 await 之前调用
 *  migrate,就会撞上 let 的暂时性死区。 */
let schemaChanged = false;
/** True once persist() is already scheduled - collapses rapid writes into one flush. */
let persistPending = false;
/** Backstop timer for {@link persist}. See the comment there. */
let persistFallback: ReturnType<typeof setTimeout> | null = null;
/** One-shot flag so the happy path logs its first flush but not every one. */
let loggedFirstFlush = false;

/**
 * Resolves once `initDb()` has finished loading sql.js + opening the file +
 * migrating. IPC handlers `await` this before touching the DB so the window
 * can be created before DB init completes (startup decoupling). Null until
 * `initDb()` is first called; `awaitDb()` then returns a resolved promise.
 */
let dbReadyPromise: Promise<void> | null = null;

/** Wait for the DB to be ready. Safe to call before `initDb()` - returns a
 *  resolved promise in that case (callers must still handle the "not yet
 *  initialized" path via `getDb()`'s throw). */
export function awaitDb(): Promise<void> {
  return dbReadyPromise ?? Promise.resolve();
}

/** Initialize (or reuse) the singleton database. Must be called after
 * `app.whenReady()` (uses `app.getPath`). Loads the existing file if present,
 * else creates empty.
 *
 * Returns a Promise<Database> for callers that need the handle, but also
 * populates `dbReadyPromise` so IPC handlers can `await awaitDb()` without
 * holding the handle. Safe to fire-and-forget (`void initDb()`) to start DB
 * init in the background while the window loads. */
export function initDb(): Promise<Database> {
  if (db) return Promise.resolve(db);
  if (dbReadyPromise) return dbReadyPromise.then(() => db!);

  dbReadyPromise = (async () => {
    SQL = await initSqlJs();
    // 先把老位置(旧版把库和数据库放在 userData 下)搬进统一数据根,**再**定路径 ——
    // 顺序反了就会读到一个还不存在的文件、当成空库建一个新的。
    migrateLegacyIntoDataRoot();
    dbPath = join(dataRoot(), DATA_DB_FILENAME);

    if (existsSync(dbPath)) {
      db = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
      log.info(`sqlite opened from existing file: ${dbPath}`);
    } else {
      db = new SQL.Database();
      log.info(`sqlite created new database: ${dbPath}`);
    }
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
  })();

  return dbReadyPromise.then(() => db!);
}

/** Get the initialized connection. Throws if initDb() hasn't resolved yet. */
export function getDb(): Database {
  if (!db) throw new Error("getDb() called before initDb() resolved");
  return db;
}

/** Create tables if missing. Idempotent — safe on every startup. */
function migrate(database: Database): void {
  // 本次迁移是否真的动过表结构。结束时据此决定要不要立刻落盘 —— 见函数末尾。
  schemaChanged = false;
  database.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      archived    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    /* sessions 的列由 store/sessionSchema.ts 的 SESSION_COLUMNS 生成(单一事实
       来源:CREATE / ALTER / INSERT / rowToSession 全从那一份定义出)。 */
    ${sessionsCreateSql()};
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    /* ── 工作流 ──────────────────────────────────────────────────────────
       用户画的流程图(节点 / 依赖边 / 位置),取代原来写死在 systemPrompt.ts 里
       那五个对话模式。

       **为什么是表而不是一个 settings 键**:SettingRepo.set 内部调 persist(),
       而 sql.js 的 persist 是**重写整个数据库文件** —— 画布上拖一个节点就要存一次,
       那是"拖一下重写整库"。工作流又是用户资产(要增删改查、排序),和
       projects / library_items 同类。

       内置的六个工作流**不入库** —— 它们的默认版在代码里(main/orchestration/
       builtins.ts),这张表里的一行是**用户对它的覆盖**(同名 id)。所以
       「恢复默认」= 删掉那一行,代码里的原版立刻回来。

       id 两类:内置的沿用原模式 id(default / search / read / write / review /
       code),用户自建的 "wf_" 前缀。因为内置 id 没变,sessions.composer_mode
       列里那些旧值**不需要任何迁移**。 */
    CREATE TABLE IF NOT EXISTS workflows (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      icon        TEXT,
      -- 1 = 这一行是对某个内置工作流的覆盖(而不是用户新建的)
      builtin     INTEGER NOT NULL DEFAULT 0,
      -- JSON:WorkflowDoc,含 nodes / edges / prompt / 各节点坐标
      payload     TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    /* ── 工作流的运行 ────────────────────────────────────────────────────
       一次图型工作流跑到哪儿了。写它只有一个理由:**进程会死**。

       节点会话、流程记录、用户点过的岔路口 —— 全在内存里,应用一关就什么都不剩,
       包括一张已经停在岔路口等了半天的图。有了这一行,重启之后用户点一下那张旧
       卡片就能接着往下跑,而不是从第一步重来(见 main/orchestration/runStore.ts
       与 runner.ts 的 resumeRun)。

       payload 是 JSON 的 RunSnapshot:用户最初那句请求、跑在哪个目录、流程记录、
       每个节点跑过几次、已经定下来的岔路口选择、每个节点的结局。

       ⚠️ **只写"状态变了"那几个时刻**(开跑、某一步定案、停在岔路口、收尾),
       不是每来一个 token 写一次 —— persist() 是重写整个数据库文件(见上面
       workflows 表那段注释),按 token 写就是按 token 重写整库。

       (⚠️ SQL 注释里**不要写反引号**:这整段在一个 JS 模板字符串里,一个反引号
       就会把字符串提前结束掉。) */
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL,
      -- running | interrupted | success | failed | cancelled
      status      TEXT NOT NULL,
      -- **正停在哪几格等用户拍板**(逗号分隔的节点 id;一个都没在等就是空串)。
      -- 它单独成一列而不是埋在 payload 里,是为了让"这个对话里有没有断在这儿"能
      -- 直接看出来 —— 排查时不用先把每行的 JSON 解开。
      awaiting_node TEXT,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_session
      ON workflow_runs(session_id, created_at DESC);

    /* ── 文献库 ──────────────────────────────────────────────────────────
       与会话数据完全解耦:库是全局的(所有项目共用),不挂在 project 下。
       pdf_path / md_path 一律存**相对库根目录**的路径 —— 库位置可被用户改,
       存绝对路径会在搬迁后全部失效。 */

    CREATE TABLE IF NOT EXISTS library_items (
      id          TEXT PRIMARY KEY,
      -- 属于哪个类型:开放字符串注册表(内置 8 类,用户可自建,见 contracts 的 BUILTIN_LIBRARY_TYPES)。
      -- 「paper / textbook / note」只是最早的三个内置值,不是全集。
      kind        TEXT NOT NULL DEFAULT 'paper',
      doi         TEXT,
      arxiv_id    TEXT,
      title       TEXT NOT NULL,
      authors     TEXT,
      year        INTEGER,
      venue       TEXT,
      -- 卷 / 期 / 页码 / 出版商:引用格式(GB/T 7714、APA、BibTeX)要用。
      -- 一律 TEXT —— 页码有「1234-1240」「e0123456」「S1-S8」多种形态,切片成数字必丢信息。
      volume      TEXT,
      issue       TEXT,
      page        TEXT,
      publisher   TEXT,
      abstract    TEXT,
      type        TEXT NOT NULL DEFAULT 'article',
      language    TEXT,
      url         TEXT,
      pdf_path    TEXT,
      pdf_sha256  TEXT,
      md_path     TEXT,
      source      TEXT,
      license     TEXT,
      -- 通用文件条目(统一资料库):entry_mode = attached(复制入库,相对库根)/
      -- linked(引用原路径,文件不动,可为目录);file_path 是通用文件路径。
      -- 旧的文献流(pdf_path/md_path)不受影响;老库 ALTER 出来的行缺省按 attached 读。
      entry_mode  TEXT NOT NULL DEFAULT 'attached',
      file_path   TEXT,
      added_at    INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    -- 去重靠这两个唯一索引。用部分索引(WHERE ... IS NOT NULL)是因为 SQLite 的
    -- UNIQUE 允许多个 NULL,不加 WHERE 也能工作,但显式写出来意图更清楚,
    -- 且能避免"空串算不算重复"的歧义 —— 空串在写入前会被规范化成 NULL。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_items_doi
      ON library_items(doi) WHERE doi IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_items_arxiv
      ON library_items(arxiv_id) WHERE arxiv_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_library_items_added ON library_items(added_at DESC);
    -- 内容寻址:同一个 PDF 被两条记录指向时(理论上不该发生)便于排查
    CREATE INDEX IF NOT EXISTS idx_library_items_sha ON library_items(pdf_sha256);

    CREATE TABLE IF NOT EXISTS library_collections (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      -- 分类也是分库的:三个库各有各的分类树(同一层级里不会混着论文和笔记)
      kind       TEXT NOT NULL DEFAULT 'paper',
      -- 这个分类的「给 AI 的说明」(统一资料库):拼进该分类的清单。NULL = 没写。
      prompt     TEXT,
      parent_id  TEXT REFERENCES library_collections(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_library_collections_parent ON library_collections(parent_id);

    -- 多对多:一篇文献可同时属于多个集合(如「按方法分」与「按项目分」两个正交维度)
    CREATE TABLE IF NOT EXISTS library_collection_items (
      collection_id TEXT NOT NULL REFERENCES library_collections(id) ON DELETE CASCADE,
      item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      added_at      INTEGER NOT NULL,
      PRIMARY KEY (collection_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_library_collection_items_item ON library_collection_items(item_id);

    -- 笔记表本期只建不用(UI 留到后续期次),先把 schema 定下来避免后续迁移
    CREATE TABLE IF NOT EXISTS library_notes (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      origin     TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_library_notes_item ON library_notes(item_id);

    /* 条目之间的关联 —— 一条条目指向一批别的文件。
       形状是「一对多」而不是「两两配对」(用户原话:不是两两之间关联,可以一个关联
       多个文件),所以是 item_id 指向若干目标,不是 A-B 配对表。

       目标是两选一,CHECK 强制恰好有一种:
         - target_item_id 非空 → 库里的另一条条目(经典的「PDF 和它的 MD」)
         - target_path    非空 → 库外的绝对路径(桌面上一份参考资料也该挂得上)

       级联只在条目这一侧(来源或目标条目被删,关联跟着走)。target_path 那一支
       不级联 —— 那是文件系统的事,文件被移走时由读取方跳过。

       唯一索引让"同一条目对同一个目标"只留一条,于是重复 add 是幂等的。 */
    CREATE TABLE IF NOT EXISTS library_item_links (
      id             TEXT PRIMARY KEY,
      item_id        TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      target_item_id TEXT REFERENCES library_items(id) ON DELETE CASCADE,
      target_path    TEXT,
      created_at     INTEGER NOT NULL,
      CHECK ((target_item_id IS NULL) <> (target_path IS NULL))
    );
    -- 两个方向都要查:正向(这条关联了谁)与反向(谁关联了这条 —— 界面双向展示用)。
    CREATE INDEX IF NOT EXISTS idx_library_item_links_item ON library_item_links(item_id);
    CREATE INDEX IF NOT EXISTS idx_library_item_links_target
      ON library_item_links(target_item_id) WHERE target_item_id IS NOT NULL;
    -- 同一条目的同一个目标只留一条(重复 add 幂等,靠这条挡住)。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_item_links_uniq_item
      ON library_item_links(item_id, target_item_id) WHERE target_item_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_item_links_uniq_path
      ON library_item_links(item_id, target_path) WHERE target_path IS NOT NULL;

    /* 机构认证入口档案。
       ⚠️ 本表**不含凭据** —— 真正的登录态在浏览器分区
       (persist:mcode-browser)的 cookie 里,由 BrowserManager 的保管库负责持久化。
       本表只是「常用入口 + 域名」的组织性记录,删了不会登出任何站点。 */
    CREATE TABLE IF NOT EXISTS institution_profiles (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      login_url    TEXT,
      domains      TEXT,
      proxy_prefix TEXT,
      notes        TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    /* 下载任务。同一文献重试累加 attempts 而不是新建行 —— item_id 唯一。 */
    CREATE TABLE IF NOT EXISTS download_jobs (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      status     TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      error      TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_download_jobs_item ON download_jobs(item_id);
    CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status);

    /* 长期任务(contracts/src/longTask.ts)。一条会话同时只有一条 running(任务循环器
       把关),但历史上可以有多条 —— 每次「长任务」开关发送都是一条新行。 */
    CREATE TABLE IF NOT EXISTS long_tasks (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id     TEXT NOT NULL,
      goal           TEXT NOT NULL,
      status         TEXT NOT NULL,
      iterations     INTEGER NOT NULL DEFAULT 0,
      max_iterations INTEGER NOT NULL,
      note           TEXT,
      started_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      finished_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_long_tasks_session ON long_tasks(session_id, started_at);
  `);
  // Backward-compatible column adds for dbs created before these columns
  // existed (CREATE TABLE IF NOT EXISTS won't alter an existing table).
  //
  // sessions 的兼容列全部由 sessionSchema.ts 的 SESSION_COLUMNS 生成。**对全部
  // 列都跑一遍** addColumnIfMissing,而不是只挑"不在 CREATE 里"的那些 —— 有些列
  // (provider_id/effort/archived/pinned_at…)虽然是今天 CREATE 的一部分,却是
  // 中途才加进建表语句的,更老的库照样缺它们。addColumnIfMissing 自带存在性
  // 检查,列已在就跳过,28 次 pragma 查询开销可以忽略。
  for (const col of SESSION_COLUMNS) {
    addColumnIfMissing(database, "sessions", col.name, col.def);
  }
  addColumnIfMissing(database, "projects", "archived", "INTEGER NOT NULL DEFAULT 0");
  // Optional user-assigned group name for the left-bar "grouped" view. NULL
  // means the project is ungrouped; the renderer treats "" / undefined as null.
  addColumnIfMissing(database, "projects", "group", "TEXT");
  // User-reorderable position (left-bar drag-to-reorder). Defaults to 0 so
  // pre-migration rows fall back to created_at ordering; new projects get
  // MAX(sort_order)+1 so they append to the end.
  addColumnIfMissing(database, "projects", "sort_order", "INTEGER NOT NULL DEFAULT 0");
  // Pin timestamp for the left bar's pinned-projects section (NULL = not
  // pinned). Pinned projects leave the flat list / their group and render
  // above the tree, most recent pin first; sort_order is untouched so
  // unpinning returns the project to its drag-order position. Mirrors
  // sessions.pinned_at above.
  addColumnIfMissing(database, "projects", "pinned_at", "INTEGER");

  // 文献库的卷 / 期 / 页码 / 出版商。引用格式(GB/T 7714、APA、BibTeX)要用 ——
  // 缺了就只能整段省略,所以这几个字段是"引用能不能用"的前提。老的库(这个改动
  // 之前建的)没有这几列,必须走 ALTER。
  addColumnIfMissing(database, "library_items", "volume", "TEXT");
  addColumnIfMissing(database, "library_items", "issue", "TEXT");
  addColumnIfMissing(database, "library_items", "page", "TEXT");
  addColumnIfMissing(database, "library_items", "publisher", "TEXT");

  // 三个平级的库(论文 / 教材 / 笔记)。老数据一律归到 `paper`,分类也一样 ——
  // 用户现有的东西本来就都是论文。
  addColumnIfMissing(database, "library_items", "kind", "TEXT NOT NULL DEFAULT 'paper'");
  addColumnIfMissing(database, "library_collections", "kind", "TEXT NOT NULL DEFAULT 'paper'");
  // 分类的「给 AI 的说明」:拼进该分类的清单(统一资料库,类型说明之外的第二层)。
  addColumnIfMissing(database, "library_collections", "prompt", "TEXT");

  // ── kind 退役（2026-09-24）──
  // 上面两列 `kind` **保留在库里但代码全面停止读写**（sql.js 没有 DROP COLUMN 的
  // 可移植写法；trash.ts 早有同款先例）。分类的归属改由 `group_id` 直接挂大类 ——
  // 从前分类挂在 kind 下、kind 再被大类表收编，现在是两步并一步。
  addColumnIfMissing(database, "library_collections", "group_id", "TEXT");
  // 一次性回填：老分类只有 kind，按旧大类表（settings 里的 `library.groups`，
  // LibraryGroupMeta.kinds）反查它该归哪个大类；查不到的归第一个大类。
  // 幂等：只填 `group_id IS NULL` 的行 —— 用户此后挪分类不会被打回。
  // ⚠️ 这里直接读 settings 表（不经 SettingRepo，避免模块加载顺序问题），
  // JSON 解析失败就全部归第一个大类，不抛 —— 迁移不能把启动卡死。
  {
    const needsBackfill = database
      .prepare("SELECT COUNT(*) AS n FROM library_collections WHERE group_id IS NULL")
      .getAsObject() as unknown as { n: number };
    if (needsBackfill.n > 0) {
      const row = database
        .prepare(`SELECT value FROM settings WHERE key = 'library.groups'`)
        .getAsObject() as unknown as { value: string | null };
      let groups: Array<{ id: string; kinds?: string[] }> = [];
      try {
        groups = JSON.parse(row.value ?? "[]");
      } catch {
        /* 坏 JSON：走下面的空表兜底 */
      }
      const groupOfKind = new Map<string, string>();
      for (const g of groups) {
        for (const k of g.kinds ?? []) groupOfKind.set(k, g.id);
      }
      const fallback = groups[0]?.id ?? "";
      const stmt = database.prepare("SELECT id, kind FROM library_collections WHERE group_id IS NULL");
      stmt.bind([]);
      const updates: Array<{ id: string; gid: string }> = [];
      while (stmt.step()) {
        const r = stmt.getAsObject() as unknown as { id: string; kind: string | null };
        updates.push({ id: r.id, gid: groupOfKind.get(r.kind ?? "") ?? fallback });
      }
      stmt.free();
      for (const u of updates) {
        database.run("UPDATE library_collections SET group_id = ? WHERE id = ?", [
          u.gid,
          u.id,
        ]);
      }
    }
  }


  // 统一资料库的通用文件条目(见 contracts/src/library.ts 的 LibraryItem.entryMode):
  // attached = 复制入库(相对库根),linked = 引用原路径(文件不动,可为目录)。
  // 老库没有这两列;ALTER 出来的既有行按 DEFAULT 'attached' 读,语义不变。
  addColumnIfMissing(database, "library_items", "entry_mode", "TEXT NOT NULL DEFAULT 'attached'");
  addColumnIfMissing(database, "library_items", "file_path", "TEXT");

  // Composite index for paginated message reads (cursor on created_at). The
  // single-column idx_messages_session above serves the same queries but
  // requires a sort; this index lets ORDER BY created_at LIMIT ? satisfy
  // cursor pagination without a filesort. Idempotent.
  database.run(
    "CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)",
  );

  // **上一次进程死掉时还在跑的那些运行,这一次不可能还在跑。** 节点会话、审批池、
  // 调度器里那几个 Map 全都随进程一起没了 —— 留着 `running` 只会让界面上显示一次
  // 永远不动的"运行中",而用户没法判断它到底是死是活。
  //
  // 标成 `interrupted` 而不是 `cancelled`:后者是"用户按了停止",两者在界面上该是
  // 两句不同的话。它也**不删** —— 那一行正是"上次断在这儿了"的唯一凭据,重启之后
  // 用户点那张旧卡片续跑,靠的就是它。
  //
  // 每次启动都跑一遍,幂等(`running` 的行只可能由活着的进程写出来)。它改的是数据
  // 不是结构,所以**不设 `schemaChanged`、也不为它单独落盘** —— 万一下一次写盘之前
  // 进程又死了,磁盘上那些行还是 `running`,再启动一次照样会被标对。
  database.run(
    "UPDATE workflow_runs SET status = 'interrupted', updated_at = ? WHERE status = 'running'",
    [Date.now()],
  );

  // 长期任务同理:循环器是**内存里**的订阅者,进程没了循环就没了 —— 留着 running
  // 只会让状态条显示一条永远不动的"进行中"。标成 stopped(带原因),不删:那条行
  // 是"上一次干到第几轮"的凭据,续不续由用户重新开任务决定(上下文还在会话里)。
  database.run(
    "UPDATE long_tasks SET status = 'stopped', note = '应用重启,任务中断', finished_at = ?, updated_at = ? WHERE status = 'running'",
    [Date.now(), Date.now()],
  );

  // 结构变更**立刻落盘**。
  //
  // 不落的话,ALTER 只活在内存里:磁盘上那份仍是老结构,直到用户碰巧触发了第一次
  // 写操作才被整体覆盖回去。功能上通常能自愈(每次启动都会重新跑迁移,幂等),但
  // 它有两个真问题:① 从外部看数据库的判断是错的(排查时会被"列怎么没了"误导);
  // ② 假如那次 ALTER 之后进程被强杀,而磁盘上的老结构又被新版代码用新列去查,
  // 就会报 no such column。改一行换掉这种不确定性是值得的。
  //
  // 只在**确实改过**时才写:没改的情况下落盘等于每次启动白白重写整个库文件。
  if (schemaChanged) {
    log.info("sqlite: schema changed — persisting migrated database");
    persist();
  }
}

/** Add a column only if it isn't already present. SQLite has no ADD COLUMN IF
 * NOT EXISTS, so we check pragma_table_info first. The column and table names
 * are double-quoted so SQLite keywords (e.g. `group`) work as identifiers —
 * without the quotes, `ADD COLUMN group TEXT` is a syntax error.
 *
 * 返回是否**真的改了** —— 调用方据此决定要不要落盘(见 `migrate` 末尾)。 */
function addColumnIfMissing(database: Database, table: string, column: string, def: string): boolean {
  const stmt = database.prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`);
  stmt.bind([table, column]);
  const exists = stmt.step();
  stmt.free();
  if (!exists) {
    database.run(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${def}`);
    schemaChanged = true;
    return true;
  }
  return false;
}

/**
 * 导出内存库的字节,**并把连接上的 `PRAGMA foreign_keys` 恢复回去**。
 *
 * ⚠️ 别直接用 `db.export()` —— sql.js 的导出会**整个重置连接状态**,其中就包括
 * `foreign_keys`,而它是**连接级**的开关,建库时那一次 `ON` 不会在导出后自动回来。
 * 后果是 silently 的:第一次写盘之后,所有 `ON DELETE CASCADE` 都不再触发,而
 * 一切看起来正常 —— 直到某天发现删了条目、挂在它下面的行还在。
 *
 * 也没有"再开一次就好"的便宜路子:内联 `db.export(); db.run("PRAGMA ...")` 在
 * 每个调用点各写一遍,迟早有人加第四个调用点忘了配。所以导出这件事只有这一个出口。
 */
function exportBytes(): Uint8Array {
  const data = db!.export();
  db!.run("PRAGMA foreign_keys = ON");
  return data;
}

/**
 * 立刻把内存里的数据库写到磁盘,**但不关闭连接**。
 *
 * 与 `persist()` 的区别:那个是防抖的(等微任务),这个同步落盘。给「迁移整个数据根」
 * 用 —— 得先保证磁盘上的那份是最新的,再去复制它;而复制失败时又不能把连接关掉
 * (关了应用就残了,得重启才能恢复)。
 */
export function flushDb(): void {
  try {
    if (db && dbPath) writeFileSync(dbPath, exportBytes());
  } catch (err) {
    log.error(`sqlite flush failed: ${(err as Error).message}`);
  }
}

/**
 * Flush the in-memory database to disk. Coalesced via the microtask queue so a
 * burst of writes (e.g. a replaceAll inside a transaction) hits the file once.
 * Call this after any write; readers don't need it.
 *
 * The coalescing flag used to be the only guard, which meant a single missed
 * microtask froze persistence for the rest of the process: `persistPending`
 * stayed true, every later call returned at the top, and the file only ever
 * changed when `closeDb()` force-flushed at quit. Observed in the wild as
 * "the DB is frozen at its startup contents, but nothing errors". Hence the
 * timer backstop below - a dropped flush now costs 250ms, not the session.
 */
export function persist(): void {
  if (!db || !dbPath) {
    log.warn(`persist skipped: no database handle (db=${!!db}, dbPath=${dbPath})`);
    return;
  }
  if (persistPending) return;
  persistPending = true;

  const flush = (via: string): void => {
    if (!persistPending) return;
    persistPending = false;
    if (persistFallback) {
      clearTimeout(persistFallback);
      persistFallback = null;
    }
    try {
      const data = exportBytes();
      // Ensure the userData dir exists (it should, but be defensive).
      const dir = join(dbPath!, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(dbPath!, data);
      if (via !== "microtask") {
        log.info(`sqlite persisted ${data.length}B via ${via} (coalesced flush was dropped)`);
      } else if (!loggedFirstFlush) {
        loggedFirstFlush = true;
        log.info(`sqlite persisted ${data.length}B via microtask`);
      }
    } catch (err) {
      log.error(`sqlite persist failed (via ${via}): ${(err as Error).message}`);
    }
  };

  // Happy path: share one export+write across every synchronous write in a tick.
  try {
    queueMicrotask(() => flush("microtask"));
  } catch (err) {
    // If the microtask queue is unusable we cannot defer at all - write now
    // rather than lose the batch.
    log.error(`persist: cannot schedule microtask (${(err as Error).message}); flushing inline`);
    flush("inline");
    return;
  }

  persistFallback = setTimeout(() => {
    persistFallback = null;
    if (persistPending) flush("timer");
  }, 250);
  persistFallback.unref();
}

/** Close the connection on shutdown. Persist first so nothing is lost. */
export function closeDb(): void {
  try {
    // Unconditional: the file lags memory by up to the coalescing window, so
    // "a flush is pending" is not the only case where the file is behind.
    if (persistFallback) {
      clearTimeout(persistFallback);
      persistFallback = null;
    }
    persistPending = false;
    if (db && dbPath) writeFileSync(dbPath, exportBytes());
    db?.close();
  } catch {
    /* ignore — shutting down anyway */
  }
  db = null;
}
