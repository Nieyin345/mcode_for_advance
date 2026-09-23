/**
 * 右栏:通用文件条目的预览。
 *
 * 统一资料库之后,任意文件(pdf / md / ppt / word / 图片)或**目录**都能以
 * linked / attached 方式进库(见 `LibraryItem.entryMode` 的 `filePath`)。这类条目
 * 没有「PDF 状态 / 转录 / 笔记」那一套,有的只是文件本体 —— 这个组件就是它的预览页:
 *
 *   文本   ── md/markdown 走聊天那套 Markdown 渲染(长文由 ChunkedMarkdown 分段加载),其余进 <pre>;
 *   图片   ── data URL 直接摆;
 *   pdf    ── 复用 PdfPreview(给它喂字节);
 *   office ── 复用模版库的 DocxPreview / PptxPreview / XlsxPreview(它们吃字节);
 *   目录   ── 文件名列表,点一个子文件用 relPath 再读一次。
 *
 * ## 字节从哪来
 *
 * 渲染进程读不了本地文件,所以只有一条路:`library.readFile` 把内容分类交上来 ——
 * 文本给 text,二进制给 mime + base64(预览的体积上限在主进程挡住),目录给
 * files 列表。base64 在这里就地转回字节喂给那几个预览组件,它们的 props 形状
 *(`data: Uint8Array`)不动。
 */
import { useEffect, useState } from "react";
import type { LibraryItem } from "@contracts/library";
import type { LibraryFileContent } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { ChunkedMarkdown } from "@renderer/components/chat/ChunkedMarkdown.js";
import { IconArrowLeft, IconFile, IconFolder, IconLoader2 } from "@renderer/lib/icons.js";
import { DocxPreview } from "@renderer/components/templates/DocxPreview.js";
import { PptxPreview } from "@renderer/components/templates/PptxPreview.js";
import { XlsxPreview } from "@renderer/components/templates/XlsxPreview.js";
import { PdfPreview } from "./PdfPreview.js";

/** 取路径的扩展名(斜杠两种都认;无扩展名返回空串)。 */
function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** base64 → 字节。预览体积上限在主进程挡着,这里的 for 循环最多几十毫秒,够用。 */
function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function FilePreview({
  item,
  which,
}: {
  item: LibraryItem;
  /**
   * 看**哪一份**（2026-09-21）。
   *
   * 省略 = 本体:通用条目给文件本身,论文给它的 **PDF**。`"md"` 才是"我要看转录" ——
   * 论文的 PDF 与转录是两样东西,用户要的是「点击和双击都显示 PDF 本身,转录另外看」。
   * 从前这里没有这一格,而主进程那条读文件的路只认 `file_path`(论文的记录在那上面
   * 是空的),于是点任何一篇论文都报「这条资料没有关联文件」。
   */
  which?: "pdf" | "md";
}) {
  const { t } = useI18n();
  /** 目录条目:正在看的子文件(相对该目录,`/` 分隔)。null = 条目本体。 */
  const [relPath, setRelPath] = useState<string | null>(null);
  const [content, setContent] = useState<LibraryFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * PDF 在磁盘上的绝对路径 —— 只有它才能保存批注（见 `PdfPreview` 的 `filePath`）。
   * 条目只给 id，所以要拿 `library.entryPath` 换一次（与 `FileViewer` 那边同一个调用）。
   * 换不出来就不给，阅读器退化成只读。
   */
  const [pdfPath, setPdfPath] = useState<string | undefined>(undefined);

  // 换条目回到根 —— 上一个目录里翻到一半的子文件对这一条没有意义
  useEffect(() => {
    setRelPath(null);
  }, [item.id, which]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await api.library.readFile({
          id: item.id,
          relPath: relPath ?? undefined,
          which,
        });
        if (!cancelled) setContent(res.content);
        // 换一次绝对路径（只有 PDF 用得上）。**换不出来不影响预览** ——
        // 那条路上阅读器只是不画保存按钮。
        try {
          const p = await api.library.entryPath({
            id: item.id,
            ...(which ? { which } : {}),
          });
          if (!cancelled) setPdfPath(p.path || undefined);
        } catch {
          // 手机端 `api.library` 是抛错的代理
          if (!cancelled) setPdfPath(undefined);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id, relPath, which]);

  /**
   * 目录条目在预览什么:条目本体(根目录列表)或某个子文件。
   *
   * ⚠️ 论文那类条目 `filePath` 是空的,所以这条链**必须**跟着 `which` 走 ——
   * 否则 `ext` 退化成空串,一份 **Markdown 转录会被当成普通文本塞进 `<pre>`**
   * (用户看到的是一堆 `#` 和 `*` 的源码)。见下面 `ext === "md"` 那个分支。
   */
  const viewing = relPath ?? item.filePath ?? (which === "md" ? item.mdPath : item.pdfPath) ?? item.id;
  const ext = extOf(viewing);

  const open = (name: string, isDir: boolean) => {
    setRelPath(relPath ? `${relPath}/${name}` : name);
    if (isDir) return; // readFile 对目录 relPath 会再回一份列表,交给上面的 effect
  };

  // ── 加载 / 失败 ──
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-content-subtle">
        <IconLoader2 size={14} className="animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-start justify-center p-6">
        <span className="break-all text-center text-xs text-red-500">{error}</span>
      </div>
    );
  }
  if (!content) return null;

  // ── 目录:文件名列表(点子文件/子目录用 relPath 再读) ──
  if (content.type === "dir") {
    return (
      <div className="flex h-full flex-col">
        {relPath && (
          <div className="flex shrink-0 items-center border-b border-edge px-2 py-1">
            <button
              onClick={() => setRelPath(null)}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
            >
              <IconArrowLeft size={12} />
              {t("library.file.back")}
            </button>
            <span className="ml-1 min-w-0 truncate font-mono text-[0.7857em] text-content-subtle">
              {relPath}
            </span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {content.files.length === 0 ? (
            <div className="px-2 py-1 text-[0.7857em] text-content-subtle">
              {t("library.file.emptyDir")}
            </div>
          ) : (
            content.files.map((f) => (
              <button
                key={f.name}
                onClick={() => open(f.name, f.isDir)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-content-muted hover:bg-surface-hover hover:text-content"
              >
                {f.isDir ? (
                  <IconFolder size={13} className="shrink-0 text-content-subtle" />
                ) : (
                  <IconFile size={13} className="shrink-0 text-content-subtle" />
                )}
                <span className="min-w-0 truncate">{f.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    );
  }

  // ── 不支持的格式:主进程会说明原因,原话摆出来 ──
  if (content.type === "unsupported") {
    return (
      <div className="flex h-full items-start justify-center p-6">
        <span className="break-all text-center text-xs text-red-500">{content.error}</span>
      </div>
    );
  }

  // ── 文本 ──
  if (content.type === "text") {
    if (ext === "md" || ext === "markdown") {
      return (
        // 这一层的 `overflow-y-auto` **就是**滚动容器，所以给 `scroll="parent"`
        // —— 让它把内容放在这里滚，不再自己套一层（见 `ChunkedMarkdown` 文件头那段：
        // 两层滚动叠在一起，能滚的那根和内层那根不是同一个，界面表现为"滑不动"）。
        <div className="h-full overflow-y-auto px-4 py-3">
          <ChunkedMarkdown text={content.text} scroll="parent" />
        </div>
      );
    }
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-content">
        {content.text}
      </pre>
    );
  }

  // ── 二进制 ──
  const bytes = base64ToBytes(content.base64);
  const officeKey = `${item.id}:${relPath ?? ""}`; // 预览组件只拿它当重渲染的依赖键
  if (content.mime.startsWith("image/")) {
    return (
      <div className="h-full overflow-auto p-2">
        <img src={`data:${content.mime};base64,${content.base64}`} alt={viewing} className="max-h-full max-w-full mx-auto" />
      </div>
    );
  }
  if (content.mime === "application/pdf" || ext === "pdf") {
    // 字节直接喂给阅读器,不再走一次 readPdf(那条路只认条目的 pdfPath)。
    // `pdfPath` 有的话一并给它 —— 那是"保存批注"唯一的落点。
    return <PdfPreview item={item} bytes={bytes} {...(pdfPath ? { filePath: pdfPath } : {})} />;
  }
  if (content.mime.includes("wordprocessingml") || ext === "docx" || ext === "dotx") {
    // 失败路径上的「系统程序打开」对库条目没有现成 IPC,先留空 —— 渲染成功才是常态
    return <DocxPreview data={bytes} relPath={officeKey} onOpenExternal={() => {}} />;
  }
  if (content.mime.includes("presentationml") || ext === "pptx" || ext === "ppsx" || ext === "potx") {
    return <PptxPreview data={bytes} relPath={officeKey} onOpenExternal={() => {}} />;
  }
  if (content.mime.includes("spreadsheetml") || ext === "xlsx" || ext === "xlsm" || ext === "xltx") {
    return <XlsxPreview data={bytes} relPath={officeKey} onOpenExternal={() => {}} />;
  }
  return (
    <div className="flex h-full items-start justify-center p-6">
      <span className="text-center text-xs text-content-muted">
        {t("library.file.unknownMime", { mime: content.mime })}
      </span>
    </div>
  );
}
