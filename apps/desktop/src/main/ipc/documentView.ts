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
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
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
  type DocViewDormantListResult,
  type DocViewResult,
  type DocViewSlidesResult,
  type DocViewOpenInput,
  DocViewRevisionStateSchema,
  DocViewRevisionDecideSchema,
  DocViewRevisionModeSchema,
  DocViewCommentMutateSchema,
  DocViewCommentCreateSchema,
  DocViewHistoryListSchema,
  DocViewRevisionFocusSchema,
  DocViewRevisionRewriteSchema,
  DocViewHistoryRestoreSchema,
  type DocViewHistoryListResult,
  type DocViewHistoryRestoreResult,
  type DocViewRevisionRewriteResult,
  type DocRevisionState,
  type DocRevisionAuthor,
  type DocViewRevisionResult,
} from "@contracts/ipc";
import { revisionSessions } from "@main/document/revisionSessions.js";
import { recordDocumentVersion, listDocumentVersions, restoreDocumentVersion } from "@main/document/documentHistory.js";
import { notifyDocumentMutation } from "@main/document/documentMutationNotifier.js";
import { VENDOR_PAGE_CHANNELS } from "@main/document/documentViewHost.js";
import { rendererToolDispatch } from "@main/document/rendererToolDispatch.js";
import type { PendingChange, RevisionAnchor } from "@main/document/pendingChanges.js";
import { physicalPath } from "@main/lib/realPathWithin.js";

/** 修订会话按**物理路径**为键：`D:\WS\a.docx` 与 `d:/ws/a.docx` 必须是同一个会话，
 *  否则左栏只显示一半改动。归一化失败时退回原串（仍然可用，只是不折叠别名）。 */
const normalizePath = (filePath: string): string => physicalPath(filePath) ?? filePath;

/**
 * 页面报上来的锚点**形状校验 + 收窄**成 `RevisionAnchor`。
 *
 * 宿主不认识各家锚点的语义（`block`/`cell`/`element`/`page`/`range`），但必须
 * 拒绝明显不是锚点的东西 —— 否则左栏跳转时会拿到一个结构错误的输入，
 * 而"跳到错地方"比"不跳"更让人困惑。
 *
 * 这里的返回类型是 `RevisionAnchor | null`（不是布尔）：调用方需要的是
 * **收窄后的对象**，用 `boolean` 会让类型断言跑回来。
 */
function narrowRevisionAnchor(value: unknown): RevisionAnchor | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const anchor = value as Record<string, unknown>;
  switch (anchor["kind"]) {
    case "block":
      return typeof anchor["block"] === "number"
        ? { kind: "block", block: anchor["block"] } : null;
    case "cell":
      return typeof anchor["sheet"] === "string" && typeof anchor["address"] === "string"
        ? { kind: "cell", sheet: anchor["sheet"], address: anchor["address"] } : null;
    case "element":
      return typeof anchor["slide"] === "number" && typeof anchor["elementId"] === "string"
        ? { kind: "element", slide: anchor["slide"], elementId: anchor["elementId"] } : null;
    case "page":
      return typeof anchor["page"] === "number"
        ? {
            kind: "page",
            page: anchor["page"],
            ...(typeof anchor["text"] === "string" ? { text: anchor["text"] } : {}),
          }
        : null;
    case "range":
      return typeof anchor["from"] === "number" && typeof anchor["to"] === "number"
        ? { kind: "range", from: anchor["from"], to: anchor["to"] } : null;
    case "unknown":
      return { kind: "unknown" };
    default:
      return null;
  }
}
import { recordRpcHandler } from "@main/appControl/registry.js";
import { errText } from "@main/lib/ipcError.js";
import { log } from "@main/lib/logger.js";
import { dataRoot } from "@main/lib/dataRoot.js";
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

/** 【ARC-007 P1/GA1】slides 渲染树的宽度（vendor 的 `FIT_WIDTH`，`App.tsx` 固定
 *  1280）。放这里而不是让页面传：页面给的数字会决定服务端渲染树几何，宿主只认
 *  自己的常量（与 docs 的保存通道同一取向：页面不参与决策）。 */
const SLIDES_FIT_WIDTH_PX = 1280;

/** FULL-1: The renderer does NOT select what HTML receives the privileged
 * GenOffice preload. Derive the one original vendor editor from the same
 * canonical CLI path used by document.capabilities (L1 native app assets).
 * Workflow pages instead require an engine identity, then the existing
 * DocumentViewCredentialBroker checks the actual bound localhost port/token.
 * Never infer trust merely from a file:// scheme or loopback hostname. */
export function isApprovedDocumentViewOpen(input: DocViewOpenInput, cliPath: string | null): boolean {
  let url: URL;
  try { url = new URL(input.url); }
  catch { return false; }
  if (input.workflowEngineId) {
    // The Host will still verify loopback and the broker's live engine/port.
    return input.editor === undefined &&
      (url.protocol === "http:" || url.protocol === "https:");
  }
  if (input.url.trim() !== input.url || /[\u0000-\u001f\u007f]/.test(input.url)) return false;
  if (url.username || url.password || cliPath === null) return false;
  const editor = input.editor === "slides" || input.editor === "sheets" || input.editor === "pdf" || input.editor === "markdown" || input.editor === "html" ? input.editor : "docs";
  const vendor = editor === "sheets" || editor === "pdf" || editor === "markdown" || editor === "html" ||
    (editor === "slides" && input.url === "genoffice-app://slides/index.html");
  if (vendor !== (input.filePath !== undefined)) return false;
  if (vendor) return url.href === `genoffice-app://${editor}/index.html`;
  if (url.protocol !== "file:") return false;
  const native = cliPath.replace(/\\/g, "/");
  let root: string;
  if (native.endsWith("/genoffice/packages/cli/dist/genoffice.cjs")) {
    root = dirname(dirname(dirname(dirname(cliPath))));
  } else if (native.endsWith("/genoffice/cli/genoffice.cjs")) {
    root = dirname(dirname(cliPath));
  } else {
    return false;
  }
  const allowed = pathToFileURL(join(root, "apps", editor, "out", "renderer", "index.html")).href;
  // Paths with query tricks, fragment routing or a mismatched editor type
  // cannot be elevated to a privileged Mcode WebContentsView.
  return url.href === allowed + "?mode=tab";
}

export function registerDocumentViewHandlers(
  ipc: IpcMain,
  host: DocumentViewHost,
  /** 【ARC-007】路径围栏判据（生产传 `findContainingWorkspaceRoot` 那一份）。 */
  withinWorkspace: (p: string) => boolean,
  /** 【ARC-007】slides 编辑桥（A 方案第一步）。省略 = 生产单例（默认未装配，
   *  所有调用 fail-closed）；无头套件注入假执行器验证转发与身份。 */
  slides: SlidesBridge = productionSlidesBridge,
  /** Production must supply a Host-derived native-editor URL/engine policy.
   * No callback is a hard deny, never implicit permission. */
  authorizeOpen: (input: DocViewOpenInput) => boolean = () => false,
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

  // Recovery is a separate, sender-bound binary cache, never a path-selected
  // filesystem write. The trusted Host validates the active DOCX session.
  ipc.handle("mcode:document-view:write-recovery", async (evt: unknown, raw: unknown) => {
    try {
      const docId = host.docIdForSender((evt as { sender?: unknown } | null)?.sender);
      if (docId === null || !raw || typeof raw !== "object") return { ok: false, reason: "无权访问恢复会话" };
      const data = raw as { path?: unknown; bytes?: unknown };
      return await host.writeRecoveryCopy(docId, data.path, data.bytes);
    } catch (error) { return { ok: false, reason: errText(error) }; }
  });

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
  // Native and legacy Docs preloads use ipcRenderer.send, not invoke.
  // Keep the invoke endpoint for deterministic fake-Ipc callers; both use
  // the exact same sender-bound state handler, never parallel dirty logic.
  ipc.handle("mcode:document-view:close-check-result", onCloseCheckResult);
  // 【O4】**缺 on 不许静默降级。** `on` 是页面回报「脏不脏」的唯一入口：
  // 生产装配传的是 `createDbGuardedIpc(ipcMain)`，它曾经只实现 `handle`（类型却写
  // `IpcMain`），于是这一行在真实装配里**恒假**——页面的回答落在无人监听的通道上，
  // `closeWithDirtyProtection` 等 2 秒超时后按 fail-closed 拒绝关闭，用户看到的是
  // 「编辑器未响应关闭检查」，而原因离这句提示很远（O3 实证：页面确实回了）。
  //
  // 所以这里不再 `if (typeof ipc.on === 'function')` 悄悄跳过，而是**喊出来**：
  // 保留 `handle` 那条（invoke 式调用方仍可用），但监听注册缺失必须带**后果**写进
  // 日志 —— 下一个人看到的主进程日志要能直接指回这里。包装层的 `on` 已在
  // `dbGuardedIpc.ts` 补齐（同一张卡），这条日志是给**下一个残缺包装**留的。
  if (typeof ipc.on === "function") {
    ipc.on("mcode:document-view:close-check-result", onCloseCheckResult);
  } else {
    log.error(
      "文档视图注册器收到的 ipc 缺少 on()：mcode:document-view:close-check-result 没有监听者。" +
        "后果：关闭 docs 文档会等 2 秒超时后被拒（「编辑器未响应关闭检查；为保护未保存内容，拒绝关闭」），" +
        "即使编辑器页面已经回了关闭检查。装配方必须传入实现了 on 的 IpcMain" +
        "（生产用 createDbGuardedIpc(ipcMain)，它自 O4 起实现了完整注册面）。",
    );
  }

  /* ─────────── 【Office 深度集成】修订：页面 → 宿主的上报 ───────────
   *
   * 页面（docs 的 revision-bridge）把当前修订列表推上来，宿主存进
   * `revisionSessions`，左栏从 `revisionState` 读。
   *
   * **身份**：与其他页面通道同一条纪律 —— docId 由宿主从 `event.sender` 反查，
   * 页面不能自报"我是哪个文档"。反查不到的上报直接丢弃（视图已关/不是我们的页面）。
   */
  const onRevisionReport = (event: unknown, raw: unknown): void => {
    const sender = (event as { sender?: unknown } | null)?.sender;
    const docId = sender === undefined ? null : host.docIdForSender(sender);
    if (docId === null) return;
    const rawPath = host.pathOfDocId(docId);
    if (rawPath === null) return;
    /* ⚠️ **必须归一化**，和其余每一条修订通道用同一个键。
     *
     * `physicalPath` 会改变字符串形式（Windows 上大小写、盘符、8.3 短名），
     * 而 `stateOf` / `setMode` / `decide` 全都用 `normalizePath(input.filePath)`
     * 去查。这里若用 `pathOfDocId` 的**原样**路径建会话，两边就是两个键：
     *   - 上报把改动写进 "C:\\...\\a.docx"
     *   - 左栏去读       "c:\\...\\a.docx"
     * **后果是左栏永远是空的**，而链路上没有任何一步报错 —— 这是「同一份数据
     * 用两个键存」的经典形态，症状表现为「功能没做」，修起来却只是加一次归一化。 */
    const filePath = normalizePath(rawPath);
    const payload = raw as { changes?: unknown } | null;
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.changes)) return;
    const editor = host.editorOf(docId);
    if (editor === null) return;
    // 默认 **edit**：人打开文档就是直接改。复核模式要显式切（AI 走工具层，
    // 不受这个值控制 —— 它的 track 由 AiPanel 自己的开关决定）。
    revisionSessions.ensure(filePath, editor, revisionSessions.modeOf(filePath) ?? "edit");
    revisionSessions.syncFromEditor(filePath, payload.changes.map((entry) => {
      const change = entry as Record<string, unknown>;
      const location = (change["location"] ?? {}) as Record<string, unknown>;
      const author = (change["author"] ?? {}) as Record<string, unknown>;
      const anchorRaw = change["anchor"];
      return {
        id: String(change["id"] ?? ""),
        editor,
        filePath,
        location: {
          order: typeof location["order"] === "number" ? location["order"] : 0,
          label: typeof location["label"] === "string" ? location["label"] : "",
          // 锚点原样透传：**左栏点条目要跳到正文那一处**，而位置只有页面知道。
          // 宿主不认识各家锚点的细节（block/cell/element/page/range），
          // 所以只做形状校验后原样存 —— 猜错形状比不存更坏（跳转到错地方）。
          ...(narrowRevisionAnchor(anchorRaw) !== null ? { anchor: narrowRevisionAnchor(anchorRaw)! } : {}),
        },
        kind: (change["kind"] as PendingChange["kind"]) ?? "replace",
        ...(typeof change["before"] === "string" ? { before: change["before"] } : {}),
        ...(typeof change["after"] === "string" ? { after: change["after"] } : {}),
        author: {
          id: typeof author["id"] === "string" ? author["id"] : "user",
          label: typeof author["label"] === "string" ? author["label"] : "我",
        },
        at: typeof change["at"] === "number" ? change["at"] : Date.now(),
      };
    }));
  };
  ipc.handle("mcode:document-view:revision-report", onRevisionReport);
  if (typeof ipc.on === "function") ipc.on("mcode:document-view:revision-report", onRevisionReport);


  /* ─────────── 页面回执：等它，别假定它 ───────────
   *
   * 【EDIT-06 修复】**`sendToEditor` 返回 true 只说明消息进了队列，不说明页面做了事。**
   * 页面收到 `revision-command` 后会回一条 `revision-decide-result`
   * （`{nonce, ok, applied?, reason?}`），这里的表就是等那条回执的地方。
   *
   * ## 为什么必须有它
   *
   * 修复前 `setDecider` 只要 `sendToEditor` 成功就回 `ok: true`，接着
   * `revisionSessions.decide` 会把条目从缓存里摘掉。于是：页面通道死了 / 页面不认识
   * 这条命令 / 页面拒绝执行（选区为空、id 对不上）—— 三种情况用户看到的都是
   * **「处理成功了」而正文一个字没变**。这正是 `revisionSessions` 文件头警告过的那种
   * 最坏的不一致（"左栏显示处理完了而正文没变"），而它是在**发送侧**发生的。
   *
   * ## 超时时也失败，不是"当它成功"
   *
   * 2 秒。取这个值的依据与 `closeWithDirtyProtection` 同一条：页面处理一次
   * accept/reject 是同步遍历文档结构，正常在毫秒级；2 秒不回来说明页面已经不响应了。
   * 超时回 `ok: false` —— 宁可让用户再点一次，也不要静默丢改动。
   */
  /**
   * 页面回执的形状。`selectedText` 只有 `action: "read-selection"` 会填
   * （见 `onRevisionRewrite`）—— 其余命令不回文字，所以它是可选的。
   */
  interface RevisionReply {
    ok: boolean;
    applied?: number;
    reason?: string;
    selectedText?: string;
  }
  interface PendingRevisionReply {
    resolve(reply: RevisionReply): void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pendingRevisionReplies = new Map<string, PendingRevisionReply>();
  const REVISION_REPLY_TIMEOUT_MS = 2_000;

  /**
   * 发一条命令并**等页面回执**。
   *
   * `nonce` 由调用方给（它要能把回执对回来）；通道发不出去时立刻失败。
   */
  const sendAndAwaitRevision = (
    docId: string,
    message: Record<string, unknown>,
  ): Promise<RevisionReply> => {
    const nonce = typeof message["nonce"] === "string" ? message["nonce"] : null;
    if (nonce === null) return Promise.resolve({ ok: false, reason: "命令没有 nonce，无法配对回执" });
    const sent = host.sendToEditor(docId, "mcode:document-view:revision-command", message);
    if (!sent) return Promise.resolve({ ok: false, reason: "编辑器没有接收命令的通道" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRevisionReplies.delete(nonce);
        resolve({
          ok: false,
          reason: "编辑器没有回应这条命令（2 秒超时）。改动可能没有生效 —— 请重试一次。",
        });
      }, REVISION_REPLY_TIMEOUT_MS);
      pendingRevisionReplies.set(nonce, { resolve, timer });
    });
  };

  /** 页面回了 `revision-decide-result` → 唤醒等它的那个 Promise。 */
  const onRevisionDecisionResult = (_evt: unknown, raw: unknown): void => {
    const payload = raw as
      | { nonce?: unknown; ok?: unknown; applied?: unknown; reason?: unknown; selectedText?: unknown }
      | null;
    if (payload === null || typeof payload !== "object") return;
    const nonce = typeof payload["nonce"] === "string" ? payload["nonce"] : null;
    if (nonce === null) return;
    const waiter = pendingRevisionReplies.get(nonce);
    if (waiter === undefined) return; // 迟到的回执（已超时）—— 丢弃，不重复 resolve
    clearTimeout(waiter.timer);
    pendingRevisionReplies.delete(nonce);
    waiter.resolve({
      ok: payload["ok"] === true,
      ...(typeof payload["applied"] === "number" ? { applied: payload["applied"] } : {}),
      ...(typeof payload["reason"] === "string" ? { reason: payload["reason"] } : {}),
      ...(typeof payload["selectedText"] === "string" ? { selectedText: payload["selectedText"] } : {}),
    });
  };
  ipc.handle("mcode:document-view:revision-decide-result", onRevisionDecisionResult);
  if (typeof ipc.on === "function") {
    ipc.on("mcode:document-view:revision-decide-result", onRevisionDecisionResult);
  } else {
    // 与 close-check-result 同一条纪律：缺 `on` 不许静默降级 —— 只是这次的后果
    // 换成了「每次接受/拒绝都等满 2 秒然后报超时」，不是数据损坏。
    log.error(
      "文档视图注册器收到的 ipc 缺少 on()：页面回的 revision-decide-result 没有监听者。" +
        "后果：接受/拒绝修订一律在 2 秒后报「编辑器没有回应」，即使页面已经执行了。",
    );
  }

  /* 宿主 → 页面的接受/拒绝命令：按 docId 找到那个 webContents 发过去，**并等回执**。 */
  revisionSessions.setDecider(async ({ filePath, action, ids }) => {
    const docId = host.docIdForOpenPath(filePath);
    if (docId === null) return { ok: false, reason: "这个文档没有打开在编辑器里" };
    const reply = await sendAndAwaitRevision(docId, {
      nonce: `${docId}:${action}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      action,
      ids,
    });
    if (!reply.ok) {
      // 页面的原话优先（它知道为什么拒绝：选区为空 / id 已经不在）；没给原因时用兜底。
      return { ok: false, reason: reply.reason ?? "编辑器没有执行这条命令" };
    }
    return { ok: true };
  });

  // IpcMain.handle 的监听器形参带类型化的 event；本模块的 handler 全都不读它，
  // 按 `(event: unknown, raw: unknown)` 声明即可结构兼容 recordRpcHandler。
  const onOpen = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      const input = DocViewOpenSchema.parse(raw);
      if (!authorizeOpen(input)) {
        return { ok: false, reason: "文档视图 URL 未匹配已安装的原厂编辑器或受信工作流引擎" };
      }
      if (input.filePath !== undefined && !withinWorkspace(input.filePath))
        return { ok: false, reason: "原厂视图拒绝打开工作区以外的路径" };
      return host.open(input);
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
      return await host.closeWithDirtyProtection(DocViewCloseSchema.parse(raw).docId);
    } catch (err) {
      return failed(err);
    }
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_CLOSE, onClose);
  ipc.handle(IPC.DOCUMENT_VIEW_CLOSE, onClose);

  const onOpenPath = async (_evt: unknown, raw: unknown): Promise<DocViewResult> => {
    try {
      const input = DocViewOpenPathSchema.parse(raw);
      // 【ARC-007 P1/GA1】slides 视图的 openPath 走**两条链**（见 `prepareSlidesOpen`）：
      // 宿主准备待打开并**立即**让注入的执行器解析（vendor 同一份代码）；解析成功
      // 推送 `slides:opened`，页面挂载/通知后拉取。失败 = 不登记待打开（不占会话）。
      if (host.editorOf(input.docId) === "slides") {
        const prepared = host.prepareSlidesOpen(input.docId, input.filePath, withinWorkspace);
        if (!prepared.ok) return prepared;
        const wc = host.webContentsOf(input.docId) as unknown as { id?: unknown } | null;
        const webContentsId = wc && typeof wc.id === "number" ? wc.id : null;
        if (webContentsId === null) {
          host.settleSlidesOpen(input.docId, null, false, withinWorkspace);
          return { ok: false, reason: "当前视图没有 webContents id，无法定位 slides 会话" };
        }
        const opened = await slides.openDeck(webContentsId, input.docId, input.filePath, SLIDES_FIT_WIDTH_PX);
        if (!opened.ok) {
          host.settleSlidesOpen(input.docId, null, false, withinWorkspace);
          return { ok: false, reason: opened.reason };
        }
        // 缓存：页面挂载时的 `consumePendingOpen` 拉取直接拿这一份，不重复解析。
        host.cacheSlidesOpenResult(input.docId, opened.openResult, "");
        host.notifySlidesOpened(input.docId, opened.openResult);
        return { ok: true };
      }
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
   * 【Office 深度集成】可无损回收的后台视图。
   *
   * **只读**：返回的是「谁可以回收」+「回收前要存什么」，不销毁任何东西。
   * 销毁仍走既有 `documentView.close` —— 不新开第二条销毁通道（两个入口意味着
   * 两套关闭语义，而 close 已经要摘会话、退租约、撤销 handoff）。
   *
   * 顺序契约：调用方必须**先**存下这里的凭据，**再** close；反过来会丢掉重建
   * 所需的状态（尤其是 filePath 与 mcodeSessionId）。
   *
   * `excluded` 把"为什么没进候选"逐项计数报出来 —— 只有 candidates 为空而
   * excluded 也全 0 时，才说明确实没有后台视图，而不是判据把所有人都挡了。
   */
  const onDormantList = (): DocViewDormantListResult => {
    const now = Date.now();
    const candidates: DocViewDormantListResult["candidates"] = [];
    const excluded = { notVisible: 0, dirtyOrUnknown: 0, tooRecent: 0, noDocument: 0 };
    for (const view of host.list()) {
      if (view.visible) { excluded.notVisible += 1; continue; }
      const snapshot = host.dormantSnapshot(view.docId, now);
      if (snapshot === null) {
        // 拿不到可恢复快照 = 缺 filePath/URL，绝不能回收。
        excluded.noDocument += 1;
        continue;
      }
      candidates.push({
        docId: snapshot.docId,
        url: snapshot.url,
        editor: snapshot.editor,
        filePath: snapshot.filePath!,
        bounds: snapshot.bounds,
        mcodeSessionId: snapshot.mcodeSessionId,
        hiddenForMs: snapshot.hiddenAt === null ? 0 : Math.max(0, now - snapshot.hiddenAt),
      });
    }
    // 只保留宿主判定为"够久没显示且干净"的那些；其余计入具体原因。
    const reclaimable = new Set(host.dormancyCandidates(now));
    const kept = candidates.filter((candidate) => {
      if (reclaimable.has(candidate.docId)) return true;
      // 到这里说明宿主判据没选它：干净但太新，或有未保存编辑。
      excluded.tooRecent += 1;
      return false;
    });
    return { candidates: kept, excluded };
  };
  recordRpcHandler(IPC.DOCUMENT_VIEW_DORMANT_LIST, onDormantList);
  ipc.handle(IPC.DOCUMENT_VIEW_DORMANT_LIST, onDormantList);

  /* ─────────── 【Office 深度集成】修订与复核（Overleaf 式） ───────────
   *
   * 四条通道，全部以**文件路径**为键（与 `document_tool_call` 同一套寻址）：
   *   - `revisionState`  读：左栏的数据源；
   *   - `revisionDecide` 写：接受/拒绝，**派发回编辑器执行**，宿主不自己算 diff；
   *   - `revisionMode`   写：编辑 / 复核模式；
   *   - `commentMutate`  写：新增 / 编辑 / 回复 / resolve 评论。
   *
   * **为什么接受/拒绝要派发回编辑器**：修订的原文与新文住在编辑器里
   * （docs 是 ProseMirror 的 ins/del Mark）。宿主要是自己算一遍应用，
   * 两边会分叉 —— 用户在编辑器里 undo 一次，宿主那份就错了。
   * 宿主只做两件事：把决定送到、把结果摘出缓存。
   */
  const onRevisionState = (raw: unknown): DocRevisionState | null => {
    const input = DocViewRevisionStateSchema.parse(raw);
    return revisionSessions.stateOf(normalizePath(input.filePath));
  };
  recordRpcHandler(IPC.DOC_VIEW_REVISION_STATE, onRevisionState);
  ipc.handle(IPC.DOC_VIEW_REVISION_STATE, onRevisionState);

  const onRevisionDecide = async (raw: unknown): Promise<DocViewRevisionResult> => {
    const input = DocViewRevisionDecideSchema.parse(raw);
    const filePath = normalizePath(input.filePath);
    const state = revisionSessions.stateOf(filePath);
    if (state === null) return { ok: false, reason: `这个文档没有修订会话：${input.filePath}` };
    // `ids` 为空 = 全部（批量按钮）。
    const targets = input.ids.length === 0 ? state.changes.map((change) => change.id) : input.ids;
    if (targets.length === 0) return { ok: true, state };
    try {
      const applied = await revisionSessions.decide(filePath, input.action, targets);
      if (!applied.ok) return { ok: false, reason: applied.reason };
      return { ok: true, state: revisionSessions.stateOf(filePath) ?? undefined };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };
  recordRpcHandler(IPC.DOC_VIEW_REVISION_DECIDE, onRevisionDecide);
  ipc.handle(IPC.DOC_VIEW_REVISION_DECIDE, onRevisionDecide);

  /* 模式切换**必须送到页面**，否则只是宿主里记了个值：
   *   - markdown 的修订是 Mcode 自己写的扩展，开关在页面里（`setMarkdownTracking`）；
   *   - docs 的修订是原厂 recorder，开关在 App 的 `trackChanges` state。
   * 两边都听 `revision-command` 的 `action: "mode"`。
   *
   * **新文档也要能切**（这是最容易漏的一条）：一份干净文档没有任何修订，
   * 页面不会上报，宿主也就没有会话 —— 但用户恰恰要在这种时候切到复核模式，
   * 好让自己接下来的修改被记录。所以先 `ensure` 再切，而不是要求会话已存在。 */
  const onRevisionMode = (raw: unknown): DocViewRevisionResult => {
    const input = DocViewRevisionModeSchema.parse(raw);
    const filePath = normalizePath(input.filePath);
    const docId = host.docIdForOpenPath(filePath);
    if (docId === null) return { ok: false, reason: `这个文档没有打开在编辑器里：${input.filePath}` };
    const editor = host.editorOf(docId);
    if (editor === null) return { ok: false, reason: `这个文档没有打开在编辑器里：${input.filePath}` };
    const sent = host.sendToEditor(docId, "mcode:document-view:revision-command", {
      nonce: `${docId}:mode:${Date.now()}`,
      action: "mode",
      ids: [],
      mode: input.mode,
      // 人按的按钮 → 作者是人。AI 的作者名由工具层自己带，不经过这里。
      author: "我",
    });
    // 送不到就别改宿主状态：宁可按钮弹回原样，也不要显示"复核中"而实际没记录。
    if (!sent) return { ok: false, reason: "编辑器没有接收命令的通道" };
    revisionSessions.ensure(filePath, editor, input.mode);
    revisionSessions.setMode(filePath, input.mode);
    return { ok: true, state: revisionSessions.stateOf(filePath) ?? undefined };
  };
  recordRpcHandler(IPC.DOC_VIEW_REVISION_MODE, onRevisionMode);
  ipc.handle(IPC.DOC_VIEW_REVISION_MODE, onRevisionMode);

  /* 页面回报：评论锚点已挂到文档上 —— 宿主这边建条目。
   *
   * **为什么由页面回执**：算锚点要看 ProseMirror 的选区与文档结构，宿主看不到。
   * 页面把 from/to 与段落标签报回来，宿主只负责"记下来"，不重算位置 ——
   * 与修订那条链同一个取向（编辑器是唯一事实源）。 */
  const onCommentCreated = (event: unknown, raw: unknown): void => {
    const sender = (event as { sender?: unknown } | null)?.sender;
    const docId = sender === undefined ? null : host.docIdForSender(sender);
    if (docId === null) return;
    const rawPath = host.pathOfDocId(docId);
    if (rawPath === null) return;
    // 与 `onRevisionReport` 同一条纪律：**这里也必须归一化**，否则评论条目会
    // 记在一个左栏查不到的键上（后果同样是"左栏永远空"，而且不报错）。
    const filePath = normalizePath(rawPath);
    const payload = raw as
      | { commentId?: unknown; anchor?: unknown; text?: unknown; location?: { order?: unknown; label?: unknown } }
      | null;
    if (payload === null || typeof payload !== "object") return;
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (text === "") return;
    const editor = host.editorOf(docId);
    if (editor === null) return;
    revisionSessions.ensure(filePath, editor, revisionSessions.modeOf(filePath) ?? "edit");
    const commentId = typeof payload.commentId === "string" && payload.commentId !== ""
      ? payload.commentId
      : `c-${Date.now()}`;
    revisionSessions.addComment({
      id: commentId,
      filePath,
      location: {
        order: typeof payload.location?.order === "number" ? payload.location.order : 0,
        label: typeof payload.location?.label === "string" ? payload.location.label : "",
      },
      author: { id: "user", label: "我" },
      text,
      at: Date.now(),
      replies: [],
      resolved: false,
    });
  };
  ipc.handle("mcode:document-view:revision-comment-created", onCommentCreated);
  if (typeof ipc.on === "function") ipc.on("mcode:document-view:revision-comment-created", onCommentCreated);

  /* 用户在左栏点"对选中文字加评论"：把文字发到页面，由页面挂锚点并回执。
   *
   * **失败一律报原因**，不静默返回 ok —— 否则用户以为评论建好了，左栏却没有条目。 */
  const onCommentCreate = (raw: unknown): DocViewRevisionResult => {
    const input = DocViewCommentCreateSchema.parse(raw);
    const filePath = normalizePath(input.filePath);
    const docId = host.docIdForOpenPath(filePath);
    if (docId === null) return { ok: false, reason: "这个文档没有打开在编辑器里" };
    const editor = host.editorOf(docId);
    if (editor === null) return { ok: false, reason: "这个文档没有打开在编辑器里" };
    const commentId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sent = host.sendToEditor(docId, "mcode:document-view:revision-command", {
      nonce: `${docId}:comment:${commentId}`,
      action: "comment",
      ids: [],
      text: input.text,
      commentId,
    });
    if (!sent) return { ok: false, reason: "编辑器没有接收命令的通道" };
    // 状态由页面的 `revision-comment-created` 回执推进（这里不预先建条目 ——
    // 选区为空时页面会拒绝，预建会留下一条挂不上去的评论）。
    revisionSessions.ensure(filePath, editor, revisionSessions.modeOf(filePath) ?? "edit");
    return { ok: true, state: revisionSessions.stateOf(filePath) ?? undefined };
  };
  recordRpcHandler(IPC.DOC_VIEW_COMMENT_CREATE, onCommentCreate);
  /* 【EDIT-09】文件历史：列出与回滚。
   *
   * 与修订那套的区别：历史是**磁盘上的字节**，与编辑器是否开着无关 ——
   * 所以这两个 handler 不经过 host，直接读数据根下的快照。
   *
   * 路径仍然要过工作区围栏：不让"读历史"变成读任意路径的跳板。 */
  const onHistoryList = async (raw: unknown): Promise<DocViewHistoryListResult> => {
    const input = DocViewHistoryListSchema.parse(raw);
    if (!withinWorkspace(input.filePath)) {
      return { ok: false, reason: "文件历史只对工作区内的文件开放" };
    }
    return listDocumentVersions({ filePath: physicalPath(input.filePath) ?? input.filePath, dataRoot: dataRoot() });
  };
  /* 【EDIT-06】左栏点条目 → 让编辑器滚到那一处。
   *
   * 锚点的**语义由页面解释**（block/cell/element/page/range 怎么换算成滚动位置，
   * 每种编辑器都不一样）。宿主只做三件事：反查 docId、把锚点原样转发、报失败。
   *
   * **不 fallback 到"只聚焦窗口"**：那会让用户以为跳成功了，而实际上什么都没动。
   * 页面不在 / 通道不通 → 明确报原因。 */
  const onRevisionFocus = (raw: unknown): DocViewRevisionResult => {
    const input = DocViewRevisionFocusSchema.parse(raw);
    const filePath = normalizePath(input.filePath);
    const docId = host.docIdForOpenPath(filePath);
    if (docId === null) return { ok: false, reason: "这个文档没有打开在编辑器里" };
    const sent = host.sendToEditor(docId, "mcode:document-view:revision-focus", {
      nonce: `${docId}:focus:${Date.now()}`,
      anchor: input.anchor,
    });
    if (!sent) return { ok: false, reason: "编辑器没有接收命令的通道" };
    return { ok: true };
  };
  /**
   * 【EDIT-08】取当前选区，交给 AI 改写。
   *
   * ## 为什么它不自己调模型
   *
   * 模型的调用与审批在**会话层**（Mcode 的对话），不在这里。这一层的职责只有一件：
   * 把「用户想改这段」变成**一段确定的文字 + 一句指令**，回给调用方（左栏）。
   *
   * ## 为什么回包里必须有选区文字
   *
   * 调用方（`RevisionPanel`）拿不到编辑器的选区 —— 只有页面有。如果这一层只回
   * `{ok:true}`，调用方就不知道用户到底选了哪段：它要么放弃（本次实现里的旧行为：
   * 拿到 ok 就清草稿，什么都没发生），要么自己猜一遍。**猜错的后果是「改写的是
   * 另一段」，而且用户看不出来** —— 所以这里**必须把选区带回来**，取不到就失败。
   *
   * ## 修复前它是什么样
   *
   * 它下发 `action: "rewrite"`，而**五家桥一条都不处理这个 action**（它们的联合类型
   * 里根本没有它）。页面静默丢掉，主进程只要 `sendToEditor` 成功就回 `ok: true`。
   * 于是点「交给 AI 改写」→ 面板显示成功、草稿被清空 → AI 从未被唤起。
   * 这是「发了命令就假定成功」的典型形态，与 `setDecider` 那条同一个病。
   */
  const onRevisionRewrite = async (raw: unknown): Promise<DocViewRevisionRewriteResult> => {
    const input = DocViewRevisionRewriteSchema.parse(raw);
    const filePath = normalizePath(input.filePath);
    const docId = host.docIdForOpenPath(filePath);
    if (docId === null) return { ok: false, reason: "这个文档没有打开在编辑器里" };
    /* 调用方给了选区就直接用（少一次往返）；没给就让页面取。
     * 页面取的那条也要**等回执** —— "已下发"不等于"取到了"。 */
    if (input.selectedText !== undefined && input.selectedText.trim() !== "") {
      return { ok: true, selectedText: input.selectedText };
    }
    const reply = await sendAndAwaitRevision(docId, {
      nonce: `${docId}:rewrite:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      action: "read-selection",
      ids: [],
      instruction: input.instruction,
    });
    if (!reply.ok) {
      return { ok: false, reason: reply.reason ?? "编辑器没有给出当前选区" };
    }
    const selected = reply.selectedText;
    if (typeof selected !== "string" || selected.trim() === "") {
      return { ok: false, reason: "编辑器回了选段请求，但没有给出文字（可能选区已经取消了）" };
    }
    return { ok: true, selectedText: selected };
  };
  recordRpcHandler(IPC.DOC_VIEW_REVISION_REWRITE, onRevisionRewrite);
  ipc.handle(IPC.DOC_VIEW_REVISION_REWRITE, onRevisionRewrite);

  recordRpcHandler(IPC.DOC_VIEW_REVISION_FOCUS, onRevisionFocus);
  ipc.handle(IPC.DOC_VIEW_REVISION_FOCUS, onRevisionFocus);

  recordRpcHandler(IPC.DOC_VIEW_HISTORY_LIST, onHistoryList);
  ipc.handle(IPC.DOC_VIEW_HISTORY_LIST, onHistoryList);

  const onHistoryRestore = async (raw: unknown): Promise<DocViewHistoryRestoreResult> => {
    const input = DocViewHistoryRestoreSchema.parse(raw);
    if (!withinWorkspace(input.filePath)) {
      return { ok: false, reason: "文件历史只对工作区内的文件开放" };
    }
    /* 回滚会**覆盖用户文件** —— 所以拒绝"这个文件正开在编辑器里且未保存"的情形：
     * 那样用户屏幕上是旧内容、磁盘是新内容，下一次保存会把回滚结果覆盖掉。 */
    const openDocId = host.docIdForOpenPath(input.filePath);
    if (openDocId !== null) {
      if (host.isDirtyOf(openDocId)) {
        return { ok: false, reason: "这个文档有未保存的修改，先保存或放弃修改再回滚" };
      }
    }
    const restored = await restoreDocumentVersion({
      filePath: physicalPath(input.filePath) ?? input.filePath,
      sha256: input.sha256,
      dataRoot: dataRoot(),
    });
    if (!restored.ok) return restored;
    /* 回滚改了磁盘 → 通知打开的视图重新读盘（否则编辑器里还是旧内容）。 */
    /* 回滚改了磁盘 → 走既有的"文档被外部改动"通知链，让开着的视图重新读盘。
     * 用 notifyDocumentMutation 而不是宿主的私有方法：那条链已经是
     * "磁盘写成功之后通知 UI"的唯一出口（documentMutationNotifier.ts 文件头）。 */
    void notifyDocumentMutation({
      filePath: physicalPath(input.filePath) ?? input.filePath,
      revision: null,
      source: "document-edit",
    });
    return { ok: true };
  };
  recordRpcHandler(IPC.DOC_VIEW_HISTORY_RESTORE, onHistoryRestore);
  ipc.handle(IPC.DOC_VIEW_HISTORY_RESTORE, onHistoryRestore);

  ipc.handle(IPC.DOC_VIEW_COMMENT_CREATE, onCommentCreate);

  const onCommentMutate = (raw: unknown): DocViewRevisionResult => {
    const input = DocViewCommentMutateSchema.parse(raw);
    const filePath = normalizePath(input.filePath);
    const state = revisionSessions.stateOf(filePath);
    if (state === null) return { ok: false, reason: `这个文档没有修订会话：${input.filePath}` };
    const me: DocRevisionAuthor = { id: "user", label: "我" };
    const now = Date.now();
    switch (input.op) {
      case "add":
        revisionSessions.addComment({
          id: `c-${now}-${Math.random().toString(36).slice(2, 8)}`,
          filePath,
          location: {
            order: input.location.order,
            label: input.location.label,
            ...(input.anchor !== undefined ? { anchor: { kind: "unknown" as const } } : {}),
          },
          author: me,
          text: input.text,
          at: now,
          replies: [],
          resolved: false,
        });
        break;
      case "edit":
        if (!revisionSessions.editComment(filePath, input.commentId, input.text)) {
          return { ok: false, reason: `找不到这条评论：${input.commentId}` };
        }
        break;
      case "reply":
        if (!revisionSessions.replyToComment(filePath, input.commentId, {
          id: `r-${now}-${Math.random().toString(36).slice(2, 8)}`,
          author: me, text: input.text, at: now,
        })) {
          return { ok: false, reason: `找不到这条评论：${input.commentId}` };
        }
        break;
      case "resolve":
        if (!revisionSessions.setCommentResolved(filePath, input.commentId, input.resolved)) {
          return { ok: false, reason: `找不到这条评论：${input.commentId}` };
        }
        break;
    }
    return { ok: true, state: revisionSessions.stateOf(filePath) ?? undefined };
  };
  recordRpcHandler(IPC.DOC_VIEW_COMMENT_MUTATE, onCommentMutate);
  ipc.handle(IPC.DOC_VIEW_COMMENT_MUTATE, onCommentMutate);

  /* 各家编辑器的页面通道 → 统一入口。
   *
   * docs 走 preload 策略已经转过名了；markdown（以及将来别家）用自己的前缀，
   * 这里按 `VENDOR_PAGE_CHANNELS` 再订阅一遍同名 handler —— **同一个 handler**，
   * 所以身份反查、形状校验、错误处理都只有一份。 */
  if (typeof ipc.on === "function") {
    for (const vendorChannel of Object.keys(VENDOR_PAGE_CHANNELS)) {
      // 只挂"页面 → 宿主"方向；反向的（命令下发）由 `host.sendToEditor` 按各家的名字发。
      if (!vendorChannel.endsWith("-report") && !vendorChannel.endsWith("-created")
        && !vendorChannel.endsWith("-reply")) continue;
      const handler = vendorChannel.endsWith("-created")
        ? (event: unknown, raw: unknown): void => onCommentCreated(event, raw)
        : vendorChannel.endsWith("-reply")
          ? (event: unknown, raw: unknown): void => {
              const payload = raw as { nonce?: unknown; callId?: unknown; status?: unknown; output?: unknown } | null;
              if (payload === null || typeof payload !== "object") return;
              if (typeof payload.nonce !== "string" || typeof payload.callId !== "string") return;
              const status = payload.status;
              if (status !== "ok" && status !== "error" && status !== "cancelled") return;
              // **sender 校验**：只接受来自已登记编辑器页的回执。
              const senderDocId = host.docIdForSender((event as { sender?: unknown } | null)?.sender);
              if (senderDocId === null) return;
              if (!payload.nonce.startsWith(`${senderDocId}:`)) return;
              rendererToolDispatch.acceptReply({
                nonce: payload.nonce,
                callId: payload.callId,
                status,
                ...(typeof payload.output === "string" ? { output: payload.output } : {}),
              });
            }
          : onRevisionReport;
      ipc.on(vendorChannel, handler);
    }
  }

  /**
   * 【ARC-007】slides 编辑（A 方案第一步）：`documentView.slidesAddSlide`。
   *
   * **身份**：与 open/save 同一条纪律 —— 始终从受信 `event.sender`
   * 反查目标 docId。生产 preload 的空入参属于合法调用；历史调用方
   * 若主动提供 `docId`，则必须与 sender 一致，否则拒绝（绝不跨视图）。
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
      if (input.docId !== undefined && resolved !== input.docId) {
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
      return await slides.addSlide(webContentsId, resolved, input.sourceIndex, input.before);
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
      if (input.docId !== undefined && resolved !== input.docId) {
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
   * 【ARC-007 P1/GA1】**slides 打开**：页面（preload 的 `openPptxPath` /
   * `consumePendingOpen`）拉取宿主已准备的 `OpenResult`。
   *
   * 两条单向链与 docs 相同，只是"解析者"换成 vendor：
   *  1. 宿主 `openSlidesPath`（面板经 `documentView:openPath` 触发）只登记
   *     `pendingOpen` 并**推一次** `slides:opened`（executor 解析后的结果）；
   *  2. 页面挂载/收到通知后 invoke 本通道**拉取**（`slides.readOpened`）；
   *     页面**不再**把路径回传给宿主，也不 invoke `slides:open-path`。
   *
   * 路径来自宿主的 `pendingOpen`（`prepareSlidesOpen` 已过围栏）；执行器只做
   * 解析与渲染树构造（vendor 同一份代码），返回值里的 `path` 仅供标题显示。
   */
  const onSlidesReadOpened = async (evt: unknown, raw: unknown) => {
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
      // 【ARC-007 P1/GA1】先看页面回执：`slides:opened` 推送之后页面会调
      // `applyOpen` 并**回执**（`settleSlidesOpen` 在这里由 preload 触发）。
      // 拉取本身是幂等的：已经准备好的 `OpenResult` 缓存到 live 视图上，
      // 页面重拉（StrictMode 双挂载）不会重复解析、也不会重复提交。
      const pending = host.pendingOpenFor(resolved);
      if (pending === null) {
        const cached = host.slidesOpenResultFor(resolved);
        if (cached !== null) {
          // 重拉（StrictMode 双挂载 / 推送与拉取竞争）：会话提交是幂等的，
          // 结果不重复解析。
          host.settleSlidesOpen(resolved, cached.result, true, withinWorkspace);
          return { ok: true, ...cached };
        }
        return { ok: false, reason: "没有待打开的演示文稿（openPath 尚未请求）" };
      }
      if (!withinWorkspace(pending.filePath)) {
        return { ok: false, reason: `文件已不在已知工作区内：${pending.filePath}` };
      }
      const wc = host.webContentsOf(resolved) as unknown as { id?: unknown } | null;
      const webContentsId = wc && typeof wc.id === "number" ? wc.id : null;
      if (webContentsId === null) {
        return { ok: false, reason: "当前视图没有 webContents id，无法定位 slides 会话" };
      }
      const opened = await slides.openDeck(webContentsId, resolved, pending.filePath, SLIDES_FIT_WIDTH_PX);
      if (!opened.ok) return { ok: false, reason: opened.reason };
      const result = opened.openResult as { path?: unknown; slides?: unknown; size?: unknown; defaultFont?: unknown } | null;
      if (result === null || typeof result !== "object" || !Array.isArray(result.slides)) {
        return { ok: false, reason: "打开失败：vendor 解析器返回的形状不是 OpenResult（缺 slides）" };
      }
      let hash = "";
      try {
        const bytes = await readFile(pending.filePath);
        hash = createHash("sha256").update(bytes).digest("hex");
      } catch {
        /* 版本只是保存乐观锁的基准；读不到时为空串（保存时会重新判） */
      }
      // 缓存给重拉用（StrictMode 双挂载 / 推送与拉取竞争），并回执提交会话：
      // 到这里页面已经拿到能渲染的 `OpenResult`，与 docs 的 open-committed 同一
      // 时机语义（成功标记后置，失败不占会话）。
      host.cacheSlidesOpenResult(resolved, result, hash);
      host.settleSlidesOpen(resolved, result, true, withinWorkspace);
      return { ok: true, result, hash };
    } catch (err) {
      return { ok: false, reason: errText(err) };
    }
  };
  ipc.handle("mcode:document-view:slides-read-opened", onSlidesReadOpened);

  /**
   * 【ARC-007 P1/GA1】**slides 保存**：页面 `save()` 的宿主对端。
   *
   * 页面不传路径也不传字节：vendor 主进程的会话里已有 deck（打开时由执行器
   * 建立），宿主只给**它自己打开的那份路径**（`slidesSaveTarget` 每次保存都
   * 重新过围栏），执行器调 vendor 的 `savePptxToFile` 同一份实现写盘。
   * 写盘后宿主重算盘上版本并推进会话（`recordSlidesSave`）。
   */
  const onSlidesSave = async (evt: unknown, raw: unknown) => {
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
      const target = host.slidesSaveTarget(resolved, withinWorkspace);
      if (!target.ok) return { ok: false, error: target.reason };
      const wc = host.webContentsOf(resolved) as unknown as { id?: unknown } | null;
      const webContentsId = wc && typeof wc.id === "number" ? wc.id : null;
      if (webContentsId === null) {
        return { ok: false, error: "当前视图没有 webContents id，无法定位 slides 会话" };
      }
      const saved = await slides.saveDeck(webContentsId, resolved, target.filePath);
      if (!saved.ok) return { ok: false, error: saved.reason };
      const recorded = await host.recordSlidesSave(resolved, withinWorkspace);
      if (!recorded.ok) return { ok: false, error: recorded.reason };
      return { ok: true, path: recorded.filePath, bytes: recorded.bytes };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  };
  ipc.handle("mcode:document-view:slides-save", onSlidesSave);

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
      /* 【Office 深度集成】保存成功后记一版历史。
       *
       * **只在真落盘之后**（`result.ok`），且**失败不影响保存的返回值** ——
       * 历史是附属能力，写历史出错不该让一次成功的保存看起来失败。
       * 真正的失败在这里只记日志（用户仍然拿到了他的保存）。 */
      if (result.ok === true) {
        const savedPath = (result as { path?: unknown }).path;
        if (typeof savedPath === "string" && savedPath !== "") {
          void recordDocumentVersion({ filePath: savedPath, source: "user", dataRoot: dataRoot() })
            .catch((err: unknown) => {
              log.warn(`document history record failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
      }
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
