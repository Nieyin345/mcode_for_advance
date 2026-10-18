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
 * ## 安全判据（台账 ARC-007「CSP 自限、离线自足」）
 *
 * **URL 白名单是 fail-closed 的**：只放行 `file://`（repo 内 GenOffice 快照的编辑器页）
 * 与本机回环 `http(s)://127.0.0.1 | localhost | [::1]`。远程地址、`data:`、`javascript:`
 * 一律在**创建视图之前**拒绝 —— 顺序是判据的一部分：先拒后建，拒绝路径上不能留下
 * 已经加载过远程内容的 webContents。
 *
 * webPreferences 三项逐项钉死：`contextIsolation: true`（页面碰不到宿主作用域）、
 * `nodeIntegration: false`（没有 Node 能力）、`sandbox: true`（渲染进程进 Chromium
 * 沙箱）。没有 preload —— 这一版视图里还没有文档桥，宁可少给能力。
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

interface LiveDocumentView {
  docId: string;
  view: DocumentViewLike;
  /** 已经接受的 URL（已规范化）。 */
  url: string;
  /** 最近一次渲染端量出来的可见几何。 */
  bounds: DocViewRect;
  visible: boolean;
  /** 最近一次加载/渲染失败(诊断用;成功后清空)。 */
  lastFailure?: { kind: "load" | "render-gone"; reason: string; at: number };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
  private readonly getWindow: () => DocumentViewHostWindow | null;
  private readonly createView: (webPreferences: DocumentViewWebPreferences) => DocumentViewLike;
  /** 已经挂过 `closed` 清理钩子的那个窗口（换窗口时先摘旧的）。 */
  private cleanupWindow: DocumentViewHostWindow | null = null;
  private cleanupHandler: (() => void) | null = null;
  /** dispose 之后不再接受 open —— 退出路径上的迟到调用不该复活视图。 */
  private disposed = false;

  constructor(ports: DocumentViewHostPorts) {
    this.getWindow = ports.getMainWindow;
    this.createView = ports.createView ?? defaultCreateView;
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
    if (!live) return { ok: true };
    this.detachAndDestroy(live);
    this.views.delete(docId);
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
    try {
      wc.send(VENDOR_MENU_COMMAND_CHANNEL, VENDOR_OPEN_PATH_COMMAND, filePath);
    } catch (err) {
      return { ok: false, reason: `发送打开请求失败：${err instanceof Error ? err.message : String(err)}` };
    }
    live.lastFailure = undefined;
    log.info(`document view open-path: ${docId} ${filePath}`);
    return { ok: true };
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
    }
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
      // 页面是否加载成功由后续的文档桥/状态事件回答（这一版还没有桥）。
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
