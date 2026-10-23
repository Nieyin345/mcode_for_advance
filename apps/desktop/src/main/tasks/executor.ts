/**
 * 【T100】执行方的任务状态入口 —— **进程内函数，不是 IPC 渠道**。
 *
 * ## 为什么有这一层，而校验不在这里
 *
 * 两层校验各管一件事，位置不同：
 *
 * | 校验 | 在哪 | 为什么 |
 * |---|---|---|
 * | **迁移表**（能从什么状态到什么状态） | `TaskRepo.setStatus` | 凡改状态的人都要过 —— 用户的验收、回合收尾的自动记账、将来的执行路径 |
 * | **谁能调**（`accepted` / `rejected` 不开放给执行方） | **本文件** | 它是「这一条路只给执行方」这条**授权**规则，不是数据完整性 |
 *
 * 把迁移表下沉到 repo 是因为 `autoCreate.ts` 走 `setStatus` 时**绕过了它** ——
 * 而那正是「执行方不能把任务写成 accepted」那条边界漏掉的地方（见
 * `TaskRepo.setStatus` 的注释）。
 *
 * ## 这里不认识 IPC
 *
 * 原先这些是 `ipc.handle(...)` 的 handler 主体。它们注册成渠道之后，
 * `ipc-parity` / `ipc-wiring` 两套守卫（正确地）报「注册了但渲染端够不着」——
 * 而唯一的「消费者」是无头套件。**为测试开一条产品里没人发的渠道不是理由。**
 * 改成导出函数后：主进程内部直接调，套件直接 import，零 IPC 注册。
 */

import {
  TASK_EXECUTOR_STATUSES,
  TaskGetInputSchema,
  type Task,
  type TaskStatus,
} from "@contracts/ipc";
import { TaskRepo } from "@main/store/repositories/task.js";

export interface ExecutorTransitionInput {
  id?: unknown;
  status?: unknown;
  artifacts?: unknown;
  failureReason?: unknown;
}

/**
 * 执行方把任务迁到某个状态。
 *
 * 两道校验：
 * 1. **本文件**：目标状态必须在 `TASK_EXECUTOR_STATUSES` 里 —— `accepted` / `rejected`
 *    在这里被拒，它们只能由用户的 `task.accept` / `task.reject` 写；
 * 2. **`TaskRepo.setStatus`**：当前状态到目标状态的迁移合法。
 */
export function transitionTaskAsExecutor(input: ExecutorTransitionInput): Task {
  const id = TaskGetInputSchema.parse({ id: input.id }).id;
  const status = input.status as TaskStatus;
  if (!TASK_EXECUTOR_STATUSES.includes(status)) {
    throw new Error(
      `执行方不能把任务置为 ${String(input.status)} —— 验收状态（accepted / rejected）只能由用户在验收界面写`,
    );
  }
  return TaskRepo.setStatus({
    id,
    status,
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts as Task["artifacts"] }),
    ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason as string | null }),
  });
}

/** `rejected → running`：返修。用户退回后，执行方从这里重新开始。 */
export function reopenTask(input: { id?: unknown }): Task {
  return TaskRepo.reopen(TaskGetInputSchema.parse({ id: input.id }).id);
}

export interface LinkTaskInput {
  id?: unknown;
  sessionId?: unknown;
  workflowId?: unknown;
}

/** 把任务关联到另一个会话 / 工作流（多 Agent 推进同一个任务）。 */
export function linkTask(input: LinkTaskInput): Task {
  const id = TaskGetInputSchema.parse({ id: input.id }).id;
  return TaskRepo.link({
    id,
    ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
    ...(typeof input.workflowId === "string" ? { workflowId: input.workflowId } : {}),
  });
}
