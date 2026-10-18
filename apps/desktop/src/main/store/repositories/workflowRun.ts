/**
 * 工作流运行存档 —— workflow_runs 表。
 *
 * 从 `repositories.ts`（3277 行、13 张表挤在一起）按实体拆出。
 * 本文件只管这一张表；**正文是整段搬过来的，没有改写**。
 */
import type { WorkflowDoc } from "@contracts/workflow";
import { getDb, persist } from "../db.js";
import { v } from "../sessionSchema.js";
import { withStatement } from "./withStatement.js";

/* ────────────────────────── 工作流的运行(续跑) ────────────────────────── */

/**
 * 一次运行的结局。
 *
 * 前两个是"活着的时候"写的,后三个是收尾写的,`interrupted` 则是**只有下次启动
 * 才写得出来**的一种 —— 上一次进程死的时候它还在跑(见 `db.ts` 的 `migrate`)。
 * 和 `cancelled` 分开是因为它们是两句不同的话:"你按了停止"和"上次断在这儿了"。
 */
export type WorkflowRunStatus = "running" | "interrupted" | "success" | "failed" | "cancelled";

export interface WorkflowRunRow {
  id: string;
  sessionId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  /** 正停在哪几格等用户拍板。一个都没在等就是空数组。 */
  awaiting: string[];
  /** JSON 的 `RunSnapshot`。**这一层不认识它** —— 形状归 `orchestration/runStore.ts`,
   *  这里只负责原样存取(同 `workflows.payload` 对 `WorkflowDoc` 的做法)。 */
  payload: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkflowRunDbRow {
  id: string;
  session_id: string;
  workflow_id: string;
  status: string;
  awaiting_node: string | null;
  payload: string;
  created_at: number;
  updated_at: number;
}

/**
 * `awaiting_node` 那一列是**逗号分隔的一串节点 id**(见 `resumableFor`)。
 *
 * 空串和 NULL 都收成空数组 —— 库里两种都可能出现(没在等的运行写的是空数组,它
 * `join` 出来就是空串;老一点的行可能是 NULL)。
 */
function splitAwaiting(raw: string | null): string[] {
  if (raw === null) return [];
  return raw.split(",").filter((s) => s.length > 0);
}

export const WorkflowRunRepo = {
  /**
   * 把这次运行**此刻的样子**写下来(第一次写就是建行)。开跑、每步定案、停在岔路口、
   * 收尾,四处都走它 —— 分成 insert/update 两个入口的话,"这一行到底建出来没有"就有
   * 两个答案,而漏建的那一条路只会在重启之后才暴露。
   *
   * `created_at` 只在第一次写时定下(upsert 的 DO UPDATE 不碰它),所以它是"这次
   * 运行什么时候开始的"。
   */
  save(args: {
    id: string;
    sessionId: string;
    workflowId: string;
    status: WorkflowRunStatus;
    payload: string;
    /** 正停在等用户的那些节点。见 `WorkflowRunRow.awaiting`。 */
    awaiting: readonly string[];
  }): void {
    const now = Date.now();
    getDb().run(
      `INSERT INTO workflow_runs
         (id, session_id, workflow_id, status, awaiting_node, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status        = excluded.status,
         awaiting_node = excluded.awaiting_node,
         payload       = excluded.payload,
         updated_at    = excluded.updated_at`,
      [
        v(args.id),
        v(args.sessionId),
        v(args.workflowId),
        v(args.status),
        v(args.awaiting.join(",")),
        v(args.payload),
        v(now),
        v(now),
      ],
    );
    persist();
  },

  /** 某个对话里的一条运行。没有返回 null。 */
  get(id: string): WorkflowRunRow | null {
    const stmt = getDb().prepare("SELECT * FROM workflow_runs WHERE id = ?");
    return withStatement(stmt, (query) => {
      query.bind([v(id)]);
      const found = query.step();
      const row = found ? (query.getAsObject() as unknown as WorkflowRunDbRow) : null;
      return row ? rowToWorkflowRun(row) : null;
    });
  },

  /** 自动化历史跨项目会话汇总，先过滤、排序，再应用全局 limit。
   *  普通聊天里运行同一张图不属于自动化历史。 */
  listForAutomationWorkflow(workflowId: string, limit: number): WorkflowRunRow[] {
    const stmt = getDb().prepare(
      `SELECT r.* FROM workflow_runs r
       JOIN sessions s ON s.id = r.session_id
       WHERE r.workflow_id = ? AND s.kind = 'automation' AND s.composer_mode = ?
       ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`,
    );
    return withStatement(stmt, (query) => {
      query.bind([v(workflowId), v(workflowId), v(limit)]);
      const out: WorkflowRunRow[] = [];
      while (query.step()) out.push(rowToWorkflowRun(query.getAsObject() as unknown as WorkflowRunDbRow));
      return out;
    });
  },

  /**
   * 某个会话的**运行历史**,新的在前(自动化页要显示"最近几次")。
   *
   * 与 {@link resumableFor} 的区别是它**不挑状态**:那个只找"被中断且正等着某一步"
   * 的(续跑用),这个把所有运行都列出来(看历史用)。`payload` 照样原样返回 ——
   * 折叠成"每步的结局与摘要"是编排层的事(见 `orchestration/runStore.ts` 的
   * `decodeSnapshot`),这一层不认识那个形状。
   */
  listForSession(sessionId: string, limit: number): WorkflowRunRow[] {
    const stmt = getDb().prepare(
      `SELECT * FROM workflow_runs
        WHERE session_id = ?
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
    );
    return withStatement(stmt, (query) => {
      query.bind([v(sessionId), v(limit)]);
      const out: WorkflowRunRow[] = [];
      while (query.step()) {
        out.push(rowToWorkflowRun(query.getAsObject() as unknown as WorkflowRunDbRow));
      }
      return out;
    });
  },

  /**
   * 某个对话里、**正停在 `nodeId` 这一格**且被中断的那次运行。
   *
   * ## 为什么按节点查,而不是"最近一次被中断的运行"
   *
   * 用户点的是**某一张卡片**,而那张卡片属于哪一次运行是确定的。只按会话取最近一条
   * 的话,一个对话里跑过两轮之后,点第一轮那张旧卡会去续第二轮 —— 而它们问的根本不是
   * 同一件事。
   *
   * ## `awaiting_node` 是一张**列表**(逗号分隔)
   *
   * 两处岔路口可以同时就绪,于是两条都在等人(见 `RunState.awaiting`)—— 存单个的话,
   * 用户点**先停下的那一处**会看到"这条选择已经不适用了"。
   *
   * 所以这里是"取出这个对话里所有被中断的,再在 JS 里找"而不是一条 SQL 的等值匹配。
   * 代价可以忽略:`pruneSession` 把每个对话的行数压到十行以内,而这段代码一次点击才
   * 跑一遍 —— 拿它换一条能读懂的查询是划算的。
   *
   * 取最新的一条:同一格可以断过好几次(续一次、又断一次)。
   */
  resumableFor(sessionId: string, nodeId: string): WorkflowRunRow | null {
    const stmt = getDb().prepare(
      `SELECT * FROM workflow_runs
        WHERE session_id = ? AND status = 'interrupted'
        ORDER BY updated_at DESC`,
    );
    return withStatement(stmt, (query) => {
      query.bind([v(sessionId)]);
      const rows: WorkflowRunRow[] = [];
      while (query.step()) {
        rows.push(rowToWorkflowRun(query.getAsObject() as unknown as WorkflowRunDbRow));
      }
      return rows.find((r) => r.awaiting.includes(nodeId)) ?? null;
    });
  },

  /** 一个对话只留最近 `keep` 次运行。**开跑时清一次** —— 运行行会一直堆下去,而
   *  除了"最后一次能续跑的"以外,别的都只是历史。
   *
   *  `id` 那个次序是**并列时的决胜**:`created_at` 是毫秒,两次运行撞在同一毫秒上
   *  虽然少见但不是不可能(测试里就撞),而并列时 SQLite 返回哪几条是没保证的 ——
   *  同一个库两次跑出不同的结果,排查时会被自己误导。 */
  pruneSession(sessionId: string, keep: number): void {
    getDb().run(
      `DELETE FROM workflow_runs
        WHERE session_id = ?
          AND id NOT IN (
            SELECT id FROM workflow_runs
             WHERE session_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?
          )`,
      [v(sessionId), v(sessionId), v(keep)],
    );
    persist();
  },

  /**
   * 【MC-053】删掉一条运行行。**只为"落盘失败后回滚这次新建的行"这一个用途**而存在 ——
   * `saveRun` 在 durable 落盘失败时要把内存回滚到先前状态:先前**没有**这一行(这次是
   * 首次写)就得把它删掉,否则内存里会留着一条磁盘上没有的行。
   *
   * 与 `pruneSession` 一样走普通 `persist()`(合并落盘)—— 回滚的是**内存**那一格,
   * 磁盘本就没写成,不需要再 fsync。
   */
  remove(id: string): void {
    getDb().run("DELETE FROM workflow_runs WHERE id = ?", [v(id)]);
    persist();
  },
};

function rowToWorkflowRun(r: WorkflowRunDbRow): WorkflowRunRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    workflowId: r.workflow_id,
    status: r.status as WorkflowRunStatus,
    awaiting: splitAwaiting(r.awaiting_node),
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
