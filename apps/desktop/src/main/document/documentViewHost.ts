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
import { atomicReplaceFile } from "@main/lib/atomicFile.js";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";
// 【ARC-007 DocumentSessionRegistry】路径归一化的**唯一一份**实现。`physicalPath`
// 会 resolve（吃掉 `.`/`..`/多余分隔符）、跟随 symlink/junction 到真实目的地、
// 并在 Windows/macOS 上折叠大小写 —— 与 `pathGuard.samePath` 同一套判据的物理版。
// 本模块不能 import `pathGuard`（它会拉进 repositories → db → electron），
// `realPathWithin` 就是为这种场景拆出来的零依赖叶子（已经给了 fileSnapshot 用）。
import { physicalPath } from "@main/lib/realPathWithin.js";
import type { DocViewOpenInput, DocViewRect, DocViewResult, DocViewSnapshot } from "@contracts/ipc";

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
  on?(event: "did-fail-load", listener: (...args: unknown[]) => void): unknown;
  on?(event: "render-process-gone", listener: (...args: unknown[]) => void): unknown;
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
  createView?: (webPreferences: DocumentViewWebPreferences) => DocumentViewLike;
  /** 【ARC-007】**诊断/测试接缝**：在保存租约内、版本比较通过之后、`atomicReplaceFile`
   *  之前调用。生产不传（no-op）。存在的唯一理由是让回归网能**确定性地**把"胜者
   *  持锁的窗口"拉长 —— 从而断言落败者在租约串行下真的没走到替换那一步；没有它，
   *  并发断言只能靠时序碰运气。 */
  beforeAtomicReplace?: (realPath: string) => void | Promise<void>;
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

interface LiveDocumentView {
  docId: string;
  view: DocumentViewLike;
  /** 已经接受的 URL（已规范化）。 */
  url: string;
  /** 最近一次渲染端量出来的可见几何。 */
  bounds: DocViewRect;
  visible: boolean;
  /** 【ARC-007】这个视图**当前打开的那份文档**（`openPath` 成功发送后记下）。
   *
   *  保存通道只认它：页面不能把内容写到"任意工作区路径"，只能写回**它自己被
   *  打开时那份文件** —— 否则一个被投毒的编辑器页就能覆盖工作区里任意的 `.docx`。
   *  取值为 null 表示视图里还没有文档（只有起始页），此时保存一律拒绝。 */
  openedFilePath: string | null;
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
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `不是合法的 URL：${raw.slice(0, 200)}` };
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
  private readonly beforeAtomicReplace: (realPath: string) => void | Promise<void>;
  /** 已经挂过 `closed` 清理钩子的那个窗口（换窗口时先摘旧的）。 */
  private cleanupWindow: DocumentViewHostWindow | null = null;
  private cleanupHandler: (() => void) | null = null;
  /** dispose 之后不再接受 open —— 退出路径上的迟到调用不该复活视图。 */
  private disposed = false;

  constructor(ports: DocumentViewHostPorts) {
    this.getWindow = ports.getMainWindow;
    this.createView = ports.createView ?? defaultCreateView;
    this.beforeAtomicReplace = ports.beforeAtomicReplace ?? (() => undefined);
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
    const checked = checkDocumentViewUrl(input.url);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    if (this.disposed) return { ok: false, reason: "文档视图宿主已释放" };

    const win = this.liveWindow();
    if (win === null) return { ok: false, reason: "主窗口尚未就绪，无法创建文档视图" };
    this.installWindowCleanup(win);

    const existing = this.views.get(input.docId);
    if (existing) {
      const urlChanged = existing.url !== checked.url;
      existing.url = checked.url;
      existing.bounds = input.bounds;
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
      view = this.createView({
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
      visible: false,
      openedFilePath: null,
      openedFileRevision: null,
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

    // 【ARC-007】诊断钩子要在导航**之前**装上，否则首帧的失败会漏掉。
    this.watchFailures(live);
    this.views.set(input.docId, live);
    this.navigate(live);
    if (input.visible) {
      live.visible = true;
      this.applyBounds(live);
    } else {
      this.parkOffscreen(live);
    }
    log.info(`document view opened: ${input.docId} visible=${input.visible}`);
    return { ok: true };
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
    const live = this.views.get(docId);
    if (!live) {
      // 【ARC-007 DocumentSessionRegistry】视图已经不在了，会话也必须摘 —— 否则
      // 这条路径会被一个不存在的视图永久占住，别的视图再打开同一文件会被误拒。
      // （正常路径上 close 与 releaseSession 成对；这一句兜住"视图先被窗口清理
      // 销毁、close 后到"的迟到调用。）
      this.releaseSession(docId);
      return { ok: true };
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
    const wc = live.view.webContents;
    if (typeof wc.send !== "function") {
      return { ok: false, reason: "当前视图不支持接收打开请求" };
    }
    // 【ARC-007 DocumentSessionRegistry】**先登记会话，再发打开请求**。
    // 判定放在发送之前：被拒的 openPath 不能留下任何"路径已占用"的痕迹，
    // 也不能把一份注定失败的打开请求发给页面。发送失败时回滚登记（见下）。
    const claim = this.claimOpenedPath(docId, filePath, wc);
    if (!claim.ok) return { ok: false, reason: claim.reason };
    try {
      wc.send(VENDOR_MENU_COMMAND_CHANNEL, VENDOR_OPEN_PATH_COMMAND, filePath);
    } catch (err) {
      // 登记了但没发出去：会话要回到发送前的状态 —— 否则一条实际没打开的路径
      // 会被占住，别的视图再打开同一文件会被误拒；若是"同一视图换文件"失败，
      // 也不能把旧文件的会话弄丢（视图里还在编辑它）。
      if (claim.previous !== null) {
        this.sessions.set(claim.previous.key, claim.previous);
        this.sessionKeyByDocId.set(docId, claim.previous.key);
      } else {
        this.releaseSession(docId);
      }
      return { ok: false, reason: `发送打开请求失败：${err instanceof Error ? err.message : String(err)}` };
    }
    live.lastFailure = undefined;
    live.openedFilePath = claim.session.filePath;
    // 【ARC-007】记下**打开时**的内容版本（异步读盘算 sha256；保存通道会 await
    // 同一个 Promise，见 `openedFileRevision` 字段的说明）。会话表持有同一个
    // Promise —— 单视图下两份是同一对象，不是各算一份。
    live.openedFileRevision = claim.session.revision;
    log.info(`document view open-path: ${docId} ${filePath}`);
    return { ok: true };
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
      return await withOsFileLease(target, async (real): Promise<SaveOutcome> => {
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

        // 与 `file.writeFile` 共用同一份原子替换（`@main/lib/atomicFile`）。
        await atomicReplaceFile(real, bytes);
        const revision = await fileContentVersion(real);
        // 保存成功后，本视图的"打开时版本"推进到刚写下的这一版 —— 用户连续保存两次
        // （第二次基于第一次的结果）不该被自己的上一次保存判成冲突。会话表里的
        // 权威 revision 必须**一起**推进（两个字段同一个 Promise 对象，见 openPath）。
        const advanced = Promise.resolve(revision);
        live.openedFileRevision = advanced;
        session.revision = advanced;
        live.lastFailure = undefined;
        live.lastSaveConflict = undefined;
        log.info(`document view saved: ${docId} ${target} (${bytes.byteLength} bytes)`);
        return { ok: true, bytes: bytes.byteLength, filePath: target, revision };
      });
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
    }));
  }

  /** 【ARC-007】把 webContents 的失败事件记到视图上（成功后清空）。
   *  两个事件都只记诊断、不改状态 —— 视图仍然"在"，只是页面没起来。 */
  private watchFailures(live: LiveDocumentView): void {
    const wc = live.view.webContents;
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

  private applyBounds(live: LiveDocumentView): void {
    try {
      live.view.setBounds(live.bounds);
    } catch (err) {
      log.warn(
        `document view setBounds failed: ${live.docId} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private parkOffscreen(live: LiveDocumentView): void {
    try {
      live.view.setBounds(offscreenBounds(live.bounds));
    } catch (err) {
      log.warn(
        `document view park failed: ${live.docId} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
