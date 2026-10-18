/**
 * 【ARC-007】文档视图宿主的 IPC 接线 —— `documentView:*` 七条通道。
 *
 * ## 与其它域同一条纪律
 *
 *   - 入参先过 zod（`@contracts/ipc/documentView`），校验失败**不调宿主**，把
 *     zod 的字段错误翻成一句人话回给调用方（`errText`，与 browser 域同一个出口）；
 *   - handler 不向渲染端抛异常 —— 一切失败都落在 `{ ok:false, reason }` 上；
 *   - 每条 handler 都过 `recordRpcHandler`，于是「桌面点按钮」与「Agent 经
 *     `app_api_call`」够到的是**同一个函数**（CLAUDE.md 硬规矩 2）。
 *
 * ## 为什么每条都直接写 `ipc.handle(IPC.X, …)`（不抽公共注册助手）
 *
 * 两套 IPC 回归网（`ipc-parity-smoke` / `ipc-wiring-smoke`）靠**源码文本**认
 * 「主进程到底接了哪些通道」，而它们只解析 `.handle(IPC.常量, …)` 这种直接写法。
 * 抽一个 `register(ipc, channel, fn)` 助手会让七条通道同时从两套网里消失 ——
 * 症状是它们把契约通道报成「主进程没注册」，而代码其实是对的。多写七行换两套网
 * 仍然看得见，这个交换划算。
 *
 * ## `recordRpcHandler` 为什么要在 `ipc.handle` 之前显式调（其它域没这一句）
 *
 * 生产装配时传进来的是 `createDbGuardedIpc` 包装过的 `ipc`，它会在 `handle()` 内部
 * 再登记一份**guarded 版**（带 `awaitDb()` 与幂等账本）。本模块先登记原函数、再交给
 * `ipc.handle`，于是包装层的登记后写、覆盖这一份 —— 生产行为不变。而裸 `ipcMain`
 * （无头套件的 fakeIpc）下没有包装层，这一句就是唯一让 `registeredRpcChannels()`
 * 看得见它们的地方：套件因此能**不引入 electron** 就验证「七条都登记了」。
 *
 * ⚠️ 两处登记**必须是同一个函数对象**（先定 `const handler`，再依次交出去）——
 * 各写一份等于两份实现，日后改一处漏一处，两套网都看不出来。
 *
 * ## 宿主由调用方注入
 *
 * `registerDocumentViewHandlers(ipc, host)` 不 import 生产单例 —— 套件注入自己的
 * `DocumentViewHost`（假构造器）来验状态机，生产装配传 `documentViewHost` 单例。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  DocViewBoundsSchema,
  DocViewCloseSchema,
  DocViewOpenPathSchema,
  DocViewDocIdSchema,
  DocViewOpenSchema,
  type DocViewListResult,
  type DocViewResult,
} from "@contracts/ipc";
import { recordRpcHandler } from "@main/appControl/registry.js";
import { errText } from "@main/lib/ipcError.js";
import type { DocumentViewHost } from "@main/document/documentViewHost.js";

/** zod/业务错误 → 线上的人话结果。 */
function failed(err: unknown): DocViewResult {
  return { ok: false, reason: errText(err) };
}

export function registerDocumentViewHandlers(
  ipc: IpcMain,
  host: DocumentViewHost,
  /** 【ARC-007】路径围栏判据（生产传 `findContainingWorkspaceRoot` 那一份）。 */
  withinWorkspace: (p: string) => boolean,
): void {
  // IpcMain.handle 的监听器形参带类型化的 event；本模块的 handler 全都不读它，
  // 按 `(event: unknown, raw: unknown)` 声明即可结构兼容 recordRpcHandler。
  const onOpen = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      return host.open(DocViewOpenSchema.parse(raw));
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_OPEN, onOpen);
  ipc.handle(IPC.DOCUMENT_VIEW_OPEN, onOpen);

  const onBounds = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      const input = DocViewBoundsSchema.parse(raw);
      return host.setBounds(input.docId, input.bounds);
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_BOUNDS, onBounds);
  ipc.handle(IPC.DOCUMENT_VIEW_BOUNDS, onBounds);

  const onShow = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      return host.show(DocViewDocIdSchema.parse(raw).docId);
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_SHOW, onShow);
  ipc.handle(IPC.DOCUMENT_VIEW_SHOW, onShow);

  const onHide = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      return host.hide(DocViewDocIdSchema.parse(raw).docId);
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_HIDE, onHide);
  ipc.handle(IPC.DOCUMENT_VIEW_HIDE, onHide);

  const onFocus = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      return host.focus(DocViewDocIdSchema.parse(raw).docId);
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_FOCUS, onFocus);
  ipc.handle(IPC.DOCUMENT_VIEW_FOCUS, onFocus);

  const onClose = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      return host.close(DocViewCloseSchema.parse(raw).docId);
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_CLOSE, onClose);
  ipc.handle(IPC.DOCUMENT_VIEW_CLOSE, onClose);

  const onOpenPath = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      const input = DocViewOpenPathSchema.parse(raw);
      return host.openPath(input.docId, input.filePath, withinWorkspace);
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_OPEN_PATH, onOpenPath);
  ipc.handle(IPC.DOCUMENT_VIEW_OPEN_PATH, onOpenPath);

  // 只读诊断：返回状态快照（没有会失败的路径，不带 ok 信封）。
  const onList = (): DocViewListResult => ({ views: host.list() });
  recordRpcHandler(IPC.DOCUMENT_VIEW_LIST, onList);
  ipc.handle(IPC.DOCUMENT_VIEW_LIST, onList);

  /**
   * 【ARC-007】**视图 preload 的内部通道** —— 页面请求打开某个文档。
   *
   * 为什么不是第八条 `documentView.*` RPC：它只由我们注入的 preload 调用，
   * 渲染端/Agent 都不该有这个入口。挂成 RPC 等于把"让页面读任意工作区内文件"
   * 的能力开给 Agent —— 那是扩大能力面，不是补桥。
   *
   * `withinWorkspace` 由生产装配注入（`findContainingWorkspaceRoot` 那一份判据），
   * **不在这里另写一套路径判断**（README 硬规矩 2）。
   */
  ipc.handle("mcode:document-view:open-path", async (evt: unknown, raw: unknown) => {
    try {
      const input = raw as { filePath?: unknown };
      const filePath = typeof input?.filePath === "string" ? input.filePath : "";
      // 【ARC-007】**身份由宿主反查，页面说了不算**：从 `event.sender` 找到是哪个
      // WebContents 在请求，再映射回 docId。页面改自己的 URL/参数都影响不到这一步 ——
      // 否则"页面能改 docId"就等于"页面能把 A 视图的打开请求算到 B 头上"。
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const docId = host.docIdForSender(sender);
      if (docId === null) return { ok: false, reason: "这个请求不是来自任何文档视图" };
      return host.openPath(docId, filePath, withinWorkspace);
    } catch (err) {
      return failed(err);
    }
  });

  /**
   * 【ARC-007】**视图 preload 的内部保存通道** —— 页面把编辑后的字节写回
   * **它自己打开的那份文件**。
   *
   * 与 open-path 同一条纪律：不进 RpcMap（渲染端/Agent 都不该有这个入口），
   * 身份从 `event.sender` 反查。页面只递字节，**不递路径** —— 目标路径由宿主
   * 从 `openedFilePath` 取，页面没有"另存到别处"的表达能力。
   *
   * 字节在 Electron 里经结构化克隆过来是 `Uint8Array`（或 Node `Buffer`，
   * 两者都是 Uint8Array 的子类）；其它形状一律拒绝，不尝试"猜一个转换"。
   */
  ipc.handle("mcode:document-view:save", async (evt: unknown, raw: unknown) => {
    try {
      const input = raw as { bytes?: unknown } | null;
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const docId = host.docIdForSender(sender);
      if (docId === null) return { ok: false, reason: "这个请求不是来自任何文档视图" };
      if (!(input?.bytes instanceof Uint8Array)) {
        return { ok: false, reason: "保存内容不是字节数组" };
      }
      return await host.saveOpenedFile(docId, input.bytes, withinWorkspace);
    } catch (err) {
      return failed(err);
    }
  });

}
