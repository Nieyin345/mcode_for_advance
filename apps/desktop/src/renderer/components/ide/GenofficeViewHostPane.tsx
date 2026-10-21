/**
 * 【ARC-007】**GenOffice 编辑器视图宿主面板**（渲染端）—— 把已经就绪的
 * `documentView.*` IPC 接到 IDE 的中栏。
 *
 * ## 它在链路的哪一段
 *
 * `main/document/documentViewHost.ts` 负责 `WebContentsView` 的生命周期（创建、
 * bounds、显隐、销毁），本组件只做三件事：
 *   1. 从 GenOffice CLI 路径推出**仓库内编辑器页**的 `file://` 地址（页面按文件
 *      类型路由到 docs / sheets / slides 三个 module 的构建产物）；
 *   2. 把一个占位 `div` 的窗口像素矩形（`getBoundingClientRect` → 整数）经
 *      `documentView.bounds` 持续同步给主进程；`ResizeObserver` 覆盖"面板被拖动/
 *      窗口缩放"这类几何变化；
 *   3. 挂载时 `open`、卸载时 `close`。
 *
 * ## 为什么卸载必须 close（而不是像浏览器面板那样只 hide）
 *
 * `WebContentsView` 是叠在 BrowserWindow 上的 **OS 级子视图**，它不属于 React 的
 * DOM 树 —— 组件卸载时 DOM 占位 div 没了，但这个原生视图仍然会漂浮在窗口最上层，
 * 盖住别的面板（与浏览器面板"视图在主进程保活、由容器 show/hide"不同：那个面板
 * 是全局单例标签页，用户切回来要保住浏览状态；这里的每一个面板实例只对应**当前
 * 打开的文件**，关掉就没有再保活的理由）。所以卸载路径上必须 `close`，让主进程
 * 摘除并销毁视图；`close` 在宿主侧是幂等的（不存在 = 已经关了）。
 *
 * ## 为什么"编辑器页未构建"要显式说出来
 *
 * GenOffice 是**仓库内固定 commit 的快照**（`.gitignore` 的 `/genoffice/`），编辑器页
 * 是它的构建产物（`genoffice/apps/<module>/out/renderer/index.html`）。没构建时
 * `file://` 导航会失败，`WebContentsView` 只会呈现一块空白 —— 用户根本不知道是
 * "没构建"还是"坏了"。CLI 快照与编辑器页来自同一份快照：`document.capabilities()`
 * 报告的 CLI 缺失（或路径形状不认识）就是"页面不可用"的**可判定**信号，此时直接
 * 画出错误说明与重试入口，不创建视图。
 *
 * ## sheets / slides 的打开入口：宿主侧没有对端（显式降级，不装空白）
 *
 * 只有 docs 能真正打开指定文件。表格与演示文稿的**打开通道**长在 GenOffice
 * **自己的主进程**里，而 Mcode 宿主不跑那份主进程。这条结论是逐条核对 vendor
 * 渲染端所有可达入口之后得出的（不是"没找"）：
 *
 *  - **`menu:command` 只有 docs 订阅**。在 `genoffice/apps/sheets/src` 与
 *    `genoffice/apps/slides/src` 里都 grep 不到 `menu:command` 订阅者；docs 是
 *    唯一监听它的页面（`genoffice/apps/docs/src/preload/index.ts:250`）。宿主发
 *    `menu:command("open-path", path)` 对 sheets/slides 等于发进没有收件人的通道。
 *  - **sheets**：渲染端唯一的打开入口 `handleInspectWorkbook`
 *    （`apps/sheets/src/renderer/App.tsx:4604`）→ `desktopApi.selectWorkbook()`
 *    （`App.tsx:4617`）→ `ipcRenderer.invoke("workbook:select")`
 *    （`apps/sheets/src/preload/index.ts:107`）；handler 在 vendor 主进程里读
 *    `queuedWorkbookPaths`（按 vendor 的 webContents id 键，
 *    `apps/sheets/src/main/sheets-main.ts:2231`）再跑 `prepareWorkbookForOpen` +
 *    `openWorkbookSession`（`:2811`、`:2873`）。渲染端其余"打开"线索也都回到主进程：
 *    `hasQueuedWorkbook` 读同一张 Map（`sheets-main.ts:2785`；渲染端调用点
 *    `App.tsx:1901` / `renderer/main.tsx:91`），`menu:action` 只承载**不带路径**的
 *    菜单动作（`preload/index.ts:438`、`shared/ipc-channels.ts:95`）。也就是说，
 *    即便宿主把"有排队文档"喂成 true，渲染端下一步仍要向 vendor 主进程要一份
 *    `WorkbookFile` —— 那条路同样没有对端。
 *  - **slides**：renderer 订阅的是 `slides:menu`
 *    （`apps/slides/src/preload/index.ts:384`），`MenuCommand` 联合
 *    （`apps/slides/src/shared/ipc.ts:1269`）里只有 `'open'`（弹**文件对话框**，
 *    `App.tsx:2318`），没有任何带路径的命令。按路径打开只有 `slides:open-path` /
 *    `slides:consume-pending-open` 两条 `invoke`（`preload/index.ts:149`、`:150`），
 *    handler 在 vendor 主进程跑 `preparePresentationForOpen` + `openAndBuild`
 *    （`apps/slides/src/main/slides-main.ts:1458`）；`consume-pending-open` 读的
 *    `pendingByWc` 只由 vendor 主进程的 `createSlidesView` 填充（`:343`、`:5064`），
 *    宿主无从写入。
 *  - **其余入口也核过**：两家的 URL 参数只有 `?mode=`（页签/观众模式）与 sheets 的
 *    `?openingWorkbook=1`（只是首帧 spinner 标志，`App.tsx:726`），都不携带路径；
 *    渲染端没有 `postMessage` 打开通道，也没有"把待打开路径写进 localStorage /
 *    IndexedDB 再自读"的排队表 —— 排队事实只存在于 vendor 主进程的内存 Map。
 *
 * 宿主注册这些通道只能伪造一份 `WorkbookFile` / `OpenResult`（真实内容由 vendor 的
 * xlsx/pptx 引擎在那边组装），所以这里**不伪造**：对 sheets/slides 不创建视图、
 * 不发 open，直接画出「表格/演示文稿的打开暂不可用」+ 明确原因（vendor 的打开通道
 * 在其主进程）。否则用户看到的是一个已挂载但被 vendor 页面自身启动逻辑炸掉
 * （`window.desktopApi.getAiSettings()`
 * 无保护，`apps/sheets/src/renderer/App.tsx:1729`；`window.slidesApi.onMenuCommand`
 * 无保护，`apps/slides/src/renderer/App.tsx:2312`）的空面板 —— 分不清"没构建"和"没接线"。
 *
 * ## 已知边界（如实记录，不在本切片里假装解决）
 *
 * - docs 的打开/保存桥已接（`documentViewPreload.ts`）；sheets/slides 的打开入口
 *   未接，见上一节。
 * - CLI 存在但三个 module 的 `out/renderer` 没构建时，渲染端没有可用的 stat IPC
 *   去探测文件是否存在 —— 该情形由主进程的导航失败日志暴露，界面层只能保证
 *   **CLI 缺失**这一分支是显式的（见上）。
 * - 原生视图永远盖在 DOM 之上：错误条只占占位区**上方**的一条，不试图浮在视图上。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import type { DocViewRect } from "@contracts/ipc";
import { genofficeAppForPath, type GenofficeApp } from "@contracts/genofficeFileRoute";

/** GenOffice 编辑器 module 名（与 vendor 的 `rendererUrl` host 同名）。 */
export type GenofficeEditorHost = GenofficeApp;

/** Pure vendor app choice only: unsupported extensions must never default to docs.
 * This deliberately does not decide authorization or renderer/sidecar readiness. */
export const editorHostForPath = genofficeAppForPath;

/**
 * 【ARC-007】哪些编辑器页在宿主里有**打开对端**。
 *
 * 判据不是"vendor 有没有某个通道"，而是"宿主能不能在不伪造数据的前提下回它"：
 *
 *  - **docs**：`menu:command("open-path", path)` 由宿主直接下发路径、页面自己读盘
 *    （`apps/docs/src/preload/index.ts:250` 的 `onMenuCommand` → `App.tsx` 的
 *    `case "open-path"`）。
 *  - **slides**：宿主装配了 slides 执行器（`slidesBridge` + `slidesExecutor.ts`）时，
 *    打开链把**宿主已过围栏的路径**交给 vendor 的解析器（`openPptx` 同一份实现）
 *    构造 `OpenResult`，再经 `slides:opened`/`slides-read-opened` 交给页面；保存
 *    写回同一份打开会话。页面拿到的是渲染树，**拿不到任意路径**。
 *    装配事实经 `document.capabilities.hosts.slides` 报告（`genoffice/` 快照缺失
 *    或未构建时为 false）—— 这里只信能力报告，不猜。
 *  - **sheets**：**没有**对端（打开需要宿主交出一份 vendor 主进程组装好的
 *    `WorkbookFile`，含 sessionId 与分块读取的会话）。本切片未接，恒为 false。
 */
export function hasHostOpenChannel(host: GenofficeEditorHost | undefined, slidesHost = false,
  nativeHosts: Partial<Record<"pdf" | "markdown" | "html" | "sheets" | "slides", boolean>> = {}): boolean {
  return host === "docs" || (host === "slides" && (slidesHost || nativeHosts.slides === true)) ||
    ((host === "pdf" || host === "markdown" || host === "html" || host === "sheets") && nativeHosts[host] === true);
}

/**
 * 用 GenOffice *原版*编辑器构建产物，不复制编辑内核。
 *
 * CLI 的两种权威形状（见主进程 resolveGenofficeCliPath）：
 *   开发：<repo>/genoffice/packages/cli/dist/genoffice.cjs
 *   安装：<resources>/genoffice/cli/genoffice.cjs
 * 但前者属于源仓快照、后者随安装包资源；两者不可混推。只接受这两个
 * 完整文件后缀，避免路径里碰巧出现 /genoffice/packages/cli/ 就误导到其它页面。
 *
 * 本函数只解决**定位**，不证明资源已经打包；发行版如未携带原厂
 * apps/<host>/out/renderer，宿主必须按资源清单拒绝并报告缺失。
 */
export function editorPageUrl(cliPath: string, host: GenofficeEditorHost): string | null {
  const normalized = cliPath.replace(/\\/g, "/");
  const devCli = "/genoffice/packages/cli/dist/genoffice.cjs";
  const packagedCli = "/genoffice/cli/genoffice.cjs";
  const suffix = normalized.endsWith(devCli) ? devCli
    : normalized.endsWith(packagedCli) ? packagedCli
    : null;
  if (suffix === null) return null;
  const installOrRepoRoot = normalized.slice(0, -suffix.length);
  // Both source and staged release use the same vendor-relative apps/... tree.
  const pagePath = `${installOrRepoRoot}/genoffice/apps/${host}/out/renderer/index.html`;
  // encodeURI fails to encode # and ?, so spaces in workstation path names
  // can turn into a fragment/query and break the original vendor page URL.
  // Encode every path segment, preserving only a Windows drive-letter colon.
  const encoded = pagePath.split("/").map((part, index) =>
    index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)
  ).join("/");
  const withScheme = /^[A-Za-z]:\//.test(pagePath)
    ? `file:///${encoded}`
    : `file://${encoded}`;
  return `${withScheme}?mode=tab`;
}

/**
 * Stable per-file native-view identity (not a content fingerprint).
 *
 * The previous 32-bit FNV-1a + string length collided for two different
 * same-length DOCX paths, causing the view keyed by docId to be reused for
 * a different file. Length does not make a 32-bit hash collision-safe.
 *
 * Two differently seeded 64-bit FNV-1a streams, each over the exact UTF-16
 * code units encoded as two bytes, give a bounded 128-bit identity while
 * remaining synchronous in the sandboxed renderer (Web Crypto is async).
 * This is not an authorization mechanism: the host must still validate the
 * requested path. Keep the complete result within the contract's 200 chars.
 */
export function stableDocId(filePath: string): string {
  const mask = 0xffff_ffff_ffff_ffffn;
  const prime = 0x100000001b3n;
  let first = 0xcbf29ce484222325n;
  let second = 0x84222325cbf29ce4n;
  for (let i = 0; i < filePath.length; i++) {
    const code = filePath.charCodeAt(i);
    const lo = BigInt(code & 0xff);
    const hi = BigInt(code >>> 8);
    first = ((first ^ lo) * prime) & mask;
    first = ((first ^ hi) * prime) & mask;
    second = ((second ^ lo) * prime) & mask;
    second = ((second ^ hi) * prime) & mask;
  }
  const hex = (value: bigint): string => value.toString(16).padStart(16, "0");
  return `genoffice-view-${hex(first)}${hex(second)}-${filePath.length}`;
}

/** 占位矩形的窗口坐标 → 契约 bounds（整数、非负、尺寸至少 1）。 */
function measureBounds(el: HTMLElement): DocViewRect | null {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  const clamp = (v: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(v)));
  return {
    // 契约里 x/y 的下限是 0：元素被滚动出一部分时 rect.left/top 可能为负，
    // 直接发给宿主会被 zod 拒绝（视图就不动了），这里夹到合法区间。
    x: clamp(r.left, 0, 16384),
    y: clamp(r.top, 0, 16384),
    // 宽高至少 1：0 尺寸在宿主眼中是个永远不可见的视图。
    width: clamp(r.width, 1, 16384),
    height: clamp(r.height, 1, 16384),
  };
}

/**
 * 关闭视图并吞掉一切失败。
 *
 * 卸载 / 迟到 open 这两条路径上**没有界面可报错**，静默是正确取舍；但两种拒绝
 * 形态都要兜住：桌面 preload 回一个 rejected Promise（`.catch` 接得住），手机端
 * `webApi` 的 `webUnsupported` 是**同步抛出**的（`.catch` 接不住，必须 try/catch）。
 * 留一个 unhandled rejection 或同步异常会让 React 19 整棵卸载。
 */
/** A file's docId is intentionally stable across tabs and re-mounts.
 * A previous component's delayed open acknowledgement must not destroy a
 * newer component's *same* native view. Track renderer owners separately
 * from the durable host identity; the Host stays sole file/revision owner. */
const activeNativePaneOwners = new Map<string, symbol>();

function closeQuietly(docId: string): void {
  try {
    void api.documentView.close({ docId }).catch(() => {});
  } catch {
    /* web 传输同步拒绝 —— 卸载路径无事可做 */
  }
}

export function GenofficeViewHostPane({ filePath, active = true }: { filePath: string; active?: boolean }) {
  const { t } = useI18n();
  const mcodeSessionId = useSessionStore((s) => s.activeSessionId);
  // A dock may translate the stage without changing its width/height.
  // ResizeObserver alone does not report pure translations.
  const dockSide = useSessionStore((s) => s.paneLayout?.placements?.find(p =>
    p.content?.kind === "document" && p.content.documentId === filePath)?.side);
  // 读能力报告走 useRpc（硬规矩 7）；本组件只用它拿 CLI 路径推仓库根。
  const caps = useRpc(() => api.document.capabilities(), [], { toastOnError: false });
  const [openError, setOpenError] = useState<string | null>(null);
  /** 【ARC-007】页面**加载/渲染失败**的诊断（与 openError 是两回事：open 成功了、
   *  页面却崩了）。vendor 编辑器页依赖 preload 桥，而本宿主刻意不给 preload ——
   *  没有这条，用户只看到一片空白，分不清"没加载"与"加载了但崩了"。 */
  const [pageFailure, setPageFailure] = useState<{ kind: string; reason: string } | null>(null);
  /** 【ARC-007】保存冲突（宿主侧乐观锁拦下的保存）。与 pageFailure 分开显示：
   *  页面没坏，只是**保存被拒**，用户需要先重新载入再改。 */
  const [saveConflict, setSaveConflict] = useState<{ message: string; at: number } | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const docId = useMemo(() => stableDocId(filePath), [filePath]);
  const host = editorHostForPath(filePath);
  const cliPath = caps.data?.cli.available === true ? caps.data.cli.path : null;
  // 【ARC-007 P1/GA1】打开对端是**能力报告**（装配事实），不是格式猜测：
  // `document.capabilities.hosts` 由主进程报告（docs 恒真；slides 取决于 vendor
  // 执行器是否装配；sheets 未接恒假）。
  const slidesHostAvailable = caps.data?.hosts?.slides === true;
  const nativeHosts = { pdf: caps.data?.hosts?.pdf, markdown: caps.data?.hosts?.markdown, html: caps.data?.hosts?.html,
    sheets: caps.data?.hosts?.sheets, slides: caps.data?.hosts?.slidesNative };
  // 【ARC-007】只给有宿主对端的编辑器页算 URL：没有对端时建视图只会得到一张
  // vendor 页面自身启动逻辑炸掉的空面板。`null` 让下面两个 effect 全部跳过。
  const url =
    cliPath !== null && host !== undefined && hasHostOpenChannel(host, slidesHostAvailable, nativeHosts)
      ? host === "pdf" || host === "markdown" || host === "html" || host === "sheets" ||
          (host === "slides" && nativeHosts.slides === true)
        ? `genoffice-app://${host}/index.html`
        : editorPageUrl(cliPath, host)
      : null;
  /** 没有打开对端的编辑器页：**显式降级**分支（与"未构建"是两回事，文案与原因也分开）。 */
  const unsupportedHost = host === undefined ? "unrecognized" : hasHostOpenChannel(host, slidesHostAvailable, nativeHosts) ? null : host;

  useEffect(() => {
    if (url === null) return;
    const stage = stageRef.current;
    if (stage === null) return;

    const owner = Symbol(docId);
    activeNativePaneOwners.set(docId, owner);
    let disposed = false;
    let raf = 0;
    let attempts = 0;
    /** 上一次发给宿主的几何（去重：rect 没变就不发，IPC 每个 rAF 一发很浪费）。 */
    let lastKey = "";
    let observer: ResizeObserver | null = null;

    const sendOpen = (bounds: DocViewRect): void => {
      // 【ARC-007 P1/GA1】slides 视图必须声明编辑器域：宿主据此把 openPath/保存
      // 接到 vendor 解析器与 slides 会话（docs 不声明，行为不变）。
      const pending = api.documentView.open({
        docId,
        url,
        bounds,
        visible: activeRef.current,
        ...(host === "slides" ? { editor: "slides" as const } : {}),
        ...((host === "pdf" || host === "markdown" || host === "html" || host === "sheets")
          ? { editor: host, filePath } : {}),
        ...(host === "slides" && nativeHosts.slides === true ? { filePath } : {}),
        ...(mcodeSessionId && (host !== "slides" || nativeHosts.slides === true) ? { mcodeSessionId } : {}),
      });
      lastKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      void pending.then(
        (result) => {
          if (disposed) {
            // open 在路上的时候组件卸载了：立即关一次，否则视图会被创建出来
            // 变成没人管得到的孤儿（原生视图不随 DOM 卸载，见文件头）。
            // Cleanup has already issued close. The *only* case requiring
            // another close is an orphan where no newer component owns this
            // docId. Closing unconditionally would destroy the fresh view.
            if (!activeNativePaneOwners.has(docId)) closeQuietly(docId);
            return;
          }
          if (!result.ok) {
            setOpenError(result.reason);
            return;
          }
          // Switching away while open is in flight must not leave an OS child
          // view floating above another pane.
          if (!activeRef.current) void api.documentView.hide({ docId }).catch(() => {});
          // 【ARC-007】open 成功后再请求"打开这份文档":视图里是编辑器起始页,
          // 不请求的话用户看到的是空白文档。宿主侧会核对路径在工作区内。
          void api.documentView.openPath({ docId, filePath }).then(
            (opened) => {
              if (!opened.ok && !disposed) setOpenError(opened.reason);
            },
            (err: unknown) => {
              // Transport failures do not appear in host.list().lastFailure:
              // no page-side request was accepted. Surface this distinct
              // error instead of silently leaving a blank native editor.
              if (!disposed) setOpenError(err instanceof Error ? err.message : String(err));
            },
          );
        },
        (err: unknown) => {
          if (!disposed) setOpenError(err instanceof Error ? err.message : String(err));
        },
      );
    };

    const sync = (): void => {
      if (disposed || !activeRef.current) return;
      const bounds = measureBounds(stage);
      if (bounds === null) return;
      const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      if (key === lastKey) return;
      lastKey = key;
      void api.documentView.bounds({ docId, bounds }).then(
        (result) => {
          if (!result.ok && !disposed) setOpenError(result.reason);
        },
        () => {
          /* 几何同步失败下一帧还会再来；不在每次 resize 里刷错误条 */
        },
      );
    };

    const schedule = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    };

    // 首帧布局可能还没量出尺寸（面板刚挂载 / 被折叠）—— 有界重试，等不到就
    // 显式报"占位区没有可用尺寸"，绝不把 0×0 或凭空猜的矩形发给宿主。
    const start = (): void => {
      if (disposed) return;
      const bounds = measureBounds(stage);
      if (bounds !== null) {
        sendOpen(bounds);
        // open 之后补一次同步：open 与首帧测量之间布局可能又变了。
        schedule();
      } else if (attempts < 120) {
        attempts += 1;
        raf = requestAnimationFrame(start);
      } else {
        setOpenError(t("ide.genoffice.viewHostStageTooSmall"));
      }
    };
    start();

    // ResizeObserver 覆盖面板被拖动分隔条/窗口缩放导致的尺寸变化；窗口 resize
    // 再兜一层（元素尺寸没变、只是位置变了的情形，例如上方工具栏换行）。
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(stage);
    }
    window.addEventListener("resize", schedule);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      // **原生视图不随 DOM 卸载**；only the latest mount can close
      // this stable docId. A stale cleanup/ack must not close a replacement.
      if (activeNativePaneOwners.get(docId) === owner) {
        activeNativePaneOwners.delete(docId);
        closeQuietly(docId);
      }
    };
    // url/docId 变了要重建视图；retryNonce 是显式重试。t 只影响错误文案。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, url, retryNonce]);

  // A cached document pane retains the same native view while another content
  // tab is selected. Hide/show moves the OS child without destroying its editor.
  useEffect(() => {
    if (url === null) return;
    try {
      if (!active) {
        void api.documentView.hide({ docId }).catch(() => {});
      } else {
        const bounds = stageRef.current && measureBounds(stageRef.current);
        if (bounds) {
          void api.documentView.bounds({ docId, bounds })
            .then((result) => result.ok ? api.documentView.show({ docId }) : undefined)
            .catch(() => {});
        }
      }
    } catch { /* native views are unavailable in the web fallback */ }
  }, [active, docId, url, dockSide]);

  // 【ARC-007】轮询宿主快照里的 lastFailure。为什么是轮询而不是事件:
  // 宿主当前只有 list() 一条读口(没有推送通道),而这条诊断的价值是"出问题时
  // 看得见"——2 秒一次、只在面板挂载且视图已打开时跑,开销可忽略。
  useEffect(() => {
    if (url === null) return;
    let cancelled = false;
    const tick = (): void => {
      void api.documentView.list().then(
        (result) => {
          if (cancelled) return;
          const mine = result.views.find((v) => v.docId === docId);
          setPageFailure(mine?.lastFailure ?? null);
          // 【ARC-007】保存冲突走同一张快照（宿主在成功保存后清空它）。
          const conflict = mine?.lastSaveConflict;
          setSaveConflict(conflict !== undefined ? { message: conflict.message, at: conflict.at } : null);
        },
        () => { /* 读不到快照不该刷错误条 */ },
      );
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [docId, url, retryNonce]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {caps.loading && <LoadingNote label={t("common.loading")} />}
      {/* 【ARC-007】sheets/slides：**显式**说明打开为什么不可用（原因：vendor 的
          打开通道在其主进程里），不装空白。这一支必须排在「未构建」之前 —— CLI 是否
          构建不影响"宿主没有打开对端"这个事实，两个错误的修法也不同（一个是去构建，
          一个是等 vendor 提供渲染端入口）。 */}
      {!caps.loading && unsupportedHost !== null && (
        <div className="p-3">
          <ErrorNote title={t("ide.genoffice.viewHostUnsupported")} tone="warning">
            <div>
              {unsupportedHost === "unrecognized"
                ? "该格式没有对应的 GenOffice 原厂编辑器；已拒绝打开（未使用 docs 兜底）。"
                : unsupportedHost === "pdf" || unsupportedHost === "markdown" || unsupportedHost === "html" || unsupportedHost === "sheets"
                ? `${unsupportedHost} 原厂视图不可用：缺少 GenOffice 快照、预加载/渲染资源${unsupportedHost === "sheets" ? "或 Rust xlsx-sidecar" : ""}。请构建对应 app 后重试。`
                : t(unsupportedHost === "slides" ? "ide.genoffice.viewHostUnsupportedSlides" : "ide.genoffice.viewHostUnsupportedSheets")}
            </div>
          </ErrorNote>
        </div>
      )}
      {!caps.loading && unsupportedHost === null && url === null && (
        <div className="p-3">
          <ErrorNote
            title={t("ide.genoffice.editorNotBuilt")}
            action={
              <Button size="sm" variant="ghost" onClick={() => void caps.refetch()}>
                {t("common.retry")}
              </Button>
            }
          >
            <div>{t("ide.genoffice.editorNotBuiltDesc")}</div>
            {caps.data !== undefined && (
              <div className="mt-1 break-all font-mono text-[0.9em] text-content-muted">
                {caps.data.cli.path ?? t("ide.genoffice.cliMissing")}
              </div>
            )}
          </ErrorNote>
        </div>
      )}
      {pageFailure !== null && (
        <div className="p-3">
          <ErrorNote
            title={t("ide.genoffice.viewHostPageFailed")}
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPageFailure(null);
                  setRetryNonce((n) => n + 1);
                }}
              >
                {t("common.retry")}
              </Button>
            }
          >
            <div className="break-words">{pageFailure.reason}</div>
          </ErrorNote>
        </div>
      )}
      {saveConflict !== null && (
        <div className="p-3">
          <ErrorNote
            title={t("ide.genoffice.viewHostSaveConflict")}
            tone="warning"
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSaveConflict(null);
                  // 重新载入 = 重建视图并重新 openPath：宿主会记下新的打开时版本。
                  setRetryNonce((n) => n + 1);
                }}
              >
                {t("ide.genoffice.viewHostSaveConflictRetry")}
              </Button>
            }
          >
            <div className="break-words">{saveConflict.message}</div>
          </ErrorNote>
        </div>
      )}
      {openError !== null && (
        <div className="p-3">
          <ErrorNote
            title={t("ide.genoffice.viewHostOpenFailed")}
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setOpenError(null);
                  setRetryNonce((n) => n + 1);
                }}
              >
                {t("common.retry")}
              </Button>
            }
          >
            <div className="break-words">{openError}</div>
          </ErrorNote>
        </div>
      )}
      {/* 占位区：主进程把 WebContentsView 摆到它的窗口矩形上。空 div 是故意的 ——
          这里不渲染任何会与原生视图抢像素的内容。 */}
      <div ref={stageRef} className="min-h-0 flex-1" data-genoffice-view-stage="" />
    </div>
  );
}
