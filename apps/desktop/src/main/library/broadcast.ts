/**
 * 库变了 → 告诉渲染端重载(左栏那棵树、右栏那一屏、正在看的那一篇都会跟着重拉)。
 *
 * ## 为什么要有这一条广播,以及为什么它必须由**两边**一起用
 *
 * 库有两类写者:
 *   - **用户** —— IPC,都在 `main/ipc/library.ts` 里;
 *   - **AI** —— MCP 工具,在 `main/mcp/libraryServer.ts` 里。
 *
 * 两边的真相都在主进程里,而渲染端各有自己的缓存(左栏的分类树与条目列表、右栏那一
 * 屏的列表、右栏正在看的那一篇的正文)。谁改了都得让另一边知道。少了这一条:
 *
 *   - 用户在左栏改个名字,右栏还显示旧的 —— 用户的原话是「左边框的操作要和右边的
 *     预览要实时同步」;
 *   - AI 建好的分类在左栏根本不出现,用户会以为它没干活 —— 「他对文件系统的操作要
 *     和用户在 ui 的操作一样」。
 *
 * 早先它只存在于 MCP 那一侧(用户自己动手时没人发),于是右栏永远慢半拍。搬到这个
 * 模块里、两边都调,**一个实现**才谈得上"两条路效果一样"。
 *
 * ## 失败不影响调用方
 *
 * 窗口没开着(手机端连的会话、或者应用正在退出)时推送会抛 —— 那时也没有界面要
 * 更新。一次已经写成功的操作不该因为"没人听"而报错。
 */
import { IPC } from "@contracts/ipc";
import type { LibraryItem } from "@contracts/library";
import { sendToRenderer } from "@main/window.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { log } from "@main/lib/logger.js";

export function notifyLibraryChanged(reason: string): void {
  try {
    sendToRenderer(IPC.LIBRARY_CHANGED, { channel: IPC.LIBRARY_CHANGED, reason });
  } catch {
    /* 没有窗口在听 —— 不是错误 */
  }
}

/**
 * 统一资料库:一条条目**入库成功** → 发一条 `library.item.imported`。
 *
 * ## 为什么走 `emitExternal` 而不是 `broadcastRuntimeEvent`
 *
 * 事件的长相是"广播给所有客户端"(同 `sessionSync.broadcastRuntimeEvent` 的那两条
 * 通道),但它的**正经读者是 automation 的「事件发生时」触发器与钩子** —— 那两位挂在
 * `runtimeManager.subscribe` 上,而 `broadcastRuntimeEvent` 恰恰不发观察者(见
 * `runner.ts` 里 `workflow.node.usage` 那条同款注释)。所以走 `emitExternal`:两条
 * 客户端通道 + 观察者,一次到位。
 *
 * ## `sessionId` 用合成哨兵 "(system)"
 *
 * 理由写在 `@contracts/runtime` 的 `LibraryItemImportedEvent` 上 —— 导入不属于任何
 * 对话。渲染端对认不出的类型按未知事件忽略;`HookRunner` 对 "(system)" 有专门的
 * 放行(会话查不到≠事件丢了)。
 *
 * 三个导入入口(`operations.importIdentifiers` / `pdfImport.importPdfFiles` /
 * `fileImport.importGenericFiles`)都调这里 —— 事件语义只有一份,散在各入口迟早分叉。
 */
export function emitItemImported(item: LibraryItem): void {
  try {
    runtimeManager.emitExternal({
      type: "library.item.imported",
      sessionId: "(system)",
      itemId: item.id,
      kind: item.kind,
      title: item.title,
    });
  } catch (err) {
    log.warn(`[library] 发导入事件失败(${item.id}):${(err as Error).message}`);
  }
}
