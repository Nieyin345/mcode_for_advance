/**
 * 【T99】`tasks` 表的列定义。
 *
 * ## 为什么单独一个文件
 *
 * `sessionSchema.ts` 那套（`SESSION_COLUMNS` + `inCreate`）是为**给已有表加列**设计的
 * —— 它的 `inCreate: false` 表示「老库要走 ALTER 补这一列」。
 *
 * **`tasks` 是一张新表，不涉及那套机制**：`CREATE TABLE IF NOT EXISTS` 本身就是幂等的，
 * 老库跑一遍就建出来，新库也一样。所以这里不需要 `inCreate` 那种标记 —— 加列时才需要，
 * 而现在没有列要加。
 *
 * 这个判断要写下来：下次有人看到 `taskSchema.ts` 和 `sessionSchema.ts` 长得不一样，
 * 会以为是漏了；实际是**两者的迁移问题不同**。
 *
 * ## sql.js 的坑
 *
 * 建表本身不涉及导出。但要记住 CLAUDE.md 那条：`db.export()` 会重置连接上的 pragma
 * （含外键）—— 所有落盘只走 `persist()` / `exportBytes()`，不要新开导出点。
 */
import type { Task, TaskStatus } from "@contracts/ipc";

/** 表名。`db.ts` 的 `migrate()` 引用它。 */
export const TASKS_TABLE = "tasks";

/**
 * 建表 SQL —— 放在 `db.ts` 的 `migrate()` 里执行。
 *
 * 列的选择遵循仓库既有惯例（`scene_deployments` 那一套）：
 *
 *   - **可查询的投影列**单独成列（`status` / `created_at`）—— 便于「按状态筛」「按时间排」
 *     而不必每次解 JSON；
 *   - **形状复杂的**放 JSON（`depends_on` / `origin` / `links` / `artifacts` / `acceptance`）
 *     —— 这一层不认识它们的内部结构，编码/解码在 repository 里。
 *
 * `goal` 单独成列而不是塞进 JSON：它是**列表页要显示的那句话**，每次列表都解一遍
 * JSON 只为取一个字段不划算。
 */
export const TASKS_CREATE_SQL = `
    CREATE TABLE IF NOT EXISTS ${TASKS_TABLE} (
      id                TEXT PRIMARY KEY,
      goal              TEXT NOT NULL,
      status            TEXT NOT NULL,
      depends_on        TEXT NOT NULL DEFAULT '[]',
      origin            TEXT NOT NULL,
      links             TEXT NOT NULL DEFAULT '{"sessionIds":[],"workflowIds":[]}',
      artifacts         TEXT NOT NULL DEFAULT '[]',
      acceptance        TEXT,
      failure_reason    TEXT,
      rejection_reason  TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON ${TASKS_TABLE}(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON ${TASKS_TABLE}(created_at DESC);
`;

/** 数据库行 → 领域对象。JSON 列在这里解码；解不开就抛（不静默回落到空值）。 */
export interface TaskDbRow {
  id: string;
  goal: string;
  status: string;
  depends_on: string;
  origin: string;
  links: string;
  artifacts: string;
  acceptance: string | null;
  failure_reason: string | null;
  rejection_reason: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 判断一个字符串是不是合法的任务状态。
 *
 * **不是** `TaskStatusSchema.safeParse` 的重复：这一层（store）不想 import zod，
 * 而 `TaskStatus` 已经由契约定义了。用 `Set` 保证「表里存了一个我们不认识的状态」
 * 会被显式报出来，而不是当成某个默认值。
 */
const KNOWN_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  "pending", "running", "blocked", "done", "failed", "accepted", "rejected",
]);

/**
 * 行 → `Task`。
 *
 * ⚠️ **JSON 解不开时抛错，不回落**。回落成空数组会让「这个任务的产物丢了」变成
 * 「这个任务没有产物」—— 那是两种完全不同的事实，而后者看起来一切正常。
 */
export function rowToTask(r: TaskDbRow): Task {
  if (!KNOWN_STATUSES.has(r.status)) {
    throw new Error(`task ${r.id}: 数据库里的状态 ${JSON.stringify(r.status)} 不在任务状态集合里`);
  }
  let dependsOn: string[];
  let origin: Task["origin"];
  let links: Task["links"];
  let artifacts: Task["artifacts"];
  let acceptance: Task["acceptance"];
  try {
    dependsOn = JSON.parse(r.depends_on) as string[];
    origin = JSON.parse(r.origin) as Task["origin"];
    links = JSON.parse(r.links) as Task["links"];
    artifacts = JSON.parse(r.artifacts) as Task["artifacts"];
    acceptance = r.acceptance === null ? null : (JSON.parse(r.acceptance) as Task["acceptance"]);
  } catch (error) {
    throw new Error(`task ${r.id}: 存储的 JSON 列无法解析（${(error as Error).message}）`);
  }
  return {
    id: r.id,
    goal: r.goal,
    status: r.status as TaskStatus,
    dependsOn,
    origin,
    links,
    artifacts,
    acceptance,
    failureReason: r.failure_reason,
    rejectionReason: r.rejection_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
