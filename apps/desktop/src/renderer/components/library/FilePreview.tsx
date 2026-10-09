/**
 * 右栏:通用文件条目的预览。
 *
 * 统一资料库之后,任意文件(pdf / md / ppt / word / 图片)或**目录**都能以
 * linked / attached 方式进库(见 `LibraryItem.entryMode` 的 `filePath`)。这类条目
 * 没有「PDF 状态 / 转录 / 笔记」那一套,有的只是文件本体 —— 这个组件就是它的预览页:
 *
 *   文本   ── md/markdown 走 Milkdown / Crepe 只读预览，其余进 <pre>;
 *   图片   ── data URL 直接摆;
 *   pdf    ── 复用 PdfPreview(给它喂字节);
 *   office ── 用 OnlyOffice 只读 viewer；插件选区仍可引用到 AI;
 *   目录   ── 文件名列表,点一个子文件用 relPath 再读一次。
 *
 * ## 字节从哪来
 *
 * 渲染进程读不了本地文件,所以只有一条路:`library.readFile` 把内容分类交上来 ——
 * 文本给 text,二进制给 mime + base64(预览的体积上限在主进程挡住),目录给
 * files 列表。base64 在这里就地转回字节，供 PDF 等仍使用字节的 viewer。Office 则走
 * `entryPath` + OnlyOffice，不再送进本地 Office renderer。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryItem } from "@contracts/library";
import { isOnlyOfficeSupportedPath, type LibraryFileContent } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { joinPath } from "@renderer/lib/path.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { makeQuoteTag } from "@renderer/lib/contentTag.js";
const MarkdownPreviewPane = lazy(() => import("./MarkdownPreviewPane.js"));
import { SelectionToolbar, type SelectionToolbarState } from "@renderer/components/chat/SelectionToolbar.js";
import { SelectionQuoteMenu, type QuoteTarget } from "@renderer/components/chat/SelectionQuoteMenu.js";
import { IconArrowLeft, IconFile, IconFolder, IconLoader2 } from "@renderer/lib/icons.js";
import { OnlyOfficeEditorPane } from "@renderer/components/ide/OnlyOfficeEditorPane.js";
// PdfPreview is itself a lazy shell: the PDF engine (EmbedPDF + pdfium glue,
// >1MB) loads only when a PDF is actually shown (see PdfPreview.tsx).
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

  /**
   * **右栏预览里也能框选引用**（2026-09-24）。
   *
   * ★ 用户的要求：「打开的文件的引用，就是中间页面的打开，**还是右边栏的预览**，
   * 都能够框选，然后引用到当前的开启的对话里面」。
   *
   * 中间那一栏（`FileViewer`）和编辑器（`FileEditor`）早就有了，**右栏这一处漏了**
   * —— 这个组件用的是 `FilePreview`（不是 `FileViewer`），而它里面从来没挂过
   * `SelectionToolbar`，所以在右栏预览里框选**什么都不会发生**。
   *
   * 交互与另外两处逐字一致，连"只给复制 / 引用两个按钮"都一样（这里没有消息流，
   * 书签和「问侧边」都没有落点）。
   */
  const [sel, setSel] = useState<SelectionToolbarState | null>(null);
  const [quote, setQuote] = useState<SelectionToolbarState | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onUp = () => {
      // 让浏览器先落定选区再读（`mouseup` 那一刻 `getSelection()` 还是旧的）。
      window.setTimeout(() => {
        const s = window.getSelection();
        const text = s?.toString().trim() ?? "";
        const root = bodyRef.current;
        if (!s || s.rangeCount === 0 || text.length === 0 || !root) {
          setSel(null);
          return;
        }
        const node = s.anchorNode;
        if (!node || !root.contains(node)) return;
        const r = s.getRangeAt(0).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        setSel({
          rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
          text,
          messageId: "",
          role: "assistant",
        });
      }, 0);
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, []);

  /**
   * 引用落到哪。落点走 store 的 `quoteIntoComposer`（共享实现只有一份，硬规矩 2）
   * —— 它内部带 touch 计数，目标会话开着时那个输入框会当场重跑草稿还原、
   * 没开的下次挂载见。见 `deliverComposerDraft` 的说明。
   *
   * 来源路径：`pdfPath`（entryPath 换出来的**条目根**绝对路径）+ `relPath` 拼出
   * **正在看的那份子文件**；都拿不到时退成条目标题。⚠️ 不拿 `item.filePath` 兜底
   * —— attached 条目它是**相对库根**的（contracts/library.ts），当成"来源"给模型
   * 是一个解析不了的伪路径。标题至少是人能认的。
   */
  const quoteTo = useCallback(
    (t2: QuoteTarget, text: string) => {
      const quoted = text.trim();
      setQuote(null);
      setSel(null);
      window.getSelection()?.removeAllRanges();
      if (!quoted) return;
      const sourcePath = pdfPath ? (relPath ? joinPath(pdfPath, relPath) : pdfPath) : item.title;
      const tag = makeQuoteTag({
        text: quoted,
        origin: { kind: "file", filePath: sourcePath, name: item.title },
      });
      useSessionStore.getState().quoteIntoComposer(t2.id, tag);
      useToastStore.getState().push({
        kind: "info",
        title: t("chatStream.quote.doneToast", { name: t2.title }),
        sessionId: t2.id,
      });
    },
    [t, pdfPath, relPath, item.title],
  );

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
   *
   * ⚠️ **本体那一支必须带上 `item.mdPath`。** 笔记(以及只挂转录、没有 PDF 的论文)
   * 的本体**就是它们的 markdown** —— 没有 `filePath`、也没有 `pdfPath`。从前这条链
   * 只兜 `filePath ?? pdfPath ?? item.id`,于是这类条目退到 `item.id`(如 `li_note_…`,
   * 无扩展名)→ `ext` 为空 → 走 `<pre>`,单击一条笔记看到的是满屏 `#` 与 `*` 的源码。
   * 主进程 `entryRootAbsPath` 的未指名顺序(filePath → pdfPath → mdPath)与本链一致。
   */
  const viewing = relPath ?? (which === "md" ? (pdfPath ?? item.mdPath ?? "transcript.md") : (item.filePath ?? item.pdfPath ?? item.mdPath ?? item.id));
  const ext = extOf(viewing);

  const open = (name: string, isDir: boolean) => {
    setRelPath(relPath ? `${relPath}/${name}` : name);
    if (isDir) return; // readFile 对目录 relPath 会再回一份列表,交给上面的 effect
  };

  // ── 加载 / 失败 ──
  // 形状与 `FileViewer` 一致：先算 `body`、最后统一挂工具条（见文件头那段
  // 「右栏预览也要能框选引用」）。从前这里是一串 early return，工具条根本没地方挂。
  //
  // ⚠️ **useMemo 不能省**：`sel` 在预览区**每次 mouseup** 都会 set，而 body 的
  // 二进制分支里 `base64ToBytes` 每跑一次就是十几 MB 的解码 + 一个新 bytes 身份
  // （PdfPreview 那边的 memo 全失效）。依赖只放数据，不放 sel/quote。
  const body = useMemo(() => {
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
                // 「返回上级」只退**一级**,与中间栏孪生 `FileViewer` 逐字一致。
                // 从前这里把 relPath 整个清成 null —— 翻进 `a/b` 再点它直接弹回条目根,
                // 越过了 `a`,而按钮上印的明明是「返回上级」。
                onClick={() => setRelPath(relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : null)}
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
      // 空文件要说出来 —— 一张白板子和"坏了"在界面上长得一模一样。
      // 与中间栏孪生 `FileViewer` 同一条判据(那份早就守着;右栏这一处从前没守)。
      if (content.text.trim().length === 0) {
        return (
          <div className="p-4 text-[0.8571em] text-content-muted">{t("templates.preview.emptyFile")}</div>
        );
      }
      if (ext === "md" || ext === "markdown") {
        return (
          <div className="h-full overflow-y-auto">
            <Suspense fallback={<div className="p-4"><IconLoader2 size={14} className="animate-spin" /></div>}>
              <MarkdownPreviewPane markdown={content.text} filePath={pdfPath ? (relPath ? joinPath(pdfPath, relPath) : pdfPath) : undefined} />
            </Suspense>
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
    if (content.mime.startsWith("image/")) {
      return (
        <div className="h-full overflow-auto p-2">
          <img src={`data:${content.mime};base64,${content.base64}`} alt={viewing} className="max-h-full max-w-full mx-auto" />
        </div>
      );
    }
    if (content.mime === "application/pdf" || ext === "pdf") {
      const bytes = base64ToBytes(content.base64);
      // 字节直接喂给阅读器,不再走一次 readPdf(那条路只认条目的 pdfPath)。
      // 目录条目的 entryPath 是目录本身；读的是 relPath 指向的子 PDF，
      // 保存/外部打开也必须指向同一份子文件，否则写入会落到目录上。
      const filePath = pdfPath ? (relPath ? joinPath(pdfPath, relPath) : pdfPath) : undefined;
      return <PdfPreview item={item} bytes={bytes} {...(filePath ? { filePath } : {})} />;
    }
    if (isOnlyOfficeSupportedPath(viewing)) {
      const filePath = pdfPath ? (relPath ? joinPath(pdfPath, relPath) : pdfPath) : undefined;
      if (!filePath) {
        return (
          <div className="flex h-full items-start justify-center p-6">
            <span className="text-center text-xs text-red-500">{t("ide.office.openFailed")}</span>
          </div>
        );
      }
      return (
        <OnlyOfficeEditorPane
          key={filePath}
          filePath={filePath}
          readOnly
        />
      );
    }
    // 未知类型只报 mime：不解码 base64（从前这里白解一遍、结果没人用）。
    return (
      <div className="flex h-full items-start justify-center p-6">
        <span className="text-center text-xs text-content-muted">
          {t("library.file.unknownMime", { mime: content.mime })}
        </span>
      </div>
    );
  }, [loading, error, content, relPath, ext, viewing, item, pdfPath, t]);

  return (
    // `ref` 挂在根那一层 —— 选中的文字必须落在这一整块里才算数（同 `FileViewer`）。
    // **不多包 div**：多包一层会让 PdfPreview / OnlyOfficeEditorPane 那几支"自己管滚动"的
    // 布局多经一道（它们靠父容器直接给高度）。
    <div ref={bodyRef} className="h-full min-h-0">
      {body}
      {/* 选中一段文字 → 「复制 / 引用给…」（见文件头那段：右栏预览从前没有这一层）。 */}
      {sel && !quote && (
        <SelectionToolbar state={sel} onQuote={setQuote} onClose={() => setSel(null)} />
      )}
      {/* 引用给谁 —— 复用对话那一套。目标列表第一行是**右栏此刻展开的那条**，
          所以"引用到当前展开对话"默认就是它（与 `FileViewer` 那一处同一套）。 */}
      {quote && (
        <SelectionQuoteMenu
          state={quote}
          sessionId=""
          currentTitle={t("library.file.thisFile")}
          onPick={quoteTo}
          onClose={() => {
            setQuote(null);
            setSel(null);
          }}
        />
      )}
    </div>
  );
}
