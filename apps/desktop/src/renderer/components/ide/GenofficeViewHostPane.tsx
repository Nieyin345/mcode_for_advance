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
 * ## 已知边界（如实记录，不在本切片里假装解决）
 *
 * - 这一版宿主**没有文档桥**：视图里是编辑器的起始页，不会自动打开 `filePath`
 *   指向的那份文档（主进程不向页面注入参数，页面也没有消费通道）。打开具体文档
 *   属于后续 DocumentSessionRegistry 切片。
 * - CLI 存在但三个 module 的 `out/renderer` 没构建时，渲染端没有可用的 stat IPC
 *   去探测文件是否存在 —— 该情形由主进程的导航失败日志暴露，界面层只能保证
 *   **CLI 缺失**这一分支是显式的（见上）。
 * - 原生视图永远盖在 DOM 之上：错误条只占占位区**上方**的一条，不试图浮在视图上。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import type { DocViewRect } from "@contracts/ipc";
import { documentExtension } from "@contracts/documentKind";

/** GenOffice 编辑器 module 名（与 vendor 的 `rendererUrl` host 同名）。 */
export type GenofficeEditorHost = "docs" | "sheets" | "slides";

/**
 * 文件 → 编辑器 module 的路由。
 *
 * 与 vendor `apps/shell/src/main/app-routing.ts` 的 `appForPath` **同一条判据**
 * （那边是唯一权威；这里只覆盖 `isOnlyOfficeSupportedPath` 能放进本面板的扩
 * 展名子集）。老格式（doc/rtf/xls/ppt…）vendor 走"转换后打开"，当前宿主没有
 * 转换通道，落到 docs 起始页 —— 这是已知边界，不是路由判据本身的猜测。
 */
export function editorHostForPath(filePath: string): GenofficeEditorHost {
  switch (documentExtension(filePath)) {
    case "xlsx":
    case "xlsm":
    case "xltx":
    case "ods":
      return "sheets";
    case "pptx":
    case "pptm":
    case "potx":
    case "odp":
      return "slides";
    default:
      return "docs";
  }
}

/**
 * 从 CLI bundle 路径推出仓库根，再拼出编辑器页的 `file://` 地址。
 *
 * CLI 的固定位置是 `<repo>/genoffice/packages/cli/dist/genoffice.cjs`
 * （见 `main/document/genofficeCli.resolveGenofficeCliPath`），所以剥掉
 * `/genoffice/packages/cli/…` 之后的就是仓库根 —— 不再向渲染端要第二个"仓库根"
 * 通道（多一条路径来源就多一处会漂的真相）。
 *
 * `?mode=tab` 是 vendor 编辑器页认识的参数（`Ribbon.tsx` 读它来让出窗口控制按钮
 * 的留白）；我们的视图里没有 tab strip，所以按 tab 模式渲染。
 *
 * 路径形状不认识时返回 `null`，调用方按"编辑器页未构建"显式报告 —— 不猜一个
 * 可能指向错误位置的 URL。
 */
export function editorPageUrl(cliPath: string, host: GenofficeEditorHost): string | null {
  const normalized = cliPath.replace(/\\/g, "/");
  const marker = "/genoffice/packages/cli/";
  const at = normalized.indexOf(marker);
  if (at <= 0) return null;
  const repoRoot = normalized.slice(0, at);
  const pagePath = `${repoRoot}/genoffice/apps/${host}/out/renderer/index.html`;
  // Windows 盘符路径要三段斜杠（file:///D:/…）；POSIX 根路径本身以 / 开头，
  // 直接 file:// + 编码后的绝对路径即可（file:///home/…）。
  const withScheme = /^[A-Za-z]:\//.test(pagePath)
    ? `file:///${encodeURI(pagePath)}`
    : `file://${encodeURI(pagePath)}`;
  return `${withScheme}?mode=tab`;
}

/**
 * docId 的稳定生成：`filePath` 的 FNV-1a 32 位散列 + 长度。
 *
 * 为什么用散列而不是路径本身：契约把 `docId` 限在 200 字符内，而 Windows 深路径
 * 很容易超；为什么带上长度：不同路径撞同一个 32 位散列时，长度再不同的会被分开，
 * 剩下同长同散列的概率可以忽略。稳定性是必要的 —— 同一文件的重渲染必须命中
 * 同一个视图（宿主对同 docId 的 open 是复用语义）。
 */
export function stableDocId(filePath: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    hash ^= filePath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `genoffice-view-${hash.toString(16).padStart(8, "0")}-${filePath.length}`;
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
function closeQuietly(docId: string): void {
  try {
    void api.documentView.close({ docId }).catch(() => {});
  } catch {
    /* web 传输同步拒绝 —— 卸载路径无事可做 */
  }
}

export function GenofficeViewHostPane({ filePath }: { filePath: string }) {
  const { t } = useI18n();
  // 读能力报告走 useRpc（硬规矩 7）；本组件只用它拿 CLI 路径推仓库根。
  const caps = useRpc(() => api.document.capabilities(), [], { toastOnError: false });
  const [openError, setOpenError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const docId = useMemo(() => stableDocId(filePath), [filePath]);
  const host = editorHostForPath(filePath);
  const cliPath = caps.data?.cli.available === true ? caps.data.cli.path : null;
  const url = cliPath !== null ? editorPageUrl(cliPath, host) : null;

  useEffect(() => {
    if (url === null) return;
    const stage = stageRef.current;
    if (stage === null) return;

    let disposed = false;
    let raf = 0;
    let attempts = 0;
    /** 上一次发给宿主的几何（去重：rect 没变就不发，IPC 每个 rAF 一发很浪费）。 */
    let lastKey = "";
    let observer: ResizeObserver | null = null;

    const sendOpen = (bounds: DocViewRect): void => {
      const pending = api.documentView.open({ docId, url, bounds, visible: true });
      lastKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
      void pending.then(
        (result) => {
          if (disposed) {
            // open 在路上的时候组件卸载了：立即关一次，否则视图会被创建出来
            // 变成没人管得到的孤儿（原生视图不随 DOM 卸载，见文件头）。
            closeQuietly(docId);
            return;
          }
          if (!result.ok) setOpenError(result.reason);
        },
        (err: unknown) => {
          if (!disposed) setOpenError(err instanceof Error ? err.message : String(err));
        },
      );
    };

    const sync = (): void => {
      if (disposed) return;
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
      // **原生视图不随 DOM 卸载** —— 这里必须显式销毁，理由见文件头。
      closeQuietly(docId);
    };
    // url/docId 变了要重建视图；retryNonce 是显式重试。t 只影响错误文案。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, url, retryNonce]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {caps.loading && <LoadingNote label={t("common.loading")} />}
      {!caps.loading && url === null && (
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
