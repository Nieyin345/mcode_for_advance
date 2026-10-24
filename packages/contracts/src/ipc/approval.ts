/**
 * 【T109】**审批历史** —— 路线图 §5「任务中心能追踪状态、失败、审批、产物与证据」。
 *
 * ## 它解决什么
 *
 * `ApprovalBridge` 的 `pendingApprovals` 是内存 Map：处理完就从列表消失、进程退出即丢。
 * 用户看不到「上次那个操作我批了没」「这轮一共批了几次」。
 *
 * ## 三个形状判断（详见 `.scratch/approval-history/spec.md`）
 *
 * ### ① 没有 `taskId`
 *
 * **不是「大多数审批没有任务」，是时序上更硬的那条**：任务在 `turn.done` **才**建，
 * 而审批发生在 `turn.done` **之前** —— 存一个当时还不存在的 id，只能存 `null`。
 *
 * 「审批 → 任务」的反查靠 `tasks.origin.ref`（它存的是 sessionId），不是这张表。
 *
 * ### ② 只有 `sessionId` 一个外键
 *
 * 一次审批发生在会话里，`PendingApproval` 存的就是 `sessionId`。
 *
 * ### ③ `decision` 有七种，不是两种
 *
 * 因为写入出口有五个（工具/提问/计划/跳过/会话取消），而「会话取消」**不是用户拒绝** ——
 * 混成 `deny` 会让「我拒绝过几次」这个统计是假的。
 */
import { z } from "zod";

/** 审批的三种来源。**不是** decision —— 那是「用户怎么答的」。 */
export const ApprovalKindSchema = z.enum(["tool", "question", "plan"]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

/**
 * 用户（或系统）对这个请求做了什么。
 *
 * | 值 | 含义 | 由谁写 |
 * |---|---|---|
 * | `allow` / `deny` | 允许 / 拒绝工具调用 | `resolveApproval` |
 * | `answered` | 回答了模型的问题 | `resolveUserInput` |
 * | `dismissed` | **关掉问题卡片没答** | `dismissUserInput` |
 * | `approved` / `rejected` | 批准 / 否掉计划 | `resolvePlanApproval` |
 * | `cancelled` | **会话被取消，pending 一起失效** | `rejectPending` |
 */
// ⚠️ 叫 `ApprovalOutcome` 而不是 `ApprovalDecision`：后者已被 `session.ts:246` 占用，
// 含义是「用户对一张审批卡怎么答的（IPC 层）」。两者相关但不是同一个东西 ——
// 这里是**落库的结论**，多出 `answered` / `dismissed` / `cancelled` 三种。
export const ApprovalOutcomeSchema = z.enum([
  "allow", "deny", "answered", "dismissed", "approved", "rejected", "cancelled",
]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;

/**
 * 一条审批记录。
 *
 * ⚠️ **没有 `input` 原文** —— 它会被 `redactValue` 打码，说明本来就当敏感物对待。
 * 表里只放**用户在审批卡上看到过的那个东西**（`subject`）。
 *
 * ⚠️ **也没有 `inputDigest`** —— 没有诚实的消费者：没有场景需要判断「这两次审批
 * 是不是同一个操作」，而 `kind + subject + 时间` 已经回答了用户真正会问的问题。
 * 一个没人读的校验字段会让后来的人以为这里有完整性保证。
 */
export const ApprovalSchema = z.object({
  /** = `requestId`。 */
  id: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  kind: ApprovalKindSchema,
  /** 人话：工具名 / 问题第一句 / 计划标题（最多 240 字，超长已截断）。 */
  subject: z.string().max(500),
  decision: ApprovalOutcomeSchema,
  /** 用户勾了「始终允许」吗。 */
  always: z.boolean(),
  decidedAt: z.number().int().nonnegative(),
  /** 少量结构化补充（JSON 字符串或 null）。只放已脱敏、用户看到过的字段。 */
  detail: z.string().max(4000).nullable(),
}).strict();
export type Approval = z.infer<typeof ApprovalSchema>;

/* ────────────────────────── IPC 形状 ────────────────────────── */

export const ApprovalListInputSchema = z.object({
  /** 哪个会话的审批历史。**必填** —— 全局列表没有意义（会混所有会话）。 */
  sessionId: z.string().min(1).max(200),
  /** 上限（1–500，默认 200）。 */
  limit: z.number().int().min(1).max(500).optional(),
  /** 游标分页：只取早于这个时间戳的。 */
  before: z.number().int().nonnegative().optional(),
}).strict();
export type ApprovalListInput = z.infer<typeof ApprovalListInputSchema>;

export const APPROVAL_LIST_CHANNEL = "approval:list";
