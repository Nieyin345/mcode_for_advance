/**
 * **统一文件预览** —— 所有文件在中间栏走的就是这一个组件。
 *
 * ## 它合并了哪两份
 *
 * 从前应用里有**两套**文件预览,都在右栏,各写各的:
 *
 *   `library/FilePreview.tsx`  ── 文献库条目。字节走 `library.readFile`(base64),
 *                                  office 三种格式**在渲染端**解 base64 再喂预览组件。
 *   `templates/TemplatePanel.tsx` ── 模版库文件。字节走 `templates.readFile`,
 *                                  **主进程已经分好类**(office 直接给 `Uint8Array`),
 *                                  渲染端只管画。
 *
 * 同一张 pptx,从文献库点开和从模版库点开,走的是两份代码、两条形状不同的数据。
 * 这个文件把两者收成一条:**按来源取数 → 归一到 `ViewData` → 一套渲染分支**。
 *
 * ## 为什么要归一,而不是"两边各留一份、外面套个壳"
 *
 * 因为**渲染分支才是重复的大头**(文本/图片/pdf/office/目录/不支持,六路)。留着两份
 * 取数、一份渲染,等于把两条路合并到"用哪条路读"这一格上 —— 那一格本来就只有一行。
 * 反过来(一份取数、两份渲染)才会留下两套会各自跑偏的画法。
 *
 * ## 目录只有文献库有
 *
 * `library.readFile` 对目录回一份文件名列表;模版库里没有"目录条目"这个概念
 * (`templates.list` 已经摊平到文件一层)。所以 `relPath` 只对 `library` 那一支有意义,
 * 模版那一支恒为根。
 *
 * ## 两个 `onOpenExternal` 为什么不一样
 *
 * 文献库的条目落在数据根下,模版文件落在模版库里 —— 各有各的"用系统程序打开"通道,
 * 而且**只有模版那条有现成的 IPC**(`templates.openFile`)。文献库那一条主进程还没有,
 * 所以那一支给的是 no-op(与 `FilePreview` 当年的处理一字不差,只是把原因写在了这里)。
 *
 * 顶栏上那两条出口也因此**只对模版画** —— 一个按下去什么都不发生的按钮比没有更坏
 * (PDF 那个组件内部的出口同理,见它签名那段)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { SelectionToolbar, type SelectionToolbarState } from "@renderer/components/chat/SelectionToolbar.js";
import { SelectionQuoteMenu, type QuoteTarget } from "@renderer/components/chat/SelectionQuoteMenu.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { PdfPreview } from "./PdfPreview.js";
import { DocxPreview } from "@renderer/components/templates/DocxPreview.js";
import { PptxPreview } from "@renderer/components/templates/PptxPreview.js";
import { XlsxPreview } from "@renderer/components/templates/XlsxPreview.js";
import {
  IconArrowLeft,
  IconExternalLink,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconLoader2,
} from "@renderer/lib/icons.js";
import { extOf, type FileViewTarget } from "@renderer/stores/fileViewStore.js";

/**
 * 归一之后的预览数据。**两条来源都落到这里**,下面的渲染分支只认这个类型。
 *
 * 与 `LibraryFileContent` 的差别只有一处,但很要紧:二进制那一支给的是**字节**
 * (`bytes`),不是 base64。文献库那条路回来的是 base64,在这里就地解掉 —— 于是
 * office 预览组件不必知道自己是"从哪条路来的",也省掉下游每个分支各解一次。
 */
type ViewData =
  | { type: "dir"; files: Array<{ name: string; isDir: boolean }> }
  | { type: "text"; text: string }
  | { type: "binary"; mime: string; bytes: Uint8Array; base64: string }
  | { type: "unsupported"; error: string };

/** base64 → 字节。预览体积上限在主进程挡着,这个循环最多几十毫秒。 */
function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function FileViewer({ target }: { target: FileViewTarget }) {
  const { t } = useI18n();
  /** 文献库目录条目:正在往下翻到哪一层(`/` 分隔)。模版那一支恒为 null。 */
  const [relPath, setRelPath] = useState<string | null>(
    target.source.kind === "library" ? (target.source.relPath ?? null) : null,
  );
  const [data, setData] = useState<ViewData | null>(null);
  const [name, setName] = useState(target.name);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /**
   * **在文件里选一段文字 → 引用给某条对话**（2026-09-21）。
   *
   * ★ 用户的要求：「主页面展示的文件**可以鼠标选择，然后引用到当前展开对话的上下文**
   * 里面」。
   *
   * ## 从前这件事根本做不到
   *
   * `SelectionToolbar` 只挂在 `ChatPane` 上 —— 也就是说**只有在对话里选文字**才弹
   * 那个工具条。文件预览里选一段，什么都不会发生。这里把它也挂到文件这一侧。
   *
   * ## 只给两个按钮（复制 / 引用）
   *
   * 书签和「问侧边对话」都不给：书签靠 `state.messageId` 定位（那是消息流里才有的
   * 东西，文件没有），而"问侧边"与"引用给某条"在这里是同一件事，没必要两个入口。
   * `SelectionToolbar` 那两个回调现在是可选的，不给就不画 —— 见它的 props 说明。
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
          // 文件里没有消息 id —— 给空串。上面那套书签因此不画（见 state 那段）。
          messageId: "",
          role: "assistant",
        });
      }, 0);
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, []);

  /**
   * 引用落到哪 —— **只落草稿、不替用户发**（与对话里那条逐字同一个做法：
   * 「我先看看再发」才是更稳的那一步）。
   */
  const quoteTo = useCallback(
    (t2: QuoteTarget, text: string) => {
      const quoted = text.trim();
      setQuote(null);
      setSel(null);
      window.getSelection()?.removeAllRanges();
      if (!quoted) return;
      const store = useSessionStore.getState();
      const prev = store.composerDraftBySession[t2.id];
      store.saveComposerDraft(t2.id, {
        text: prev?.text ? `${prev.text}

${quoted}` : quoted,
        html: "",
        tags: prev?.tags ?? [],
      });
      useToastStore.getState().push({
        kind: "info",
        title: t("chatStream.quote.doneToast", { name: t2.title }),
        sessionId: t2.id,
      });
    },
    [t],
  );

  // 换目标回到根 —— 上一个目录里翻到一半的子文件对这一条没有意义。
  useEffect(() => {
    setRelPath(target.source.kind === "library" ? (target.source.relPath ?? null) : null);
    setName(target.name);
  }, [target]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const next = await loadViewData(target, relPath);
        if (!cancelled) {
          setData(next.data);
          if (next.name !== undefined) setName(next.name);
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
  }, [target, relPath]);

  /** 用系统默认程序打开。模版与**项目文件**各有一条通道（见文件头那段）。 */
  const openExternal = useCallback(async () => {
    // **项目文件那条**（2026-09-21）。从前这里只认 `template`，于是项目里的
    // PDF 在中间预览出来后，「用系统程序打开」那个按钮**点了没反应** —— 用户报的
    // 「主页面打不开 pdf」有一部分就是它（另一部分是 `readPdf` 只认条目 id）。
    // 走 `shell.openPath`，它自带「只允许项目根」的围栏（见那个 RPC 的注释）。
    if (target.source.kind === "project") {
      setBusy(true);
      try {
        await api.shell.openPath({ path: target.source.ref });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (target.source.kind !== "template") return;
    setBusy(true);
    try {
      const res = await api.templates.openFile({
        kind: target.source.ref.kind as never,
        dirName: target.source.ref.dirName,
        relPath: target.source.ref.relPath,
      });
      if (!res.ok) setError(res.error ?? t("templates.preview.actionFailed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [target, t]);

  /** 在系统文件管理器里定位。同样只有模版那条有。 */
  const reveal = useCallback(async () => {
    if (target.source.kind !== "template") return;
    setBusy(true);
    try {
      const res = await api.templates.reveal({
        kind: target.source.ref.kind as never,
        dirName: target.source.ref.dirName,
      });
      if (!res.ok) setError(res.error ?? t("templates.preview.actionFailed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [target, t]);

  const ext = extOf(name);

  // ── 顶栏:文件名 + 两条出口。**一直在** —— 加载中/失败时用户也要知道在看哪个文件,
  //    以及能从这里出去。这也是它比原来那两份强的地方:那两份的顶栏只在成功时画。
  //
  //    ⚠️ 两条出口**只对模版那一支画**:文献库还没有对应的 IPC(见文件头那段)。
  //    从前这里画了但点不动 —— 一个能按下去、按了什么都不发生的按钮,比没有更坏。
  //    什么时候主进程给文献库补上 `openFile` / `revealFile` 那个"从条目拿绝对路径"的
  //    通道,什么时候再把它放回来。
  const header = (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-3 py-1.5">
      <IconFile size={13} className="shrink-0 text-content-subtle" />
      <span className="min-w-0 flex-1 truncate text-xs text-content" title={name}>
        {name}
      </span>
      {/* **项目文件也给「用系统程序打开」**（2026-09-21）—— 从前这里只放
          `template`，于是项目里的 PDF 在中间预览出来之后**没有任何出口**，用户读到的是
          「主页面打不开 pdf」。它现在走 `shell.openPath`（那条自带项目根围栏）。
          「在文件夹中显示」仍然只给模版：项目文件那一侧还没有对应的 RPC，
          画一个按下去不动的按钮比不画更坏。 */}
      {(target.source.kind === "template" || target.source.kind === "project") && (
        <>
          {target.source.kind === "template" && (
            <button
              onClick={() => void reveal()}
              disabled={busy}
              title={t("settings.templates.reveal")}
              className={headerBtn}
            >
              <IconFolderOpen size={12} />
            </button>
          )}
          <button
            onClick={() => void openExternal()}
            disabled={busy}
            title={t("templates.ctx.openExternal")}
            className={headerBtn}
          >
            <IconExternalLink size={12} />
          </button>
        </>
      )}
    </div>
  );

  const body = (() => {
    if (loading) {
      return (
        <div className="flex flex-1 items-center justify-center text-content-subtle">
          <IconLoader2 size={14} className="animate-spin" />
        </div>
      );
    }
    if (error !== null) {
      return (
        <div className="flex flex-1 items-start justify-center p-6">
          <span className="break-all text-center text-xs text-danger">{error}</span>
        </div>
      );
    }
    if (data === null) return null;

    if (data.type === "unsupported") {
      return (
        <div className="flex flex-1 items-start justify-center p-6">
          <span className="break-all text-center text-xs text-danger">{data.error}</span>
        </div>
      );
    }

    // ── 目录:文件名列表,点子文件/子目录用 relPath 再读一次 ──
    if (data.type === "dir") {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          {relPath !== null && (
            <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
              <button
                onClick={() => setRelPath(relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : null)}
                className="flex items-center gap-1 rounded px-1 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
              >
                <IconArrowLeft size={12} />
                {t("library.file.back")}
              </button>
              <span className="min-w-0 truncate font-mono text-[0.7857em] text-content-subtle">
                {relPath}
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {data.files.length === 0 ? (
              <div className="px-2 py-1 text-[0.7857em] text-content-subtle">
                {t("library.file.emptyDir")}
              </div>
            ) : (
              data.files.map((f) => (
                <button
                  key={f.name}
                  onClick={() => setRelPath(relPath === null ? f.name : `${relPath}/${f.name}`)}
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

    if (data.type === "text") {
      // 空文件要说出来 —— 一张白板子和"坏了"在界面上长得一模一样(同 TemplatePanel)。
      if (data.text.trim().length === 0) {
        return (
          <div className="p-4 text-[0.8571em] text-content-muted">{t("templates.preview.emptyFile")}</div>
        );
      }
      // md 走聊天那套渲染(标题/表格/代码块都在);其余原样等宽摆出来。
      // ⚠️ 不把 .tex / .cls 之类也塞进 Markdown 渲染:`#` 在 LaTeX 里是宏参数,
      //    重排之后那份源码就没法读了(同 TemplatePanel 当年那条注释)。
      if (ext === "md" || ext === "markdown") {
        return (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <Markdown>{data.text}</Markdown>
          </div>
        );
      }
      return (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[0.8571em] leading-relaxed text-content">
          {data.text}
        </pre>
      );
    }

    // ── 二进制 ──
    const { bytes, mime } = data;
    if (mime.startsWith("image/")) {
      return (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <img
            src={`data:${mime};base64,${data.base64}`}
            alt={name}
            className="mx-auto max-h-full max-w-full"
          />
        </div>
      );
    }
    if (mime === "application/pdf" || ext === "pdf") {
      return <PdfPreview item={itemOf(target)} bytes={bytes} onOpenExternal={openExternal} />;
    }
    // office 三种:预览组件吃字节,自己管滚动和缩放,所以不吃外面的容器样式。
    // 渲染不出来时的那条出口一律指向 `openExternal` —— 模版那一支有 `templates.openFile`
    // 通道,文献库那一支还没有,所以那里是 no-op(见文件头那段)。
    if (mime.includes("wordprocessingml") || ext === "docx" || ext === "dotx") {
      return <DocxPreview data={bytes} relPath={name} onOpenExternal={() => void openExternal()} />;
    }
    if (mime.includes("presentationml") || ext === "pptx" || ext === "ppsx" || ext === "potx") {
      return <PptxPreview data={bytes} relPath={name} onOpenExternal={() => void openExternal()} />;
    }
    if (mime.includes("spreadsheetml") || ext === "xlsx" || ext === "xlsm" || ext === "xltx") {
      return <XlsxPreview data={bytes} relPath={name} onOpenExternal={() => void openExternal()} />;
    }
    return (
      <div className="flex flex-1 items-start justify-center p-6">
        <span className="text-center text-xs text-content-muted">
          {t("library.file.unknownMime", { mime })}
        </span>
      </div>
    );
  })();

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {header}
      {/* `ref` 包住正文 —— 选中的文字必须落在**这一块里面**才算数（不然在别处拖选
          也会弹出这个工具条，见那个 mouseup 监听的 `root.contains` 那一句）。 */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {body}
      </div>

      {/* 选中一段文字 → 只有「复制 / 引用给…」两个按钮（见 state 那段）。 */}
      {sel && !quote && (
        <SelectionToolbar
          state={sel}
          onQuote={setQuote}
          onClose={() => setSel(null)}
        />
      )}
      {/* 引用给谁 —— 复用对话那一套（`SelectionQuoteMenu`）。它的目标列表第一行是
          **右栏此刻展开的那条**，所以"引用到当前展开对话"是这个列表的默认那一项。 */}
      {quote && (
        <SelectionQuoteMenu
          state={quote}
          // 文件里没有"当前会话"这个概念：把空串传进去，列表就只剩
          // 「右栏展开的那条 + 它的节点会话」——正是这里该有的候选。
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

const headerBtn =
  "shrink-0 rounded p-1 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content disabled:opacity-40";

/**
 * `PdfPreview` 只认一个条目 id(见它签名那段)。这里给一个**只够它画**的壳:
 * 文献库那一支给条目 id(「用系统程序打开」要用它去找路径);模版那一支没有条目,
 * 给空串 —— 那条出口由 `onOpenExternal` 接管。
 */
function itemOf(target: FileViewTarget): { id: string } {
  return { id: target.source.kind === "library" ? target.source.ref : "" };
}

/**
 * 按**来源**取数,归一到 `ViewData`。
 *
 * 这是两条路唯一的交汇点 —— 上面所有渲染分支都只认归一后的形状。
 */
async function loadViewData(
  target: FileViewTarget,
  relPath: string | null,
): Promise<{ data: ViewData; name?: string }> {
  if (target.source.kind === "library") {
    const res = await api.library.readFile({
      id: target.source.ref,
      relPath: relPath ?? undefined,
    });
    const c = res.content;
    if (c.type === "dir") return { data: { type: "dir", files: c.files } };
    if (c.type === "text") return { data: { type: "text", text: c.text } };
    if (c.type === "unsupported") return { data: { type: "unsupported", error: c.error } };
    return {
      data: {
        type: "binary",
        mime: c.mime,
        base64: c.base64,
        // ⚠️ 这里解一次就够 —— 下游每个分支再解一次是白烧 CPU(大 PDF 十几 MB)。
        bytes: base64ToBytes(c.base64),
      },
    };
  }

  // 项目文件那一支（见 `loadProjectFileData` 的说明）。
  if (target.source.kind === "project") {
    return { data: await loadProjectFileData(target.source.ref) };
  }

  const res = await api.templates.readFile({
    kind: target.source.ref.kind as never,
    dirName: target.source.ref.dirName,
    relPath: target.source.ref.relPath,
  });
  // 模版那条**主进程已经分好类**:office 直接给 Uint8Array,连 mime 都是现成的。
  // 但它没有 mime 字段,所以 office 那三支靠扩展名认(下面的渲染分支两种都认)。
  if (res.kind === "text") return { data: { type: "text", text: res.text } };
  if (res.kind === "image") {
    // data URL → base64 那一段。`image` 那一支和 `binary` 共用渲染分支。
    const comma = res.dataUrl.indexOf(",");
    const base64 = comma >= 0 ? res.dataUrl.slice(comma + 1) : "";
    const mime = /^data:([^;,]+)/.exec(res.dataUrl)?.[1] ?? "image/png";
    return { data: { type: "binary", mime, base64, bytes: base64ToBytes(base64) } };
  }
  if (res.kind === "unsupported") {
    return {
      data: {
        type: "unsupported",
        error:
          res.reason === "tooLarge"
            ? `文件太大,看不了(${Math.round(res.size / 1024 / 1024)} MB)`
            : "这个格式没法在应用里预览。",
      },
    };
  }
  const mime =
    res.kind === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : res.kind === "pptx"
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return { data: { type: "binary", mime, base64: "", bytes: res.data } };
}

/**
 * **项目文件**那一支(用户 2026-09-20:「点预览看它一眼、双击才进编辑器改」)。
 *
 * ## 为什么先试文本、再试二进制
 *
 * 主进程那两条 RPC 是**分开**的(`file:readFile` 给文本、`file:readBinary` 给
 * `data:` URL),而这里手上只有一个路径 —— 得自己判该走哪条。
 *
 * 判据**不按扩展名**:项目里 `.md` / `.json` / 没有后缀的配置、`.env` 那种都该当
 * 文本看,而列一张"哪些是文本"的表必然漏。所以**先按文本读**:读得动就是文本,
 * 抛了(二进制解不出来)再走二进制那条。主进程两条都带**项目根防逃逸**,所以
 * 路径不合法时这里也会抛,那句话如实透出去。
 *
 * ⚠️ 二进制那条**返回的是 `data:` URL 而不是裸 base64**,而且失败时给空串
 * (见 `FileReadBinarySchema` 的说明)—— 所以空串要**当成失败**报出来,不能当成
 * "一个 0 字节的文件"(那两件事在界面上长得一样)。
 */
async function loadProjectFileData(filePath: string): Promise<ViewData> {
  try {
    const res = await api.file.readFile({ filePath });
    return { type: "text", text: res.content };
  } catch {
    // 不是文本(或读不动)—— 落到二进制那一支。
  }
  const bin = await api.file.readBinary({ filePath });
  if (!bin.dataUrl) {
    return { type: "unsupported", error: "这个文件读不出来(可能不是文本,也不像能预览的图片/PDF)。" };
  }
  const comma = bin.dataUrl.indexOf(",");
  const base64 = comma >= 0 ? bin.dataUrl.slice(comma + 1) : "";
  const mime = /^data:([^;,]+)/.exec(bin.dataUrl)?.[1] ?? "application/octet-stream";
  return { type: "binary", mime, base64, bytes: base64ToBytes(base64) };
}
