/**
 * 【T99】任务 IPC —— 只注册**渲染端真的会发**的四个方法。
 *
 * ## 这里只剩薄薄一层
 *
 * 每个 handler 做一件事：解析参数、调 `@main/tasks/executor.js` 或 `TaskRepo`、返回。
 * **校验逻辑与状态机不在这里** —— 它们在 `main/tasks/executor.ts`，因为主进程内部的
 * 执行路径（`main/tasks/autoCreate.ts`）也要走同一份，而那条路根本不经过 IPC。
 *
 * ## 为什么只有四条
 *
 * `task:create` / `task:transition` / `task:reopen` / `task:link` 曾经也注册成 IPC 渠道
 * （T99），四个 handler 的主体就是那三条校验。那有两个问题：
 *
 * 1. **它们的唯一调用方是无头套件**（`grep` 过：生产侧零调用方）。为测试注册一条渲染端
 *    够不着的渠道，等于给 `ipc-parity` / `ipc-wiring` 那两条守卫开例外 —— 而那两条守卫
 *    防的是「注册了但渲染端看不见」这个真实问题，答案「因为套件需要」不是产品理由。
 * 2. **它们本该是进程内函数。** `autoCreate.ts` 建任务、改状态时在同一个进程里，
 *    没有理由绕一圈 IPC。
 *
 * 所以那四条改成了 `executor.ts` 的导出函数（套件直接 import，零 IPC 注册），
 * 渠道常量与 `RpcMap` 条目一并删掉。
 *
 * ## 一条硬边界：执行方够不到 `accept` / `reject`
 *
 * 路线图 §3：「**执行完成不等于验收通过**」。两层各守一半，缺一不可：
 *
 *   - **`executor.ts`** 挡住「把状态**写成** accepted」——`TASK_EXECUTOR_STATUSES`；
 *   - **`policy.ts` 的 `BLOCKED`** 挡住「agent 够得到这个**方法**」。`accept` / `reject`
 *     不匹配 `READ_VERB`（那条正则以 `list|get|read|…` 开头），不显式钉 `blocked` 的话
 *     会落到兜底 `write`：弹一张审批卡，agent 点一下就等于给自己盖章。
 *
 * `task.accept` / `task.reject` 留在 IPC 上，因为**任务中心面板真的调它们**
 * （`TaskCenterPanel.tsx` 的接受/退回按钮）。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  TaskAcceptInputSchema,
  TaskGetInputSchema,
  TaskListInputSchema,
  TaskRejectInputSchema,
  type Task,
} from "@contracts/ipc";
import { TaskRepo } from "@main/store/repositories/task.js";

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
}
