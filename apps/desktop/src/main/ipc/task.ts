/**
 * 【T99】任务 IPC —— 任务是一级对象（路线图 §3 第一条 / §5 核心闭环）。
 *
 * ## 这一层做两件事：校验 + 状态机
 *
 * 存储层的 `TaskRepo` 只管读写；**「哪些状态迁移合法」在这里**，因为它是业务规则，
 * 而 store 那层不该认识它。
 *
 * ## 一条硬边界：执行方够不到 `accept` / `reject`
 *
 * 路线图 §3：「**执行完成不等于验收通过**」。所以：
 *
 *   - `task.transition`（执行方用的）只接受 `TASK_EXECUTOR_STATUSES`（pending / running /
 *     blocked / done / failed）—— **写 `accepted` 会在参数校验阶段就被拒**；
 *   - `task.accept` / `task.reject` 是用户动作。它们被 `appControl/policy.ts` 的
 *     `BLOCKED` 表判为 `blocked`（agent 够不到），见本卡回写里的说明。
 *
 * 两层各守一半，缺一不可：
 *  - **本文件**挡的是「把状态**写成** accepted」——`TASK_EXECUTOR_STATUSES` 是参数校验；
 *  - **policy.ts** 挡的是「agent 够得到这个**方法**」——`accept` / `reject` 不匹配
 *    `READ_VERB`（那条正则以 `list|get|read|…` 开头），不显式钉 `blocked` 的话会落到
 *    兜底 `write`：弹一张审批卡，agent 点一下就等于给自己盖章。
 *
 * 这条边界不是靠「调用方自觉」，是**两个不同的方法 + 一个可断言的集合 + 一张可断言的
 * 权限表** —— 于是「AI 自己把任务标成已验收」在代码层走不通。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  TaskAcceptInputSchema,
  TaskGetInputSchema,
  TaskListInputSchema,
  TaskRejectInputSchema,
  TASK_EXECUTOR_STATUSES,
  type Task,
  type TaskStatus,
} from "@contracts/ipc";
import { TaskRepo } from "@main/store/repositories/task.js";

/** 生成任务 id。前缀与其他实体同构（`task_`），日志里一眼能看出是什么。 */
function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

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
 *    就是返修**（用户退回后执行方重新开始）。
 */
const EXECUTOR_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: [],
  running: ["pending", "blocked", "rejected"],
  blocked: ["pending", "running"],
  done: ["running"],
  failed: ["running", "blocked"],
  // 这两个状态执行方永远写不进去（不在 TASK_EXECUTOR_STATUSES 里），留空表是为了
  // 让 Record 完整 —— 万一有人漏了那条校验，这里也不会给出任何合法来源。
  accepted: [],
  rejected: [],
};

export function registerTaskHandlers(ipc: Pick<IpcMain, "handle">): void {
  ipc.handle(IPC.TASK_LIST, (_evt, raw) => {
    const input = TaskListInputSchema.parse(raw ?? {});
    return { tasks: TaskRepo.list(input) };
  });

  ipc.handle(IPC.TASK_GET, (_evt, raw) => {
    const input = TaskGetInputSchema.parse(raw);
    return TaskRepo.get(input.id);
  });

  ipc.handle(IPC.TASK_ACCEPT, (_evt, raw): Task => {
    const input = TaskAcceptInputSchema.parse(raw);
    return TaskRepo.accept({ id: input.id, evidence: input.evidence });
  });

  ipc.handle(IPC.TASK_REJECT, (_evt, raw): Task => {
    const input = TaskRejectInputSchema.parse(raw);
    return TaskRepo.reject({ id: input.id, reason: input.reason });
  });

  /**
   * 执行方的状态迁移。
   *
   * 它**没有对应的 RpcMap 条目**（不是给渲染端/扩展用的），只由主进程内部的执行路径
   * 调用。放成 handler 是为了让无头套件能驱动同一段代码 —— 如果只写成一个导出函数，
   * 套件验的和生产走的就是两份实现。
   */
  ipc.handle(IPC.TASK_TRANSITION, (_evt, raw) => {
    const input = raw as { id?: unknown; status?: unknown; artifacts?: unknown; failureReason?: unknown };
    const id = TaskGetInputSchema.parse({ id: input.id }).id;
    const status = input.status as TaskStatus;
    if (!TASK_EXECUTOR_STATUSES.includes(status)) {
      throw new Error(
        `执行方不能把任务置为 ${String(input.status)} —— 验收状态（accepted / rejected）只能由用户在验收界面写`,
      );
    }
    const current = TaskRepo.get(id);
    if (!current) throw new Error(`task ${id} 不存在`);
    const allowed = EXECUTOR_TRANSITIONS[status];
    if (!allowed.includes(current.status)) {
      throw new Error(
        `任务状态不能从 ${current.status} 迁到 ${status}（合法来源：${allowed.join(" / ") || "无"}）`,
      );
    }
    return TaskRepo.setStatus({
      id,
      status,
      ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts as Task["artifacts"] }),
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason as string | null }),
    });
  });

  /** `rejected → running`：返修。用户退回后，执行方从这里重新开始。 */
  ipc.handle(IPC.TASK_REOPEN, (_evt, raw) => {
    const input = TaskGetInputSchema.parse(raw);
    return TaskRepo.reopen(input.id);
  });

  /** 把任务关联到另一个会话 / 工作流（多 Agent 推进同一个任务）。 */
  ipc.handle(IPC.TASK_LINK, (_evt, raw) => {
    const input = raw as { id?: unknown; sessionId?: unknown; workflowId?: unknown };
    const id = TaskGetInputSchema.parse({ id: input.id }).id;
    return TaskRepo.link({
      id,
      ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
      ...(typeof input.workflowId === "string" ? { workflowId: input.workflowId } : {}),
    });
  });

  /** 建任务 —— 只给主进程内部用（谁发起、发起时用哪个 id 由宿主决定）。 */
  ipc.handle(IPC.TASK_CREATE, (_evt, raw) => {
    const input = raw as { goal?: unknown; origin?: unknown; dependsOn?: unknown; id?: unknown };
    if (typeof input.goal !== "string" || input.goal.trim().length === 0) {
      throw new Error("任务必须有目标（goal 不能为空）");
    }
    const id = typeof input.id === "string" && input.id.length > 0 ? input.id : newTaskId();
    return TaskRepo.create({
      id,
      task: {
        goal: input.goal,
        origin: input.origin as Task["origin"],
        dependsOn: Array.isArray(input.dependsOn) ? (input.dependsOn as string[]) : [],
      },
    });
  });
}
