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
  DocViewSlidesAddSlideSchema,
  DocViewSlidesEditTextSchema,
  type DocViewListResult,
  type DocViewResult,
  type DocViewSlidesResult,
} from "@contracts/ipc";
import { recordRpcHandler } from "@main/appControl/registry.js";
import { errText } from "@main/lib/ipcError.js";
import type { DocumentViewHost } from "@main/document/documentViewHost.js";
import type { SlidesBridge } from "@main/document/slidesBridge.js";
import { slidesBridge as productionSlidesBridge } from "@main/document/slidesBridge.js";

/** zod/业务错误 → 线上的人话结果。 */
function failed(err: unknown): DocViewResult {
  return { ok: false, reason: errText(err) };
}

/** slides 编辑通道的失败包装（同一取向：失败永远落在 `{ok:false, reason}`）。 */
function slidesFailed(err: unknown): DocViewSlidesResult {
  return { ok: false, reason: errText(err) };
}

export function registerDocumentViewHandlers(
  ipc: IpcMain,
  host: DocumentViewHost,
  /** 【ARC-007】路径围栏判据（生产传 `findContainingWorkspaceRoot` 那一份）。 */
  withinWorkspace: (p: string) => boolean,
  /** 【ARC-007】slides 编辑桥（A 方案第一步）。省略 = 生产单例（默认未装配，
   *  所有调用 fail-closed）；无头套件注入假执行器验证转发与身份。 */
  slides: SlidesBridge = productionSlidesBridge,
): void {
  /**
   * 【ARC-007 P0】**页面拉取已准备好的打开响应** —— vendor `openDocxPath` 的
   * 宿主对端。返回与 vendor `OpenDocxResult` 同形状的对象（含一次性
   * `dataUrl` 与 sha256）。**不提交会话**：见 `settlePendingOpen`。
   */
  const onReadOpened = async (evt: unknown, raw: unknown) => {
    try {
      const input = raw as { docId?: unknown } | null;
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const resolved = host.docIdForSender(sender);
      if (resolved === null) return { ok: false, reason: "这个请求不是来自任何文档视图" };
      if (typeof input?.docId === "string" && input.docId !== "" && input.docId !== resolved) {
        return {
          ok: false,
          reason: `docId 与发送方不一致（声明 ${input.docId}，实际 ${resolved}）—— 拒绝操作`,
        };
      }
      return await host.readOpened(resolved, withinWorkspace);
    } catch (err) {
      return { ok: false, reason: errText(err) };
    }
  };
  // 内部通道（与 open-path/save 同形态；字面量注册的原因见下）。
  ipc.handle("mcode:document-view:read-opened", onReadOpened);

  /**
   * 【ARC-007 P0】**页面回执**：vendor 页面成功打开后会调 `getRecentFiles()`
   * （成功路径唯一必经调用）；preload 在此回执 `openPathCommitted`。只有回执才
   * 把待开请求提交成会话（`settlePendingOpen(true)`）—— 失败的打开不占会话、
   * 不改 CAS 基准。
   */
  const onOpenCommitted = async (evt: unknown, raw: unknown) => {
    try {
      const input = raw as { docId?: unknown; accepted?: unknown } | null;
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const resolved = host.docIdForSender(sender);
      if (resolved === null) return { ok: false, reason: "这个请求不是来自任何文档视图" };
      if (typeof input?.docId === "string" && input.docId !== "" && input.docId !== resolved) {
        return {
          ok: false,
          reason: `docId 与发送方不一致（声明 ${input.docId}，实际 ${resolved}）—— 拒绝操作`,
        };
      }
      return host.settlePendingOpen(resolved, input?.accepted !== false, withinWorkspace);
    } catch (err) {
      return { ok: false, reason: errText(err) };
    }
  };
  ipc.handle("mcode:document-view:open-committed", onOpenCommitted);

  /**
   * 【ARC-007 P0】**页面替换守卫**：vendor `confirmDocumentReplace()` 的宿主对端。
   * 真实 dirty 来自页面经 `reportCloseCheck` 的上报（`close-check-result` 通道）。
   * 生产在装配期注入 `confirmDirty`（真人确认）；未注入时脏状态 fail-closed。
   */
  const onConfirmReplace = async (evt: unknown) => {
    try {
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const resolved = host.docIdForSender(sender);
      if (resolved === null) return false;
      return await host.confirmDocumentReplace(resolved);
    } catch {
      return false;
    }
  };
  ipc.handle("mcode:document-view:confirm-replace", onConfirmReplace);

  /**
   * 【ARC-007 P0】页面上报 dirty —— vendor `reportCloseCheck`（preload:263）的
   * 对端。形状与 vendor 一致：`{ dirty, autoSave?, filePath? }`；只取 `dirty`。
   */
  const onCloseCheckResult = (evt: unknown, raw: unknown): void => {
    try {
      const input = raw as { dirty?: unknown } | null;
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const resolved = host.docIdForSender(sender);
      if (resolved === null) return;
      host.reportPageDirty(resolved, input?.dirty === true);
    } catch {
      /* 上报是 best-effort；坏形状忽略 */
    }
  };
  ipc.handle("mcode:document-view:close-check-result", onCloseCheckResult);

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
   * 【ARC-007】slides 编辑（A 方案第一步）：`documentView.slidesAddSlide`。
   *
   * **身份**：与 open/save 同一条纪律 —— 页面声明的 `docId` 必须与宿主从
   * `event.sender` 反查的结果**一致**；不一致直接拒（不拿 sender 的结果悄悄
   * 顶替，否则调用方以为自己操作的是 A 视图，实际改了 B）。
   *
   * **执行**：经注入的 `SlidesBridge` 转发到 vendor 主进程同一份 handler
   * （`slides:add-blank-slide`）。桥未装配 = `ok:false` + 点名原因，绝不假装成功。
   */
  const onSlidesAddSlide = async (evt: unknown, raw: unknown): Promise<DocViewSlidesResult> => {
    try {
      const input = DocViewSlidesAddSlideSchema.parse(raw);
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const resolved = host.docIdForSender(sender);
      if (resolved === null) return { ok: false, reason: "这个请求不是来自任何文档视图" };
      if (resolved !== input.docId) {
        return {
          ok: false,
          reason: `docId 与发送方不一致（声明 ${input.docId}，实际 ${resolved}）—— 拒绝操作`,
        };
      }
      const wc = host.webContentsOf(resolved) as unknown as { id?: unknown } | null;
      const webContentsId = wc && typeof wc.id === "number" ? wc.id : null;
      if (webContentsId === null) {
        return { ok: false, reason: "当前视图没有 webContents id，无法定位 slides 会话" };
      }
      return await slides.addSlide(webContentsId, resolved);
    } catch (err) {
      return slidesFailed(err);
    }
  };
  // 内部通道（与 `mcode:document-view:save` 同形态，字面量注册——ipc-parity 的
  // 解析器只认 `IPC.*` 与从契约模块 import 的常量）。字符串与契约
  // `DOCUMENT_VIEW_SLIDES_ADD_SLIDE_CHANNEL` 必须一致（documentView 契约文件是
  // 唯一形状来源；两边漂移由 ipc-wiring 的内部通道断言发现）。
  ipc.handle("mcode:document-view:slides-add-slide", onSlidesAddSlide);

  /** 【ARC-007】slides 编辑：`documentView.slidesEditText`。身份/执行同上。 */
  const onSlidesEditText = async (evt: unknown, raw: unknown): Promise<DocViewSlidesResult> => {
    try {
      const input = DocViewSlidesEditTextSchema.parse(raw);
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const resolved = host.docIdForSender(sender);
      if (resolved === null) return { ok: false, reason: "这个请求不是来自任何文档视图" };
      if (resolved !== input.docId) {
        return {
          ok: false,
          reason: `docId 与发送方不一致（声明 ${input.docId}，实际 ${resolved}）—— 拒绝操作`,
        };
      }
      const wc = host.webContentsOf(resolved) as unknown as { id?: unknown } | null;
      const webContentsId = wc && typeof wc.id === "number" ? wc.id : null;
      if (webContentsId === null) {
        return { ok: false, reason: "当前视图没有 webContents id，无法定位 slides 会话" };
      }
      return await slides.editText(webContentsId, resolved, input.slideIndex, input.elementId, input.text);
    } catch (err) {
      return slidesFailed(err);
    }
  };
  ipc.handle("mcode:document-view:slides-edit-text", onSlidesEditText);

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
   *
   * ## 冲突回包为什么带 `error`
   *
   * vendor 编辑器保存失败时读的是 `result.error`（`file-actions.ts` 的
   * `ctx.setStatus(t('appSaveFailed', { error: result.error ?? '' }))`），
   * 而不是我们的 `message` 字段。宿主的冲突结果带 `message`；这里把它映射成
   * `error`，页面才会在状态栏/提示里显示真正的原因，而不是一条空白错误。
   * `reason:"conflict"` 与 `currentRevision` 原样保留 —— 页面将来要携带
   * revision 时直接可用（vendor 当前的 `saveDocx(path, data, auto)` 不带版本）。
   */
  ipc.handle("mcode:document-view:save", async (evt: unknown, raw: unknown) => {
    try {
      const input = raw as {
        bytes?: unknown;
        expectedRevision?: unknown;
        newDocument?: unknown;
        defaultName?: unknown;
      } | null;
      const sender = (evt as { sender?: unknown } | null)?.sender;
      const docId = host.docIdForSender(sender);
      if (docId === null) return { ok: false, reason: "这个请求不是来自任何文档视图" };
      if (!(input?.bytes instanceof Uint8Array)) {
        return { ok: false, reason: "保存内容不是字节数组" };
      }
      /**
       * 【ARC-007】`newDocument: true` —— vendor `saveDocxNew(defaultName, data)`
       * （shared/ipc.ts:472-481，file-actions.ts:1101）的首次保存。
       *
       * 页面只传**文件名建议**与字节（vendor 语义本来就不传路径）。宿主把它当
       * 「落在这个视图已打开文档所在目录里的一个新文件」：目录来自
       * `openedFilePath`，文件名由宿主清洗 + 随机后缀保证不覆盖，路径从不回传到
       * 页面（页面后续保存只走 `saveDocx`，宿主认 `openedFilePath`）。`defaultName`
       * 非字符串按空名处理（宿主给 `untitled`）—— 不因一个坏字段拒绝一次合法保存。
       */
      if (input.newDocument === true) {
        const defaultName = typeof input.defaultName === "string" ? input.defaultName : "";
        const created = await host.saveNewFile(docId, input.bytes, withinWorkspace, defaultName);
        if (!created.ok) {
          // vendor 的 saveDocxNew 读 `result.error` 显示失败（file-actions.ts:1102-1107）。
          return { ok: false, error: created.reason };
        }
        return { ok: true, path: created.filePath, bytes: created.bytes };
      }
      // 留位：当前 vendor preload 不发送版本；若将来页面携带（或宿主内部直接调用），
      // 字符串形态原样交给宿主作为 expected。非字符串一律忽略（不猜转换）。
      const expected = typeof input.expectedRevision === "string" ? input.expectedRevision : undefined;
      const result = await host.saveOpenedFile(docId, input.bytes, withinWorkspace, expected);
      if (!result.ok && result.reason === "conflict") {
        return {
          ok: false,
          reason: "conflict",
          error: result.message,
          currentRevision: result.currentRevision,
        };
      }
      return result;
    } catch (err) {
      return failed(err);
    }
  });

}
