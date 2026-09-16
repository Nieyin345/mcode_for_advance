/**
 * 工作流那一摊变了 → 告诉渲染端重拉列表。
 *
 * ## 为什么要有这一条广播,以及为什么它必须由**两边**一起用
 *
 * 设置 → 工作流里那份列表有两类写者:
 *   - **用户** —— IPC,都在 `main/ipc/orchestration.ts` 里;
 *   - **AI** —— MCP 工具,在 `main/mcp/mcodeServer.ts` 里。
 *
 * 两边的真相都在数据根下(`workflows` 表 / `workflows/agents/*.json` /
 * `workflows/node-types/*.json`),而渲染端有自己缓存的一份列表。谁改了都得让另一边
 * 知道。少了这一条:AI 建好的工作流要等用户关掉设置页再打开才出现,用户会以为它
 * 没干活 —— 与 `main/library/broadcast.ts` 里那条一模一样的理由,用户的原话也是
 * 同一句:「他对文件系统的操作要和用户在 ui 的操作一样」。
 *
 * ## 覆盖范围:工作流 + 代理档案 + 节点类型
 *
 * 四样东西共用一个信号,因为它们**显示在同一屏上**:工作流列表、自动化那一栏、节点
 * 类型目录(画布「添加节点」菜单)、代理档案(插入菜单)。分开四条信号的话,渲染端
 * 要维护四套订阅,而它们做的事完全一样 —— 重拉一遍。
 *
 * 故意做得很粗:只报"变了",不报"变了什么"。细粒度的增量同步要维护两边的状态机,
 * 而重拉一份列表是毫秒级的 —— 这里不值得为性能引入出错的可能。
 *
 * ⚠️ **渲染端只重拉列表,不重载正在编辑的那一份文档**(理由写在
 * `@contracts/ipc` 的 `WorkflowChangedMessage` 上)。
 *
 * ## 失败不影响调用方
 *
 * 窗口没开着(手机端连的会话、或者应用正在退出)时推送会抛 —— 那时也没有界面要
 * 更新。一次已经写成功的操作不该因为"没人听"而报错。
 */
import { IPC } from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";

export function notifyWorkflowsChanged(reason: string): void {
  try {
    sendToRenderer(IPC.WORKFLOW_CHANGED, { channel: IPC.WORKFLOW_CHANGED, reason });
  } catch {
    /* 没有窗口在听 —— 不是错误 */
  }
}
