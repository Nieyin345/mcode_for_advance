/**
 * 记忆库变了 → 告诉渲染端重拉列表。
 *
 * ## 为什么要有这一条广播,以及它为什么必须由**两边**一起用
 *
 * 「记忆」面板里那份列表有两类写者:
 *   - **用户** —— IPC,在 `main/ipc/memory.ts` 里;
 *   - **AI** —— MCP 工具,在 `main/mcp/memoryServer.ts` 里。
 *
 * 两边的真相都是数据根下的 `memory/<类目>/*.md`,而渲染端有自己缓存的一份列表。
 * 谁改了都得让另一边知道。少了这一条:AI 刚记下一条,用户切到记忆面板却看不见它,
 * 会以为它没记住 —— 与 `main/orchestration/broadcast.ts` 里那条一模一样的理由,
 * 用户的原话也是同一句:「他对文件系统的操作要和用户在 ui 的操作一样」。
 *
 * ## 用的是既有的 `library:changed` 通道,不新开一条
 *
 * ⚠️ 这里**刻意不复用工作流那条**(`workflow:changed`)—— 那条的名字写死了"工作流",
 * 拿它报"记忆变了"会让接收方去重拉工作流列表。而新开一条 `memory:changed` 要动
 * 契约、preload、渲染端订阅三处,换来的只是"信号的名字更专一"。
 *
 * 记忆面板本来就与资料库同屏(都在设置 → 数据那一摊),而且它已经在用
 * `library:changed` 那条做别的刷新 —— 复用它的语义是准的:数据根下的内容变了。
 * 细粒度的 `reason` 字符串带出去,将来真要分开也只是加个判断。
 */
import { IPC } from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";

export function notifyMemoryChanged(reason: string): void {
  try {
    sendToRenderer(IPC.LIBRARY_CHANGED, { channel: IPC.LIBRARY_CHANGED, reason });
  } catch {
    /* 没有窗口在听 —— 不是错误(同 notifyWorkflowsChanged) */
  }
}
