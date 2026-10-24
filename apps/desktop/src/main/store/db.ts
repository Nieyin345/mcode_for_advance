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
 * (see `persist()`). Every save fsyncs a staging file before replacing the
 * last good snapshot; failed saves retain the in-memory data and retry.
 */
import { app } from "electron";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js/dist/sql-asm.js";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, openSync, fsyncSync, closeSync } from "node:fs";
import { log } from "@main/lib/logger.js";
import { migrateLegacyIntoDataRoot, dbPath as resolveDbPath } from "@main/lib/dataRoot.js";
import { SESSION_COLUMNS, sessionsCreateSql } from "./sessionSchema.js";
import { TASKS_CREATE_SQL } from "./taskSchema.js";
import { APPROVALS_CREATE_SQL } from "./approvalSchema.js";
import { withStatement } from "./repositories/withStatement.js";
import { DEFAULT_LIBRARY_GROUPS, parseLibraryGroupsJson, LIBRARY_GROUPS_SETTING_KEY } from "@contracts/libraryTypes";
import type { CommitResult } from "@contracts/commit";

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let dbPath: string | null = null;
/** 本次 `migrate()` 是否真的加过列。声明在模块顶部(而不是函数旁边)是为了不依赖
 *  「模块体先跑完、再调用 migrate」这个顺序 —— 那样只要将来有人在 await 之前调用
 *  migrate,就会撞上 let 的暂时性死区。 */
let schemaChanged = false;
/** 迁移结束时是否留下了**需要立刻落盘**的改动(结构变更或分类回填)。由 migrate()
 *  置位,由 initDb() 在**发布句柄之后**读取并 persist —— 之前是 migrate() 自己调
 *  persist(),而那时 db 尚未发布(见 initDb),写盘会落空。 */
let migrateNeedsPersist = false;
/** True once persist() is already scheduled - collapses rapid writes into one flush. */
let persistPending = false;
/** Backstop timer for {@link persist}. See the comment there. */
let persistFallback: ReturnType<typeof setTimeout> | null = null;
/** One-shot flag so the happy path logs its first flush but not every one. */
let loggedFirstFlush = false;
/** Dirty is separate from scheduled: a failed callback is NOT a saved DB. */
let persistDirty = false;
let persistEpoch = 0;
let persistRetry: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = 1000;
let persistenceFailure: Error | null = null;
const persistenceErrorListeners = new Set<(error: Error) => void>();
/** 【ARC-009】进程内**成功落盘**的序号(每次 fsync+rename 成功 +1)。给 `OperationResult`
 *  `durableRevision` 一个真值,回答「这份是不是最后一次落盘」。**只增不减、不因失败回退**。 */
let durableRevision = 0;

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
  // A previously-failed attempt must not poison this one: a rejected
  // dbReadyPromise is cleared in the failure handler below (we null it before
  // the microtask that awaits it runs), so reaching here again starts fresh.
  if (db) return Promise.resolve(db);
  if (dbReadyPromise) return dbReadyPromise.then(() => db!);

  dbReadyPromise = (async () => {
    // ── fail-closed 初始化(整条链一个最终 catch)─────────────────────────────
    // 【MC-019 · 第 6/12 轮复核】从前只有 `new SQL.Database` / PRAGMA / migrate 那一段
    // 在 try 里,而 `initSqlJs()`(WASM 加载)与 `migrateLegacyIntoDataRoot()`(搬老库)
    // 在它**外面** —— 那两步任一 reject,`dbReadyPromise` 就永远指向一个已拒绝的 Promise,
    // 再调 initDb 仍返回它,本进程内**无法重试**。现在把整条链包进一个 catch:
    // 任何失败都清掉本地状态(db/dbPath/dbReadyPromise/标志回 null),下一次调用
    // 就能干净重来。
    let localDb: Database | null = null;
    try {
      SQL = await initSqlJs();
      // 先把老位置(旧版把库和数据库放在 userData 下)搬进统一数据根,**再**定路径 ——
      // 顺序反了就会读到一个还不存在的文件、当成空库建一个新的。
      migrateLegacyIntoDataRoot();
      // 用 `dataRoot.ts` 的 `dbPath()` 而不是自己 join —— 它带**安全网**:搬迁失败
      // (老库还在 userData、新位置没有)时继续用老库,避免在建空库让聊天记录看起来
      // "全丢了"。过去这里自己 join,把那道网绕过了。
      const path = resolveDbPath();

      // 先用**局部**句柄开库 + 跑 PRAGMA + 迁移,全部成功之后才发布到模块级 `db`。
      // 之前是"开库立刻赋值给 db、随后才 migrate":迁移一抛,`db` 已非 null 而
      // `dbReadyPromise` 已 reject —— 再调 initDb 会因首个 `if (db)` 返回那个**半迁移**
      // 的句柄,getDb() 也照样把它交出去。
      localDb = existsSync(path)
        ? new SQL.Database(new Uint8Array(readFileSync(path)))
        : new SQL.Database();
      localDb.run("PRAGMA foreign_keys = ON");
      migrate(localDb);

      // 迁移成功 —— 现在才发布句柄,并记下路径。
      db = localDb;
      dbPath = path;
      log.info(existsSync(path) ? `sqlite opened from existing file: ${path}` : `sqlite created new database: ${path}`);
      // 结构变更/分类回填的落盘放在**句柄发布之后**(migrate() 内部只置位、不写盘):
      // persistNowOrThrow() 要读模块级 db/dbPath,发布前调它会静默跳过。
      //
      // 【MC-019】这里**必须**走**同步 durable** 那一份写盘(persistNowOrThrow),不能用
      // 协程化的 `persist()`。理由就是"内存 ready / 磁盘未 ready"那个窗口:`initDb()`
      // resolve 等于向外声明"数据库就绪"——`awaitDb()` 从这一刻起就返回已就绪。若此刻
      // 迁移后的结构还只在内存里、写盘只是排了一个 microtask,那么在这条 microtask 跑
      // 完之前进程被杀(或被别的调用方抢到一次 `getDb()`),磁盘上留着的仍是**老结构**:
      // 新版代码用新列去查老库就是 `no such column`,而调用方同时看到"库 ready"与
      // "初始化没报错"。`persist()` 还会把写盘失败**吞掉**(notify + 退避重试),于是
      // "写盘失败"这条路上内存是 ready 的、磁盘永远没写成 —— 正是台账要求消除的那种态。
      //
      // 改成同步 durable 之后有两条明确结果,没有第三种:
      //   · 写成功 → 句柄发布,initDb resolve,磁盘与内存一致(迁移真的落了盘);
      //   · 写失败 → persistNowOrThrow 抛出,落进下面同一个 catch:关掉局部句柄、把
      //     db/dbPath/dbReadyPromise 清回 null,initDb **reject**。故障解除后重试
      //     initDb 能干净重来 —— "磁盘失败 + 重试"绝不会产出 ready 的内存库而磁盘没写。
      // 这是**唯一一份** durable 写盘实现(writeSnapshot + persistNowOrThrow),initDb
      // 与退出前落盘、workflow durable 闸门走的是同一条,不存在第二套。
      if (migrateNeedsPersist) persistNowOrThrow();
    } catch (err) {
      // 任何一步失败(initSqlJs / 搬老库 / 定路径 / 开库 / PRAGMA / 迁移)→ 全部回滚到
      // "没初始化过"的状态,让下一次 initDb 能重试。局部句柄关掉,不让它泄漏。
      try { localDb?.close(); } catch { /* 真正的错是上面那个,别盖过它 */ }
      db = null;
      dbPath = null;
      dbReadyPromise = null;
      migrateNeedsPersist = false;
      throw err instanceof Error ? err : new Error(String(err));
    }
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

    /* ── 场景部署(MC-058 · ARC-002)──────────────────────────────────────────
       一次场景部署的**持久事实** —— SceneSpec(声明)→ ScenePlan(计划)→ SceneDeployment
       (真的建成了什么、哪一步失败、验收过没过)。它是**可持久、可回读、可审计**的记录:
       渲染端 / 部署报告 / 重试都读它。从前 SceneDeployment 只是纯契约里的一个内存形状,
       进程一关就没了,「这次部署到底成了什么」无从追溯。

       payload 是 JSON 的整条 SceneDeployment。**这一层不认识它的形状**(同
       workflows.payload 对 WorkflowDoc、workflow_runs.payload 对 RunSnapshot)——
       编码 / 解码 + 形状校验收在 appServices/sceneDeploymentStore.ts 一处。

       另外几列是**可查询投影**(从 payload 抄出来,便于「按场景列 / 按状态筛」而不必每次
       解 JSON),不是第二份真相;整体 status 按定义由各步推导,解码时会重算。

       (⚠️ SQL 注释里不要写反引号 —— 这整段在一个 JS 模板字符串里。) */
    CREATE TABLE IF NOT EXISTS scene_deployments (
      deployment_id TEXT PRIMARY KEY,
      scene_id      TEXT NOT NULL,
      -- deploying | active | partial | failed(推导所得,可查询投影)
      status        TEXT NOT NULL,
      spec_digest   TEXT NOT NULL,
      plan_digest   TEXT NOT NULL,
      -- JSON:整条 SceneDeployment(deploymentId/sceneId/digests/actor/status/steps/acceptance)
      payload       TEXT NOT NULL,
      -- 这次部署什么时候开始的(save 第一次写时定下,后续覆盖不改写)
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scene_deployments_scene
      ON scene_deployments(scene_id, updated_at DESC);

    /* 【T99】任务是一级对象（路线图 §3 第一条）。
       新表，不涉及 sessionSchema 那套 inCreate 迁移机制 —— 见 taskSchema.ts 的说明。
       （⚠️ 本段在 JS 模板字符串里，注释中不要用反引号。） */
    ${TASKS_CREATE_SQL}

    /* 【T109】审批历史 —— ApprovalBridge 的 pendingApprovals 是内存 Map，
       处理完就消失、进程退出即丢，用户看不到「上次那个操作我批了没」。
       新表，不需要 sessionSchema 那套 inCreate 迁移。见 approvalSchema.ts。
       （⚠️ 本段在 JS 模板字符串里，注释中不要用反引号。） */
    ${APPROVALS_CREATE_SQL}

    /* ── 操作账本(MC-067 / ARC-009 步②)────────────────────────────────────
       本地 agent 经 app_api_call 调 Mcode 功能时的**可信幂等账本**。

       为什么是表而不是进程内 Map:旧 Map 只按 operationId 字符串缓存已完成结果 ——
       换会话/方法/参数复用同一 id 会命中旧结果;两个并发请求都能穿过缓存各执行一次;
       RPC 抛错后同 id 再试仍会真调一次。根因是把"幂等"简化成"结束后按字符串缓存"。

       operation_id 是**主键(唯一约束)** —— begin() 靠
       INSERT ... ON CONFLICT(operation_id) DO NOTHING + 改动行数做**原子领取**:两个
       并发调用不可能同时领到同一个 id,重启后同一 id 也不重复执行(真正的跨进程去重)。

       意图身份(owner/session/method/request_digest)由**宿主**产生,模型只能自选
       operationId —— 同 id 换会话/方法/参数 = 变了意图,读出这一行判 OPERATION_ID_CONFLICT。
       见 main/store/operationLedger.ts 与 @contracts/appControl 的 OperationIntent。 */
    CREATE TABLE IF NOT EXISTS operations (
      operation_id   TEXT PRIMARY KEY,
      owner_id       TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      scene_id       TEXT NOT NULL,
      method         TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      effect_kind    TEXT NOT NULL,
      grant_revision TEXT NOT NULL,
      status         TEXT NOT NULL,
      result_json    TEXT,
      body           TEXT,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operations_owner ON operations(owner_id, updated_at DESC);

    /* ── 分叉孤儿登记(MC-027)────────────────────────────────────────────
       复制一段对话时,引擎侧那一步(provider.forkSession)先产生**外部**会话文件,
       本地再建会话行 + 抄消息。若引擎那步成了、本地那步失败,本地事务**整体回滚**
       —— 可引擎侧那份复制再没任何东西指向它。有删除入口的引擎当场补删(见
       provider.deleteSession);删不掉 / 引擎没这条入口的,就在这里**登一行孤儿**,
       供人工清理,绝不悄悄遗忘。

       为什么是表而不是只打日志:这是一份**待办**(需要有人去引擎那边清),日志会被
       轮转掉,而这一行要一直留到清理者把它删掉或标记已处理。 */

    CREATE TABLE IF NOT EXISTS fork_orphans (
      id                  TEXT PRIMARY KEY,
      -- 源会话(Mcode 侧)。清理者据此知道"这是哪一段的残留"。
      source_session_id   TEXT NOT NULL,
      -- 引擎侧那份**没有本地行指向**的会话 id。
      provider_session_id TEXT NOT NULL,
      provider_id         TEXT NOT NULL,
      -- 那份会话文件所在的目录(删的时候还要它)。
      cwd                 TEXT NOT NULL,
      -- 为啥走到登记这条路的(补偿删除抛错时的原文,或"引擎不提供删除")。
      reason              TEXT NOT NULL,
      -- 'ORPHANED' = 待人工清理;'RESOLVED' = 已处理(留着做审计)。
      status              TEXT NOT NULL DEFAULT 'ORPHANED',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fork_orphans_status ON fork_orphans(status, created_at DESC);

    /* ── 文献库 ──────────────────────────────────────────────────────────
       与会话数据完全解耦:库是全局的(所有项目共用),不挂在 project 下。
       pdf_path / md_path 一律存**相对库根目录**的路径 —— 库位置可被用户改,
       存绝对路径会在搬迁后全部失效。 */

    CREATE TABLE IF NOT EXISTS library_items (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      -- 简介 / 摘要:用户或 AI 写的一句话说明,可空。
      abstract    TEXT,
      language    TEXT,
      url         TEXT,
      pdf_path    TEXT,
      pdf_sha256  TEXT,
      md_path     TEXT,
      -- 通用文件条目(统一资料库):entry_mode = attached(复制入库,相对库根)/
      -- linked(引用原路径,文件不动,可为目录);file_path 是通用文件路径。
      -- 旧的文献流(pdf_path/md_path)不受影响;老库 ALTER 出来的行缺省按 attached 读。
      entry_mode  TEXT NOT NULL DEFAULT 'attached',
      file_path   TEXT,
      added_at    INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    -- 学术字段退役(2026-09-27):老库里还有 kind / doi / arxiv_id / authors / year /
    -- venue / volume / issue / page / publisher / type / source / license 这些列
    -- (以及 doi / arxiv_id 上的两个唯一索引),新库不再建;代码全面停止读写。
    -- 见 migrate() 里「学术字段退役」那段。
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

    /* ── 插件 hook 执行审计(MC-061)────────────────────────────────────────
       MC-061 的执行通道是「插件携带的、不受信的命令」。HookRunner 从前只把每次执行记进
       内存里 50 条的环 + 按 hook 计数 —— 进程一关就没了,「这个插件昨天跑过没有、哪份
       授权放行的、被撤权挡下几次」无从追溯。这一张表把**每条插件 hook 的执行**落成一行
       持久审计(用户手写的钩子不落:那是用户自己的命令,判据见 HookRunner 里那条)。

       列里记的是**执行事实**:插件/版本/命令摘要/原生事件/matcher 摘要(来源身份,见
       @contracts/hostHookGrant 的 HostHookSource)+ 结局(status)+ 原因(error,含授权
       拒绝的理由)。stdout/stderr 不进这一层(它可能有输出上限那么大,审计要的是「跑没跑、
       为什么」)。

       与其它表不同,这里**没有 payload 列** —— 审计行就是一排可查询的列,没有要原样保留的
       嵌套形状。run_id 主键让「先落 running、落定再覆盖终态」是一次 upsert,而不是两次
       INSERT(同 workflow_runs 的 upsert 形状)。 */
    CREATE TABLE IF NOT EXISTS hook_runs (
      run_id         TEXT PRIMARY KEY,
      hook_id        TEXT NOT NULL,
      -- 【MC-010】plugin | user(老库迁移来的行为空串,读取侧按 plugin 解释)
      source         TEXT NOT NULL DEFAULT '',
      plugin_id      TEXT NOT NULL,
      plugin_version TEXT,
      native_event   TEXT NOT NULL,
      command_digest TEXT NOT NULL,
      matcher_digest TEXT,
      event          TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      session_kind   TEXT NOT NULL,
      -- running | ok | failed | timeout | skipped
      status         TEXT NOT NULL,
      exit_code      INTEGER,
      duration_ms    INTEGER,
      error          TEXT,
      started_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hook_runs_hook
      ON hook_runs(hook_id, started_at DESC);

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

  // 分类表上退役的 `kind` 列(见下面「kind 退役」):下面的回填还要 SELECT 它,
  // 极老的库没有这一列会直接炸,所以仍旧补齐。
  addColumnIfMissing(database, "library_collections", "kind", "TEXT NOT NULL DEFAULT 'paper'");
  // 分类的「给 AI 的说明」:拼进该分类的清单(统一资料库,类型说明之外的第二层)。
  addColumnIfMissing(database, "library_collections", "prompt", "TEXT");

  // ── 学术字段退役(2026-09-27)──
  // 学术那一套(DOI / arXiv / 作者 / 年份 / 期刊 / 卷期页 / 出版商 / 文献类型 /
  // 元数据来源 / 许可、外部检索、PDF 自动下载、引用导出、期刊分区)整体搬出核心,
  // 交给外部 MCP 服务 + 自动化。老库 `library_items` 上的那些列**保留但不再读写**
  // (与 kind 同一做法),唯一索引留着也无害(代码不再写 doi/arxiv_id,永远是 NULL)。
  // `download_jobs` 表是纯派生数据(任务队列),直接删。
  if (tableExists(database, "download_jobs")) {
    database.run("DROP TABLE download_jobs");
    schemaChanged = true;
  }

  // ── 机构登录退役(2026-10-11)──
  // `institution.*`(机构认证入口档案:list/save/delete/authStatus/clearCookies)是知网/
  // 图书馆登录场景,纯学术专属,按「学术功能全部通过扩展、工作流实现,core 不留学术」
  // 的原则整体移出核心。**退役 = 代码不再读写,不是把用户的历史记录删掉。**
  //
  // `institution_profiles` 表只存「常用入口 + 域名」的组织性元数据(⚠️ **不含凭据** ——
  // 真正的登录态在内嵌浏览器分区 `persist:mcode-browser` 的 cookie 里,由 BrowserManager
  // 保管,与本表无关),它是用户**自己整理的机构入口书签**(机构名称、入口网址、域名),
  // 属于用户资产。从前这里直接 `DROP TABLE` —— 升级一次就把这些记录抹掉,而用户没有
  // 任何办法找回。与 `library_items` 的学术列(kind / doi / authors …)同一条规矩:
  // **保留老表但不再读写**,退役模块不在核心继续生效即可,数据留着不碍事。
  // (对比 `download_jobs`:那是**纯派生**的任务队列,可弃才 DROP;本表是用户数据,不弃。)
  //
  // 于是这里**不做任何事** —— 留着原表(旧库升级后仍在),将来若用户想导出这些历史入口
  // 仍然能读到。刻意不设 `schemaChanged`(没有结构变更需要落盘)。

  // ── kind 退役（2026-09-24）──
  // 两列 `kind` **保留在库里但代码全面停止读写**（sql.js 没有 DROP COLUMN 的
  // 可移植写法；trash.ts 早有同款先例）。分类的归属改由 `group_id` 直接挂大类 ——
  // 从前分类挂在 kind 下、kind 再被大类表收编，现在是两步并一步。
  addColumnIfMissing(database, "library_collections", "group_id", "TEXT");
  // 回填：老分类按旧组表里的 kinds 反查归属；前版新建缺 groupId 的分类、以及
  // 前版迁移写出的空串归属都无法反查，归当前第一个大类（原右键目标已无法还原）。
  // 幂等：只填 NULL 或旧迁移写出的空串；用户此后挪分类不会被打回。
  // ⚠️ 这里直接读 settings 表（不经 SettingRepo，避免模块加载顺序问题），
  // JSON 解析失败就全部归第一个大类，不抛 —— 迁移不能把启动卡死。
  let recoveredCollections = 0;
  {
    // sql.js 的 getAsObject() 只读取**当前行**；未 step() 时得到 {}，旧代码因此
    // 每次都读到 undefined，从来没执行过这段回填（即使库里已有隐藏分类）。
    const countStmt = database.prepare("SELECT COUNT(*) AS n FROM library_collections WHERE group_id IS NULL OR group_id = ''");
    const needsBackfill = withStatement(countStmt, (query) => {
      query.step();
      return Number((query.getAsObject() as { n?: number }).n ?? 0);
    });
    if (needsBackfill > 0) {
      // 用共享常量而不是字面量:键一旦改名,这里的回填会静默读空、把所有旧分类归到首组。
      const settingsStmt = database.prepare("SELECT value FROM settings WHERE key = ?");
      const row = withStatement(settingsStmt, (query) => {
        query.bind([LIBRARY_GROUPS_SETTING_KEY]);
        return query.step()
          ? (query.getAsObject() as { value: string })
          : null;
      });
      // 未保存过组表时 UI 展示的是出厂大类，不能把 fallback 写成空串。
      // 已保存的 [] 则表示用户删光了大类，暂不回填，等重新建组后再归属。
      let groups: Array<{ id: string; kinds?: string[] }> = DEFAULT_LIBRARY_GROUPS.map((g) => ({ id: g.id }));
      if (row !== null) {
        try {
          const saved: unknown = JSON.parse(row.value);
          // 与 loadLibraryGroups 用同一份校验。仅保存成功的旧 JSON 还保留 kinds，
          // 校验通过后用原值保留这份映射供老分类回填。
          if (parseLibraryGroupsJson(saved).ok) {
            groups = saved as Array<{ id: string; kinds?: string[] }>;
          }
        } catch {
          /* 坏 JSON：按出厂组表恢复（与 loadLibraryGroups 一致）。 */
        }
      }
      const groupOfKind = new Map<string, string>();
      for (const g of groups) {
        for (const k of Array.isArray(g.kinds) ? g.kinds : []) groupOfKind.set(k, g.id);
      }
      const fallback = groups[0]?.id;
      if (fallback) {
        const stmt = database.prepare("SELECT id, kind FROM library_collections WHERE group_id IS NULL OR group_id = ''");
        const updates = withStatement(stmt, (query) => {
          query.bind([]);
          const changes: Array<{ id: string; gid: string }> = [];
          while (query.step()) {
            const r = query.getAsObject() as unknown as { id: string; kind: string | null };
            changes.push({ id: r.id, gid: groupOfKind.get(r.kind ?? "") ?? fallback });
          }
          return changes;
        });
        for (const u of updates) {
          database.run("UPDATE library_collections SET group_id = ? WHERE id = ?", [u.gid, u.id]);
        }
        recoveredCollections = updates.length;
      }
    }
  }


  // 统一资料库的通用文件条目(见 contracts/src/library.ts 的 LibraryItem.entryMode):
  // attached = 复制入库(相对库根),linked = 引用原路径(文件不动,可为目录)。
  // 老库没有这两列;ALTER 出来的既有行按 DEFAULT 'attached' 读,语义不变。
  addColumnIfMissing(database, "library_items", "entry_mode", "TEXT NOT NULL DEFAULT 'attached'");
  addColumnIfMissing(database, "library_items", "file_path", "TEXT");

  // 【MC-010】hook_runs 的执行来源列(plugin | user)。老库里的行都是插件语义
  // (当时只落插件),ALTER 补出的空串在读取侧按 plugin 解释 —— 语义不变。
  addColumnIfMissing(database, "hook_runs", "source", "TEXT NOT NULL DEFAULT ''");

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

  // 结构变更**立刻落盘**。
  //
  // 不落的话,ALTER 只活在内存里:磁盘上那份仍是老结构,直到用户碰巧触发了第一次
  // 写操作才被整体覆盖回去。功能上通常能自愈(每次启动都会重新跑迁移,幂等),但
  // 它有两个真问题:① 从外部看数据库的判断是错的(排查时会被"列怎么没了"误导);
  // ② 假如那次 ALTER 之后进程被强杀,而磁盘上的老结构又被新版代码用新列去查,
  // 就会报 no such column。改一行换掉这种不确定性是值得的。
  //
  // 回填也是数据修改：否则空串分类只在内存里恢复，退出后又变回隐藏状态。
  // 没改的情况下不落盘，避免每次启动白白重写整个库文件。
  //
  // ⚠️ 只**置位**,不在这里调 persist() —— migrate() 现在跑在句柄发布**之前**
  // (initDb 用局部句柄调它),此时 `db`/`dbPath` 还是 null,persist() 会静默跳过。
  // 由 initDb() 在 `db = localDb` 之后据此落盘(见那里的注释)。
  migrateNeedsPersist = schemaChanged || recoveredCollections > 0;
  if (migrateNeedsPersist) {
    log.info(schemaChanged ? "sqlite: schema changed — persisting migrated database"
      : `sqlite: recovered ${recoveredCollections} ungrouped library collections`);
  }
}

function tableExists(database: Database, table: string): boolean {
  const stmt = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  return withStatement(stmt, (query) => {
    query.bind([table]);
    return query.step();
  });
}

/** Add a column only if it isn't already present. SQLite has no ADD COLUMN IF
 * NOT EXISTS, so we check pragma_table_info first. The column and table names
 * are double-quoted so SQLite keywords (e.g. `group`) work as identifiers —
 * without the quotes, `ADD COLUMN group TEXT` is a syntax error.
 *
 * 返回是否**真的改了** —— 调用方据此决定要不要落盘(见 `migrate` 末尾)。 */
function addColumnIfMissing(database: Database, table: string, column: string, def: string): boolean {
  const stmt = database.prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`);
  const exists = withStatement(stmt, (query) => {
    query.bind([table, column]);
    return query.step();
  });
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
  try { return db!.export(); }
  finally { db!.run("PRAGMA foreign_keys = ON"); }
}

/** Observe the first failure of each outage. No UI/Electron dependency here;
 * main installs the user-visible handler. A successful save resets the latch. */
export function onDbPersistenceError(listener: (error: Error) => void): () => void {
  persistenceErrorListeners.add(listener);
  return () => { persistenceErrorListeners.delete(listener); };
}

/** The ONLY database-file writer. Never truncate the last good snapshot.
 * Same-directory rename keeps replacement on one filesystem. File fsync covers
 * buffered file writes; this is not a claim of power-loss-proof directory sync
 * on every platform/filesystem. Exclusive create also prevents following an
 * existing staging path. Only a staging file owned by this call is cleaned up. */
function writeSnapshot(): number {
  const target = dbPath!;
  const data = exportBytes();
  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.persist-${process.pid}-${randomUUID()}.tmp`;
  let fd: number | undefined;
  let ownsStaging = false;
  try {
    fd = openSync(staging, "wx", 0o600);
    ownsStaging = true;
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(staging, target);
    ownsStaging = false;
    return data.length;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original write error */ }
    }
    if (ownsStaging) {
      try { rmSync(staging, { force: true }); } catch { /* do not mask the save failure */ }
    }
  }
}

function cancelScheduledPersist(): void {
  persistEpoch++;
  persistPending = false;
  if (persistFallback) clearTimeout(persistFallback);
  if (persistRetry) clearTimeout(persistRetry);
  persistFallback = null;
  persistRetry = null;
}

function schedulePersistRetry(): void {
  if (persistRetry || !db || !dbPath) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
  persistRetry = setTimeout(() => {
    persistRetry = null;
    if (!persistDirty || !db || !dbPath) return;
    try { persistNowOrThrow(); } catch { /* already reported; next retry is scheduled */ }
  }, delay);
  persistRetry.unref();
}

function recordPersistenceFailure(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const firstFailure = persistenceFailure === null;
  persistDirty = true;
  persistenceFailure = error;
  schedulePersistRetry();
  log.error(`sqlite save failed; keeping unsaved data and retrying: ${error.message}`);
  if (firstFailure) {
    for (const listener of persistenceErrorListeners) {
      try { listener(error); }
      catch (observerError) { log.error(`sqlite persistence observer failed: ${String(observerError)}`); }
    }
  }
}

/** Synchronous save for migration/quit. Failure must reach the caller: copying
 * an older file or reporting a successful exit would otherwise lose changes. */
export function flushDb(): void {
  if (db && dbPath) persistNowOrThrow();
}

/** Durable workflow barrier: write the in-flight marker before invoking a
 * command/model/plugin. Also the single commit path for ordinary/quit saves. */
export function persistNowOrThrow(): void {
  const result = commitNow();
  if (result.outcome !== "DURABLE") {
    throw new Error(result.reason ?? "sqlite commit failed");
  }
}

/**
 * 【ARC-005 步②】把这一次落盘的结果**结构化**地交出来,而不是只有"成功 / 抛错"。
 *
 * {@link persistNowOrThrow} 是它上面的一层薄包装 —— **落盘实现只有这一份**,谁都不许
 * 再抄一遍 `writeSnapshot` + 失败记录。调用方该问"内存改了、磁盘 durable 没有"时用本函数,
 * 该用"失败即抛"的旧语义时用 `persistNowOrThrow`。
 *
 * 三种结果(**判据见 `@contracts/commit`**):
 *  - `DURABLE` —— fsync + rename 都成了,磁盘上就是这一份;
 *  - `APPLIED_NOT_DURABLE` —— 写盘失败(内存里的改动还在,进程仍握着它;`persistDirty`
 *    保持为真并排退避重试)。**调用方绝不能把它当成功** —— 重启就没了;
 *  - `FAILED` —— 数据库尚未初始化,一个字节都没动。
 *
 * ⚠️ 「内存已应用」是**调用方**已经改过的事(如 `WorkflowRunRepo.save` 先写了内存表),
 * 本函数只负责把它 fsync 到磁盘。所以 `APPLIED_NOT_DURABLE` 说的是"你那份内存改动没能落盘",
 * 不是"本函数自己改了内存"。
 */
export function commitNow(): CommitResult {
  if (!db || !dbPath) {
    return { outcome: "FAILED", reason: "sqlite database is not initialized" };
  }
  cancelScheduledPersist();
  persistDirty = true;
  try {
    const size = writeSnapshot();
    const recovered = persistenceFailure !== null;
    persistDirty = false;
    persistenceFailure = null;
    retryDelayMs = 1000;
    // ARC-009:这次成功落盘的**进程内版本号**。只在 fsync + rename 都成了之后才递增 ——
    // 失败路径不动它(没落盘就没有新版本)。
    durableRevision += 1;
    if (recovered) log.info(`sqlite persistence recovered (${size}B)`);
    else if (!loggedFirstFlush) {
      loggedFirstFlush = true;
      log.info(`sqlite persisted ${size}B via atomic replacement`);
    }
    return { outcome: "DURABLE", bytes: size, durableRevision };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    recordPersistenceFailure(err);
    return { outcome: "APPLIED_NOT_DURABLE", reason: err.message };
  }
}

/** Coalesce synchronous mutations, retaining the existing 250ms backstop.
 * A transient error leaves dirty=true and gets bounded exponential retries;
 * new edits during an outage do not defeat backoff. Explicit saves still run
 * immediately. Epochs stop an old queued callback from flushing a newer batch. */
export function persist(): void {
  if (!db || !dbPath) {
    log.warn(`persist skipped: no database handle (db=${!!db}, dbPath=${dbPath})`);
    return;
  }
  persistDirty = true;
  if (persistPending || persistRetry) return;
  persistPending = true;
  const epoch = ++persistEpoch;
  const flush = (): void => {
    if (!persistPending || epoch !== persistEpoch) return;
    try { persistNowOrThrow(); } catch { /* observers and retry own the failure */ }
  };
  try { queueMicrotask(flush); }
  catch { flush(); return; }
  persistFallback = setTimeout(flush, 250);
  persistFallback.unref();
}

/** Save before closing. A failed save throws WITHOUT discarding the live
 * connection, so the caller can cancel quit/migration and the retry can recover. */
export function closeDb(): void {
  if (!db) return;
  persistNowOrThrow();
  db.close();
  db = null;
  dbPath = null;
  dbReadyPromise = null;
}
