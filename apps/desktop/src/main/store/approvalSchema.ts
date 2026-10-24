/**
 * 【T109】`approvals` 表的列定义 + 两个读写函数。
 *
 * ## 为什么和 `taskSchema.ts` 同形，但不是照抄
 *
 * 同形：两者都是**新表**（`CREATE TABLE IF NOT EXISTS` 幂等，不需要 `sessionSchema.ts`
 * 那套 `inCreate` 的 ALTER 迁移）。所以这里也不需要 `inCreate` 标记。
 *
 * 不同：`taskSchema.ts` 只放列定义与行转换，读写在同目录 `repositories/task.ts`。
 * **本文件把两者放在一起**，因为这张卡的写入边界只到 `approvalSchema.ts` ——
 * 新增 `repositories/approval.ts` 会超出「不改 store/repositories」的约束。
 *
 * ⚠️ **这个合并是边界造成的，不是设计偏好。** 如果将来 `approvals` 长出更多查询
 * （按 task 关联、按时间窗统计、分页游标），**应该拆出 `repositories/approval.ts`**，
 * 让本文件退回「只有列定义」。现在不拆是因为只有三条读写、且不许动 repositories。
 *
 * ## 这张表解决什么
 *
 * `ApprovalBridge` 的 `pendingApprovals` 是内存 Map：处理完就从列表消失、进程退出即丢。
 * 用户看不到「上次那个操作我批了没」「这轮一共批了几次」。
 *
 * ## 三个设计判断（详见 `.scratch/approval-history/spec.md`）
 *
 * ### ① 没有 `task_id` 列
 *
 * 理由不是「大多数审批没有任务」，而是**时序上更硬的那条**：
 * `classifyTurn` 在 `turn.done` **才**建任务，而审批发生在 `turn.done` **之前**
 * （工具调用要等用户点了才继续，那一轮才可能产出文件）。
 * **存一个当时还不存在的 id，只能存 `null`。**
 *
 * 「审批 → 任务」的反查靠 `tasks.origin.ref`（它存的是 sessionId）：
 * ```sql
 * SELECT * FROM tasks WHERE json_extract(origin, '$.kind') = 'session'
 *                    AND json_extract(origin, '$.ref') = :sessionId
 * ```
 * （sql.js 1.14.1 / SQLite 3.49.1 实测支持，见 `.scratch/approval-history/json-extract-probe.mjs`）
 *
 * ### ② 不存 `input` 原文
 *
 * `gateAppAction` 传进来的 input 会被 `redactValue` 打码 —— 说明它本来就当敏感物对待。
 * 表里只存**用户在审批卡上看到过的东西**（`subject`），用户没看到的不存。
 *
 * ### ③ 不存 `input_digest`
 *
 * 没有诚实的消费者：没有场景需要「这两次审批是不是同一个操作」，而
 * `tool_name + subject + 时间` 已经回答了用户真正会问的问题。
 * **一个没人读的校验字段会让后来的人以为这里有完整性保证**（CLAUDE.md 第十二条：
 * 假门禁比没有门禁更坏）。
 *
 * ### ④ 五种 decision，不是两种
 *
 * 卡上原写「写入点只有 `resolveApproval` 一个」。**实际有五个出口**（见
 * `ApprovalBridge` 的 `approvalRecordFor` 调用点）：三类用户决定（工具/提问/计划）、
 * 「跳过不答」也算决定，还有 `rejectPending` 的会话取消 ——
 * **那个不是用户拒绝，所以记 `cancelled` 而不是 `deny`**。
 */
import { getDb, persist } from "./db.js";
import { v } from "./sessionSchema.js";

/** 表名。`db.ts` 的 `migrate()` 引用它。 */
export const APPROVALS_TABLE = "approvals";

/**
 * 建表 SQL —— 放在 `db.ts` 的 `migrate()` 里执行。
 *
 * 索引的两个选择，都与「不依赖量级也安全」有关（量级实测不出来，见 spec 的问题 3）：
 *
 *  - `(session_id, decided_at)` —— 主查询是「这个会话批过什么」；
 *  - `(decided_at)` —— 全局时间窗（「最近批了什么」、将来的清理）。
 */
export const APPROVALS_CREATE_SQL = `
    CREATE TABLE IF NOT EXISTS ${APPROVALS_TABLE} (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      subject     TEXT NOT NULL,
      decision    TEXT NOT NULL,
      always      INTEGER NOT NULL DEFAULT 0,
      decided_at  INTEGER NOT NULL,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_session ON ${APPROVALS_TABLE}(session_id, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_approvals_decided ON ${APPROVALS_TABLE}(decided_at DESC);
`;

/** 审批的三种来源。**不是** decision —— 那是「用户怎么答的」。 */
export type ApprovalKind = "tool" | "question" | "plan";

/**
 * 用户（或系统）对这个请求做了什么。
 *
 * | 值 | 含义 | 谁写的 |
 * |---|---|---|
 * | `allow` | 允许了工具调用 | `resolveApproval` |
 * | `deny` | 拒绝了工具调用 | `resolveApproval` |
 * | `answered` | 回答了模型的问题 | `resolveUserInput` |
 * | `dismissed` | **关掉问题卡片没答** | `dismissUserInput` |
 * | `approved` / `rejected` | 批准 / 否掉了计划 | `resolvePlanApproval` |
 * | `cancelled` | **会话被取消，pending 一起失效** | `rejectPending` |
 *
 * ⚠️ `cancelled` **不是** `deny`：用户没有拒绝过任何东西，是会话被取消了。
 * 混成 `deny` 会让「我拒绝过几次」这个统计是假的。
 */
export type ApprovalOutcome =
  | "allow"
  | "deny"
  | "answered"
  | "dismissed"
  | "approved"
  | "rejected"
  | "cancelled";

export interface ApprovalRecord {
  /** = `requestId`。同一 requestId 重复写会被 `INSERT OR REPLACE` 覆盖（幂等）。 */
  id: string;
  sessionId: string;
  kind: ApprovalKind;
  /** 人话：工具名 / 问题第一句 / 计划标题。**用户在审批卡上看到过的那个东西。** */
  subject: string;
  decision: ApprovalOutcome;
  /** 用户勾了「始终允许」吗。 */
  always: boolean;
  decidedAt: number;
  /**
   * 少量结构化补充（JSON 或 null）。
   *
   * ⚠️ **只放已经脱敏的、用户在卡片上看到过的字段**（例如工具的 `description`）。
   * **不要往里塞 `input` 原文** —— 它会被 `redactValue` 打码，说明本来就当敏感物。
   */
  detail: string | null;
}

/** 数据库行 → 领域对象。 */
export interface ApprovalDbRow {
  id: string;
  session_id: string;
  kind: string;
  subject: string;
  decision: string;
  always: number;
  decided_at: number;
  detail: string | null;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<ApprovalKind>(["tool", "question", "plan"]);
const KNOWN_DECISIONS: ReadonlySet<string> = new Set<ApprovalOutcome>([
  "allow", "deny", "answered", "dismissed", "approved", "rejected", "cancelled",
]);

/**
 * 行 → `ApprovalRecord`。
 *
 * ⚠️ **不认识的值抛错，不回落。** 回落成某个默认值会让「表里有个我们不认识的
 * decision」变成「这是一次普通拒绝」—— 那是两种完全不同的事实。
 */
export function rowToApproval(r: ApprovalDbRow): ApprovalRecord {
  if (!KNOWN_KINDS.has(r.kind)) {
    throw new Error(`approval ${r.id}: 数据库里的 kind ${JSON.stringify(r.kind)} 不在已知集合里`);
  }
  if (!KNOWN_DECISIONS.has(r.decision)) {
    throw new Error(`approval ${r.id}: 数据库里的 decision ${JSON.stringify(r.decision)} 不在已知集合里`);
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind as ApprovalKind,
    subject: r.subject,
    decision: r.decision as ApprovalOutcome,
    always: r.always !== 0,
    decidedAt: r.decided_at,
    detail: r.detail,
  };
}

/**
 * 写一条审批记录。
 *
 * ## ⚠️ **调用方必须吞掉这里的异常**
 *
 * 审批是**用户的动作**，历史记录是**附属品**。写库失败绝不能让用户点不动按钮 ——
 * 所以 `ApprovalBridge` 里每个出口都把它包在 try/catch 里，失败只记日志。
 * 那条纪律的真正检验在 `approval-history-smoke` 的「写库抛错时 resolveApproval
 * 仍返回 sessionId」。
 *
 * ## 为什么 `INSERT OR REPLACE`
 *
 * 同一 `requestId` 理论上只结算一次，但 `rejectPending` 和单个 resolve 之间有竞态
 * （批量清理正在遍历时用户点了别处）。`OR REPLACE` 让重复写变成幂等覆盖，
 * 而不是抛唯一键冲突 —— **一次本来成功的审批不该因为历史记不上而报错**。
 */
export function insertApproval(record: ApprovalRecord): void {
  getDb().run(
    `INSERT OR REPLACE INTO approvals
       (id, session_id, kind, subject, decision, always, decided_at, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v(record.id),
      v(record.sessionId),
      v(record.kind),
      v(record.subject),
      v(record.decision),
      record.always ? 1 : 0,
      v(record.decidedAt),
      v(record.detail),
    ],
  );
  persist();
}

/**
 * 按会话列出审批记录（新→旧）。
 *
 * **`limit` 默认不是「全部」** —— 量级实测不出来（见 spec 的问题 3），所以取一个
 * 有界的默认值，避免一个跑了几个月的会话一次拉出几千条。
 */
export function listApprovals(input: {
  sessionId: string;
  limit?: number;
  /** 只取早于这个时间戳的（游标分页）。 */
  before?: number;
}): ApprovalRecord[] {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const stmt = input.before === undefined
    ? getDb().prepare(
        `SELECT id, session_id, kind, subject, decision, always, decided_at, detail
           FROM approvals WHERE session_id = ? ORDER BY decided_at DESC LIMIT ?`,
      )
    : getDb().prepare(
        `SELECT id, session_id, kind, subject, decision, always, decided_at, detail
           FROM approvals WHERE session_id = ? AND decided_at < ?
           ORDER BY decided_at DESC LIMIT ?`,
      );
  try {
    stmt.bind(input.before === undefined
      ? [v(input.sessionId), limit]
      : [v(input.sessionId), input.before, limit]);
    const out: ApprovalRecord[] = [];
    while (stmt.step()) {
      out.push(rowToApproval(stmt.getAsObject() as unknown as ApprovalDbRow));
    }
    return out;
  } finally {
    stmt.free();
  }
}
