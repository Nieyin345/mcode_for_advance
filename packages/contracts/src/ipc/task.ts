/**
 * 【T99】**任务是一级对象** —— 路线图 §3 第一条、§5 核心闭环。
 *
 * ## 它解决什么
 *
 * 在这之前，用户的「任务」只是 `sessions` 表里的一个 TEXT 列（`todos`）：
 *
 *   - 会话删了，任务就没了；
 *   - 跨会话查不到（它是会话内的数组元素，没有独立 ID）；
 *   - 工作流 / 自动化引用不了它；
 *   - 「谁批的、批了什么」事后查不到；
 *   - 「验收不通过 → 退回 → 重做」这条闭环不存在。
 *
 * ## 三个形状判断（定错的话，后面所有功能都要改）
 *
 * ### ① `done` 与 `accepted` 必须分开
 *
 * 路线图 §3 原文：「**执行完成不等于验收通过**；失败应返修、重新验证……证据不够应标
 * BLOCKED/FAIL，而不是报告成功。」这是**硬规矩**，不是设计偏好。
 *
 * 合成一个状态的话，「跑完了」和「跑对了」在数据上无法区分 —— 而这正是仓库反复
 * 记录的那类缺陷（「测试绿着而问题还在」是它在测试层的同构）。任务对象如果也合并，
 * 就会把同一类错误抬进产品数据模型里，将来任何一个「任务完成率」的统计都会是假的。
 *
 * `accepted` 只能由**用户**判定（`task.accept`），执行方永远不能自己写这个状态。
 *
 * ### ② `rejected` 必须能回到 `running`
 *
 * 路线图 §3：「失败应**返修**、重新验证」；§5：「用户能完成、**返修并重新验收**」。
 *
 * 返修 = `rejected → running`。如果 `rejected` 是终态，用户唯一的出路是「再建一个
 * 任务」，那么「这是同一个任务的第二次尝试」这个事实就丢了 —— 而这恰恰是
 * 用户最需要看到的（「这个任务我退回过三次」）。
 *
 * `acceptance.round` 用来记这是第几轮验收；它随每次 `rejected → running` 递增，
 * 于是「退回过几次」是数据里的一个数，不是一句回忆。
 *
 * ### ③ `origin` 要能指向多来源
 *
 * 路线图 §3：「可以由**聊天、工作流、自动化和多个 Agent** 关联或推进」。
 *
 * 所以 `origin` 不是「一个会话 id」，而是「谁发起的 + 还有谁在推进它」：
 * `createdBy` 只有一个（发起者），`linkedSessions` / `linkedWorkflows` 是集合。
 * 一个任务可以被别的 Agent 接手推进，但发起者不变 —— 这两件事在数据上就分开了。
 */
import { z } from "zod";

/* ────────────────────────── 状态 ────────────────────────── */

/**
 * 任务状态。
 *
 * | 状态 | 谁写 | 含义 |
 * |---|---|---|
 * | `pending` | 执行方 | 已创建，未开始 |
 * | `running` | 执行方 | 正在做 |
 * | `blocked` | 执行方 | 等审批或等依赖（**不是失败**） |
 * | `done` | 执行方 | 执行完成 —— **不等于验收通过** |
 * | `failed` | 执行方 | 执行失败（带 `failureReason`） |
 * | `accepted` | **只有用户** | 验收通过 |
 * | `rejected` | **只有用户** | 验收不通过，待返修 |
 *
 * **两个「只有用户」是硬边界**：执行方把所有状态写到 `done` 就必须停 —— 它不能
 * 自己盖章说「这个做得好」。这条边界由 `task.accept` / `task.reject` 的路径保证
 * （见 `TASK_EXECUTOR_STATUSES`）。
 */
export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "done",
  "failed",
  "accepted",
  "rejected",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * **执行方可以写的状态** —— 不含 `accepted` / `rejected`。
 *
 * 这不是文档，是一个**可被断言的集合**：`task.transition` 会拒绝不在这个集合里的
 * 目标状态，于是「AI 自己把任务标成已验收」在代码层就走不通。
 */
export const TASK_EXECUTOR_STATUSES: readonly TaskStatus[] = [
  "pending", "running", "blocked", "done", "failed",
] as const;

/* ────────────────────────── 来源 ────────────────────────── */

/** 谁发起了这个任务。 */
export const TaskOriginSchema = z.object({
  /** 发起方种类。`agent` = AI 主动建的；`user` = 用户从 UI 建的。 */
  kind: z.enum(["user", "agent", "workflow", "automation"]),
  /** 具体身份：会话 id / 工作流 id / 自动化 id。 */
  ref: z.string().min(1).max(200),
  /** 发起时所在的项目（可选，跨项目任务没有）。 */
  projectPath: z.string().max(4096).optional(),
}).strict();
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;

/**
 * 与这个任务**关联**的其他会话 / 工作流。
 *
 * 为什么和 `origin` 分开：发起者只有一个，推进者可以有很多。路线图说「可以由聊天、
 * 工作流、自动化和多个 Agent 关联或推进」—— 「关联或推进」是复数关系，塞进
 * `origin` 会让「谁发起」这个事实被覆盖掉。
 */
export const TaskLinksSchema = z.object({
  sessionIds: z.array(z.string().min(1).max(200)).max(64).default([]),
  workflowIds: z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();
export type TaskLinks = z.infer<typeof TaskLinksSchema>;

/* ────────────────────────── 产物 ────────────────────────── */

/** 任务产出的一个文件。 */
export const TaskArtifactSchema = z.object({
  /** 绝对路径（产物可能在项目外，例如导出的 PPT）。 */
  path: z.string().min(1).max(4096),
  /** 人话说明：这个文件是什么。 */
  description: z.string().min(1).max(500),
  /** 产出时刻（ms epoch）。 */
  createdAt: z.number().int().nonnegative(),
}).strict();
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

/* ────────────────────────── 验收 ────────────────────────── */

/**
 * 验收证据 —— 「凭什么说这个任务通过了」。
 *
 * 形状照 `SceneAcceptanceResult`（仓库里唯一有验收闭环的先例），但**通用化**：
 * 场景那条路的 `expected` / `observed` / `missing` 是资源 id 比对，而通用任务的
 * 验收判据不一定是「资源清单」—— 可能是「打开看了一眼」「跑了一遍脚本」。
 *
 * 所以这里记的是**结论 + 理由 + 谁判的**，而不是具体的比对过程。具体比对留在
 * 各自的功能里（场景部署仍用它自己那份）。
 */
export const TaskAcceptanceSchema = z.object({
  /** 第几轮验收。每次 `rejected → running` 递增。1 = 首次。 */
  round: z.number().int().positive(),
  /** 判定时刻（ms epoch）。 */
  decidedAt: z.number().int().nonnegative(),
  /** 判定的理由 —— 用户写的话，或系统给出的证据摘要。**必填**，不许空着说「通过」。 */
  evidence: z.string().min(1).max(4000),
}).strict();
export type TaskAcceptance = z.infer<typeof TaskAcceptanceSchema>;

/* ────────────────────────── 任务 ────────────────────────── */

export const TaskSchema = z.object({
  /** 稳定 ID，跨会话、跨重启不变。前缀 `task_`，与其它实体同构。 */
  id: z.string().min(1).max(200),
  /** 目标（人话，用户能看懂）。 */
  goal: z.string().min(1).max(4000),
  status: TaskStatusSchema,
  /** 依赖的任务 ID（DAG）。空数组 = 无依赖。 */
  dependsOn: z.array(z.string().min(1).max(200)).max(256).default([]),
  origin: TaskOriginSchema,
  links: TaskLinksSchema,
  artifacts: z.array(TaskArtifactSchema).max(512).default([]),
  /** 验收结果。`null` = 还没验收（包括 `done` 但用户还没看）。 */
  acceptance: TaskAcceptanceSchema.nullable(),
  /** 执行失败的原因（`status === "failed"` 时应有）。 */
  failureReason: z.string().max(4000).nullable(),
  /** 用户退回的理由（`status === "rejected"` 时应有）。 */
  rejectionReason: z.string().max(4000).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type Task = z.infer<typeof TaskSchema>;

/* ────────────────────────── IPC 形状 ────────────────────────── */

export const TaskListInputSchema = z.object({
  status: TaskStatusSchema.optional(),
  /** 只列某个会话**发起或关联**的任务。省略 = 全部（跨会话）。 */
  sessionId: z.string().min(1).max(200).optional(),
}).strict();
export type TaskListInput = z.infer<typeof TaskListInputSchema>;

export const TaskGetInputSchema = z.object({ id: z.string().min(1).max(200) }).strict();
export type TaskGetInput = z.infer<typeof TaskGetInputSchema>;

export const TaskAcceptInputSchema = z.object({
  id: z.string().min(1).max(200),
  /** 验收证据 —— **必填**。没有理由的「通过」不算验收。 */
  evidence: z.string().min(1).max(4000),
}).strict();
export type TaskAcceptInput = z.infer<typeof TaskAcceptInputSchema>;

export const TaskRejectInputSchema = z.object({
  id: z.string().min(1).max(200),
  /** 退回理由 —— **必填**。返修的人要知道改什么。 */
  reason: z.string().min(1).max(4000),
}).strict();
export type TaskRejectInput = z.infer<typeof TaskRejectInputSchema>;

export const TASK_LIST_CHANNEL = "task:list";
export const TASK_GET_CHANNEL = "task:get";
export const TASK_ACCEPT_CHANNEL = "task:accept";
export const TASK_REJECT_CHANNEL = "task:reject";
