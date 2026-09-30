/**
 * **统一文件预览** —— 所有文件在中间栏走的就是这一个组件。
 *
 * ## 按来源取数 → 归一 → 一套渲染分支
 *
 * 两条来源:文献库条目(`library.readFile`,目录会给一份文件名列表)与项目文件
 * (`file.readFile` / `file.readBinary`)。**渲染分支才是重复的大头**
 * (文本/图片/pdf/OnlyOffice/目录/不支持),所以取数分两支、渲染只有一套。
 *
 * ⚠️ 从前还有第三条来源「模版库文件」(`templates.readFile`,office 由主进程直接给
 * `Uint8Array`)—— 它随模版库并进统一资料库一起撤掉了(左栏只剩一个「资料库」入口)。
 * `templates.readFile` / `openFile` 那几条 RPC **仍然存在**,因为库里的 `linked`
 * 模版条目要靠它们读盘(见 `fileImport.ts` 的 `readEntryFile`),只是不再有独立的
 * 模版预览这一支。
 *
 * ## 顶栏那一条出口只给项目文件
 *
 * 「用系统程序打开」走 `shell.openPath`(它自带项目根围栏)。文献库那一侧还没有对应的
 * RPC,所以不画 —— 一个按下去什么都不发生的按钮比没有更坏。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { makeQuoteTag } from "@renderer/lib/contentTag.js";
import { SelectionToolbar, type SelectionToolbarState } from "@renderer/components/chat/SelectionToolbar.js";
import { SelectionQuoteMenu, type QuoteTarget } from "@renderer/components/chat/SelectionQuoteMenu.js";
import { api } from "@renderer/lib/api.js";
import { dirname, extname, joinPath } from "@renderer/lib/path.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { translate } from "@renderer/lib/i18n/core.js";
import { ChunkedMarkdown } from "@renderer/components/chat/ChunkedMarkdown.js";
// Lazy shell: the PDF engine loads only when a PDF is shown (see PdfPreview.tsx).
import { PdfPreview } from "./PdfPreview.js";
import {
  IconArrowLeft,
  IconExternalLink,
  IconFile,
  IconFolder,
  IconLoader2,
} from "@renderer/lib/icons.js";
import { extOf, type FileViewTarget } from "@renderer/stores/fileViewStore.js";
import { isOnlyOfficeSupportedPath } from "@contracts/ipc";
import { OnlyOfficeEditorPane } from "@renderer/components/ide/OnlyOfficeEditorPane.js";

/**
 * 归一之后的预览数据。**两条来源都落到这里**,下面的渲染分支只认这个类型。
 *
 * 与 `LibraryFileContent` 的差别只有一处,但很要紧:二进制分支给的是**字节**
 * (`bytes`),不是 base64。文献库那条路回来的是 base64,在这里就地解掉；PDF/图片
 * 用这些字节，Office 则通过绝对路径交给 OnlyOffice。
 */
type ViewData =
  | { type: "dir"; files: Array<{ name: string; isDir: boolean }> }
  /** `baseDir`：这份文本所在的**绝对目录** —— 只给 md 用（见下面 `img` 那段）。
   *  没有它的话，md 里 `![](images/1.jpg)` 这种相对引用解析不出来，图片是裂的。 */
  | { type: "text"; text: string; baseDir?: string }
  | {
      type: "binary";
      mime: string;
      bytes: Uint8Array;
      base64: string;
      /**
       * 这个二进制文件在磁盘上的**绝对路径** —— PDF 保存批注与 OnlyOffice 打开都用它。
       * 文献库条目要走 `library.entryPath` 换一次；换不出来就不给，PDF 退化成只读，
       * Office 显示明确错误而不退回本地 renderer。
       */
      filePath?: string;
    }
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
  /** 这个文件的**绝对路径**（拿得到时）—— 引用要用它说清"文件在哪"（见 `quoteTo`）。
   *  条目那一支要从 id 换一次；换不出来（手机端 shim）就是 null，降级成只给文件名。 */
  const [absPath, setAbsPath] = useState<string | null>(null);
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
   *
   * 落点走 store 的 `quoteIntoComposer`（共享实现只有一份，硬规矩 2）——
   * 它内部带 touch 计数，目标会话开着时那个输入框会当场重跑草稿还原、
   * 没开的下次挂载见。见 `deliverComposerDraft` 的说明。
   */
  const quoteTo = useCallback(
    (t2: QuoteTarget, text: string) => {
      const quoted = text.trim();
      setQuote(null);
      setSel(null);
      window.getSelection()?.removeAllRanges();
      if (!quoted) return;
      // **落成一个标签，不是一段纯文本**（2026-09-21）。
      //
      // ★ 用户：「我要的是**像引用文件一样在对话框里面加一个绿色的小标签**」。
      //
      // `makeQuoteTag` 在正文外面套来源抬头 —— 用户要求"如果是文件里面的内容，
      // 提示词也顺便说清楚文件在哪里"。`absPath` 拿不到时降级成只给文件名。
      const tag = makeQuoteTag({
        text: quoted,
        origin: {
          kind: "file",
          filePath: absPath ?? name,
          name,
        },
      });
      useSessionStore.getState().quoteIntoComposer(t2.id, tag);
      useToastStore.getState().push({
        kind: "info",
        title: t("chatStream.quote.doneToast", { name: t2.title }),
        sessionId: t2.id,
      });
    },
    [t, absPath, name],
  );

  // 换目标回到根 —— 上一个目录里翻到一半的子文件对这一条没有意义。
  useEffect(() => {
    setRelPath(target.source.kind === "library" ? (target.source.relPath ?? null) : null);
    setName(target.name);
    // 换文件了旧路径就作废 —— 不然引用时会拿上一个文件的路径。
    setAbsPath(null);
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
          setAbsPath(next.absPath ?? null);
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

  /** 用系统默认程序打开。 */
  const openExternal = useCallback(async () => {
    // 项目文件那一条（2026-09-21）。从前这里只认 `template`，于是项目里的
    // PDF 在中间预览出来后，「用系统程序打开」那个按钮**点了没反应** —— 用户报的
    // 「主页面打不开 pdf」有一部分就是它（另一部分是 `readPdf` 只认条目 id）。
    // 走 `shell.openPath`，它自带「只允许项目根」的围栏（见那个 RPC 的注释）。
    if (target.source.kind !== "project") return;
    setBusy(true);
    try {
      await api.shell.openPath({ path: target.source.ref });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [target]);

  const ext = extOf(name);

  // ── 顶栏:文件名 + 出口。**一直在** —— 加载中/失败时用户也要知道在看哪个文件,
  //    以及能从这里出去。
  //
  //    ⚠️ 出口**只对项目文件画**。文献库还没有"从条目拿绝对路径"那个 RPC
  //    (见文件头那段)—— 画一个按下去什么都不发生的按钮比没有更坏。
  const header = (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-3 py-1.5">
      <IconFile size={13} className="shrink-0 text-content-subtle" />
      <span className="min-w-0 flex-1 truncate text-xs text-content" title={name}>
        {name}
      </span>
      {/* 「用系统程序打开」**只给项目文件那一支**（2026-09-21）—— 它走
          `shell.openPath`（自带项目根围栏）。文献库那一侧还没有对应的 RPC，
          画一个按下去不动的按钮比不画更坏。 */}
      {target.source.kind === "project" && (
        <button
          onClick={() => void openExternal()}
          disabled={busy}
          title={t("templates.ctx.openExternal")}
          className={headerBtn}
        >
          <IconExternalLink size={12} />
        </button>
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
      // 空文件要说出来 —— 一张白板子和"坏了"在界面上长得一模一样。
      if (data.text.trim().length === 0) {
        return (
          <div className="p-4 text-[0.8571em] text-content-muted">{t("templates.preview.emptyFile")}</div>
        );
      }
      // md 走聊天那套渲染(标题/表格/代码块都在);其余原样等宽摆出来。
      // ⚠️ 不把 .tex / .cls 之类也塞进 Markdown 渲染:`#` 在 LaTeX 里是宏参数,
      //    重排之后那份源码就没法读了。
      if (ext === "md" || ext === "markdown") {
        return (
          // ⚠️ **滚动容器交给 `ChunkedMarkdown` 自己**（`scroll="self"` 是默认值）。
          //    这一层只给尺寸（`min-h-0 flex-1`），**不能**再写 `overflow-y-auto` ——
          //    两条滚动叠在一起，外层滚内层不滚，触底哨兵永远不触发。
          //    内边距也跟着挪进滚动容器（原来在外层，现在由 `className` 带进去），
          //    否则滚动条紧贴文字、和从前长得不一样。
          <div className="min-h-0 flex-1">
            {/* ★ `baseDir` 是**必须**的 —— 没有它，md 里的 `![](images/1.jpg)`
                不会去读那个图，而是渲染成一个文件名 chip（用户看到的"图全裂了"）。
                见 `Markdown` 组件 `img` 分支里那句 `if (baseDir)`。 */}
            <ChunkedMarkdown text={data.text} baseDir={data.baseDir} className="h-full px-6 py-4" />
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
      return (
        <PdfPreview
          item={itemOf(target)}
          bytes={bytes}
          {...(data.filePath ? { filePath: data.filePath } : {})}
          onOpenExternal={openExternal}
        />
      );
    }
    if (isOnlyOfficeSupportedPath(name)) {
      if (!data.filePath) {
        return (
          <div className="flex flex-1 items-start justify-center p-6">
            <span className="text-center text-xs text-danger">{t("ide.office.openFailed")}</span>
          </div>
        );
      }
      return (
        <OnlyOfficeEditorPane
          key={data.filePath}
          filePath={data.filePath}
          readOnly
        />
      );
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
    <div ref={bodyRef} className="flex h-full min-h-0 flex-col bg-surface">
      {header}
      {/* `ref` 挂在**根那一层**上（2026-09-21）—— 见下面 `root.contains` 那句：
          选中的文字必须落在这一整块里才算数。**不多包任何一层 div**：多包一层会让
          `PdfPreview` / `OnlyOfficeEditorPane` 那几支"自己管滚动"的布局多经一道（它们靠父容器
          直接给高度），而这层 ref 只需要"是个容器"就够了 —— 根 div 本来就是。 */}
      {body}

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
): Promise<{ data: ViewData; name?: string; absPath?: string }> {
  if (target.source.kind === "library") {
    const res = await api.library.readFile({
      id: target.source.ref,
      relPath: relPath ?? undefined,
      // 看**哪一份**。用户要的是「点击和双击都显示 PDF 本身」—— 所以中间栏也走本体，
      // 与右栏预览同一条判据（从前这里靠主进程回退到 `md_path`，于是点 PDF 弹转录）。
      which: target.source.which,
    });
    const c = res.content;
    if (c.type === "dir") return { data: { type: "dir", files: c.files } };
    if (c.type === "text") {
      /**
       * ★ **必须带上目录，否则 md 里的图片是裂的。**
       *
       * `Markdown` 的 `img` 分支只在**有 `baseDir`** 时才把相对路径解析成本地
       * 文件去读（`MarkdownLocalImage` → `file.readBinary`）；没有 baseDir 时它
       * 退化成"渲染成一个可点击的文件名 chip" —— 也就是用户看到的"图全裂了"。
       *
       * 条目只给 id、不给路径（`LibraryFileContent` 的 text 分支没有路径字段），
       * 所以走 `library.entryPath` 换一次。**换不出来就算了**（目录条目、
       * 或文件已经不在盘上），那种情况下退化成 chip 也比报错强。
       */
      let baseDir: string | undefined;
      let mdPath: string | undefined;
      try {
        const p = await api.library.entryPath({
          id: target.source.ref,
          ...(target.source.which ? { which: target.source.which } : {}),
        });
        if (p.path) {
          baseDir = dirname(p.path);
          // 条目根 + relPath = 用户**正在看的那份子文件**的绝对路径。
          // 从前只给条目根 —— 目录条目里翻进子文件后引用，「来源」指向的是根，
          // 模型按它去读会读错文件。
          mdPath = relPath ? joinPath(p.path, relPath) : p.path;
        }
      } catch {
        /* 手机端 `api.library` 是抛错的代理 —— 拿不到就没有 baseDir */
      }
      // `absPath` 给引用用（提示词里要说清"这个文件在哪"）—— 拿不到就不给。
      return {
        data: { type: "text", text: c.text, ...(baseDir ? { baseDir } : {}) },
        ...(mdPath ? { absPath: mdPath } : {}),
      };
    }
    if (c.type === "unsupported") return { data: { type: "unsupported", error: c.error } };
    // 路径：与上面 md 那支同一个调用。PDF 保存批注要落到原文件上，
    // 而条目只给 id —— 换不出来就退化成只读（阅读器那边不画保存按钮）。
    // 引用来源同理要带上 relPath（子文件场景，见上面 md 那支的说明）。
    let binPath: string | undefined;
    try {
      const p = await api.library.entryPath({
        id: target.source.ref,
        ...(target.source.which ? { which: target.source.which } : {}),
      });
      if (p.path) binPath = relPath ? joinPath(p.path, relPath) : p.path;
    } catch {
      /* 手机端 `api.library` 是抛错的代理 */
    }
    return {
      data: {
        type: "binary",
        mime: c.mime,
        base64: c.base64,
        // ⚠️ 这里解一次就够 —— 下游每个分支再解一次是白烧 CPU(大 PDF 十几 MB)。
        bytes: base64ToBytes(c.base64),
        ...(binPath ? { filePath: binPath } : {}),
      },
      ...(binPath ? { absPath: binPath } : {}),
    };
  }

  // 项目文件那一支（见 `loadProjectFileData` 的说明）。
  if (target.source.kind === "project") {
    const data = await loadProjectFileData(target.source.ref);
    // 项目文件的绝对路径就是 `ref` 本身 —— 引用时直接给它。
    return { data, absPath: target.source.ref };
  }
  // 两种来源都处理完了 —— 走到这儿说明 `FileSource` 加了新成员却没在这里接。
  throw new Error("不认识的预览来源");
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
/**
 * 读一个项目文件，归一到 `ViewData`。
 *
 * ## ⚠️ "先按文本试读"这个策略对 PDF 是**错的**（2026-09-21 修）
 *
 * 这里从前只有一条判断："先 `file.readFile` 当文本读，读不动（抛了）再走二进制"。
 * 那条判断背后的假设是「二进制文件解不出文本、会抛」—— **而 PDF 不满足它**：
 * PDF 的头是 `%PDF-1.7`、对象头是 `2 0 obj`、字典是 `<</Length 3 0 R/Filter/
 * FlateDecode>>` —— 全是**合法的 ASCII**，`readFile` 读得动。于是它被当成文本
 * 返回，屏幕上就出现"一半正常一半乱码方块"那一屏（用户截图里正是这个）。
 *
 * 而且**注释早就写下了这个风险**（"列一张'哪些是文本'的表必然漏"）—— 结论反了：
 * 正因为列不全，才**必须**按扩展名先把已知的二进制格式拦掉，不能靠"试读抛不抛"。
 *
 * ## 判据
 *
 * `BINARY_EXTS` 是**已知的、确定不该当文本读**的那一类（pdf / office / 压缩包 /
 * 可执行 / 字体 / 常见图片）。它**不需要列全**——列进去的走二进制，没列进去的
 * 照旧"先试文本、抛了再二进制"，所以漏一个的后果只是"多试一次文本"，不会错。
 * 这是刻意的：一张必须完整的表迟早会漏，一张"只做加速/纠偏"的表漏了也不会坏。
 */
async function loadProjectFileData(filePath: string): Promise<ViewData> {
  if (!BINARY_EXTS.has(extname(filePath).toLowerCase())) {
    try {
      const res = await api.file.readFile({ filePath });
      // 项目文件本来就有绝对路径 —— md 里的相对图片能直接解析（同 library 那支）。
      return { type: "text", text: res.content, baseDir: dirname(filePath) };
    } catch {
      // 不是文本(或读不动)—— 落到二进制那一支。
    }
  }
  const bin = await api.file.readBinary({ filePath });
  if (!bin.dataUrl) {
    return {
      type: "unsupported",
      error: translate(useSessionStore.getState().locale, "library.viewer.unreadable"),
    };
  }
  const comma = bin.dataUrl.indexOf(",");
  const base64 = comma >= 0 ? bin.dataUrl.slice(comma + 1) : "";
  const mime = /^data:([^;,]+)/.exec(bin.dataUrl)?.[1] ?? "application/octet-stream";
  // `filePath` 参数**本来就是绝对路径** —— PDF 保存批注要用它落回原文件。
  return { type: "binary", mime, base64, bytes: base64ToBytes(base64), filePath };
}

/** **确定不该当文本读**的扩展名。见 `loadProjectFileData` 的头注 —— 这张表只需要
 * 覆盖"头几个字节是合法 ASCII、试读不会抛"的那类格式，PDF 是最典型的一个。 */
const BINARY_EXTS = new Set([
  // 文档
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
  // 压缩包
  ".zip",
  ".gz",
  ".tar",
  ".tgz",
  ".rar",
  ".7z",
  ".bz2",
  ".xz",
  // 图片（这几种也常有 ASCII 头，如 PNG 的 \x89PNG / JPEG 的 JFIF）
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
  // 字体 / 可执行
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]);
