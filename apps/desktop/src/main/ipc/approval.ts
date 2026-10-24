/**
 * 【T109】审批历史 IPC —— 只有一条 `approval.list`。
 *
 * ## 为什么只有读
 *
 * **写入不在 IPC 上**：审批记录由 `ApprovalBridge` 在五个结算出口里直接写库
 * （`claude/ApprovalBridge.ts` 的 `recordApproval`）。那条路必然经过，且**不能用 IPC
 * 让渲染端补记** —— 那等于让页面自己声明「我刚才批了什么」。
 *
 * ## 为什么按 `sessionId` 必填
 *
 * 全局审批列表没有意义：不同会话的审批混在一起，用户认不出来。
 * （任务那边 `task.list` 允许省略 sessionId 是因为「任务是跨会话的一级对象」；
 * 审批不是 —— 它天生属于一个会话。）
 */
import type { IpcMain } from "electron";
import { ApprovalListInputSchema, IPC, type Approval } from "@contracts/ipc";
import { listApprovals } from "@main/store/approvalSchema.js";

export function registerApprovalHandlers(ipc: Pick<IpcMain, "handle">): void {
  ipc.handle(IPC.APPROVAL_LIST, (_evt, raw): { approvals: Approval[] } => {
    const input = ApprovalListInputSchema.parse(raw);
    return {
      approvals: listApprovals({
        sessionId: input.sessionId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.before === undefined ? {} : { before: input.before }),
      }),
    };
  });
}
