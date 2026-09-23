/**
 * PDF 阅读器 —— **EmbedPDF**（MIT，基于 PDFium/WASM）。
 *
 * ## 为什么从 pdf.js 换成它（2026-09-22）
 *
 * 用户的要求原话是「**全面用第三方的这个包来做**」，起因是"pdf 编辑做了好几天还是很差
 * 的效果"，他要"装上就能用、几乎很少再写代码"的那种。
 *
 * 之前的路子：`pdf.js` 官方 `PDFViewer` 只负责**看**，编辑要自己在它上面搭
 * （`react-pdf-highlighter-plus` 那个壳子 + 自己写撤销 + 自己写保存 + 自己写烘烤）——
 * 六种工具 × 三套自写机制，处处能坏。
 *
 * EmbedPDF **自带整套 UI**（工具栏、缩略图、批注、形状、涂黑、搜索、缩放），
 * 而且是**独立引擎**（不是 pdf.js 的包装），批注、撤销、表单都在它内部。
 *
 * ## ⚠️ 三件必须做对的事（漏一件就整个渲染不出来）
 *
 * 1. **`wasmUrl` 要自托管**。它默认从 CDN 取 `pdfium.wasm`；这个应用是离线的、而且
 *    CSP 是 `default-src 'self'`，走 CDN 必然失败（表现是"只有工具栏、没有页面"）。
 *    这份 wasm 由 `electron.vite.config.ts` 的 `copyPdfiumWasm` 插件拷进
 *    `public/embedpdf/`，所以下面用**运行时路径**引用它。
 *
 *    ⚠️ **不能写成 `import ... from "@embedpdf/pdfium/pdfium.wasm?url"`** ——
 *    那条路只在 dev 下成立，生产构建会 `Rollup failed to resolve import`（这是个
 *    包内路径 + query，`assetsInclude` 管不到）。构建才炸，dev 看不出来。
 * 2. **`fontFallback: null`**。它默认会去 jsDelivr 拉回退字体 —— 同样是联网，
 *    必须显式关掉。这条不关的话，离线环境里控制台会一直报证书/网络错。
 * 3. **给它一个**有高度的**容器**。它按容器的实际尺寸布局，塌了就是"只有工具栏、
 *    没有页面"（与 pdf.js 那边踩过的同一个坑）。
 *
 * ## 字节还是从外面来（props 没变）
 *
 * 三个调用点（中间栏 `FileViewer`、右栏 `FilePreview`、`FileEditor` 的预览档）
 * 都只给 `{ item, bytes, onOpenExternal }` —— **这一层自己拿字节**，所以换引擎
 * 不用改它们任何一行。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryItem } from "@contracts/library";
import { PDFViewer, ZoomMode, type PDFViewerRef } from "@embedpdf/react-pdf-viewer";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconExternalLink,
  IconLoader2,
  IconRefresh,
} from "@renderer/lib/icons.js";

/** 把 `Uint8Array` 转成一段独立的 `ArrayBuffer`。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 它真正用到的只有 `item.id`，**不是**整篇文献：标题由外面的顶栏显示，PDF 状态 / 转录
 * 那一套是右栏详情页的事。所以入参收窄成这两样 —— 中间栏那个 `FileViewer` 什么都
 * 不知道（它连 `LibraryItem` 都没有），从前要为此编一个假条目传进来。
 *
 * `id` 在**给了 `bytes`** 之后只剩一个用处：「用系统程序打开」那个按钮要按条目去找路径。
 * 模版库的文件没有条目 id（它那条通道是 `templates.openFile`），所以那时给空串 ——
 * 按钮届时交给 `onOpenExternal`。
 */
export function PdfPreview({
  item,
  bytes,
  filePath,
  onOpenExternal,
}: {
  item: Pick<LibraryItem, "id">;
  bytes?: Uint8Array;
  /**
   * PDF 在磁盘上的绝对路径。**只有它才能保存批注** ——
   * `library.writeHighlights` 按路径寻址（那条路要原子替换原文件 +
   * 维护旁边的 `.mcode-original.pdf` 干净底稿）。
   *
   * 不给 = 这个入口只读（比如手机端某些场景），保存按钮不出现。
   */
  filePath?: string;
  /** 外部程序打开。不给就退回按 `item.id` 走 `library.openFile`。 */
  onOpenExternal?: () => void;
}) {
  const { t } = useI18n();
  /**
   * PDFium 引擎的 wasm。由构建插件拷进 `public/embedpdf/`（见文件头那三条）。
   * 用 `import.meta.env.BASE_URL` 拼，免得部署在子路径下时指错。
   */
  const wasmUrl = `${import.meta.env.BASE_URL}embedpdf/pdfium.wasm`;
  const viewerRef = useRef<PDFViewerRef>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 重新加载的把手：失败后「重试」用。 */
  const [nonce, setNonce] = useState(0);
  const [docBytes, setDocBytes] = useState<ArrayBuffer | null>(null);
  /** 保存（把批注导出并写回文件）的状态机。 */
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  /**
   * **有没保存的批注** —— 关窗前的提醒靠它（见 `unsavedRegistry`）。
   *
   * ⚠️ **不能拿"有没有批注"当判据。** 打开一篇本来就带批注的 PDF 时，
   * EmbedPDF 会发一次 `loaded` 事件（带 `total`），那**不是**用户改的。
   * 所以只认 `create` / `update` / `delete` 三种 —— 见下面那个订阅。
   */
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocBytes(null);

    // async IIFE 而不是直接挂 .then：手机端的 web shim 对没有映射的命名空间是同步
    // 抛错的，把异常甩出 effect 会让 React 19 整棵卸载（见 webApi.ts 的说明）
    void (async () => {
      try {
        // 字节可由调用方直接给（通用条目的 readFile 已把 base64 交上来，不必再走一次
        // readPdf —— 那条路只认条目的 pdfPath）。不给才按老路读。
        const res = bytes
          ? { ok: true as const, error: undefined, bytes }
          : await api.library.readPdf({ id: item.id });
        if (cancelled) return;
        if (!res.ok || !res.bytes || res.bytes.byteLength === 0) {
          setError(res.error ?? t("library.pdfViewer.failed"));
          setLoading(false);
          return;
        }
        // ⚠️ 拷贝一份独立的 ArrayBuffer：EmbedPDF 会接管这块内存，而调用方传进来的
        //    字节在别处也可能还在用（同 pdf.js 那边 detach 的老问题）。
        setDocBytes(toArrayBuffer(res.bytes));
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [item.id, bytes, nonce, t]);

  const open = useCallback(() => {
    if (onOpenExternal) onOpenExternal();
    else void api.library.openFile({ id: item.id, which: "pdf" });
  }, [onOpenExternal, item.id]);

  /**
   * **保存批注** —— 让 EmbedPDF 导出一份带批注的 PDF，交给主进程写回原文件。
   *
   * ## 走它自己的 `saveAsCopy()`
   *
   * EmbedPDF 的 export 插件把**当前文档连同用户加的批注**序列化成一个新的
   * `ArrayBuffer`。批注在这里是**真批注对象**（`/Annots`），不是画进页面内容的
   * 那种 —— 所以 Acrobat / 浏览器 / 微信里打开都看得见，也**改得了**。
   *
   * （pdfium 底层其实有 `FPDFPage_Flatten` 能把它们烤进内容流 —— 用户要的是
   * "先在别的查看器里能看见"，所以这一版**没有**用它。将来要"改不掉"那种，
   * 就在这一步之后调一次 flatten，接口不用动。）
   *
   * ## 为什么写回要带 `filePath`
   *
   * 主进程那条 `writeHighlights` 是**按路径**原子替换原文件、顺带维护旁边的
   * `.mcode-original.pdf` 干净底稿。没给路径（或调用方没传）就没有落点，
   * 按钮根本不该出现 —— 见下面那个 `canSave`。
   */
  const save = useCallback(async (): Promise<boolean> => {
    if (!filePath) return false;
    setSaveState("saving");
    setSaveErr(null);
    try {
      const registry = await viewerRef.current?.registry;
      /**
       * ⚠️ **不能写成 `registry.getPlugin("export")?.provides()`。**
       *
       * `getPlugin` 的声明返回 `Plugin | undefined`，而 `Plugin` 上的
       * `provides` 在类型里**也是可选的** —— TS 认为 `?.provides` 之后仍可能是
       * undefined，于是 `.provides()` 这个调用点直接报 "possibly undefined"。
       *
       * 它的**运行时**契约其实很硬：export 插件随 viewer 一起注册（snippet 那套
       * 默认全挂），`getPlugin("export")` 一定拿得到、`provides()` 一定给得出
       * `saveAsCopy`。所以这里把 `getPlugin` 的**返回值整体收窄**成一个具体形状，
       * 拿到的东西不对就明确报错，而不是靠类型上的可选链把问题糊过去。
       */
      const getPlugin = (registry as unknown as {
        getPlugin?: (name: string) => { provides: () => unknown } | undefined;
      } | null)?.getPlugin;
      const plugin = getPlugin ? getPlugin.call(registry, "export")?.provides() : undefined;
      const saveAsCopy = (plugin as { saveAsCopy?: unknown } | undefined)?.saveAsCopy as
        | (() => { toPromise: () => Promise<ArrayBuffer> })
        | undefined;
      if (typeof saveAsCopy !== "function") {
        throw new Error(t("library.pdfViewer.saveFailed"));
      }

      // `Task` → Promise。它自己的 `toPromise()` 就是干这个的。
      const buf = await saveAsCopy.call(plugin).toPromise();
      if (!buf || buf.byteLength === 0) throw new Error(t("library.pdfViewer.saveFailed"));

      // 字节 → base64。分块拼，别用 `String.fromCharCode(...arr)` ——
      // 十几 MB 的论文会把调用栈撑爆（"Maximum call stack size exceeded"）。
      const u8 = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
      }
      const r = await api.library.writeHighlights({
        pdfPath: filePath,
        bytesBase64: btoa(bin),
      } as never);
      if (!r.ok) throw new Error(r.error ?? t("library.pdfViewer.saveFailed"));
      setSaveState("saved");
      dirtyRef.current = false;
      return true;
    } catch (err) {
      setSaveState("error");
      setSaveErr((err as Error).message);
      return false;
    }
  }, [filePath, t]);

  /**
   * 给 EmbedPDF 的初始文档 —— 只在换文件时变，别每次重渲染都造新数组
   * （那会让它重新加载整篇）。
   */
  const initialDocuments = useMemo(
    () => (docBytes ? [{ buffer: docBytes, name: "document.pdf" }] : []),
    [docBytes],
  );

  /**
   * viewer 就绪：**订阅批注变化**（用来记脏），并把这条登记进未保存表。
   *
   * ## ⚠️ 只有 create / update / delete 算"脏"
   *
   * `loaded` 是**打开文档时**发的（带 `total`）—— 一篇本来就带批注的 PDF 一打开
   * 就会发一次。把它也算脏的话，用户**什么都没做**就被告知"有未保存的批注"。
   * 这正是这个仓库反复踩过的形状：判据立在"机制动过"上，而不是"用户做过"上。
   */
  /** 批注事件的取消订阅句柄。面板卸载/换文件时调。 */
  const unsubRef = useRef<(() => void) | null>(null);

  /**
   * viewer 就绪：**订阅批注变化**（用来记脏）+ 收起加载态。
   *
   * ⚠️ **registry 直接用 `onReady` 给的参数，别去 `viewerRef.current.registry` 绕。**
   *
   * `onReady?: (registry) => void` —— 参数就是那个 registry（看 `PDFViewerProps`）。
   * 从 `ref.current.registry` 拿是个**Promise**，要 `await`，而且那时 ref 有没有挂上
   * 还得赌一把。第一版就是那么写的，结果**订阅根本没接上**（拿不到就不声不响地
   * `return`），表现为"改了却从来不标记为脏 → 关窗不保存"。
   *
   * ## ⚠️ 只有 create / update / delete 算"脏"
   *
   * `loaded` 是**打开文档时**发的（带 `total`）—— 一篇本来就带批注的 PDF 一打开就会
   * 发一次。把它也算脏的话，用户什么都没做就被告知"有未保存的批注"。这正是这个仓库
   * 反复踩过的形状：判据立在"机制动过"上，而不是"用户做过"上。
   */
  const handleReady = useCallback((registry: unknown) => {
    setLoading(false);
    const getPlugin = (
      registry as { getPlugin?: (n: string) => { provides: () => unknown } | undefined } | null
    )?.getPlugin;
    const annotation = (getPlugin ? getPlugin.call(registry, "annotation")?.provides() : undefined) as
      | { onAnnotationEvent?: (cb: (e: { type: string }) => void) => unknown }
      | undefined;
    if (typeof annotation?.onAnnotationEvent !== "function") return;
    const sub = annotation.onAnnotationEvent((e) => {
      if (e.type === "create" || e.type === "update" || e.type === "delete") {
        dirtyRef.current = true;
      }
    });
    unsubRef.current = typeof sub === "function" ? (sub as () => void) : null;
  }, []);

  /** 撤销订阅。面板卸载/换文件时调，否则监听器会堆在这条会话上。 */
  useEffect(
    () => () => {
      try {
        unsubRef.current?.();
      } catch {
        /* 已经拆了 */
      }
      unsubRef.current = null;
    },
    [],
  );

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="text-xs text-red-500">{error}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setNonce((n) => n + 1)}
            className="inline-flex items-center gap-1 rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
          >
            <IconRefresh size={11} />
            {t("library.preview.retry")}
          </button>
          {/* 读不了就退到外部程序 —— 不能只留一句错误 */}
          <button
            onClick={open}
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
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 保存条 —— 只在**知道文件在哪**的时候出现（见 `filePath` 那段）。
          EmbedPDF 自带的工具栏管阅读与批注**编辑**，但"落盘到哪个文件"是宿主
          （我们）的事，它不知道，所以这一个按钮必须由我们画。 */}
      {filePath !== undefined && (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge px-2 py-1">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saveState === "saving"}
            className={cn(
              "rounded border border-edge px-2 py-0.5 text-[0.7857em] transition-colors",
              "text-content-muted hover:bg-surface-hover hover:text-content",
              "disabled:opacity-40 disabled:hover:bg-transparent",
            )}
          >
            {t("library.pdfViewer.saveAnnotations")}
          </button>
          {saveState === "saving" && (
            <span className="flex items-center gap-1 text-[0.7857em] text-content-muted">
              <IconLoader2 size={11} className="animate-spin" />
            </span>
          )}
          {saveState === "saved" && (
            <span className="text-[0.7857em] text-content-muted">
              {t("library.pdfViewer.savedToast")}
            </span>
          )}
          {saveState === "error" && saveErr && (
            <span className="truncate text-[0.7857em] text-red-500" title={saveErr}>
              {saveErr}
            </span>
          )}
        </div>
      )}

      {/* ⚠️ 高度是这一层给的。EmbedPDF 按容器的实际尺寸布局，
          塌了就是"只有工具栏、没有页面"。 */}
      <div className="min-h-0 flex-1">
        {docBytes !== null && (
          <PDFViewer
            ref={viewerRef}
            style={{ width: "100%", height: "100%" }}
            config={{
              // ★ 本地 wasm —— 见文件头那三条
              wasmUrl,
              // ★ 关掉联网取回退字体
              fontFallback: null,
              /**
               * ★ **默认"适应宽度"**（用户 2026-09-22：「打开默认自适应宽度」）。
               *
               * 它默认是 `automatic`，也就是按容器**高度**算 —— 在咱们这个窄面板
               * 里会缩得很小、两侧留一大片空。`fit-width` 是"铺满宽度"，正是读论文
               * 要的那个。
               *
               * 用枚举常量而不是 `"fit-width"` 字面量：这个库的 `ZoomMode` 是
               * 字符串枚举，值写错了类型不报、运行时也不报（就是没生效）。
               */
              zoom: { defaultZoomLevel: ZoomMode.FitWidth },
              // ★ **先跑主线程，不开 worker。**
              //
              // 它默认 `worker: true`，而那个 worker 是
              // `URL.createObjectURL(new Blob([...]))` 现铸的 `blob:` URL。
              // 在这台机器上实测：worker 起不来 → 引擎初始化不完 → 界面**永远
              // 停在 "Initializing plugins…"**（用户截图），而控制台那句被拒的
              // 报错完全看不出是 worker 的事。
              //
              // 关掉之后引擎跑在主线程：功能一样，大文件会卡一点。**先能显示**
              // 最重要 —— 等渲染确认通了，再回头调 worker 与 CSP
              //（`worker-src 'self' blob:` 已经加进 `main/index.ts`，那只对打包
              // 后的应用生效，dev 下不受那条 CSP 管）。
              worker: false,
              documentManager: { initialDocuments },
            }}
            onReady={handleReady}
          />
        )}
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
