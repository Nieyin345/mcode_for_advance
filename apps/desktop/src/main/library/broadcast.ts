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
      title: item.title,
      ...(item.filePath ? { filePath: item.filePath } : {}),
      ...(item.pdfPath ? { pdfPath: item.pdfPath } : {}),
    });
  } catch (err) {
    log.warn(`[library] 发导入事件失败(${item.id}):${(err as Error).message}`);
  }
}

/**
 * 统一资料库:一条条目的 **PDF 真下到本地了** → 发一条 `library.item.downloaded`。
 *
 * ## 为什么要有这一条(以及它在替掉什么)
 *
 * 用户的要求是「导入之后是软件自动下载，自动转录的，不需要 ai 去管」。早先这件事是
 * **写死**在软件里的:下载线程直接调一个注册进来的函数,而那个函数做的事(本地 pdf.js
 * 抽文本)写在 `ipc/library.ts` 里。用户改不了它 —— 想接自己那套高质量转录工具,只能
 * 去动源码。
 *
 * 现在拆成两截:这里只**说一句"下完了"**,至于下完该干什么,由用户在**钩子**或
 * **自动化的「事件发生时」触发器**里自己配。软件不再规定转录这件事。
 *
 * ## 为什么不能复用 `library.item.imported`
 *
 * 那个事件在**文件还不存在**的时候就发了 —— 导入只是"库里多了这一条",PDF 是随后
 * 才下来的。拿导入当转录时机,只会扑空。两者都留着是因为「导入就该干点什么」的用法
 * 确实存在(建占位笔记、按标题归类),它不需要等文件。
 *
 * ## 与导入同一条通道、同一个哨兵
 *
 * `emitExternal` 而不是 `broadcastRuntimeEvent`:理由与 {@link emitItemImported} 一字
 * 不差(正经读者是钩子和触发器,它们挂在 `runtimeManager.subscribe` 上)。`sessionId`
 * 同样是 `"(system)"` —— 下载跑在后台线程里,不属于任何对话。
 *
 * ## 为什么是同步的(调用方要留意)
 *
 * 它**在下载线程里被同步调用**(见 `downloader.ts` 的 `finalize`)。`emitExternal` 自己
 * 是同步派发,但真正的读者是异步的(钩子起进程、触发器起运行)—— 所以这里立刻返回,
 * 不阻塞下载队列往下走。
 */
export function emitItemDownloaded(item: LibraryItem): void {
  try {
    runtimeManager.emitExternal({
      type: "library.item.downloaded",
      sessionId: "(system)",
      itemId: item.id,
      title: item.title,
      // 库里存的就是**相对路径**(见 `LibraryItem.pdfPath`)—— 原样给出去,别在这里
      // 拼绝对路径:那会把一台机器的磁盘布局散进会被分享的钩子脚本里。
      pdfPath: item.pdfPath ?? "",
      ...(item.filePath ? { filePath: item.filePath } : {}),
    });
  } catch (err) {
    log.warn(`[library] 发下载完成事件失败(${item.id}):${(err as Error).message}`);
  }
}
