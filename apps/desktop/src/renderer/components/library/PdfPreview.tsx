/**
 * 右栏:文献 PDF 阅读器。
 *
 * ## 为什么用 pdf.js 的 viewer 组件而不是自己画 canvas
 *
 * 用户要的是「在软件里看 PDF」。自己用 `getDocument` + canvas 画页,能显示,但**选不中
 * 文字、搜不了、缩放要自己写** —— 读论文恰恰最需要选中和搜索。`pdfjs-dist` 里已经带着
 * Mozilla 官方那套 viewer 组件(`web/pdf_viewer.mjs`,`PDFViewer` / `PDFLinkService` /
 * `EventBus`),它就是 Firefox 里那个阅读器的组件化版本:分页虚拟化、文本层、缩放、
 * 链接都在里面,我们只写接线。Apache-2.0,和主进程已经在用的 pdfjs-dist 是同一份依赖。
 *
 * 也考虑过直接用 Electron 自带的 Chromium/PDFium 阅读器:功能更全,但它要开窗口的
 * `plugins`(默认关),而且只能渲染在**内嵌浏览器**标签里 —— 看文献的动线被拆到另一个
 * 标签,不划算。
 *
 * ## 字节从哪来
 *
 * 渲染进程读不了本地文件,所以走 `library.readPdf`(入参只有条目 id,路径在 main 里拼)。
 * 那边返回 `Uint8Array`,走结构化克隆,不做 base64 —— 论文常有十几 MB。
 *
 * ## v1 没有的东西
 *
 * 没有「搜索」(要在工具栏上再挂一个 PDFFindController + 输入框,下一版再说),
 * 没有缩略图侧栏、没有批注。**选中文字、复制、Ctrl+F 之外的基本阅读都在**。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import type { LibraryItem } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconLoader2,
  IconExternalLink,
  IconMinus,
  IconPlus,
  IconChevronLeft,
  IconChevronRight,
  IconArrowsMaximize,
} from "@renderer/lib/icons.js";

// worker 用 Vite 的 `?url` 拿到一个真实资源地址 —— pdf.js 会自己 `new Worker(...)`。
// 不设置这个的话 pdf.js 会退回主线程解析,大文件会把 UI 卡住。
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfPreview({ item, bytes }: { item: LibraryItem; bytes?: Uint8Array }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  /** 当前 PDFViewer 实例。工具栏按钮直接读它(命令式 API,不是 React state)。 */
  const viewerHandle = useRef<PDFViewer | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(100);
  /** 重新加载的把手:失败后「重试」用。 */
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const viewerEl = viewerRef.current;
    if (!container || !viewerEl) return undefined;

    let cancelled = false;
    let doc: pdfjs.PDFDocumentProxy | null = null;
    let viewer: PDFViewer | null = null;
    let eventBus: EventBus | null = null;

    setLoading(true);
    setError(null);
    setPages(0);
    setPage(1);

    // async IIFE 而不是直接挂 .then:手机端的 web shim 对没有映射的命名空间是同步
    // 抛错的,把异常甩出 effect 会让 React 19 整棵卸载(见 webApi.ts 的说明)
    void (async () => {
      try {
        // 字节可由调用方直接给(通用条目的 readFile 已把 base64 交上来,不必再走一次
        // readPdf —— 那条路只认条目的 pdfPath)。不给才按老路读。
        const res = bytes
          ? { ok: true as const, error: undefined, bytes }
          : await api.library.readPdf({ id: item.id });
        if (cancelled) return;
        if (!res.ok || !res.bytes) {
          setError(res.error ?? t("library.pdfViewer.failed"));
          return;
        }

        const task = pdfjs.getDocument({
          // 复制一份:pdf.js 会接管这块内存,而 IPC 过来的数组在别处也可能被引用
          data: new Uint8Array(res.bytes),
          // CMap 与标准字体走**本应用自己的相对路径** —— 由 electron.vite.config.ts 的
          // copyPdfjsAssets() 从 pdfjs-dist 复制到 public/pdfjs/。
          // 不用 CDN:离线可用,也不会把用户读的论文名泄漏给第三方。
          cMapUrl: "./pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "./pdfjs/standard_fonts/",
        });
        const loaded = await task.promise;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        doc = loaded;

        eventBus = new EventBus();
        const linkService = new PDFLinkService({ eventBus });
        viewer = new PDFViewer({
          container,
          viewer: viewerEl,
          eventBus,
          linkService,
        });
        linkService.setViewer(viewer);

        eventBus.on("pagesinit", () => {
          // 默认「适应宽度」：窄栏里这是唯一不用横向拖动的模式
          if (!cancelled && viewer) viewer.currentScaleValue = "page-width";
        });
        eventBus.on("pagechanging", (e: { pageNumber: number }) => {
          if (!cancelled) setPage(e.pageNumber);
        });
        eventBus.on("scalechanging", (e: { scale: number }) => {
          if (!cancelled) setZoom(Math.round(e.scale * 100));
        });

        viewer.setDocument(doc);
        linkService.setDocument(doc, null);
        if (!cancelled) {
          setPages(doc.numPages);
          setLoading(false);
        }
        viewerHandle.current = viewer;
      } catch (err) {
        if (!cancelled) {
          setLoading(false);
          setError((err as Error).message);
        }
      }
    })();

    return () => {
      cancelled = true;
      viewerHandle.current = null;
      try {
        viewer?.cleanup();
      } catch {
        /* 已经拆掉了 */
      }
      // eventBus 是局部变量,监听器随它一起被回收 —— 不用手动 off
      void doc?.destroy();
    };
    // 换一篇就重建整个阅读器 —— 复用 document 反而要处理分页残留
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, bytes, nonce]);

  const step = useCallback((delta: number) => {
    const v = viewerHandle.current;
    if (!v) return;
    v.currentPageNumber = Math.min(Math.max(1, v.currentPageNumber + delta), v.pagesCount);
  }, []);

  const zoomBy = useCallback((delta: number) => {
    const v = viewerHandle.current;
    if (!v) return;
    if (delta > 0) v.increaseScale();
    else v.decreaseScale();
  }, []);

  const btn = "flex h-5 w-5 items-center justify-center rounded text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-40 disabled:hover:bg-transparent";

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-xs text-red-500">{error}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setNonce((n) => n + 1)}
            className="rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
          >
            {t("library.preview.retry")}
          </button>
          {/* 读不了就退到外部程序 —— 不能只留一句错误 */}
          <button
            onClick={() => void api.library.openFile({ id: item.id, which: "pdf" })}
            className="inline-flex items-center gap-1 rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
          >
            <IconExternalLink size={11} />
            {t("library.pdfViewer.openExternal")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* 工具栏 —— 只放读论文真正要用的:翻页、页码、缩放、适应宽度 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
        <button className={btn} onClick={() => step(-1)} disabled={page <= 1} title={t("library.pdfViewer.prev")}>
          <IconChevronLeft size={13} />
        </button>
        <span className="min-w-[3.5rem] text-center text-[0.7857em] tabular-nums text-content-muted">
          {pages > 0 ? t("library.pdfViewer.pageOf", { n: page, total: pages }) : "—"}
        </span>
        <button className={btn} onClick={() => step(1)} disabled={page >= pages} title={t("library.pdfViewer.next")}>
          <IconChevronRight size={13} />
        </button>

        <span className="mx-1 h-3 w-px shrink-0 bg-edge" />

        <button className={btn} onClick={() => zoomBy(-1)} title={t("library.pdfViewer.zoomOut")}>
          <IconMinus size={12} />
        </button>
        <span className="min-w-[2.5rem] text-center text-[0.7857em] tabular-nums text-content-muted">
          {zoom}%
        </span>
        <button className={btn} onClick={() => zoomBy(1)} title={t("library.pdfViewer.zoomIn")}>
          <IconPlus size={12} />
        </button>
        <button
          className={btn}
          onClick={() => {
            const v = viewerHandle.current;
            if (v) v.currentScaleValue = "page-width";
          }}
          title={t("library.pdfViewer.fitWidth")}
        >
          <IconArrowsMaximize size={12} />
        </button>

        <button
          className={cn(btn, "ml-auto")}
          onClick={() => void api.library.openFile({ id: item.id, which: "pdf" })}
          title={t("library.pdfViewer.openExternal")}
        >
          <IconExternalLink size={12} />
        </button>
      </div>

      {/* 两层:外层 relative 的 flex 项负责占位,内层 absolute 才是 pdf.js 的容器。
          ⚠️ 那个容器**必须是 absolute** —— PDFViewer 构造时直接断言这一点
          (`The container must be absolutely positioned.`):它按容器的 clientHeight
          算"当前可见页范围"来做虚拟化,用 relative/static 拿到的尺寸会随内容变化,
          分页渲染就错位。所以不能省掉外层的 relative 直接给内层 absolute ——
          那样它会铺满整个面板、把工具栏盖住。 */}
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0 overflow-auto bg-surface-muted/50">
          <div ref={viewerRef} className="pdfViewer" />
        </div>
      </div>

      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex items-center gap-1.5 rounded bg-surface/90 px-3 py-1.5 text-xs text-content-muted shadow">
            <IconLoader2 size={13} className="animate-spin" />
            {t("common.loading")}
          </span>
        </div>
      )}
    </div>
  );
}
