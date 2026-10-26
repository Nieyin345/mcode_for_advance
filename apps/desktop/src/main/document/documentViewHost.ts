/**
 * 【ARC-007】**受控文档视图宿主**（主进程）—— 一个 docId 一个 `WebContentsView`。
 *
 * ## 它是什么
 *
 * GenOffice 的编辑器页面（Docs/Sheets/Slides/Markdown/PDF）是一个叠在主窗口上的
 * OS 级 web 面：渲染端量好占位矩形，把像素 bounds 发下来，主进程把视图摆到那个位置。
 * 这一层只做**视图生命周期**，不做文档读写（那是 DocumentService / GenOffice CLI 的
 * 职责），也不复用 BrowserManager 的类 —— 浏览器面板的语义是"任意网页 + 元素拾取"，
 * 文档视图的语义是"离线、受控、不加载远程内容"，两者的安全边界正好相反。
 *
 * ## 与 BrowserManager 同一套做法的部分（照它的模式，不照抄它的权限）
 *
 *   - 视图创建后立刻 `addChildView`，隐藏 = 移到屏幕外（保活），关闭才销毁；
 *   - `show()` 重新 attach 并恢复最后 bounds；`hide()` 只挪 x/y，宽高保留；
 *   - 主窗口 `closed` 时销毁全部视图（窗口没了，子视图就是孤儿）；
 *   - `dispose()` 幂等，供退出路径与测试调用。
 *
 * ## 打开会话表（【ARC-007】DocumentSessionRegistry 的宿主切片）
 *
 * 视图按 `docId` 管；**文档会话按物理路径管**。同一份文件被两个 docId 打开时，
 * 两个视图各自记一份"打开时 revision"——保存时谁后写谁赢，乐观锁只防外部改动、
 * 不防两个视图互相覆盖。这一层把「一条物理路径在任一时刻只有一个权威会话」变成
 * 判据：
 *
 *   - 路径先过 `physicalPath` 归一（resolve `.`/`..`/分隔符 + 跟 symlink/junction +
 *     Windows/macOS 折叠大小写）。所以 `D:\WS\a.docx`、`d:/ws/../ws/a.docx`、
 *     经 junction 的别名**命中同一条会话** —— 按字符串比较会让它们各开各的。
 *   - 同一路径的第二次 `openPath`（另一个 docId）→ **显式拒绝**并点名已在哪个
 *     视图打开。**选拒绝、不选复用 docId**：`openPath(docId, …)` 的契约是"把文档
 *     载入**这个**已存在的视图"（`ipc/documentView.ts` 的 RPC 与视图 preload 的
 *     内部通道都按 docId 定向），把请求偷偷改投到另一个 docId 会让调用方以为
 *     自己那个视图里打开了文档 —— 之后它的 bounds/save 全落在错误的视图上。
 *     渲染端每个面板用 `stableDocId(filePath)` 生成 docId，同一面板重渲染不会
 *     触发拒绝；两个面板开同一文件才会 —— 那正是要显式告诉用户的情形。
 *   - 同一 docId 对同一路径重复 `openPath` = 刷新（页面重新载入），重记 revision。
 *   - `close` / `closeAll` / `dispose` 摘会话；之后同一路径可重新打开，revision
 *     取**当下**盘上的版本（`openPath` 时重算）。
 *   - 保存：会话表里记住每个 docId 的**权威路径原文**。`saveOpenedFile` 先确认
 *     该 docId 仍是这条路径的唯一持有者，再把「重算盘上版本 → 比较 → 原子写」
 *     放进同一份 `withOsFileLease` 临界区（租约以归一化路径为键，与 FILE_WRITE /
 *     Excel/PDF/DOCX 编辑同一份锁）。本切片不允许两个视图持同一路径，所以"比较
 *     权威 revision 而不是各自打开时的"在行为上等价于现有乐观锁；将来若要放开
 *     多视图，把 `claim` 改成共享计数、`saveOpenedFile` 的 expected 改读会话表
 *     里的 `revision` 字段即可 —— 拒绝点只有 `claim` 一处。
 *
 * 会话记录：`docId`、路径原文、归一化键、打开时 revision（Promise，理由见
 * `LiveDocumentView.openedFileRevision`）、打开者 `webContents`（`sender`，身份
 * 反查用）。
 *
 * ## 安全判据（台账 ARC-007「CSP 自限、离线自足」）
 *
 * **URL 白名单是 fail-closed 的**：只放行 `file://`（repo 内 GenOffice 快照的编辑器页）
 * 与本机回环 `http(s)://127.0.0.1 | localhost | [::1]`。远程地址、`data:`、`javascript:`
 * 一律在**创建视图之前**拒绝 —— 顺序是判据的一部分：先拒后建，拒绝路径上不能留下
 * 已经加载过远程内容的 webContents。
 *
 * webPreferences 三项逐项钉死：`contextIsolation: true`（页面碰不到宿主作用域）、
 * `nodeIntegration: false`（没有 Node 能力）、`sandbox: true`（渲染进程进 Chromium
 * 沙箱）。preload 只在编译产物存在时挂**最小桥**（`documentViewPreload.ts`），
 * 取不到就宁可不给能力（fail-closed）。
 *
 * ## 打开通道只对 docs 成立
 *
 * `openPath` 发的是 vendor **docs** 页面认识的那对常量；sheets/slides 的打开
 * 实现长在 GenOffice 自己的主进程里（sheets=`workbook:select`、slides=
 * `slides:open-path`），本宿主没有对端，也不会伪造 `WorkbookFile`/`OpenResult`。
 * 这不是"没找到渲染端入口"：vendor 的 sheets/slides 渲染端都不订阅
 * `menu:command`（只有 docs 订阅，`apps/docs/src/preload/index.ts:250`），
 * slides 订阅的 `slides:menu` 只承载不带路径的菜单命令
 * （`apps/slides/src/preload/index.ts:384`、`apps/slides/src/shared/ipc.ts:1269`），
 * sheets 的 `menu:action` 同样不带路径（`apps/sheets/src/preload/index.ts:438`），
 * 两家的 URL 参数与 localStorage/IndexedDB 里也没有待打开路径。核对明细见
 * `GenofficeViewHostPane.tsx` 文件头「sheets / slides 的打开入口」一节。
 * 渲染端对这两类文件直接显式降级并点名原因（见同文件）。
 *
 * ## 可测性
 *
 * 构造函数接收可注入的 `createView`（WebContentsView 构造器）与 `getMainWindow`
 * （窗口解析）。视图构造器**不顶层 import electron**：本模块会被无头套件加载，
 * 顶层 `import { WebContentsView } from "electron"` 在纯 node 下会直接起不来；
 * 默认实现惰性 `require("electron")`，套件则注入假构造器验证状态机。
 */
import { getMainWindow } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { uiLocale } from "@main/lib/dialogText.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";
// 【ARC-007 DocumentSessionRegistry】路径归一化的**唯一一份**实现。`physicalPath`
// 会 resolve（吃掉 `.`/`..`/多余分隔符）、跟随 symlink/junction 到真实目的地、
// 并在 Windows/macOS 上折叠大小写 —— 与 `pathGuard.samePath` 同一套判据的物理版。
// 本模块不能 import `pathGuard`（它会拉进 repositories → db → electron），
// `realPathWithin` 就是为这种场景拆出来的零依赖叶子（已经给了 fileSnapshot 用）。
import { physicalPath } from "@main/lib/realPathWithin.js";
import { existsSync } from "node:fs";
import { link, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { issueDocumentHandoff, revokeDocumentHandoffs } from "./documentViewHandoff.js";
import { setDocumentMutationObserver, type DocumentMutationNotice } from "./documentMutationNotifier.js";
import { writeDocRecovery, inspectDocRecovery, clearDocRecovery } from "./documentRecovery.js";
import { mcodeNativeDocsIpcAvailable, registerDocsIpc } from "@main/document/docsVendorIpc.js";
import type { DocsPrivilegedPorts } from "./docsPrivilegedPorts.js";
import type { DocsAiPorts } from "./docsAiPorts.js";
import type { DocViewOpenInput, DocViewRect, DocViewResult, DocViewSnapshot } from "@contracts/ipc";
import type { EditorCredentialPort } from "./documentViewCredentialBroker.js";

/** webPreferences 的**完整**形状 —— 三项安全开关是字面量类型，改一处都过不了 typecheck。 */
export interface DocumentViewWebPreferences {
  contextIsolation: true;
  nodeIntegration: false;
  sandbox: true;
  /** 【ARC-007】最小桥（见 `documentViewPreload.ts`）。缺省 = 不给任何桥
   *  （页面会降级，但无法打开指定文档）。 */
  preload?: string;
}

/** 假构造器要满足的视图最小面（真 `WebContentsView` 天然满足，见文件头的注入说明）。 */
export interface DocumentViewWebContentsLike {
  /** 【ARC-006 Gate A 缺口】webContents id —— 编辑器凭据注入按它收窄绑定。
   *  Electron 的 `WebContents.id` 恒有；假视图可以不给（那时引擎视图 open 会被拒）。 */
  id?: number;
  loadURL(url: string): unknown;
  focus(): void;
  close(): void;
  isDestroyed?(): boolean;
  setWindowOpenHandler?(handler: (details: { url: string }) => { action: "deny" }): void;
  /** 【ARC-007】加载失败/渲染进程崩溃的**诊断钩子**。
   *
   *  为什么必须有:vendor 编辑器页依赖 preload 桥(`window.desktop.*`),而本宿主
   *  刻意不给 preload(见文件头)。页面在 `App` 的 effect 里会抛
   *  `Cannot read properties of undefined` —— 没有这两个钩子时,外层只看到一片空白,
   *  完全不知道"是没加载还是加载了但崩了"。有了钩子,`list()` 能如实报出失败原因。 */
  on?(event: "did-fail-load" | "render-process-gone" | "will-navigate" | "will-redirect", listener: (...args: unknown[]) => void): unknown;
  /** 向页面发一条受控消息（只有 `openPath` 用它）。 */
  send?(channel: string, ...args: unknown[]): void;
}

export interface DocumentViewLike {
  webContents: DocumentViewWebContentsLike;
  setBounds(bounds: DocViewRect): void;
}

/**
 * 主窗口的最小面。写成 `unknown` 形参是为了让真 `BrowserWindow`（它的
 * `contentView.addChildView` 收的是 Electron 的 `View`）在结构上满足这里 ——
 * 方法形参的双变让它成立；本模块只传自己创建的视图进去。
 */
export interface DocumentViewHostWindow {
  isDestroyed?(): boolean;
  contentView: {
    addChildView(view: unknown): void;
    removeChildView(view: unknown): void;
  };
  on?(event: "closed", listener: () => void): unknown;
  removeListener?(event: "closed", listener: () => void): unknown;
}

export interface DocumentViewHostPorts {
  /** 主窗口解析（生产传 `@main/window.js` 的 getMainWindow；无头套件传假窗口）。 */
  getMainWindow(): DocumentViewHostWindow | null;
  /** 视图构造器；缺省惰性取 `electron.WebContentsView`。 */
  createView?: ((webPreferences: DocumentViewWebPreferences) => DocumentViewLike)
    | { vendor: (openPath: string | null, kind: "pdf" | "markdown" | "html" | "sheets" | "slides") => DocumentViewLike };
  /** Vendor 的路径围栏与普通 document.* 共用主进程判据；未注入时拒绝。 */
  withinWorkspace?: (path: string) => boolean;
  /** 【ARC-007】**诊断/测试接缝**：在保存租约内、版本比较通过之后、`atomicReplaceFile`
   *  之前调用。生产不传（no-op）。存在的唯一理由是让回归网能**确定性地**把"胜者
   *  持锁的窗口"拉长 —— 从而断言落败者在租约串行下真的没走到替换那一步；没有它，
   *  并发断言只能靠时序碰运气。 */
  beforeAtomicReplace?: (realPath: string) => void | Promise<void>;
  /** 【ARC-006 Gate A 缺口】编辑器页的**宿主凭据注入**（`workflowEngineId` 视图）。
   *  省略 = 不支持引擎编辑器凭据（`workflowEngineId` 的 open 被显式拒绝，fail-closed），
   *  因为带着这个标记却没有注入器，页面只会拿到 401 —— 与其静默降级，不如说清原因。 */
  editorCredentials?: EditorCredentialPort;
  /** 【ARC-007 P0】**脏替换确认端口**：页面有未保存修改时，`openPath` 前由
   *  `confirmDocumentReplace` 调用。生产传 `dialog.showMessageBox` 的真人确认
   *  （`ipc/index.ts` 装配）；无头套件注入自动应答。省略 = fail-closed（脏时拒绝
   *  替换），绝不替用户点"放弃"。 */
  confirmDirty?: (input: { docId: string; filePath: string | null }) => Promise<boolean>;
  /** 【T29/T155】原厂编辑器（pdf/markdown/html/sheets/slides）的关闭守卫端口 —— 五家
   *  的未保存状态与保存语义归各自 **vendor 主进程**，页面 preload 并不统一订阅
   *  `mcode:document-view:close-check`。PDF/Markdown/HTML/Sheets 旧探针会超时；
   *  Slides 原先被直接关闭旁路跳过，现统一接入其原厂 `requestSlidesClose`。
   *
   *  生产装配（`ipc/index.ts`）注入 vendor `request*Close` 的转发
   *  （`genofficeNativeVendor.ts` 的 `requestNativeViewClose`）；返回值 true =
   *  可以关闭（干净，或用户选择了保存/放弃），false = 用户取消或保存失败。
   *  省略 = 原厂编辑器关闭 fail-closed，不得静默丢弃修改。 */
  vendorCloseGuard?: (input: {
    docId: string;
    editor: "pdf" | "markdown" | "html" | "sheets" | "slides";
    /** 视图的 webContents（vendor 的 `request*Close(contents, parent)` 接收的
     *  就是它）；宿主只透传，不解释。 */
    webContents: unknown;
  }) => Promise<boolean>;
}

/** 隐藏视图的落点：只挪坐标、保留宽高（与 BrowserManager.hide 同一取舍）。 */
function offscreenBounds(bounds: DocViewRect): DocViewRect {
  return { x: -9999, y: -9999, width: bounds.width, height: bounds.height };
}

/**
 * 【ARC-007】把文档交给编辑器页的**那一对常量** —— 名字来自 vendor，不是我们起的。
 *
 * GenOffice 编辑器渲染端只订阅 `menu:command`（`apps/docs/src/preload/index.ts` 的
 * `onMenuCommand` 里 `ipcRenderer.on('menu:command', ...)`），收到
 * `("open-path", path)` 才走 `openRecent(path)`（`App.tsx` 的 `case "open-path"`）。
 * 换名字等于发到没人收的通道上：`openPath` 返回 ok、文档却不打开。
 */
const VENDOR_MENU_COMMAND_CHANNEL = "menu:command";
const VENDOR_OPEN_PATH_COMMAND = "open-path";

/** 【ARC-007】保存通道的单次上限（256 MiB）。真实办公文档远小于它；超过基本可以
 *  确定是页面算错或投毒，放任它会一次性把内存和磁盘撑满。 */
const DOC_VIEW_SAVE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * 【ARC-007 P0】坏档预检：docx 是 zip，前两字节必须是 `PK`。
 * 页面解析坏文件会抛错并停在"Opening…"；宿主提前拒能给出可读原因，
 * 也避免把无意义字节 issue 成 handoff。不带宏/加密容器判断（加密 docx 仍是 PK）。
 */
function isLikelyDocx(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Windows 保留设备名（大小写不敏感）。页面给的名字落在这些词上时一律改写。 */
const WINDOWS_RESERVED_BASENAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * 【ARC-007】把页面给的 `defaultName` 洗成一个**纯文件名**（不含目录）。
 *
 * 只取 `basename` 语义 + 去掉路径分隔符/控制字符/尾随点与空格；保留名
 * （Windows `CON`/`NUL`…）替换为 `untitled`。输出永远不含 `/` `\` `..`，
 * 因此 `join(dir, name)` 不可能逃出 `dir`。空结果 → `untitled.docx`。
 */
function safeNewDocName(raw: string): string {
  const base = typeof raw === "string" ? raw : "";
  // 先按两种分隔符切：页面的说法不可信，Windows 风格 `a\b` 在 POSIX 上也是分隔符。
  const lastSegment = base.split(/[\\/]/).pop() ?? "";
  let stem = lastSegment
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .replace(/\.docx$/i, "")
    .trim();
  if (stem === "" || WINDOWS_RESERVED_BASENAMES.has(stem.toLowerCase())) stem = "untitled";
  return `${stem.slice(0, 120)}.docx`;
}

/**
 * 【ARC-007】在 `dir` 里为新文件分配一个**不存在的**路径：
 * `<stem>-<8位短随机>.docx`。与 vendor 的 `uniquePathIn` 同一职责（保证不覆盖），
 * 但用随机后缀而不是 `(1)` 计数 —— 并发两个保存不会抢同一个名字。
 * 8 位十六进制 + 最多 3 次重试仅负责选候选名；真正不覆盖别人的保证
 * 来自 saveNewFile 用 fs.link 的 OS 原子 no-replace 提交，不是这里的 existsSync。
 */
function uniquePathIn(dir: string, name: string): string {
  const stem = name.replace(/\.docx$/i, "");
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = join(dir, `${stem}-${randomUUID().replace(/-/g, "").slice(0, 8)}.docx`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("无法在目录内分配一个不冲突的文件名（重试 3 次）");
}

interface LiveDocumentView {
  docId: string;
  view: DocumentViewLike;
  /** 已经接受的 URL（已规范化）。 */
  url: string;
  /** 最近一次渲染端量出来的可见几何。 */
  bounds: DocViewRect;
  /** Last geometry successfully sent to the OS view (including offscreen).
   *  Kept separately so a failed setBounds can be retried with the same rect. */
  appliedBounds: DocViewRect | null;
  visible: boolean;
  /** 【ARC-007】这个视图**当前打开的那份文档**（`openPath` 成功发送后记下）。
   *
   *  保存通道只认它：页面不能把内容写到"任意工作区路径"，只能写回**它自己被
   *  打开时那份文件** —— 否则一个被投毒的编辑器页就能覆盖工作区里任意的 `.docx`。
   *  取值为 null 表示视图里还没有文档（只有起始页），此时保存一律拒绝。 */
  openedFilePath: string | null;
  /** T05c: Mcode shell-selected conversation; never selected by the vendor. */
  mcodeSessionId: string | null;
  /** 最近一次加载/渲染失败(诊断用;成功后清空)。 */
  lastFailure?: { kind: "load" | "render-gone"; reason: string; at: number };
  /** 【ARC-007】**打开时的内容版本**（`fileContentVersion` 的 sha256；文件当时不存在
   *  则为 null）。保存通道拿它做**宿主侧乐观锁**：页面保存前重算盘上版本，不一致
   *  就报 conflict 且不写盘。
   *
   *  存的是 Promise 而不是结果：`openPath` 是同步返回的，哈希读盘是异步的；保存
   *  恰好在哈希算完之前发生时，`saveOpenedFile` 会 await 同一个 Promise，拿到的是
   *  **打开那一刻**读到的字节的哈希 —— 于是不存在"还没算完就当成 null"的假冲突。
   *
   *  ⚠️ 为什么 expected 是"宿主记下的"而不是页面给的：vendor 编辑器的保存链路
   *  `saveDocx(path, data, auto)`（`genoffice/apps/docs/src/renderer/file-actions.ts:1114`
   *  → `src/preload/index.ts:116` → `shared/ipc.ts:417`）**不携带任何版本**，页面
   *  不知道自己读的是哪个版本。宿主只能假设"它基于打开时读到的内容在保存" ——
   *  这是诚实的乐观锁，不是伪造的并发控制：如果打开后没人动过文件，保存通过；
   *  动过就拦下。将来页面能携带版本时，`saveOpenedFile` 的 `expectedRevision`
   *  参数已经是现成入口。 */
  openedFileRevision: Promise<string | null> | null;
  /** 保存冲突的最近一次记录（成功后清空）。与 `lastFailure` 分开：页面崩了和
   *  保存被拒是两件不同的事，混在一个字段里会让诊断文案说谎。 */
  lastSaveConflict?: {
    expectedRevision: string | null;
    currentRevision: string | null;
    message: string;
    at: number;
  };
  /** Disk content changed through an Mcode document tool while this native view was open. */
  lastExternalMutation?: { at: number };
  /** 【ARC-006 Gate A 缺口】这个视图加载的是哪个工作流引擎的编辑器页
   *  （`open` 时由 `workflowEngineId` 记下）。换引擎/换回普通文档视图时要摘旧凭据绑定。 */
  workflowEngineId: string | null;
  /** 【ARC-007 P1/GA1】编辑器域（`open` 的 `editor` 字段）。`"slides"` 时
   *  `openPath`/保存走 slides 通道（vendor 解析器构造 `OpenResult`）。 */
  editor: "slides" | "sheets" | "pdf" | "markdown" | "html" | null;
  /** 【ARC-007 P0】**待打开请求**：`openPath` 准备的路径，等页面经 `readOpened`
   *  拉取一次性字节响应；页面回执（`settlePendingOpen`）后才登记会话。
   *  失败/拒绝不占会话、不改 CAS 基准。 */
  pendingOpen: { docId: string; filePath: string; requestedAt: number; recoveryBaseRevision?: string; openedBytesRevision?: string } | null;
  /** 【ARC-007 P1/GA1】最近一次为这个视图解析好的 slides `OpenResult`（连同当时
   *  字节的 sha256）。页面在推送与拉取竞争/StrictMode 双挂载时重拉同一份结果，
   *  **不重复解析**也不重复提交会话。换文件（`prepareSlidesOpen`）时清空。 */
  slidesOpen?: { result: unknown; hash: string } | null;
  /** 【ARC-007 P0】页面经 `reportCloseCheck` 上报的脏标记（vendor 每次编辑/保存
   *  后都报）。`confirmDocumentReplace` 的真实来源。 */
  pageDirty: boolean;
  /** Each new dirty report invalidates a pending human discard confirmation. */
  pageDirtyEpoch: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * 【ARC-007 DocumentSessionRegistry】一条**打开会话** —— 物理路径 → 唯一的 docId。
 *
 * `key` 是 `physicalPath` 的归一化结果（小写、resolve 过、跟过链接），**只**作
 * Map 的键；`filePath` 保留调用方给的原文（页面收到的是它，保存也写回它，避免
 * 我们悄悄改掉大小写/链接形态）。
 *
 * `sender` 是打开这个会话的 `webContents`（`openPath` 时从视图上取）。它让
 * 「谁开的」可反查 —— `docIdForSender` 回答"这条消息来自哪个 docId"，本表回答
 * "这份文件被谁开着"。同一对象在 `LiveDocumentView.view.webContents` 里也有，
 * 这里存一份引用是**登记**，不是第二份真值。
 */
interface DocumentSession {
  docId: string;
  /** 调用方给的路径原文（blank-trim 后）。 */
  filePath: string;
  /** `physicalPath` 归一化键（Windows/macOS 折叠大小写）。 */
  key: string;
  /** 打开时的内容版本（`fileContentVersion`；文件不存在为 null）。保存冲突判据
   *  的**权威**来源 —— 与 `LiveDocumentView.openedFileRevision` 是同一个 Promise
   *  对象（不是各算一份），会话表只是把它和路径绑在一起。 */
  revision: Promise<string | null>;
  /** 打开者（视图的 webContents）。 */
  sender: unknown;
  openedAt: number;
}

/** `claimOpenedPath` 的判定结果。`refresh` = 同一 docId 重开同一路径（允许）。 */
type ClaimResult =
  | { ok: true; session: DocumentSession; refresh: boolean; previous: DocumentSession | null }
  | { ok: false; reason: string };


/**
 * 文档视图的 URL 闸。**fail-closed**：解析不了、协议不在白名单、回环域名带伪装后缀
 * （`localhost.evil.com` 这类）一律拒绝并给出原因。
 *
 * 导出成纯函数是为了让无头套件直接钉住判据本身 —— 状态机的断言很难穷举 URL 形状，
 * 而这条闸是「不加载远程内容」的唯一落点。
 */
export function checkDocumentViewUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  // FULL-1: a document editor view has a privileged, narrowly-scoped Host
  // preload. WHATWG new URL() removes TAB/LF/CR and edge whitespace before
  // checking origin; accepting such an ambiguous raw request would make the
  // security gate evaluate a different URL than the caller supplied.
  if (raw.trim() !== raw || /[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, reason: "文档编辑器 URL 含控制字符或非规范空白，已拒绝加载" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `不是合法的 URL：${raw.slice(0, 200)}` };
  }
  // The Node-RED editor's actual auth is injected by the per-webContents
  // credential broker; user:password@ in a URL is neither an editor identity
  // nor a safe means of transport. Reject it before allowing any scheme.
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "文档编辑器 URL 不能携带账号或密码" };
  }
  if (parsed.protocol === "file:") {
    // `file://remote/share/x.html` 会去读网络共享 —— 只认空主机或 localhost。
    if (parsed.hostname !== "" && parsed.hostname !== "localhost") {
      return { ok: false, reason: `file: URL 不允许指向远程主机：${parsed.hostname}` };
    }
    return { ok: true, url: parsed.toString() };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      return {
        ok: false,
        reason: `文档视图只加载本机回环地址（127.0.0.1 / localhost），拒绝远程地址：${parsed.hostname || "(空)"}`,
      };
    }
    return { ok: true, url: parsed.toString() };
  }
  return {
    ok: false,
    reason: `文档视图只允许 file:// 与本机回环 http(s)，拒绝 ${parsed.protocol}：${raw.slice(0, 200)}`,
  };
}

/** 默认视图构造器：惰性 require，理由见文件头「可测性」。 */
function defaultCreateView(webPreferences: DocumentViewWebPreferences): DocumentViewLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebContentsView } = require("electron") as typeof import("electron");
  return new WebContentsView({ webPreferences }) as unknown as DocumentViewLike;
}

/** 【ARC-007】视图 preload 的**编译产物**路径。构建把 `documentViewPreload.ts`
 *  打进 `dist/main/document/documentViewPreload.js`；本文件同名，用 `__dirname`
 *  取同目录即可（开发时是源码旁的编译产物）。取不到就**不给桥**（fail-closed：
 *  宁可页面降级，也不假装桥在）。 */
function resolveViewPreload(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:path").join(__dirname, "documentViewPreload.js");
  } catch {
    return undefined;
  }
}

export class DocumentViewHost {
  private readonly views = new Map<string, LiveDocumentView>();
  private nativeDocsRelease: (() => void) | null = null;
  /** One pending close probe per view; never trust a stale cached clean flag. */
  private readonly closeCheckWaiters = new Map<string, (received: boolean) => void>();
  private readonly protectedCloses = new Map<string, Promise<DocViewResult>>();
  /** Per-Host identity prevents same docId in a second window being revoked. */
  private readonly handoffOwner = {};
  /**
   * 【ARC-007 DocumentSessionRegistry】打开会话表：归一化物理路径 → 会话。
   * 本切片保证一条路径至多一个持有者（见文件头「打开会话表」）；`docId → key`
   * 的反查放在 `live.openedFilePath` 之外的 `sessionKeyByDocId`，因为保存要拿
   * 归一化键去抢租约。
   */
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly sessionKeyByDocId = new Map<string, string>();
  private readonly getWindow: () => DocumentViewHostWindow | null;
  private readonly createView: (webPreferences: DocumentViewWebPreferences) => DocumentViewLike;
  private vendorCreateView: ((path: string | null, kind: "pdf" | "markdown" | "html" | "sheets" | "slides") => DocumentViewLike) | null;
  private withinWorkspace: (path: string) => boolean;
  private readonly beforeAtomicReplace: (realPath: string) => void | Promise<void>;
  /** 【ARC-007 P0】脏替换确认端口（见 `DocumentViewHostPorts.confirmDirty`）。 */
  private confirmDirty: ((input: { docId: string; filePath: string | null }) => Promise<boolean>) | null;
  /** 【T29】原厂四编辑器的关闭守卫（见 `DocumentViewHostPorts.vendorCloseGuard`）。 */
  private vendorCloseGuard: DocumentViewHostPorts["vendorCloseGuard"] | null;
  /** 【ARC-006 Gate A 缺口】引擎编辑器页的凭据注入（可缺省；缺省时带
   *  `workflowEngineId` 的 open 显式拒绝 —— 见 `DocumentViewHostPorts.editorCredentials`）。
   *  生产单例在模块加载时就构造好了，而注入器依赖注册表/Electron session（装配在
   *  `ipc/index.ts`）—— 故留一个**只在装配期**调用的 setter；之后不再改。 */
  private editorCredentials: EditorCredentialPort | null;
  /** 【ARC-007 P1/GA1】slides 页"文件已打开"的**推送**出口（vendor 通道名
   *  `slides:opened`，参数是 `OpenResult`）。由装配期注入（`ipc/index.ts`），
   *  与 inbox 的 `sendToRenderer` 同一纪律：没有注入 = 不推（此时 slides 打开
   *  仍可经 `consumePendingOpen` 拉取，只是页面的 `onOpened` 订阅收不到热更新）。 */
  private slidesNotify: ((docId: string, openResult: unknown) => void) | null = null;
  /** 【ARC-007 P1/GA1】视图关闭/释放时的清理端口（装配层注入 slides 执行器的
   *  `release(webContentsId)`）。宿主只负责"什么时候"调；"调谁"由装配层决定。 */
  private viewDisposer: ((webContentsId: number) => void) | null = null;
  /** T05b: Mcode-owned file/print approvals; no adapter means fail-closed. */
  private docsPrivileged: DocsPrivilegedPorts | null = null;
  private docsAi: DocsAiPorts | null = null;
  /** Mcode-owned restore/discard prompt. No injected decision means fail closed. */
  private confirmRecovery: ((input: { filePath: string; diskNewer: boolean }) => Promise<"restore" | "discard" | "cancel">) | null = null;
  /** 已经挂过 `closed` 清理钩子的那个窗口（换窗口时先摘旧的）。 */
  private cleanupWindow: DocumentViewHostWindow | null = null;
  private cleanupHandler: (() => void) | null = null;
  /** dispose 之后不再接受 open —— 退出路径上的迟到调用不该复活视图。 */
  private disposed = false;

  constructor(ports: DocumentViewHostPorts) {
    this.getWindow = ports.getMainWindow;
    this.createView = typeof ports.createView === "function" ? ports.createView : defaultCreateView;
    this.vendorCreateView = ports.createView && typeof ports.createView !== "function" ? ports.createView.vendor : null;
    this.withinWorkspace = ports.withinWorkspace ?? (() => false);
    this.beforeAtomicReplace = ports.beforeAtomicReplace ?? (() => undefined);
    this.confirmDirty = ports.confirmDirty ?? null;
    this.vendorCloseGuard = ports.vendorCloseGuard ?? null;
    this.editorCredentials = ports.editorCredentials ?? null;
    // ARC-007: native Docs main capabilities are registered only in the
    // production host. Never register GenOffice's standalone global handlers:
    // they own file dialogs/AI/storage and would bypass our CAS fence.
    if (ports.createView === undefined && mcodeNativeDocsIpcAvailable) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ipcMain } = require("electron") as typeof import("electron");
        this.nativeDocsRelease = registerDocsIpc(ipcMain, (sender: unknown): boolean => {
          const id = this.docIdForSender(sender);
          const live = id === null ? null : this.views.get(id);
          return live !== null && live !== undefined &&
            live.workflowEngineId === null && live.editor !== "slides";
        }, uiLocale, dataRoot, () => this.docsPrivileged, (sender) => {
          const docId = this.docIdForSender(sender);
          const live = docId === null ? null : this.views.get(docId);
          if (!live || live.editor === "slides" || live.workflowEngineId !== null ||
              !live.mcodeSessionId || !live.openedFilePath || !this.docsAi) return null;
          return { ports: this.docsAi, context: { sessionId: live.mcodeSessionId, filePath: live.openedFilePath } };
        });
      } catch (err) {
        log.error(`native Docs IPC not installed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** 生产装配：只有三个原厂 runtime/资源都准备好之后才注入，失败就保留禁用。 */
  setVendorViewFactory(factory: ((path: string | null, kind: "pdf" | "markdown" | "html" | "sheets" | "slides") => DocumentViewLike) | null,
    withinWorkspace?: (path: string) => boolean): void {
    this.vendorCreateView = factory;
    this.withinWorkspace = withinWorkspace ?? (() => false);
  }

  /**
   * 打开（或复用）一个文档视图。同 docId 重复 open = 复用同一个 view：
   * URL 变了才重新导航，bounds/可见性总是按入参更新。
   *
   * ⚠️ **顺序即判据**：URL 先过闸、窗口先就位，然后才创建视图。拒绝路径上不允许
   * 出现"视图已经建出来、只是没显示"的中间态（那等于给远程内容留了一个加载过的
   * webContents）。
   */
  open(input: DocViewOpenInput): DocViewResult {
    const kind = input.editor === "pdf" || input.editor === "markdown" || input.editor === "html" || input.editor === "sheets" ||
      (input.editor === "slides" && input.url === "genoffice-app://slides/index.html") ? input.editor : null;
    // The vendor factory navigates itself to its own fixed privileged scheme.
    // The renderer supplies only this exact non-navigating identity marker.
    const checked = kind !== null
      ? input.url === `genoffice-app://${kind}/index.html`
        ? { ok: true as const, url: input.url }
        : { ok: false as const, reason: "原厂视图必须使用固定的 genoffice-app 页面身份" }
      : checkDocumentViewUrl(input.url);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    if (kind !== null) {
      if (!this.vendorCreateView) return { ok: false, reason: `${kind} 原厂视图未装配（资源或 runtime 不可用）` };
      if (!input.filePath || !this.withinWorkspace(input.filePath) || !existsSync(input.filePath) || physicalPath(input.filePath) === null)
        return { ok: false, reason: "原厂视图的文件不存在，或不在已知工作区内" };
      if (input.workflowEngineId) return { ok: false, reason: "原厂文档视图不能使用工作流凭据" };
      const holder = this.sessions.get(physicalPath(input.filePath)!);
      if (holder && holder.docId !== input.docId) return { ok: false, reason: `文件已被 ${holder.docId} 持有` };
    } else if (input.filePath !== undefined) {
      return { ok: false, reason: "普通文档视图不能传入原厂文件路径" };
    }
    if (this.disposed) return { ok: false, reason: "文档视图宿主已释放" };

    // 【ARC-006 Gate A 缺口】引擎编辑器页的凭据注入：**先预检、后建视图**。
    // 预检失败（引擎没跑 / 端口不符 / 没有令牌 / 宿主没装注入器）时不创建任何
    // webContents —— 与 URL 闸同一条「拒绝路径上不留加载过的视图」纪律。
    const engineId = input.workflowEngineId ?? null;
    if (engineId !== null) {
      if (this.editorCredentials === null) {
        return {
          ok: false,
          reason: "当前宿主没有配置工作流引擎凭据注入，无法打开需要认证的引擎编辑器页",
        };
      }
      const prepared = this.editorCredentials.prepare({ engineId, url: checked.url });
      if (!prepared.ok) return { ok: false, reason: prepared.reason };
    }

    const win = this.liveWindow();
    if (win === null) return { ok: false, reason: "主窗口尚未就绪，无法创建文档视图" };
    this.installWindowCleanup(win);

    const existing = this.views.get(input.docId);
    if (existing) {
      if (kind !== null && (existing.editor !== kind || physicalPath(existing.openedFilePath ?? "") !== physicalPath(input.filePath!))) {
        return { ok: false, reason: "原厂视图不允许复用 docId 切换文件或编辑器类型" };
      }
      if (kind === null && (existing.editor === "pdf" || existing.editor === "markdown" || existing.editor === "html" || existing.editor === "sheets" ||
        (existing.editor === "slides" && existing.url === "genoffice-app://slides/index.html")))
        return { ok: false, reason: "原厂视图不能复用为普通文档视图" };
      // 【ARC-006 Gate A 缺口】每次 open（含复用）都重新核验并续上凭据绑定：
      // 绑定带空闲租约，过期后页面会 401；用户重新打开/面板重渲染就是新的使用
      // 意图，这里按当下的引擎状态（端口/令牌）重新判定 —— 引擎已停则如实失败。
      // ⚠️ 绑定**先于**任何状态更新：失败时这个视图保持原样（不留下"字段已改、
      // 绑定没换"的中间态）。
      if (engineId !== null) {
        const rebound = this.bindEditorCredentials(existing, engineId, checked.url);
        if (!rebound.ok) {
          this.editorCredentials?.release(input.docId);
          return rebound;
        }
      } else {
        // 变回普通文档视图（同一个 docId 从引擎页改作他用）：旧凭据绑定立刻失效。
        this.editorCredentials?.release(input.docId);
      }
      const urlChanged = existing.url !== checked.url;
      existing.url = checked.url;
      existing.bounds = input.bounds;
      existing.workflowEngineId = engineId;
      // 【ARC-007 P1/GA1】编辑器域随 open 更新：同一个 docId 从 docs 切到 slides
      // （或反之）时，打开/保存链必须跟着切 —— 否则 slides 页会拿到 docx 的
      // OpenDocxResult、docs 页会拿到 OpenResult。
      existing.editor = input.editor ?? null;
      existing.mcodeSessionId = input.mcodeSessionId ?? null;
      if (urlChanged) this.navigate(existing);
      if (input.visible) {
        if (!existing.visible) {
          const shown = this.show(input.docId);
          if (!shown.ok) return shown;
        } else {
          this.applyBounds(existing);
        }
      } else if (existing.visible) {
        this.hide(input.docId);
      } else {
        this.parkOffscreen(existing);
      }
      return { ok: true };
    }

    let view: DocumentViewLike;
    try {
      view = kind !== null
        ? this.vendorCreateView!(input.filePath!, kind)
        : this.createView({
            contextIsolation: true, nodeIntegration: false, sandbox: true,
            ...(resolveViewPreload() !== undefined ? { preload: resolveViewPreload()! } : {}),
          });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`document view create failed: ${msg}`);
      return { ok: false, reason: `创建文档视图失败：${msg}` };
    }

    const live: LiveDocumentView = {
      docId: input.docId,
      view,
      url: checked.url,
      bounds: input.bounds,
      appliedBounds: null,
      visible: false,
      openedFilePath: null,
      mcodeSessionId: input.mcodeSessionId ?? null,
      openedFileRevision: null,
      workflowEngineId: engineId,
      editor: input.editor ?? null,
      pendingOpen: null,
      slidesOpen: null,
      pageDirty: false,
      pageDirtyEpoch: 0,
    };

    try {
      // 文档页不得自己弹新窗口（设置里的"在新窗口打开"之类一律拒绝）。
      view.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
      win.contentView.addChildView(view);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        view.webContents.close();
      } catch {
        /* 视图可能已经不可用 */
      }
      log.warn(`document view attach failed: ${input.docId} ${msg}`);
      return { ok: false, reason: `挂载文档视图失败：${msg}` };
    }

    // 【ARC-006 Gate A 缺口】凭据绑定要在**第一次导航之前**装好，否则编辑器页的
    // 首个 /settings 就 401。绑定失败 = 拆视图（fail-closed：不留下一个注定 401 的页面）。
    if (engineId !== null) {
      const bound = this.bindEditorCredentials(live, engineId, checked.url);
      if (!bound.ok) {
        this.detachAndDestroy(live);
        return bound;
      }
    }

    // 【ARC-007】诊断钩子要在导航**之前**装上，否则首帧的失败会漏掉。
    this.watchFailures(live);
    this.views.set(input.docId, live);
    if (kind !== null) {
      // 原厂构造器已经装载原版 preload、授权指定路径并发起导航；不重复 loadURL。
      const claim = this.claimOpenedPath(input.docId, input.filePath!, view.webContents);
      if (!claim.ok) { this.close(input.docId); return { ok: false, reason: claim.reason }; }
      live.openedFilePath = claim.session.filePath;
      live.openedFileRevision = claim.session.revision;
    } else {
      this.navigate(live);
    }
    if (input.visible) {
      live.visible = true;
      this.applyBounds(live);
    } else {
      this.parkOffscreen(live);
    }
    log.info(`document view opened: ${input.docId} visible=${input.visible}${engineId !== null ? ` engine=${engineId}` : ""}`);
    return { ok: true };
  }

  /** 【ARC-006 Gate A 缺口】把「这个视图 ⇄ 这个引擎的编辑器源」交给凭据注入器。
   *  `webContents.id` 由 Electron 给；假视图没有 id 时显式拒绝（不存在"猜一个"）。 */
  private bindEditorCredentials(
    live: LiveDocumentView,
    engineId: string,
    url: string,
  ): { ok: true } | { ok: false; reason: string } {
    const broker = this.editorCredentials;
    if (broker === null) {
      return { ok: false, reason: "当前宿主没有配置工作流引擎凭据注入" };
    }
    const webContentsId = live.view.webContents.id;
    if (typeof webContentsId !== "number") {
      return { ok: false, reason: "当前视图没有 webContents id，无法绑定编辑器凭据" };
    }
    return broker.bind({ docId: live.docId, engineId, url, webContentsId });
  }

  /** 【ARC-006 Gate A 缺口】给生产单例装上凭据注入器。**只在装配期调用一次**
   *  （`ipc/index.ts` 的 `register*Handlers` 之前）；之后换会丢掉已建立的绑定，
   *  没有这个用法。 */
  setEditorCredentials(port: EditorCredentialPort | null): void {
    this.editorCredentials = port;
  }

  /** 只改几何。隐藏时记住新几何、不应用到视图（与 BrowserManager.setBounds 同）。 */
  setBounds(docId: string, bounds: DocViewRect): DocViewResult {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    live.bounds = bounds;
    if (live.visible) this.applyBounds(live);
    return { ok: true };
  }

  /** 重新挂到窗口并恢复最后几何。已可见时是幂等 no-op（避免重复 attach 闪白）。 */
  show(docId: string): DocViewResult {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    if (live.visible) return { ok: true };
    const win = this.liveWindow();
    if (win === null) return { ok: false, reason: "主窗口尚未就绪" };
    try {
      win.contentView.addChildView(live.view);
    } catch (err) {
      return { ok: false, reason: `显示文档视图失败：${err instanceof Error ? err.message : String(err)}` };
    }
    live.visible = true;
    this.applyBounds(live);
    return { ok: true };
  }

  /** 移出屏幕但**不销毁** —— 切标签/收面板时编辑状态要保住（与 BrowserManager.hide 同）。 */
  hide(docId: string): DocViewResult {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    if (!live.visible) return { ok: true };
    live.visible = false;
    this.parkOffscreen(live);
    return { ok: true };
  }

  /** 把键盘焦点交给文档页（渲染端点进占位区时调用）。 */
  focus(docId: string): DocViewResult {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    if (live.view.webContents.isDestroyed?.() === true) {
      return { ok: false, reason: "文档视图已销毁" };
    }
    try {
      live.view.webContents.focus();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `聚焦失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** 销毁一个视图。不存在 = 已经关了，幂等成功（与 BrowserManager.close 同）。 */
  close(docId: string): DocViewResult {
    revokeDocumentHandoffs(docId, this.handoffOwner);
    // 【ARC-006 Gate A 缺口】凭据绑定与视图同生共死（先于 views.delete 摘，
    // 保证「视图不在了但令牌还给它的 webContents id 发」不存在）。
    this.editorCredentials?.release(docId);
    const live = this.views.get(docId);
    if (!live) {
      // 【ARC-007 DocumentSessionRegistry】视图已经不在了，会话也必须摘 —— 否则
      // 这条路径会被一个不存在的视图永久占住，别的视图再打开同一文件会被误拒。
      // （正常路径上 close 与 releaseSession 成对；这一句兜住"视图先被窗口清理
      // 销毁、close 后到"的迟到调用。）
      this.releaseSession(docId);
      return { ok: true };
    }
    // 【ARC-007 P1/GA1】vendor 会话（slides 执行器按 webContents id 持有）随视图
    // 一起释放 —— 必须在 `detachAndDestroy` 之前取 id。
    const viewWcId = (live.view.webContents as { id?: unknown }).id;
    if (typeof viewWcId === "number" && this.viewDisposer !== null) {
      try {
        this.viewDisposer(viewWcId);
      } catch {
        /* 清理失败不影响关闭语义 */
      }
    }
    this.detachAndDestroy(live);
    this.views.delete(docId);
    this.releaseSession(docId);
    return { ok: true };
  }

  /**
   * 【ARC-007】把某个文档载入**已打开的那个视图**。
   *
   * 判据：路径必须落在已知工作区内（与 `document.*` 同一条围栏）；视图必须存在。
   * 通过后把路径交给页面。
   *
   * ⚠️ 通道形状由 **vendor 页面**决定，不是我们自创的：编辑器渲染端只订阅
   * `menu:command`（`genoffice/apps/docs/src/preload/index.ts` 的 `onMenuCommand`），
   * 并在 `App.tsx` 的 `case "open-path"` 里调 `openRecent(payload)`。早先版本发的是
   * 自定义的 `mcode:document-view:open-path` —— 页面没有订阅者，`openPath` 返回 ok
   * 但文档永远不打开。这里发的就是 vendor 认识的那对 (channel, command, payload)。
   *
   * ⚠️ 信任模型：页面**不可信**，它只能**请求**打开某个路径；宿主拒绝时原样返回原因。
   * 没有"页面给什么就读什么"这回事。
   */
  openPath(docId: string, filePath: string, withinWorkspace: (p: string) => boolean): DocViewResult {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return { ok: false, reason: "文件路径为空" };
    }
    if (!withinWorkspace(filePath)) {
      return { ok: false, reason: `文件不在已知工作区内：${filePath}` };
    }
    if (live.editor === "pdf" || live.editor === "markdown" || live.editor === "html" || live.editor === "sheets" ||
        (live.editor === "slides" && live.url === "genoffice-app://slides/index.html")) {
      // 原厂 createXxxView(path) 首帧自行 consumePending；openPath 只校验而不再推送。
      return physicalPath(filePath) !== null && physicalPath(filePath) === physicalPath(live.openedFilePath ?? "")
        ? { ok: true } : { ok: false, reason: "原厂视图仅能打开初始授权的文件" };
    }
    if (typeof live.view.webContents.send !== "function") {
      return { ok: false, reason: "当前视图不支持接收打开请求" };
    }
    // 【ARC-007 P0】**一条单向通知 + 一条单向拉取**，不再有回环。
    //
    // 旧实现：`openPath` 推 `menu:command("open-path")` → 页面 `openRecent` →
    // preload 的 `openDocxPath` **再次 invoke `open-path`** → 宿主再推 —— 环形，
    // 且页面拿到的是 `{ok:true}` 而非 `OpenDocxResult`（`commit=0`，台账 E1）。
    //
    // 现在：
    //   1. 宿主记住「待打开」请求（本方法），并推**一次** `menu:command` 通知
    //      页面"去打开这条路径"（vendor 认识的形状，页面据此走 `openRecent`）；
    //   2. preload 的 `openDocxPath` 调用 `readOpened` **只拉取**宿主已准备好的
    //      一次性字节响应（`documentViewHandoff`）—— 它不再 invoke `open-path`，
    //      所以不会回到第 1 步。页面每收到一次通知才有一次拉取，单向。
    // 本次调用只做**准备**：登记待开请求 + 围栏校验 + 发通知；会话在页面回执
    // （`open-committed`，vendor 成功路径上的 `getRecentFiles` 时）后才提交，
    // 失败/拒绝不占会话、不改 CAS 基准（见 `settlePendingOpen`）。
    // 【ARC-007 P0】准备阶段的**只读预检**：路径已被另一个 docId 持有时直接拒，
    // 不发通知、不登记（真正的登记仍在回执后的 `claimOpenedPath`，那里会再核对
    // 一次 —— 预检只是让"注定失败的打开"连通知都不发）。
    const key = physicalPath(filePath);
    if (key === null) {
      return { ok: false, reason: `无法解析文件路径（断裂链接或不可访问），拒绝打开：${filePath}` };
    }
    const holder = this.sessions.get(key);
    if (holder !== undefined && holder.docId !== docId) {
      return {
        ok: false,
        reason: `该文件已在另一个视图打开（docId=${holder.docId}）：${holder.filePath}。同一文件同时只允许一个视图持有；请先关闭那个视图或切回它。`,
      };
    }
    live.pendingOpen = { docId, filePath, requestedAt: Date.now() };
    try {
      live.view.webContents.send?.(VENDOR_MENU_COMMAND_CHANNEL, VENDOR_OPEN_PATH_COMMAND, filePath);
      // A second open request supersedes unclaimed bytes from this view.
      // Do not revoke when a rejected request fails before notification.
      revokeDocumentHandoffs(docId, this.handoffOwner);
    } catch (err) {
      live.pendingOpen = null;
      return { ok: false, reason: `发送打开通知失败：${err instanceof Error ? err.message : String(err)}` };
    }
    log.info(`document view open-path: prepared ${docId} ${filePath}`);
    return { ok: true };
  }

  /**
   * 【ARC-007 P0】**页面拉取已准备好的打开响应** —— vendor `openDocxPath` 的宿主对端。
   *
   * 返回与 vendor `OpenDocxResult`（`apps/docs/src/shared/ipc.ts:1-22`）同形状的
   * 对象：`{ path, name, dataUrl, hash }`。`dataUrl` 是一次性 handoff URL
   * （`documentViewHandoff.issueDocumentHandoff`），页面 fetch 一次即焚；
   * 宿主在 issue 时已确认路径在工作区内、字节可读、sha256 已算。
   *
   * **不提交会话**：只有页面回执（成功解析并显示）后 `settlePendingOpen(true)`
   * 才登记。失败/读盘错/坏档 → `ok:false`，待打开请求保留（可重试）但**不占**
   * 任何文件会话。
   */
  setConfirmRecovery(fn: typeof this.confirmRecovery): void {
    this.confirmRecovery = fn;
  }

  /** Only a live, sender-owned, already committed DOCX may receive a binary recovery snapshot. */
  async writeRecoveryCopy(docId: string, claimedPath: unknown, rawBytes: unknown): Promise<{ ok: boolean; reason?: string }> {
    const live = this.views.get(docId);
    const session = this.sessionOf(docId);
    if (!live || !session || live.editor !== null || live.workflowEngineId !== null ||
        !live.openedFilePath || !this.withinWorkspace(live.openedFilePath) ||
        typeof claimedPath !== "string" || physicalPath(claimedPath) !== session.key ||
        physicalPath(live.openedFilePath) !== session.key || live.view.webContents.isDestroyed?.() === true) {
      return { ok: false, reason: "没有与当前 DOCX 视图匹配的受信文件会话" };
    }
    if (!(rawBytes instanceof Uint8Array) && !(rawBytes instanceof ArrayBuffer)) {
      return { ok: false, reason: "恢复内容必须是二进制 DOCX" };
    }
    const bytes = Buffer.from(rawBytes instanceof ArrayBuffer ? new Uint8Array(rawBytes) : rawBytes);
    const expected = await session.revision;
    if (this.sessionOf(docId) !== session || this.views.get(docId) !== live ||
        live.view.webContents.isDestroyed?.() === true || !this.withinWorkspace(live.openedFilePath)) {
      return { ok: false, reason: "DOCX 恢复写入期间会话已改变" };
    }
    return writeDocRecovery({ filePath: live.openedFilePath, bytes, baseRevision: expected, dataRoot: dataRoot() });
  }

  async readOpened(
    docId: string,
    withinWorkspace: (p: string) => boolean,
  ): Promise<
    | { ok: true; result: { path: string; name: string; dataUrl: string; hash: string } }
    | { ok: false; reason: string }
  > {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    const pending = live.pendingOpen;
    if (pending === null) return { ok: false, reason: "没有待打开的文档（openPath 尚未请求）" };
    if (!withinWorkspace(pending.filePath)) {
      return { ok: false, reason: `文件已不在已知工作区内：${pending.filePath}` };
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(pending.filePath);
    } catch (err) {
      return { ok: false, reason: `无法读取文档：${err instanceof Error ? err.message : String(err)}` };
    }
    // readFile is asynchronous: meanwhile the user may switch A→B, close
    // the native view, or revoke the workspace. Without a post-await guard
    // the old read would mint A's handoff token while the pending session
    // already belongs to B (or no longer exists), mixing bytes and revision.
    if (this.views.get(docId) !== live ||
        live.pendingOpen !== pending ||
        live.view.webContents.isDestroyed?.() === true) {
      return { ok: false, reason: "读取期间文档视图已关闭或切换，拒绝过期字节响应" };
    }
    if (!withinWorkspace(pending.filePath)) {
      return { ok: false, reason: "读取期间文件已不在已知工作区内，拒绝字节响应" };
    }
    if (bytes.length === 0) return { ok: false, reason: "文档为空（拒绝把空文件交给页面）" };
    if (bytes.length > DOC_VIEW_SAVE_MAX_BYTES) {
      return { ok: false, reason: `文档过大：${bytes.length} 字节（上限 ${DOC_VIEW_SAVE_MAX_BYTES}）` };
    }
    // 坏档（不是 docx/zip）在页面解析时才会炸 —— 这里先做魔数检查，把
    // "打开了一个坏文件却显示空白页"变成一条可读的拒绝。
    if (!isLikelyDocx(bytes)) {
      return { ok: false, reason: `不是可读的 docx（魔数 ${bytes.subarray(0, 2).toString("latin1")}）` };
    }
    const diskHash = createHash("sha256").update(bytes).digest("hex");
    let recovery: Awaited<ReturnType<typeof inspectDocRecovery>>;
    try {
      recovery = await inspectDocRecovery(pending.filePath, dataRoot(), diskHash);
    } catch (err) {
      // A corrupt manifest, missing referenced snapshot or busy recovery
      // lease is NOT evidence that there is no unsaved draft. Present an
      // actionable error instead of opening the older disk file silently.
      return { ok: false, reason: err instanceof Error ? err.message : "DOCX 恢复文件检查失败" };
    }
    if (recovery) {
      if (!this.confirmRecovery) {
        return { ok: false, reason: "发现未保存 DOCX 恢复副本，但没有配置受信恢复确认，拒绝静默覆盖" };
      }
      let decision: "restore" | "discard" | "cancel" = "cancel";
      try { decision = await this.confirmRecovery({ filePath: pending.filePath, diskNewer: !recovery.basedOnCurrent }); }
      catch { /* cancel on prompt failure */ }
      if (decision === "cancel") return { ok: false, reason: "用户取消恢复确认，原文件未修改" };
      if (this.views.get(docId) !== live || live.pendingOpen !== pending ||
          live.view.webContents.isDestroyed?.() === true || !withinWorkspace(pending.filePath) ||
          (await fileContentVersion(pending.filePath)) !== diskHash) {
        return { ok: false, reason: "恢复确认期间文件或视图发生变化，拒绝加载旧快照" };
      }
      if (decision === "restore") {
        bytes = recovery.bytes;
        // Preserve the unsaved draft's original CAS baseline. Reopening an
        // older draft must never silently overwrite newer disk content.
        pending.recoveryBaseRevision = recovery.baseRevision;
      } else {
        try {
          await clearDocRecovery(pending.filePath, dataRoot(), undefined, diskHash);
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : "丢弃恢复副本失败，保留原文档" };
        }
      }
    }
    // inspectDocRecovery / user confirmation / fileContentVersion all await.
    // Rebind authorization AFTER their last await, even when no recovery was
    // found: a tab close or open A→B must not mint A\'s stale byte token.
    if (this.views.get(docId) !== live || live.pendingOpen !== pending ||
        live.view.webContents.isDestroyed?.() === true || !withinWorkspace(pending.filePath) ||
        (await fileContentVersion(pending.filePath)) !== diskHash) {
      return { ok: false, reason: "读取恢复副本期间文档、授权或磁盘版本已改变" };
    }
    // Bind the future CAS baseline to the bytes actually handed to the
    // editor, not an independent later read during the async open ACK. An
    // outside writer racing that ACK must never become implicitly authorized.
    pending.openedBytesRevision = diskHash;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const dataUrl = issueDocumentHandoff(bytes, {
      docId,
      filePath: pending.filePath,
      sha256: hash,
      owner: this.handoffOwner,
    });
    return {
      ok: true,
      result: {
        path: pending.filePath,
        name: basename(pending.filePath),
        dataUrl,
        hash,
      },
    };
  }

  /**
   * 【ARC-007 P0】**页面回执 / 放弃** —— 提交或丢弃待打开请求。
   *
   * vendor 页面在成功打开后会调 `getRecentFiles()`（`file-actions.ts:149`，
   * 成功路径上唯一必经的调用）；preload 把它转成 `openPathCommitted` 回执。
   * `accepted=true` 时才 `claimOpenedPath` 登记会话（打开失败、页面拒绝替换、
   * 解析失败都不会走到这里）；`accepted=false` 只丢弃待开请求，**不改变**现有
   * 会话与 CAS 基准。
   */
  settlePendingOpen(docId: string, accepted: boolean, withinWorkspace: (p: string) => boolean): DocViewResult {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    const pending = live.pendingOpen;
    if (pending === null) {
      // 幂等：没有待开请求时 accepted 回执是 no-op（页面可能重放回执）。
      return accepted ? { ok: true } : { ok: false, reason: "没有待打开的文档" };
    }
    if (!accepted) {
      live.pendingOpen = null;
      revokeDocumentHandoffs(docId, this.handoffOwner);
      log.info(`document view open-path: rejected by page ${docId} ${pending.filePath}`);
      return { ok: true };
    }
    if (!withinWorkspace(pending.filePath)) {
      live.pendingOpen = null;
      // Revoked workspace grants must revoke unclaimed DOCX bytes too.
      revokeDocumentHandoffs(docId, this.handoffOwner);
      return { ok: false, reason: `文件已不在已知工作区内：${pending.filePath}` };
    }
    const claim = this.claimOpenedPath(docId, pending.filePath, live.view.webContents);
    if (!claim.ok) return { ok: false, reason: claim.reason };
    live.pendingOpen = null;
    live.lastFailure = undefined;
    live.lastExternalMutation = undefined;
    live.openedFilePath = claim.session.filePath;
    if (pending.recoveryBaseRevision || pending.openedBytesRevision) {
      // Normal save compares against the version FROM WHICH this recovery
      // was generated, not the newer file that happened to be on disk when
      // the user chose Restore. External edits therefore produce conflict.
      const actualLoadedBase = Promise.resolve(pending.recoveryBaseRevision ?? pending.openedBytesRevision!);
      claim.session.revision = actualLoadedBase;
      live.openedFileRevision = actualLoadedBase;
    } else {
      live.openedFileRevision = claim.session.revision;
    }
    log.info(`document view open-path: committed ${docId} ${pending.filePath}`);
    return { ok: true };
  }

  /**
   * 【ARC-007 P1/GA1】**slides 打开链的宿主侧准备** —— 与 docs 的 `openPath`
   * 同一判据、同一 `pendingOpen` 状态机，区别只在**谁来解析**：
   *
   *  - docs：宿主把字节 issue 成 handoff，页面自己解析（`readOpened`）；
   *  - slides：vendor 渲染端只会消费 `OpenResult`（`shared/ipc.ts:91-98`），而
   *    `RenderSlide` 树由 vendor 主进程的解析器构造 —— 宿主经 `DocumentViewHostPorts`
   *    注入的 `slidesDeck` 执行器调**同一份** vendor 代码（`slidesBridge` 的
   *    `openDeck`），把结果原样交给页面。页面拿不到路径，也就没有"任意路径"这回事。
   *
   * 路径围栏、持锁预检、待打开登记、页面通知（`slides:opened` 事件）与 docs 完全
   * 一致；**会话仍然只在页面回执后提交**（`settleSlidesOpen` → `claimOpenedPath`）。
   * 返回的 `pending` 是给 handler 层拿去调执行器的（本方法不 import vendor）。
   */
  prepareSlidesOpen(
    docId: string,
    filePath: string,
    withinWorkspace: (p: string) => boolean,
  ): { ok: true; pending: { docId: string; filePath: string } } | { ok: false; reason: string } {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    if (live.editor !== "slides") {
      return { ok: false, reason: "这个视图不是演示文稿编辑器（open 时未声明 editor:\"slides\"）" };
    }
    if (typeof filePath !== "string" || filePath.trim() === "") {
      return { ok: false, reason: "文件路径为空" };
    }
    if (!withinWorkspace(filePath)) {
      return { ok: false, reason: `文件不在已知工作区内：${filePath}` };
    }
    const key = physicalPath(filePath);
    if (key === null) {
      return { ok: false, reason: `无法解析文件路径（断裂链接或不可访问），拒绝打开：${filePath}` };
    }
    const holder = this.sessions.get(key);
    if (holder !== undefined && holder.docId !== docId) {
      return {
        ok: false,
        reason: `该文件已在另一个视图打开（docId=${holder.docId}）：${holder.filePath}。同一文件同时只允许一个视图持有；请先关闭那个视图或切回它。`,
      };
    }
    live.pendingOpen = { docId, filePath, requestedAt: Date.now() };
    live.slidesOpen = null;
    log.info(`document view slides-open: prepared ${docId} ${filePath}`);
    return { ok: true, pending: { docId, filePath } };
  }

  /**
   * 【ARC-007 P1/GA1】**slides 打开链的页面回执** —— vendor slides 页在
   * `applyOpen(result)` 之后才走到这里（preload 的 `onOpened`/`consumePendingOpen`
   * 包装在把结果交给 React **之后**回执）。成功才提交会话；失败只丢弃待打开。
   *
   * `openResult.path` 必须与待打开请求的路径一致（同一物理路径）：执行器若被
   * 换掉/页面串了请求，宿主这里能发现，不把 A 文件的会话算到 B 头上。
   */
  settleSlidesOpen(
    docId: string,
    openResult: unknown,
    accepted: boolean,
    withinWorkspace: (p: string) => boolean,
  ): DocViewResult {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    const pending = live.pendingOpen;
    if (pending === null) return accepted ? { ok: true } : { ok: false, reason: "没有待打开的文档" };
    if (!accepted) {
      live.pendingOpen = null;
      log.info(`document view slides-open: rejected by page ${docId} ${pending.filePath}`);
      return { ok: true };
    }
    const claimedPath =
      openResult !== null && typeof openResult === "object"
        ? (openResult as { path?: unknown }).path
        : undefined;
    if (typeof claimedPath === "string" && claimedPath !== "" && claimedPath !== pending.filePath) {
      const samePhysical = physicalPath(claimedPath) === physicalPath(pending.filePath);
      if (!samePhysical) {
        live.pendingOpen = null;
        return {
          ok: false,
          reason: `打开结果与待打开请求不一致（请求 ${pending.filePath}，结果 ${claimedPath}）—— 拒绝提交`,
        };
      }
    }
    if (!withinWorkspace(pending.filePath)) {
      live.pendingOpen = null;
      return { ok: false, reason: `文件已不在已知工作区内：${pending.filePath}` };
    }
    const claim = this.claimOpenedPath(docId, pending.filePath, live.view.webContents);
    if (!claim.ok) return { ok: false, reason: claim.reason };
    live.pendingOpen = null;
    live.lastFailure = undefined;
    live.lastExternalMutation = undefined;
    live.openedFilePath = claim.session.filePath;
    live.openedFileRevision = claim.session.revision;
    log.info(`document view slides-open: committed ${docId} ${pending.filePath}`);
    return { ok: true };
  }

  /** 【ARC-007 P1/GA1】只读诊断：这个视图的编辑器域（未声明 = null）。 */
  editorOf(docId: string): LiveDocumentView["editor"] {
    return this.views.get(docId)?.editor ?? null;
  }

  /** AI 请求始终以实际 sender 和宿主打开的文件绑定会话；页面提供的 sessionId 无效。 */
  vendorAiContextForSender(sender: unknown): { sessionId: string; filePath: string } | null {
    const id = this.docIdForSender(sender);
    const live = id === null ? null : this.views.get(id);
    if (!live || (live.editor !== "pdf" && live.editor !== "markdown" && live.editor !== "html" &&
        live.editor !== "sheets" && !(live.editor === "slides" && live.url === "genoffice-app://slides/index.html")) ||
        !live.mcodeSessionId || !live.openedFilePath || !this.withinWorkspace(live.openedFilePath)) return null;
    return { sessionId: live.mcodeSessionId, filePath: live.openedFilePath };
  }

  /** 【ARC-007 P1/GA1】缓存一次已解析的 slides `OpenResult`（重拉不重复解析；
   *  换文件时由 `prepareSlidesOpen` 清空）。 */
  cacheSlidesOpenResult(docId: string, result: unknown, hash: string): void {
    const live = this.views.get(docId);
    if (!live) return;
    live.slidesOpen = { result, hash };
  }

  /** 【ARC-007 P1/GA1】取缓存的 `OpenResult`（无则 null）。只读诊断/重拉用。 */
  slidesOpenResultFor(docId: string): { result: unknown; hash: string } | null {
    const live = this.views.get(docId);
    if (!live) return null;
    return live.slidesOpen ?? null;
  }

  /** 【ARC-007 P1/GA1】装配期注入 `slides:opened` 推送（只推给**这个视图**的
   *  webContents；函数由装配方从 docId 反查）。 */
  setSlidesNotify(fn: ((docId: string, openResult: unknown) => void) | null): void {
    this.slidesNotify = fn;
  }

  /** 【ARC-007 P1/GA1】装配期注入"视图销毁前"的清理（slides 执行器按
   *  webContents id 持有 vendor 会话，必须有释放点）。`webContents.id` 在
   *  `close()`/`closeAll()` 里取于销毁之前。 */
  setViewDisposer(fn: ((webContentsId: number) => void) | null): void {
    this.viewDisposer = fn;
  }

  /** 【T29】装配期注入原厂四编辑器（pdf/markdown/html/sheets）的关闭守卫 ——
   *  vendor 的 `request*Close` 转发（见 `genofficeNativeVendor.ts` 的
   *  `requestNativeViewClose`）。只在装配期调用一次；
   *  null = 退回 Mcode 的 close-check 探针（修复前的旧行为）。 */
  setVendorCloseGuard(fn: DocumentViewHostPorts["vendorCloseGuard"] | null): void {
    this.vendorCloseGuard = fn;
  }

  /** 【ARC-007 P1/GA1】把执行器解析好的 `OpenResult` 推给页面（vendor 通道
   *  `slides:opened`）。页面没在听时静默 —— 它仍可在挂载时 `consumePendingOpen`。 */
  notifySlidesOpened(docId: string, openResult: unknown): void {
    if (this.slidesNotify === null) return;
    try {
      this.slidesNotify(docId, openResult);
    } catch {
      /* 推送失败不影响打开链（拉取路径仍在） */
    }
  }

  /**
   * 【ARC-007 P1/GA1】**slides 保存的目标路径** —— 只返回这个视图自己的打开会话
   * 路径（与 `saveOpenedFile` 同一判据：会话表是唯一真值，且每次保存都重新过围栏）。
   * 页面不传路径；handler 拿它去调 vendor 执行器（`slidesBridge.saveDeck`）。
   */
  slidesSaveTarget(
    docId: string,
    withinWorkspace: (p: string) => boolean,
  ): { ok: true; filePath: string } | { ok: false; reason: string } {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    if (live.editor !== "slides") {
      return { ok: false, reason: "这个视图不是演示文稿编辑器（open 时未声明 editor:\"slides\"）" };
    }
    const target = live.openedFilePath;
    if (target === null) return { ok: false, reason: "这个视图还没有打开任何演示文稿" };
    const session = this.sessionOf(docId);
    const targetKey = physicalPath(target);
    if (session === null || targetKey === null || session.key !== targetKey) {
      return {
        ok: false,
        reason: "保存目标与打开会话不一致（视图的打开记录已失效或被别的视图接管），拒绝保存",
      };
    }
    if (!withinWorkspace(target)) return { ok: false, reason: `演示文稿已不在已知工作区内：${target}` };
    return { ok: true, filePath: target };
  }

  /**
   * 【ARC-007 P1/GA1】**slides 保存成功后的版本推进** —— vendor 执行器把 deck
   * 写到 `slidesSaveTarget` 给的路径后，宿主重算盘上版本并同步到会话表与
   * `openedFileRevision`（与 `saveOpenedFile` 成功路径同一组字段）。
   *
   * 这里**不写盘**：写盘由 vendor 的 `savePptxToFile`（同一份实现）完成 —— 宿主
   * 复制一份 zip 逻辑等于两套保存语义。宿主负责的是围栏/会话/版本这三件事。
   */
  async recordSlidesSave(
    docId: string,
    withinWorkspace: (p: string) => boolean,
  ): Promise<
    | { ok: true; bytes: number; filePath: string; revision: string | null }
    | { ok: false; reason: string }
  > {
    const target = this.slidesSaveTarget(docId, withinWorkspace);
    if (!target.ok) return target;
    // Vendor does the actual PPTX write; this method only acknowledges it.
    // Capture the exact owner BEFORE awaits, so a close or document switch
    // cannot redirect its old revision into a newer independent session.
    const live = this.views.get(docId);
    const session = this.sessionOf(docId);
    if (!live || !session) {
      return { ok: false, reason: "保存目标的文档会话已失效，拒绝提交版本回执" };
    }
    let bytes = 0;
    let revision: string | null;
    try {
      const info = await stat(target.filePath);
      bytes = info.size;
      revision = await fileContentVersion(target.filePath);
    } catch (err) {
      return { ok: false, reason: `保存后无法读取文件：${err instanceof Error ? err.message : String(err)}` };
    }
    if (this.views.get(docId) !== live || this.sessionOf(docId) !== session ||
        live.openedFilePath !== target.filePath || live.view.webContents.isDestroyed?.() === true ||
        !withinWorkspace(target.filePath)) {
      return { ok: false, reason: "演示文稿在保存回执等待期间已关闭、切换或失去工作区权限，拒绝更新版本" };
    }
    const advanced = Promise.resolve(revision);
    session.revision = advanced;
    live.openedFileRevision = advanced;
    live.lastFailure = undefined;
    live.lastSaveConflict = undefined;
    live.lastExternalMutation = undefined;
    log.info(`document view slides-save: committed ${docId} ${target.filePath} (${bytes} bytes)`);
    return { ok: true, bytes, filePath: target.filePath, revision };
  }

  /**
   * 【ARC-007 P0】**页面替换守卫** —— vendor `confirmDocumentReplace()` 的宿主对端。
   *
   * 判据是**真实 dirty state**：preload 维护页面经 `reportCloseCheck` 上报的
   * 脏标记（vendor 页面在每次编辑/保存后都会上报，见 `App.tsx:5337-5346`），
   * 宿主在这里只读它，不猜。
   *
   * - 不脏 → `true`（直接允许替换）；
   * - 脏且提供了 `confirmDirty`（生产是 `dialog.showMessageBox` 的真人确认；
   *   套件注入自动应答）→ 用它的结果；
   * - 脏且**没有**确认端口 → `false`（fail-closed：宁可不让页面静默丢掉未保存
   *   修改，也不替用户点"放弃"）。
   */
  async confirmDocumentReplace(docId: string): Promise<boolean> {
    const live = this.views.get(docId);
    if (!live) return false;
    if (!live.pageDirty) return true;
    if (this.confirmDirty === null) return false;
    // The response to a dialog belongs to ONE view, document and edit epoch.
    // While it is visible the user may close/switch documents or keep editing:
    // a stale "Discard" must not authorize the newer unsaved state.
    const epoch = live.pageDirtyEpoch;
    const filePath = live.openedFilePath ?? live.pendingOpen?.filePath ?? null;
    const session = this.sessionOf(docId);
    const confirmed = await this.confirmDirty({ docId, filePath });
    return confirmed === true &&
      this.views.get(docId) === live &&
      live.view.webContents.isDestroyed?.() !== true &&
      this.sessionOf(docId) === session &&
      (live.openedFilePath ?? live.pendingOpen?.filePath ?? null) === filePath &&
      live.pageDirty === true &&
      live.pageDirtyEpoch === epoch;
  }

  /** Close protection for native Docs and embedded vendor editors. Docs query live
   * page state rather than trusting a stale dirty report; vendor editors delegate to
   * their own close/save guards below. Concurrent close clicks share one decision. */
  async closeWithDirtyProtection(docId: string): Promise<DocViewResult> {
    const pending = this.protectedCloses.get(docId);
    if (pending) return pending;
    const live = this.views.get(docId);
    if (!live) return this.close(docId);
    if (live.workflowEngineId !== null) return this.close(docId);
    // 【T29/T155】原厂五编辑器（pdf/markdown/html/sheets/slides）的关闭语义归各自
    // vendor 主进程：由原厂 `request*Close` 判断 dirty 并执行「保存 / 放弃 / 取消」；
    // Mcode 只负责转发决策，不复制脏状态或保存实现。PDF/Markdown/HTML/Sheets 的
    // 页面 preload 不订阅 `mcode:document-view:close-check`，旧探针会超时；Slides
    // 之前则被特殊分支直接关闭。现在五家统一经过同一 vendor 守卫。
    const vendorEditor = live.editor === 'pdf' || live.editor === 'markdown' ||
      live.editor === 'html' || live.editor === 'sheets' || live.editor === 'slides' ? live.editor : null;
    if (vendorEditor !== null) {
      // 没有注入守卫 = 无法问清未保存状态：宁可不关也不静默丢改动（fail-closed）。
      if (this.vendorCloseGuard === null) {
        return { ok: false, reason: '无法查询编辑器未保存状态（原厂关闭守卫未装配），拒绝关闭' };
      }
      if (live.view.webContents.isDestroyed?.() === true) {
        // 渲染进程已经没了：没有可保护的内存状态，直接销毁视图（与 Docs 探针
        // 的 fail-closed 不同 —— 那里页面还在、只是不响应，这里页面已不存在）。
        return this.close(docId);
      }
      const task = (async (): Promise<DocViewResult> => {
        let proceed: boolean;
        try {
          proceed = await this.vendorCloseGuard!({
            docId, editor: vendorEditor, webContents: live.view.webContents,
          });
        } catch (err) {
          return {
            ok: false,
            reason: `编辑器关闭检查失败：${err instanceof Error ? err.message : String(err)}`,
          };
        }
        if (proceed !== true) {
          return { ok: false, reason: '编辑器仍有未保存的修改（或保存未完成），已取消关闭' };
        }
        // 守卫在等用户选择期间，视图可能已被窗口级清理/另一个 close 销毁。
        if (this.views.get(docId) !== live) return { ok: true };
        return this.close(docId);
      })();
      this.protectedCloses.set(docId, task);
      try { return await task; }
      finally { if (this.protectedCloses.get(docId) === task) this.protectedCloses.delete(docId); }
    }
    const task = (async (): Promise<DocViewResult> => {
      const contents = live.view.webContents;
      if (typeof contents.send !== 'function' || contents.isDestroyed?.() === true) {
        return { ok: false, reason: '无法查询编辑器未保存状态，拒绝关闭' };
      }
      const answered = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.closeCheckWaiters.delete(docId);
          resolve(false);
        }, 2000);
        this.closeCheckWaiters.set(docId, (received) => {
          clearTimeout(timeout);
          this.closeCheckWaiters.delete(docId);
          resolve(received);
        });
        try { contents.send!('mcode:document-view:close-check'); }
        catch { clearTimeout(timeout); this.closeCheckWaiters.delete(docId); resolve(false); }
      });
      if (!answered) return { ok: false, reason: '编辑器未响应关闭检查；为保护未保存内容，拒绝关闭' };
      if (this.views.get(docId) !== live || contents.isDestroyed?.() === true) {
        return { ok: false, reason: '关闭检查期间视图已发生变化，拒绝过期关闭请求' };
      }
      if (!(await this.confirmDocumentReplace(docId))) {
        return { ok: false, reason: '文档有未保存修改，且没有取得有效的放弃修改确认' };
      }
      // The user explicitly confirmed closing this exact Docs view. Discard
      // its recovery copy BEFORE the view is destroyed, otherwise it could
      // resurrect edits the user deliberately discarded on next launch.
      if (live.pageDirty && live.openedFilePath) {
        // A restored draft may appear clean to the original renderer. Never
        // remove its only recovery copy without a confirmed discard.
        try { await clearDocRecovery(live.openedFilePath, dataRoot()); }
        catch (err) { return { ok: false, reason: `无法清除旧 DOCX 恢复副本，已取消关闭：${String(err)}` }; }
      }
      if (this.views.get(docId) !== live || contents.isDestroyed?.() === true) {
        return { ok: false, reason: "清理恢复副本期间文档视图已改变" };
      }
      return this.close(docId);
    })();
    this.protectedCloses.set(docId, task);
    try { return await task; }
    finally { if (this.protectedCloses.get(docId) === task) this.protectedCloses.delete(docId); }
  }

  /**
   * 【ARC-007 P0】装配期注入脏替换确认（生产是 `dialog.showMessageBox` 的真人
   * 确认，见 `ipc/index.ts`）。只在装配期调用一次；无头套件可注入自动应答。
   */
  /** Inject only the authoritative host services, not renderer-provided grants. */
  setDocsPrivilegedPorts(ports: DocsPrivilegedPorts | null): void {
    this.docsPrivileged = ports;
  }

  setDocsAiPorts(ports: DocsAiPorts | null): void {
    this.docsAi = ports;
  }

  setConfirmDirty(
    fn: ((input: { docId: string; filePath: string | null }) => Promise<boolean>) | null,
  ): void {
    this.confirmDirty = fn;
  }

  /**
   * 【ARC-007 P0】页面上报 dirty（vendor `reportCloseCheck` 的形状：
   * `{ dirty, autoSave, filePath }`）。只记 `dirty`；`autoSave`/`filePath` 是
   * vendor 的关闭守卫用的，Mcode 的替换守卫不据此做任何决定（保持最小）。
   */
  reportPageDirty(docId: string, dirty: boolean): void {
    const live = this.views.get(docId);
    if (!live) return;
    live.pageDirty = dirty === true;
    live.pageDirtyEpoch += 1;
    this.closeCheckWaiters.get(docId)?.(true);
  }

  /** 【ARC-007 P0】只读诊断：这个视图当前的待打开请求（没有则 null）。 */
  pendingOpenFor(docId: string): { docId: string; filePath: string; requestedAt: number } | null {
    return this.views.get(docId)?.pendingOpen ?? null;
  }

  /**
   * 【ARC-007 DocumentSessionRegistry】登记「docId 打开 filePath」这条会话。
   *
   * 判据（见文件头「打开会话表」）：
   *  - 路径先 `physicalPath` 归一（resolve + 跟链接 + 折叠大小写）；归一失败
   *    （断裂链接等）**fail-closed** 拒绝，不退回字符串比较 —— 那等于让同一
   *    文件换一种写法就能绕过独占。
   *  - 同一归一化键已被**另一个** docId 持有 → 拒绝并点名持有者。
   *  - 同一 docId 重开同一路径 = 刷新：重算 revision、更新 sender/时间。
   *  - 同一 docId 换到**另一个**路径 → 先摘旧会话再登记新会话（视图切换文件）。
   */
  private claimOpenedPath(docId: string, filePath: string, sender: unknown): ClaimResult {
    const key = physicalPath(filePath);
    if (key === null) {
      return { ok: false, reason: `无法解析文件路径（断裂链接或不可访问），拒绝打开：${filePath}` };
    }
    const existing = this.sessions.get(key);
    if (existing !== undefined && existing.docId !== docId) {
      return {
        ok: false,
        reason: `该文件已在另一个视图打开（docId=${existing.docId}）：${existing.filePath}。同一文件同时只允许一个视图持有；请先关闭那个视图或切回它。`,
      };
    }
    const previousKey = this.sessionKeyByDocId.get(docId);
    const previous =
      previousKey !== undefined && previousKey !== key ? (this.sessions.get(previousKey) ?? null) : null;
    if (previousKey !== undefined && previousKey !== key) this.releaseSession(docId);
    const session: DocumentSession = {
      docId,
      filePath,
      key,
      revision: fileContentVersion(filePath),
      sender,
      openedAt: Date.now(),
    };
    this.sessions.set(key, session);
    this.sessionKeyByDocId.set(docId, key);
    return { ok: true, session, refresh: previousKey === key, previous };
  }

  /** 摘掉 docId 的会话（close / 切换文件 / 发送失败回滚共用这一条路径）。 */
  private releaseSession(docId: string): void {
    const key = this.sessionKeyByDocId.get(docId);
    if (key === undefined) return;
    this.sessionKeyByDocId.delete(docId);
    const session = this.sessions.get(key);
    if (session !== undefined && session.docId === docId) this.sessions.delete(key);
  }

  /** 【ARC-007】内部反查：docId → 完整会话记录（含权威 revision / sender）。 */
  private sessionOf(docId: string): DocumentSession | null {
    const key = this.sessionKeyByDocId.get(docId);
    if (key === undefined) return null;
    const session = this.sessions.get(key);
    if (session === undefined || session.docId !== docId) return null;
    return session;
  }

  /** 【ARC-007】只读诊断：这条 docId 当前持有哪条会话（无则 null）。
   *  `revision` 是会话表里的**权威打开版本**（保存冲突判据的来源）；套件 await
   *  它来断言"关闭后重开拿到的是新版本"。不把 webContents 暴露出去。 */
  sessionFor(docId: string): {
    docId: string;
    filePath: string;
    key: string;
    revision: Promise<string | null>;
    openedAt: number;
  } | null {
    const session = this.sessionOf(docId);
    if (session === null) return null;
    return {
      docId: session.docId,
      filePath: session.filePath,
      key: session.key,
      revision: session.revision,
      openedAt: session.openedAt,
    };
  }

  /**
   * 【O10】按**归一化物理路径**取打开会话的权威版本（没有该路径的会话 → null）。
   *
   * 四个 vendor 编辑器（html/markdown/pdf/slides）的保存不经过本类的
   * `saveOpenedFile`，但它们的视图**同样**由 `open()` 的 kind 分支走
   * `claimOpenedPath` —— 会话表里已经有这四家的打开版本。保存守卫
   * （`documentSaveGuard.ts`）用它做乐观锁的 `expected`，与 docs 同一份数据源，
   * 不另记一份。
   */
  revisionForPath(physicalPathKey: string): Promise<string | null> | null {
    const session = this.sessions.get(physicalPathKey);
    return session === undefined ? null : session.revision;
  }

  /**
   * 【O10】保存成功后推进该路径的权威版本（与 docs 保存成功路径写的是
   * **同两个字段**：会话表的 `revision` 与视图的 `openedFileRevision`）。
   * 没有该路径的会话时什么都不做（独立运行/未知视图）。
   */
  advanceRevisionForPath(physicalPathKey: string, revision: string | null): void {
    const session = this.sessions.get(physicalPathKey);
    if (session === undefined) return;
    const advanced = Promise.resolve(revision);
    session.revision = advanced;
    const live = this.views.get(session.docId);
    if (live !== undefined && live.openedFilePath !== null &&
        physicalPath(live.openedFilePath) === physicalPathKey) {
      live.openedFileRevision = advanced;
      live.lastExternalMutation = undefined;
    }
  }

  /**
   * Record a successful disk mutation from Mcode's document-tool route. Never reload
   * or write the editor automatically: the user must explicitly choose to reload,
   * because the native view may contain unsaved local edits.
   */
  async noteExternalMutation(notice: DocumentMutationNotice): Promise<void> {
    const key = physicalPath(notice.filePath);
    if (key === null) return;
    const session = this.sessions.get(key);
    if (session === undefined) return;
    const live = this.views.get(session.docId);
    if (!live || live.openedFilePath === null || physicalPath(live.openedFilePath) !== key) return;
    const revisionAtStart = session.revision;
    let expected: string | null;
    try {
      expected = await revisionAtStart;
    } catch {
      expected = null;
    }
    // The user may have reloaded, closed, or saved the document while the revision was read.
    if (this.sessions.get(key) !== session || session.revision !== revisionAtStart ||
        this.views.get(session.docId) !== live || live.openedFilePath === null ||
        physicalPath(live.openedFilePath) !== key) return;
    if (notice.revision !== null && expected === notice.revision) return;
    live.lastExternalMutation = { at: Date.now() };
    log.info(`document view external mutation: ${notice.source} ${session.docId} ${notice.filePath}`);
  }

  /**
   * 【ARC-007】**保存通道** —— 页面把编辑后的字节写回它自己打开的那份文件。
   *
   * ## 为什么必须由宿主写，而不是让页面自己写
   *
   * 页面（vendor 编辑器渲染端）本来就只能通过 preload 请求写盘；我们这层
   * preload 刻意不暴露文件系统。让宿主做这件事的代价是**宿主必须自己把围栏补齐**：
   *
   * 1. **只写回本视图打开过的那份路径**（`openedFilePath`）。页面不能"另存到
   *    任意工作区文件"—— 否则一个被投毒的编辑器页就能覆盖工作区里任何 `.docx`。
   *    路径比较用 `samePath`（词法+大小写，与 `pathGuard` 同一判据）。
   * 2. **再验一次工作区**：`openPath` 时的围栏只对"打开"负责；保存时工作区集合
   *    可能已经变了（项目被移除），所以每次保存都重新问 `withinWorkspace`。
   * 3. **大小上限**：`DOC_VIEW_SAVE_MAX_BYTES`，防止页面用一条消息撑爆内存/磁盘。
   * 4. **冲突检测（宿主侧乐观锁）**：保存前重算盘上内容的 sha256（
   *    `fileContentVersion`，与 `document.edit` 的 `expectedRevision` 同一算法），
   *    与 `openPath` 时记下的版本比较；不一致 → `{ ok:false, reason:"conflict" }`
   *    且**不写盘**。页面不知道自己读的是哪个版本（vendor 的 `saveDocx` 只有
   *    `(path, data, auto)` 三参，证据见 `openedFileRevision` 字段注释），所以
   *    expected 由宿主记 —— 页面若能携带版本，走 `expectedRevision` 参数。
   * 5. **原子写**：先用 `atomicReplaceFile`（同目录临时文件 + rename），中途失败
   *    不会留下半份文件。
   * 6. **比较与写入在同一份租约里（ARC-007 TOCTOU 收窄）**：第 4 步的"重算 →
   *    比较"和第 5 步的"替换"必须是**一个临界区**。否则两个保存（另一个窗口 /
   *    另一个 Mcode 进程 / Agent 的 `file.writeFile`）可以在"都读到旧版本"之后
   *    各自通过比较、再先后 rename —— 最后一个静默覆盖前一个。现在整段包进
   *    `withOsFileLease`（与 `ipc/files.ts` 的 FILE_WRITE、Excel/PDF/DOCX 编辑
   *    **同一份**宿主级跨进程租约，`@main/lib/osFileLease`；不另起第二套锁）：
   *    同一路径的写者被串行，先落盘者的结果让后到者重算时必然看到新版本 →
   *    后到者按第 4 步报 conflict。代价是 `atomicReplaceFile` 的临时文件会与目标
   *    同目录出现（它本来就是这样）；租约文件是 `${real}.mcode-lock`，释放时删除。
   *    租约等待超时（`FILE_VERSION_CONFLICT`）按 conflict 回包，不静默覆盖。
   *
   * 返回 `{ ok:true, bytes, filePath, revision }` 让页面能显示"已保存 N 字节"，并给下一步
   * （页面携带 revision 再来）留位；失败带人话原因。冲突时额外带 `currentRevision`，
   * 页面/面板能显示"盘上现在是哪一版"。
   */
  async saveOpenedFile(
    docId: string,
    bytes: Uint8Array,
    withinWorkspace: (p: string) => boolean,
    expectedRevision?: string | null,
  ): Promise<
    | { ok: true; bytes: number; filePath: string; revision: string | null }
    | {
        ok: false;
        /** 冲突时**恰好**是 `"conflict"`；其余失败是人话原因。 */
        reason: string;
        /** 仅冲突时存在：盘上内容的当前 sha256（页面/面板据此显示"现在是哪一版"）。 */
        currentRevision?: string | null;
        /** 仅冲突时存在：给页面显示的人话说明。 */
        message?: string;
      }
  > {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    const target = live.openedFilePath;
    if (target === null) return { ok: false, reason: "这个视图还没有打开任何文档" };
    // 【ARC-007 DocumentSessionRegistry】**持有者校验**：会话表是"谁开着这份文件"
    // 的唯一真值。视图的 openedFilePath 与会话由 openPath 一起写、一起摘，正常
    // 路径上不会不一致；这里仍然每保存一次都核对（fail-closed），因为保存是唯一
    // 会写盘的操作 —— 状态一旦漂移，宁可不写也不能写到一条已被别的视图接管的路径上。
    // 校验在**取租约之前**做（与会话表同为进程内状态，早拒少抢一次锁）；真正
    // 防并发覆盖的是租约内的重算比较。将来放开多视图时，把这里从"必须唯一持有"
    // 改成"必须仍是共享持有者之一"，并把 expected 的默认值改读会话表里的权威
    // revision（见文件头）。
    const session = this.sessionOf(docId);
    const targetKey = physicalPath(target);
    if (session === null || targetKey === null || session.key !== targetKey) {
      return {
        ok: false,
        reason: "保存目标与打开会话不一致（视图的打开记录已失效或被别的视图接管），拒绝保存",
      };
    }
    if (!withinWorkspace(target)) {
      return { ok: false, reason: `文档已不在已知工作区内：${target}` };
    }
    if (!(bytes instanceof Uint8Array)) {
      return { ok: false, reason: "保存内容不是字节数组" };
    }
    if (bytes.byteLength === 0) {
      return { ok: false, reason: "保存内容为空（拒绝把文档清空后落盘）" };
    }
    if (bytes.byteLength > DOC_VIEW_SAVE_MAX_BYTES) {
      return {
        ok: false,
        reason: `保存内容过大：${bytes.byteLength} 字节（上限 ${DOC_VIEW_SAVE_MAX_BYTES}）`,
      };
    }

    // 【ARC-007】冲突判据：调用方显式给了 expectedRevision（将来页面携带版本）就用它；
    // 否则用**打开会话表里记下的权威版本**（页面携带不了版本时的乐观锁，见字段注释）。
    // 会话的 revision 与 live.openedFileRevision 在 openPath / 保存成功时一起推进 ——
    // 单视图切片里是同一个 Promise 对象；取会话表这一份是为了让"权威版本只有一个
    // 存放处"，将来多视图共享会话时不必再改这里的选择。
    //
    // ⚠️ expected 必须在**取租约之前**快照下来。两个并发保存若都等到租约内才
    // await，后到者会读到先到者刚推进的新版本 —— 于是"基于打开时内容"的乐观锁被
    // 自己的并发保存绕过（两边都成功，后者覆盖前者）。
    // 先快照、后取锁：先到者落盘后，后到者在锁内重算必然看到新版本 → conflict。
    const expected = expectedRevision !== undefined ? expectedRevision : await session.revision;

    type SaveOutcome =
      | { ok: true; bytes: number; filePath: string; revision: string | null }
      | { ok: false; reason: string; currentRevision?: string | null; message?: string };

    try {
      // 【ARC-007】比较 + 写入在**同一份租约**内：`withOsFileLease` 与
      // `ipc/files.ts` 的 FILE_WRITE、Excel/PDF/DOCX 编辑共用同一份宿主级
      // 跨进程租约（`@main/lib/osFileLease`），不另起第二套锁。此前"重算 →
      // 比较"与 `atomicReplaceFile` 分属两步，两个保存可以都读到旧版本、都通过
      // 比较、再先后 rename —— 后者静默覆盖前者（注释里登记的 TOCTOU）。
      const result = await withOsFileLease(target, async (real): Promise<SaveOutcome> => {
        const current = await fileContentVersion(real);
        if (current !== expected) {
          // ⚠️ 顺序即判据：冲突检查必须在**写盘之前**，且冲突路径上一个字节都不落盘。
          const message =
            "文档已被别处改动（另一个窗口、Agent 或外部编辑器）—— 为避免覆盖对方刚保存的内容，本次保存未执行。请重新打开后再改。";
          live.lastSaveConflict = {
            expectedRevision: expected,
            currentRevision: current,
            message,
            at: Date.now(),
          };
          log.warn(
            `document view save conflict: ${docId} ${target} expected=${String(expected)} current=${String(current)}`,
          );
          return { ok: false, reason: "conflict", currentRevision: current, message };
        }

        // 诊断/测试接缝：生产是 no-op；回归网在这里把"胜者持锁窗口"拉长以做真并发断言。
        await this.beforeAtomicReplace(real);

        // The editor may have been closed, rebound to another document or
        // removed from its workspace while waiting for the lease / above await.
        // This is the final authorization boundary before disk mutation.
        if (this.views.get(docId) !== live || this.sessionOf(docId) !== session ||
            live.openedFilePath !== target || live.view.webContents.isDestroyed?.() === true ||
            !withinWorkspace(real)) {
          return { ok: false, reason: "文档会话在等待保存期间已关闭、切换或失去工作区权限，拒绝旧保存写盘" };
        }

        // 与 `file.writeFile` 共用同一份原子替换（`@main/lib/atomicFile`）。
        await atomicReplaceFile(real, bytes);
        const revision = await fileContentVersion(real);
        // A close during the OS write cannot undo the already-published bytes.
        // In that case report the retained file explicitly, but NEVER restore
        // an obsolete session/revision into a different live document.
        if (this.views.get(docId) !== live || this.sessionOf(docId) !== session ||
            live.openedFilePath !== target || live.view.webContents.isDestroyed?.() === true) {
          return { ok: false, reason: `保存期间文档视图已关闭或切换；磁盘文件已保留在 ${target}，请重新打开确认` };
        }
        // 保存成功后，本视图的"打开时版本"推进到刚写下的这一版 —— 用户连续保存两次
        // （第二次基于第一次的结果）不该被自己的上一次保存判成冲突。会话表里的
        // 权威 revision 必须**一起**推进（两个字段同一个 Promise 对象，见 openPath）。
        const advanced = Promise.resolve(revision);
        live.openedFileRevision = advanced;
        session.revision = advanced;
        live.lastFailure = undefined;
        live.lastSaveConflict = undefined;
        live.lastExternalMutation = undefined;
        log.info(`document view saved: ${docId} ${target} (${bytes.byteLength} bytes)`);
        return { ok: true, bytes: bytes.byteLength, filePath: target, revision };
      });
      if (result.ok) {
        // Only AFTER the writer releases the same OS lease: clearing inside
        // its callback would deadlock. Never let cleanup failure undo a saved DOCX.
        try { await clearDocRecovery(target, dataRoot(), result.revision); }
        catch (err) { log.warn(`saved DOCX, but recovery cleanup failed: ${String(err)}`); }
      }
      return result;
    } catch (err) {
      // 租约等待超时 = 另一个进程正持有同一路径的写租约。按 conflict 回包
      // （不静默覆盖）—— 此时没有读过盘，不给 currentRevision（不编造版本）。
      if (err instanceof Error && /^FILE_VERSION_CONFLICT/.test(err.message)) {
        log.warn(`document view save lease busy: ${docId} ${target}`);
        return {
          ok: false,
          reason: "conflict",
          message:
            "文档正被另一个进程编辑（跨进程文件租约未取得）—— 为避免并发覆盖，本次保存未执行。请稍后重试。",
        };
      }
      return { ok: false, reason: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * 【ARC-007】**新建文档的首次保存** —— vendor `saveDocxNew(defaultName, data)`
   * （`genoffice/apps/docs/src/shared/ipc.ts:472-481`，调用点
   * `file-actions.ts:1101`）的宿主对端。
   *
   * ## vendor 语义（实读）
   *
   * 「first save of a new document: silently writes into the default folder, no
   * dialog」。页面只传**文件名**（`defaultName`）与字节；vendor 主进程把它放进
   * 自己的 `defaultSaveDir()` 并保证唯一（`docs-main.ts:5044-5084` 的
   * `uniquePathIn(defaultSaveDir(), defaultName)`）。**页面从不传绝对路径** ——
   * 它也没有"另存到任意路径"的表达方式（那是 `saveDocxAs`/`saveDocxTo`）。
   *
   * ## Mcode 的决定：路径完全由宿主给，页面连文件名都只是"建议"
   *
   *  - **目录**：这个视图**已打开文档**所在目录（`openedFilePath` 的
   *    `dirname`）—— 那是唯一一个已经通过工作区围栏的落点。视图没有打开任何
   *    文档 = 没有可信目录，**拒绝**（`{ ok:false }`），不退回"主进程任意目录"。
   *  - **文件名**：`<页面给的 defaultName 的词干，清洗后>-<短随机>.docx`；清洗
   *    去掉路径分隔符/保留名/控制字符，空则 `untitled`。随机后缀保证不覆盖已有
   *    文件（vendor 的 `uniquePathIn` 同一职责；真正不覆盖由 OS fs.link 保证）。**页面给的字符串永远不会被当成
   *    路径**（`extname`/`basename` 语义只取名字，`join` 之后仍在目录内）。
   *  - **围栏**：目标路径生成后**再问一次 `withinWorkspace`**（目录可能已从工作区
   *    移除），并通过 `physicalPath` 归一确认父目录未被链接替换出工作区。
   *  - **登记会话**：成功后走 `claimOpenedPath` 同一张会话表 —— 新文件从此是
   *    这个视图的打开文档，之后的 `saveDocx` 走既有 `saveOpenedFile` 通道；
   *    同时把 `openedFilePath` 指向它（页面后续的普通保存只认这个字段）。
   *  - **大小上限**：与 `saveOpenedFile` 共用 `DOC_VIEW_SAVE_MAX_BYTES`；
   *    空字节拒绝（不落一个 0 字节 docx）。
   *
   * 与 vendor 的差别只有一处，且是收紧：vendor 的 `defaultSaveDir()` 是应用级
   * 目录；Mcode 把它换成"该视图已打开的文档所在工作区目录"。
   */
  async saveNewFile(
    docId: string,
    bytes: Uint8Array,
    withinWorkspace: (p: string) => boolean,
    defaultName: string,
  ): Promise<
    | { ok: true; bytes: number; filePath: string; revision: string | null }
    | { ok: false; reason: string }
  > {
    const live = this.views.get(docId);
    if (!live) return { ok: false, reason: "文档视图不存在或已关闭" };
    const anchor = live.openedFilePath;
    if (anchor === null) {
      return {
        ok: false,
        reason: "这个视图还没有打开任何文档，无法确定新文件应落在哪个工作区目录",
      };
    }
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: "保存内容不是字节数组" };
    if (bytes.byteLength === 0) return { ok: false, reason: "保存内容为空（拒绝把文档清空后落盘）" };
    if (bytes.byteLength > DOC_VIEW_SAVE_MAX_BYTES) {
      return {
        ok: false,
        reason: `保存内容过大：${bytes.byteLength} 字节（上限 ${DOC_VIEW_SAVE_MAX_BYTES}）`,
      };
    }
    const dir = dirname(anchor);
    if (!withinWorkspace(dir)) {
      return { ok: false, reason: `打开文档所在目录已不在已知工作区内：${dir}` };
    }
    const safeName = safeNewDocName(defaultName);
    let target: string | null = null;
    try {
      target = uniquePathIn(dir, safeName);
    } catch (err) {
      return { ok: false, reason: `无法为新文档分配路径：${err instanceof Error ? err.message : String(err)}` };
    }
    if (target === null || !withinWorkspace(target)) {
      return { ok: false, reason: `新文档路径不在已知工作区内：${String(target)}` };
    }
    // 父目录的物理形态也必须仍在工作区内（链接/junction 替换目录的绕过）。
    const physicalTarget = physicalPath(target);
    if (physicalTarget === null || !withinWorkspace(physicalTarget)) {
      return { ok: false, reason: `新文档路径的物理位置不在已知工作区内：${target}` };
    }
    // ⚠️ 顺序：**先原子发布、后登记会话**。反过来会把原本打开的会话提早摘掉。
    // 随机文件名只是选候选路径，不能防第三方并发创建；OS link 才是 no-replace。
    // 发布后若登记失败，不可按名字 rm（别的写者可能已修改该文件）。
    let revision: string | null;
    try {
      revision = await withOsFileLease(target, async (real): Promise<string | null> => {
        // The prior existsSync/random-name probe is not a lock. Another
        // process can create this target after the probe but before a Win32
        // rename, which silently overwrites their bytes. Reuse the shared
        // atomicReplaceFile writer for a private staged copy, then publish it
        // with the OS atomic no-replace primitive (hard-link / EEXIST).
        // This is a thin Mcode Host commit adapter; GenOffice remains the
        // document editor and the source of format semantics.
        if (!withinWorkspace(real)) throw new Error("新文档目标已移出受信工作区，拒绝写入");
        const staging = join(dirname(real), `.${randomUUID()}.mcode-stage`);
        try {
          await atomicReplaceFile(staging, bytes);
          await this.beforeAtomicReplace(real);
          // The await above may span a tab close, renderer crash or a document
          // switch. A detached view must never publish an orphan file and
          // then resurrect its ownership in claimOpenedPath.
          if (this.views.get(docId) !== live || live.openedFilePath !== anchor ||
              live.view.webContents.isDestroyed?.() === true) {
            throw new Error("文档视图在保存期间被关闭或切换，已取消新建且保留原文档");
          }
          await link(staging, real); // existing file / symlink → EEXIST; never overwrite
          return await fileContentVersion(real);
        } finally {
          await rm(staging, { force: true });
        }
      });
    } catch (err) {
      if (err instanceof Error && /^FILE_VERSION_CONFLICT/.test(err.message)) {
        return {
          ok: false,
          reason:
            "目标路径正被另一个进程写入（跨进程文件租约未取得）—— 本次保存未执行，请稍后重试。",
        };
      }
      return { ok: false, reason: `写入失败：${err instanceof Error ? err.message : String(err)}` };
    }
    // The file is already visible to other processes. A second editor may
    // update it between atomic link() and a rejected session claim; deleting
    // by name here would remove THAT writer's newer data. Preserve the file
    // and explicitly tell the user where to recover it. Safe automatic
    // cleanup would require an OS atomic compare-and-unlink primitive.
    if (this.views.get(docId) !== live || live.openedFilePath !== anchor ||
        live.view.webContents.isDestroyed?.() === true) {
      return { ok: false, reason: `文档视图在提交期间已关闭或切换，新建文件已保留在 ${target}，请人工确认` };
    }
    const claim = this.claimOpenedPath(docId, target, live.view.webContents);
    if (!claim.ok) {
      return { ok: false, reason: `${claim.reason}；新建文件可能已被其他写者接手，已保留在 ${target}，请人工确认` };
    }
    const advanced = Promise.resolve(revision);
    live.openedFilePath = target;
    live.openedFileRevision = advanced;
    claim.session.revision = advanced;
    live.lastFailure = undefined;
    live.lastSaveConflict = undefined;
    log.info(`document view saved new: ${docId} ${target} (${bytes.byteLength} bytes)`);
    return { ok: true, bytes: bytes.byteLength, filePath: target, revision };
  }

  /**
   * 【ARC-007】取某个视图的 webContents 句柄。生产只给**主进程内部**用
   * （当前唯一调用方是真 Electron U1 探针与内部通道的身份反查）；渲染端拿不到
   * 它（不在 RpcMap 里）。
   */
  webContentsOf(docId: string): DocumentViewWebContentsLike | null {
    return this.views.get(docId)?.view.webContents ?? null;
  }

  /**
   * 【ARC-007】把一条 IPC 的 `event.sender` 映射回 docId。**身份由宿主决定**，
   * 页面说了不算 —— 页面改自己的 URL/参数都影响不到这一步。
   *
   * 为什么需要:视图 preload 的 `openDocxPath` 只带路径;宿主要知道"是哪个视图在请求",
   * 才能保证 A 视图的请求不会被算到 B 头上。`sender` 是 Electron 给的 webContents
   * 句柄,preload 里拿不到、也伪造不了。
   */
  docIdForSender(sender: unknown): string | null {
    if (!sender || typeof sender !== "object") return null;
    for (const [docId, live] of this.views) {
      if (live.view.webContents === sender) return docId;
    }
    return null;
  }

  /** 销毁全部（主窗口 closed / 应用退出）。幂等。 */
  closeAll(): void {
    for (const [docId, live] of [...this.views]) {
      revokeDocumentHandoffs(docId, this.handoffOwner);
      // 【ARC-006 Gate A 缺口】凭据绑定随视图一起摘（窗口没了，视图就是孤儿，
      // 令牌不能再发给一个已销毁的 webContents id）。
      this.editorCredentials?.release(docId);
      // 【ARC-007 P1/GA1】vendor 会话同样随视图释放（`id` 必须在销毁前取）。
      const viewWcId = (live.view.webContents as { id?: unknown }).id;
      if (typeof viewWcId === "number" && this.viewDisposer !== null) {
        try {
          this.viewDisposer(viewWcId);
        } catch {
          /* 清理失败不影响关闭语义 */
        }
      }
      this.detachAndDestroy(live);
      this.views.delete(docId);
      // 【ARC-007 DocumentSessionRegistry】closeAll 是窗口级/退出级清理，会话
      // 必须与视图同生共死 —— 只清 views 不清 sessions 会让"主窗口关了、文件
      // 会话还在"残留到下一次 open。
      this.releaseSession(docId);
    }
    // 兜底：理论上 views 与 sessionKeyByDocId 一一对应；若有只登记未建视图的会话
    // （不存在于当前代码路径），也会在这里被清空，不让它跨生命周期存活。
    this.sessions.clear();
    this.sessionKeyByDocId.clear();
  }

  /** 退出路径的显式清理：关全部视图、摘窗口钩子，并拒绝之后的 open。 */
  dispose(): void {
    this.disposed = true;
    this.closeAll();
    this.nativeDocsRelease?.();
    this.nativeDocsRelease = null;
    if (this.cleanupWindow !== null && this.cleanupHandler !== null) {
      try {
        this.cleanupWindow.removeListener?.("closed", this.cleanupHandler);
      } catch {
        /* 窗口已经没了 */
      }
    }
    this.cleanupWindow = null;
    this.cleanupHandler = null;
  }

  /** 诊断快照（不含 webContents 句柄 —— 那些不越过这一层）。 */
  list(): DocViewSnapshot[] {
    return [...this.views.values()].map((live) => ({
      docId: live.docId,
      url: live.url,
      visible: live.visible,
      bounds: { ...live.bounds },
      ...(live.lastFailure !== undefined ? { lastFailure: { ...live.lastFailure } } : {}),
      ...(live.lastSaveConflict !== undefined ? { lastSaveConflict: { ...live.lastSaveConflict } } : {}),
      ...(live.lastExternalMutation !== undefined ? { lastExternalMutation: { ...live.lastExternalMutation } } : {}),
    }));
  }

  /** 【ARC-007】把 webContents 的失败事件记到视图上（成功后清空）。
   *  两个事件都只记诊断、不改状态 —— 视图仍然"在"，只是页面没起来。 */
  private watchFailures(live: LiveDocumentView): void {
    const wc = live.view.webContents;
    // FULL-1: checking the initial open URL is insufficient. A vendor page,
    // script or HTTP redirect could later navigate this same privileged
    // WebContentsView to unrelated HTML, retaining its Mcode preload.
    // Keep file-based editors on the same entry document; the original
    // Node-RED editor may change routes but only within its exact origin
    // (including its bound port). WebContents.loadURL() itself remains a
    // Host-authorized action and updates live.url on explicit open().
    const blockUntrustedNavigation = (...args: unknown[]): void => {
      const event = args[0] as { preventDefault?: () => void } | undefined;
      const detail = args[1] as { url?: unknown } | string | undefined;
      const proposedUrl = typeof detail === "string" ? detail :
        detail && typeof detail.url === "string" ? detail.url : null;
      let allowed = false;
      if (proposedUrl !== null) {
        const checked = checkDocumentViewUrl(proposedUrl);
        if (checked.ok) {
          const origin = new URL(live.url);
          const target = new URL(checked.url);
          allowed = origin.protocol === "file:"
            ? target.protocol === "file:" &&
              target.hostname === origin.hostname && target.pathname === origin.pathname
            : target.origin === origin.origin;
        }
      }
      if (!allowed) {
        event?.preventDefault?.();
        log.warn(`document view blocked navigation: ${live.docId}`);
      }
    };
    wc.on?.("will-navigate", blockUntrustedNavigation);
    wc.on?.("will-redirect", blockUntrustedNavigation);
    wc.on?.("did-fail-load", (...args: unknown[]) => {
      // Electron 签名:(event, errorCode, errorDescription, validatedURL, isMainFrame)
      const code = typeof args[1] === "number" ? args[1] : null;
      const desc = typeof args[2] === "string" ? args[2] : "unknown";
      // -3 = ERR_ABORTED(被新导航取代),不是真失败。
      if (code === -3) return;
      live.lastFailure = {
        kind: "load",
        reason: `页面加载失败(${String(code ?? "?")}): ${desc}`,
        at: Date.now(),
      };
      log.warn(`document view load failed: ${live.docId} ${live.lastFailure.reason}`);
    });
    wc.on?.("render-process-gone", (...args: unknown[]) => {
      const details = args[1] as { reason?: unknown } | undefined;
      const reason = typeof details?.reason === "string" ? details.reason : "unknown";
      live.lastFailure = { kind: "render-gone", reason: `渲染进程退出: ${reason}`, at: Date.now() };
      log.warn(`document view renderer gone: ${live.docId} ${reason}`);
    });
  }

  private navigate(live: LiveDocumentView): void {
    try {
      // 导航失败只记日志：open 已经成功创建了视图，调用方拿到的应是"视图在"，
      // 页面是否加载成功由 `did-fail-load`/`render-process-gone` 记进 lastFailure。
      void Promise.resolve(live.view.webContents.loadURL(live.url)).catch(() => {
        log.warn(`document view navigation failed: ${live.docId} (${live.url})`);
      });
    } catch {
      log.warn(`document view navigation threw: ${live.docId}`);
    }
  }

  /** One native-layout seam for visible and parked editors. A failed
   *  setBounds never enters the dedup cache: the next identical measurement
   *  retries rather than treating a missing OS layout as already applied. */
  private applyNativeBounds(live: LiveDocumentView, bounds: DocViewRect, operation: string): void {
    const prev = live.appliedBounds;
    if (prev && prev.x === bounds.x && prev.y === bounds.y &&
        prev.width === bounds.width && prev.height === bounds.height) return;
    try {
      live.view.setBounds(bounds);
      live.appliedBounds = { ...bounds };
    } catch (err) {
      log.warn(
        `document view ${operation} failed: ${live.docId} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private applyBounds(live: LiveDocumentView): void {
    this.applyNativeBounds(live, live.bounds, "setBounds");
  }

  private parkOffscreen(live: LiveDocumentView): void {
    this.applyNativeBounds(live, offscreenBounds(live.bounds), "park");
  }

  private detachAndDestroy(live: LiveDocumentView): void {
    const win = this.liveWindow();
    try {
      win?.contentView.removeChildView(live.view);
    } catch {
      /* 窗口/视图正在拆除 */
    }
    try {
      if (live.view.webContents.isDestroyed?.() !== true) live.view.webContents.close();
    } catch (err) {
      log.warn(
        `document view close failed: ${live.docId} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log.info(`document view closed: ${live.docId}`);
  }

  /** 活窗口；已销毁的窗口按 null 处理（省得每个调用点各判一次）。 */
  private liveWindow(): DocumentViewHostWindow | null {
    const win = this.getWindow();
    if (win === null) return null;
    if (win.isDestroyed?.() === true) return null;
    return win;
  }

  /** 主窗口关了就销毁全部视图 —— 视图是窗口的子面，窗口没了它们就是孤儿。 */
  private installWindowCleanup(win: DocumentViewHostWindow): void {
    if (this.cleanupWindow === win && this.cleanupHandler !== null) return;
    if (this.cleanupWindow !== null && this.cleanupHandler !== null) {
      try {
        this.cleanupWindow.removeListener?.("closed", this.cleanupHandler);
      } catch {
        /* 旧窗口已经没了 */
      }
    }
    const handler = (): void => {
      this.closeAll();
    };
    try {
      win.on?.("closed", handler);
    } catch {
      /* 假窗口/已销毁窗口没有事件面 —— 退回 dispose() 兜底 */
    }
    this.cleanupWindow = win;
    this.cleanupHandler = handler;
  }
}

/**
 * 生产单例（与 BrowserManager 同一形状）。窗口钩子在第一次 open 时安装：
 * 那时主窗口一定存在，模块加载时则未必。
 */
export const documentViewHost = new DocumentViewHost({ getMainWindow });
setDocumentMutationObserver((notice) => documentViewHost.noteExternalMutation(notice));
