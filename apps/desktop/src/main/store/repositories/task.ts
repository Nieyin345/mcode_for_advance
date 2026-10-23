/**
 * 【T99】`tasks` 表的读写 —— 任务是一级对象。
 *
 * ## 这一层只管存储
 *
 * 与 `scene_deployments` 同一条边界：表里留着可查询的投影列（`status` / `created_at`）
 * 和几个 JSON 列，形状的语义在契约里（`@contracts/ipc/task.ts`）。**这里不认识
 * 「什么状态迁移合法」的业务含义** —— 那是 `main/ipc/task.ts` 的事。
 *
 * 只有一个例外：`accept()` / `reject()` 的**写入形状**在这里，因为它们要保证
 * 「验收证据必填」这件事在存储层也成立（不能靠调用方自觉）。
 */
import { getDb, persist } from "../db.js";
import { v } from "../sessionSchema.js";
import { rowToTask, type TaskDbRow } from "../taskSchema.js";
import type { Task, TaskStatus } from "@contracts/ipc";

const SELECT_COLUMNS =
  "id, goal, status, depends_on, origin, links, artifacts, acceptance, failure_reason, rejection_reason, created_at, updated_at";

/** 读一个任务的最新快照（`null` = 不存在）。 */
function readOne(id: string): Task | null {
  const stmt = getDb().prepare(`SELECT ${SELECT_COLUMNS} FROM tasks WHERE id = ?`);
  try {
    stmt.bind([v(id)]);
    if (!stmt.step()) return null;
    return rowToTask(stmt.getAsObject() as unknown as TaskDbRow);
  } finally {
    stmt.free();
  }
}

export const TaskRepo = {
  /**
   * 建一个新任务。
   *
   * **不接受 `status`**：新建的任务一律 `pending`。让调用方传状态等于允许「建的时候
   * 就说它已经 accepted」—— 那会绕过验收这条边界。
   */
  create(args: { id: string; task: Pick<Task, "goal" | "origin" | "dependsOn"> }): Task {
    const now = Date.now();
    const task: Task = {
      id: args.id,
      goal: args.task.goal,
      status: "pending",
      dependsOn: args.task.dependsOn,
      origin: args.task.origin,
      links: { sessionIds: [], workflowIds: [] },
      artifacts: [],
      acceptance: null,
      failureReason: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };
    getDb().run(
      `INSERT INTO tasks (id, goal, status, depends_on, origin, links, artifacts, acceptance,
                          failure_reason, rejection_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v(task.id),
        v(task.goal),
        v(task.status),
        v(JSON.stringify(task.dependsOn)),
        v(JSON.stringify(task.origin)),
        v(JSON.stringify(task.links)),
        v(JSON.stringify(task.artifacts)),
        v(null),
        v(null),
        v(null),
        v(now),
        v(now),
      ],
    );
    persist();
    return task;
  },

  get(id: string): Task | null {
    return readOne(id);
  },

  /**
   * 按状态 / 会话筛。
   *
   * `sessionId` 的筛选要同时看**发起者**和**关联列表** —— 一个任务可能由会话 A 发起、
   * 被会话 B 推进，两个会话都该在各自的列表里看到它。只查 `origin.ref` 会漏掉后者。
   */
  list(filter: { status?: TaskStatus; sessionId?: string } = {}): Task[] {
    const where: string[] = [];
    const binds: ReturnType<typeof v>[] = [];
    if (filter.status !== undefined) {
      where.push("status = ?");
      binds.push(v(filter.status));
    }
    const sql = `SELECT ${SELECT_COLUMNS} FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    const stmt = getDb().prepare(sql);
    const rows: Task[] = [];
    try {
      if (binds.length) stmt.bind(binds);
      while (stmt.step()) rows.push(rowToTask(stmt.getAsObject() as unknown as TaskDbRow));
    } finally {
      stmt.free();
    }
    if (filter.sessionId === undefined) return rows;
    // 会话筛选在内存里做:origin / links 都是 JSON 列,SQL 里拆它们要 json1 扩展,
    // 而 sql.js 这个构建不一定带。任务量级是个位数到几百,内存筛足够。
    return rows.filter(
      (t) => t.origin.ref === filter.sessionId || t.links.sessionIds.includes(filter.sessionId!),
    );
  },

  /** 执行方写状态（`TASK_EXECUTOR_STATUSES` 那五个）。合法性由 IPC 层先判。 */
  setStatus(args: {
    id: string;
    status: TaskStatus;
    artifacts?: Task["artifacts"];
    failureReason?: string | null;
  }): Task {
    const current = readOne(args.id);
    if (!current) throw new Error(`task ${args.id} 不存在`);
    const now = Date.now();
    getDb().run(
      `UPDATE tasks SET status = ?, artifacts = ?, failure_reason = ?, updated_at = ? WHERE id = ?`,
      [
        v(args.status),
        v(JSON.stringify(args.artifacts ?? current.artifacts)),
        v(args.failureReason === undefined ? current.failureReason : args.failureReason),
        v(now),
        v(args.id),
      ],
    );
    persist();
    const next = readOne(args.id);
    if (!next) throw new Error(`task ${args.id} 写入后读不回来`);
    return next;
  },

  /**
   * 用户验收通过。
   *
   * **只在 `done` 上合法** —— 「执行还没完成就验收通过」是没有意义的，而且会让
   * `done`/`accepted` 分开这件事形同虚设（如果 `running` 就能 accepted，那
   * 「执行完成」这个事实就没被记录过）。
   *
   * `round` 是本轮验收的序号：`rejected → running` 时递增，所以退回三次的任务
   * 这里会是 4。
   */
  accept(args: { id: string; evidence: string }): Task {
    const current = readOne(args.id);
    if (!current) throw new Error(`task ${args.id} 不存在`);
    if (current.status !== "done") {
      throw new Error(`task ${args.id} 当前是 ${current.status}，只有 done 才能验收（执行完成才谈验收）`);
    }
    const round = (current.acceptance?.round ?? 0) + 1;
    const now = Date.now();
    getDb().run(
      `UPDATE tasks SET status = 'accepted', acceptance = ?, rejection_reason = NULL, updated_at = ? WHERE id = ?`,
      [v(JSON.stringify({ round, decidedAt: now, evidence: args.evidence })), v(now), v(args.id)],
    );
    persist();
    const next = readOne(args.id);
    if (!next) throw new Error(`task ${args.id} 写入后读不回来`);
    return next;
  },

  /**
   * 用户退回。
   *
   * 合法源状态是 `done`（做完了但不对）和 `failed`（做砸了）—— 这两种都该能退回。
   * 退回后是 `rejected`，用户/执行方再把它推回 `running` 返修。
   */
  reject(args: { id: string; reason: string }): Task {
    const current = readOne(args.id);
    if (!current) throw new Error(`task ${args.id} 不存在`);
    if (current.status !== "done" && current.status !== "failed") {
      throw new Error(`task ${args.id} 当前是 ${current.status}，只有 done / failed 能退回`);
    }
    const now = Date.now();
    // 【T99】退回**也是一次验收结论**，所以轮次在这里推进，而不是等 reopen。
    //
    // 语义：「这是第几次用户给出结论」——
    //   首次验收通过        → round 1
    //   退回（第 1 次结论） → round 1，状态 rejected
    //   返修后再通过        → round 2
    //
    // 让 reopen 也 +1 的话，「退回 → 重开 → 通过」会走 1→2→3，而用户只给过两次结论。
    const round = (current.acceptance?.round ?? 0) + 1;
    getDb().run(
      `UPDATE tasks SET status = 'rejected', rejection_reason = ?, acceptance = ?, updated_at = ? WHERE id = ?`,
      [
        v(args.reason),
        v(JSON.stringify({ round, decidedAt: now, evidence: args.reason })),
        v(now),
        v(args.id),
      ],
    );
    persist();
    const next = readOne(args.id);
    if (!next) throw new Error(`task ${args.id} 写入后读不回来`);
    return next;
  },

  /**
   * `rejected → running`：**返修**。
   *
   * 路线图 §5「用户能完成、返修并重新验收」的最后一步。同时把 `acceptance.round`
   * 加一 —— 「这是第几轮」由这个动作记账，而不是让调用方算。
   */
  reopen(id: string): Task {
    const current = readOne(id);
    if (!current) throw new Error(`task ${id} 不存在`);
    if (current.status !== "rejected") {
      throw new Error(`task ${id} 当前是 ${current.status}，只有 rejected 能返修（重新打开）`);
    }
    const now = Date.now();
    // 【T99】**轮次只在用户给出结论时推进**（accept / reject），`reopen` 不动它。
    //
    // 语义是「这是第几次验收结论」：
    //   首次验收通过      → round 1
    //   退回后第二次通过  → round 2
    //   退回但还没再验    → round 仍是上一轮（1）——「这一轮还没结论」
    //
    // 如果 reopen 也 +1，那么「退回 → 重开 → 验收」会走 1→2→3，而用户只给过
    // **两次**结论。多出来的那一轮是假的。
    getDb().run(
      `UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`,
      [v(now), v(id)],
    );
    persist();
    const next = readOne(id);
    if (!next) throw new Error(`task ${id} 写入后读不回来`);
    return next;
  },

  /** 关联一个会话或工作流（多 Agent 推进同一个任务时用）。幂等。 */
  link(args: { id: string; sessionId?: string; workflowId?: string }): Task {
    const current = readOne(args.id);
    if (!current) throw new Error(`task ${args.id} 不存在`);
    const links = {
      sessionIds: args.sessionId && !current.links.sessionIds.includes(args.sessionId)
        ? [...current.links.sessionIds, args.sessionId]
        : current.links.sessionIds,
      workflowIds: args.workflowId && !current.links.workflowIds.includes(args.workflowId)
        ? [...current.links.workflowIds, args.workflowId]
        : current.links.workflowIds,
    };
    getDb().run(`UPDATE tasks SET links = ?, updated_at = ? WHERE id = ?`,
      [v(JSON.stringify(links)), v(Date.now()), v(args.id)]);
    persist();
    const next = readOne(args.id);
    if (!next) throw new Error(`task ${args.id} 写入后读不回来`);
    return next;
  },
};
