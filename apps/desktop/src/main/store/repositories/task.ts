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

/**
 * 执行方的状态迁移表 —— 合法迁移是**白名单**，不是「除了这几个都行」。
 *
 * 为什么白名单：状态机写成黑名单（「不能从 X 到 Y」）时，新增一个状态默认就是
 * 处处可达。白名单让「新状态要先想清楚它能从哪来」变成一件必须做的事。
 *
 * 关键几条：
 *  - `done` 只能从 `running` 来 —— 没跑过就说「做完了」是假的；
 *  - `failed` 可以从 `running` / `blocked` 来 —— 等依赖时发现做不了也算失败；
 *  - `running` 可以从 `pending` / `blocked` / `rejected` 来 —— **`rejected → running`
 *    就是返修**。
 *
 * `accepted` / `rejected` 的来源是空数组：它们**只能**由用户的 `accept` / `reject`
 * 写（各自有独立的前置校验）。执行方经 `setStatus` 走这条路时一个来源都不合法 ——
 * 那是刻意的，纵深防御：即使上游漏了 `TASK_EXECUTOR_STATUSES` 那道白名单，
 * 这里也写不进去。
 */
const EXECUTOR_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: [],
  running: ["pending", "blocked", "rejected"],
  blocked: ["pending", "running"],
  done: ["running"],
  failed: ["running", "blocked"],
  accepted: [],
  rejected: [],
};

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

  /**
   * 执行方写状态。
   *
   * ## 迁移表为什么在**这里**，不在 IPC 层
   *
   * 本文件的 `accept` / `reject` / `reopen` **各自都在这一步校验前置状态**
   * （`只有 done 才能验收` / `只有 done / failed 能退回` / `只有 rejected 能返修`）。
   * `setStatus` 原先没有 —— 于是它是唯一一个**谁都能把任务写成任何状态**的入口。
   *
   * 那不只是「不好看」：`main/tasks/autoCreate.ts` 走的正是 `setStatus`（回合结束后
   * 自动记任务），它**绕过了整张迁移表** —— 「执行方不能把任务写成 `accepted`」这条
   * 边界在自动记账那条路上根本不成立。把校验留在 IPC handler 里修不好这件事，
   * 因为那条路根本不经过 IPC。
   *
   * 所以迁移表下沉到这一层：**凡是改任务状态的人都走同一张表**，无论是用户的验收、
   * 回合收尾的自动记账，还是将来某个执行路径。
   */
  setStatus(args: {
    id: string;
    status: TaskStatus;
    artifacts?: Task["artifacts"];
    failureReason?: string | null;
  }): Task {
    const current = readOne(args.id);
    if (!current) throw new Error(`task ${args.id} 不存在`);
    const allowed = EXECUTOR_TRANSITIONS[args.status];
    if (!allowed.includes(current.status)) {
      throw new Error(
        `任务状态不能从 ${current.status} 迁到 ${args.status}（合法来源：${allowed.join(" / ") || "无"}）`,
      );
    }
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
