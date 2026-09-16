/**
 * 右栏的「模版」面板 —— 应用内预览模版里的一个文件。
 *
 * ## 为什么是右栏,而不是在左栏就地展开
 *
 * 用户的要求是「像 md 笔记一样,可以在左边预览」。文献库那一套的落点其实就是**右栏**:
 * 在左栏点一篇文献,右栏切到「文献库」标签把它显示出来。所以这里照抄同一套 ——
 * 左栏是**导航**、右栏是**内容**:左栏两百来像素宽,一屏 LaTeX 源在那儿根本不够看。
 *
 * ## 先做哪一类文件
 *
 * 用户说「什么文件的预览比较简单就先做哪一个」。**文本 / 代码最简单** —— 读出字节
 * 就是可以给人看的东西,不需要任何转换管线;而且它恰好是模版库里最需要先扫一眼的
 * (LaTeX 源、`.cls`、`.bib`、脚本、配置)。图片同样便宜(一个 data URL),而模版库
 * 本来就有「图片」类目,所以一并做了。
 *
 * **Word / Excel / PPT 2026-09-16 全都真渲染了**(见 `DocxPreview.tsx` /
 * `XlsxPreview.tsx` / `PptxPreview.tsx`)—— 在那之前这三种只抽文字,而模版要看的就是
 * 版式。**PDF 仍然没有应用内预览**(它要一整套分页渲染管线,那是文献库那一头的事),
 * 所以那一种如实说明并给「用外部程序打开」。假装支持比不支持更糟。
 */
import { useEffect, useState } from "react";
import type { TemplateFileContent, TemplateKind } from "@contracts/templates";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { TEMPLATE_KIND_LABEL } from "@renderer/lib/templateLabels.js";
import { api } from "@renderer/lib/api.js";
import { formatBytes } from "@renderer/lib/format.js";
import { cn } from "@renderer/lib/cn.js";
import { useTemplateStore } from "@renderer/stores/templateStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import { IconExternalLink, IconFileText, IconFolderOpen, IconTemplate } from "@renderer/lib/icons.js";
import { DocxPreview } from "./DocxPreview.js";
import { XlsxPreview } from "./XlsxPreview.js";
import { PptxPreview } from "./PptxPreview.js";

export function TemplatePanel() {
  const { t } = useI18n();
  const sel = useTemplateStore((s) => s.previewFile);
  const [content, setContent] = useState<TemplateFileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 重新读一次的触发器。
   *
   * 磁盘上的模版文件可能被**外面**改掉(用户在自己的编辑器里改完 .tex 再回来看),
   * 也可能被左栏的操作整体移走。`sel` 不变时上面那个 effect 不会重跑,所以用一个
   * 自增的计数把它推一下 —— 见下面订阅 `templates:changed` 的那一段。
   */
  const [nonce, setNonce] = useState(0);

  /**
   * 拉正文。`sel` 每次打开都是新对象(store 里 set 的是新字面量),所以它当依赖是
   * 精确的 —— 同一个文件再点一次也会重读一遍,而那正是想要的("我改完源码了,再看"）。
   *
   * `cancelled` 不能省:连着点几个文件时,先发的请求可能后回来,把后来那次的结果
   * 覆盖掉。这与 LibraryPanel 里那些异步读取是同一个套路。
   */
  useEffect(() => {
    if (!sel) {
      setContent(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await api.templates.readFile(sel);
        if (!cancelled) setContent(res);
      } catch (err) {
        if (!cancelled) {
          setContent(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sel, nonce]);

  /**
   * 模版库变了 → 跟在看的这一个文件对齐。
   *
   * **左栏的操作必须立刻反映到右栏**(用户原话:「左边框的操作要和右边的预览要实时
   * 同步」),而右栏这一屏是它自己的 state。两种情况都要管:
   *
   *   - 这一条还在(哪怕是被**移进回收站**了 —— 回收站里的模版照样能预览,与文献库
   *     一致)→ 重读一遍文件,内容跟着磁盘走;
   *   - 这一条已经从磁盘上彻底删掉了 → 收掉预览。留着一个读不到的文件会让面板停在
   *     一条看不懂的错误上,而"它已经不在了"才是用户要知道的事。
   *
   * 判据用 `load()` **之后**的那份列表,而不是当前缓存:这条广播的发送者可能正是
   * 唯一在维护缓存的那个组件,也可能根本没有别的组件挂载着(流模式)。
   */
  useEffect(() => {
    const off = window.api?.on?.templatesChanged?.(() => {
      void (async () => {
        const store = useTemplateStore.getState();
        if (!store.previewFile) return;
        await store.load();
        const now = useTemplateStore.getState();
        const cur = now.previewFile;
        if (!cur) return;
        const alive = [...now.entries, ...now.trashed].some(
          (e) => e.kind === cur.kind && e.dirName === cur.dirName,
        );
        if (alive) setNonce((n) => n + 1);
        else now.closePreview();
      })();
    });
    return off;
  }, []);

  const report = (body?: string) =>
    useToastStore
      .getState()
      .push({ kind: "error", title: t("templates.preview.actionFailed"), body });

  /** 用系统默认程序打开 —— Word / PPT / PDF 只能这么看。 */
  const openExternal = async () => {
    if (!sel) return;
    try {
      const res = await api.templates.openFile(sel);
      if (!res.ok) report(res.error);
    } catch (err) {
      report(err instanceof Error ? err.message : String(err));
    }
  };

  /** 在这条模版的文件夹里定位 —— 走的是条目级的 reveal(文件就在那里面)。 */
  const revealEntry = async () => {
    if (!sel) return;
    try {
      const res = await api.templates.reveal({ kind: sel.kind, dirName: sel.dirName });
      if (!res.ok) report(res.error);
    } catch (err) {
      report(err instanceof Error ? err.message : String(err));
    }
  };

  const actionClass =
    "flex items-center gap-1 rounded px-1.5 py-0.5 text-content-subtle transition-colors hover:bg-surface-hover hover:text-content [font-size:var(--rp-fs-md)]";

  return (
    <div className="flex h-full flex-col">
      {/* 头部:看的是哪个文件、属于哪条模版,以及两条"看不了就在这里看"的出口。 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-2 py-1.5">
        <IconFileText size={13} className="shrink-0 text-content-subtle" />
        <span className="min-w-0 flex-1 truncate text-xs text-content" title={sel?.relPath}>
          {sel?.relPath ?? t("templates.preview.title")}
        </span>
        {sel && (
          <>
            <span
              className="hidden shrink-0 items-center gap-1 text-content-subtle [font-size:var(--rp-fs-md)] sm:flex"
              title={`${t(TEMPLATE_KIND_LABEL[sel.kind])} · ${sel.dirName}`}
            >
              <IconTemplate size={11} />
              <span className="max-w-[8rem] truncate">{sel.dirName}</span>
            </span>
            <button onClick={() => void revealEntry()} title={t("settings.templates.reveal")} className={actionClass}>
              <IconFolderOpen size={12} />
            </button>
            <button
              onClick={() => void openExternal()}
              title={t("templates.ctx.openExternal")}
              className={actionClass}
            >
              <IconExternalLink size={12} />
            </button>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!sel ? (
          <div className="p-3 text-content-subtle [font-size:var(--rp-fs-md)]">
            {t("templates.preview.empty")}
          </div>
        ) : loading ? (
          <div className="p-3 text-content-subtle [font-size:var(--rp-fs-md)]">…</div>
        ) : error ? (
          <div className="p-3 text-red-500 [font-size:var(--rp-fs-md)]">{error}</div>
        ) : content?.kind === "text" ? (
          <>
            {content.truncated && (
              <div className="border-b border-edge bg-amber-500/10 px-3 py-1.5 text-amber-700 dark:text-amber-400 [font-size:var(--rp-fs-md)]">
                {t("templates.preview.truncated", { size: formatBytes(content.size) })}
              </div>
            )}
            {content.text.trim().length === 0 ? (
              // 空文件要说出来。一张白板子和"坏了"在界面上长得一模一样。
              <div className="p-3 text-content-muted [font-size:var(--rp-fs-md)]">
                {t("templates.preview.emptyFile")}
              </div>
            ) : (
              /* 等宽 + 保留空白:这是源码(.tex / .cls / 脚本),重排会把它变得没法读。
                 `whitespace-pre` + 横向滚动,而不是 `pre-wrap` —— 代码的缩进是信息。 */
              <pre className="min-h-full w-max min-w-full px-3 py-2 font-mono text-[0.7857em] leading-relaxed text-content">
                {content.text}
              </pre>
            )}
          </>
        ) : content?.kind === "image" ? (
          <div className={cn("flex justify-center p-3")}>
            <img
              src={content.dataUrl}
              alt={sel.relPath}
              className="max-h-full max-w-full rounded border border-edge bg-surface"
            />
          </div>
        ) : content?.kind === "docx" ? (
          // 真渲染版式(见 `DocxPreview.tsx`)。**它自己管滚动和缩放**,所以不吃外面
          // 那层 `overflow-auto` —— 铺满这一格就对了。
          //
          // `relPath` 当依赖键:换成另一个文件要整份重排,而不是在旧内容上接着画。
          <DocxPreview
            data={content.data}
            relPath={sel.relPath}
            onOpenExternal={() => void openExternal()}
          />
        ) : content?.kind === "xlsx" ? (
          // 同上,只是换成表格那一份。**同样是它自己管滚动和尺寸**,所以别在外面加
          // `overflow-auto` —— 表格画的是自己的滚动条和冻结的行号列标。
          <XlsxPreview
            data={content.data}
            relPath={sel.relPath}
            onOpenExternal={() => void openExternal()}
          />
        ) : content?.kind === "pptx" ? (
          // 第三份,幻灯片。滚动交给它自己(整摞片子一条滚动条,见 `PptxPreview.tsx`)。
          <PptxPreview
            data={content.data}
            relPath={sel.relPath}
            onOpenExternal={() => void openExternal()}
          />
        ) : content?.kind === "unsupported" ? (
          // 不是"失败",是这类文件本来就该用别的程序看 —— 所以文案是说明,不是报错
          <div className="flex flex-col items-start gap-2 p-3 text-content-muted [font-size:var(--rp-fs-md)]">
            <p>
              {content.reason === "tooLarge"
                ? t("templates.preview.tooLarge", { size: formatBytes(content.size) })
                : t("templates.preview.binary")}
            </p>
            <button onClick={() => void openExternal()} className="rounded border border-edge px-2 py-0.5 hover:bg-surface-hover hover:text-content">
              {t("templates.ctx.openExternal")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
