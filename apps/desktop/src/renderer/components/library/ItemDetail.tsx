/**
 * 右栏:文献详情。
 *
 * 详情面板的第一职责不是展示元数据,而是回答**「这篇能不能读、不能读要做什么」**。
 * 所以 PDF 状态与对应动作(PDF 地址解析失败时的说明、登录过期时的「去登录」)
 * 放在最上方,元数据在下面。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryItem, DownloadJob, PdfState, LibraryLinkView } from "@contracts/library";
import { formatAuthorList, missingMetadataFields, type MissingMetadataField } from "@contracts/library";
import { CITATION_STYLES, formatCitation, type CitationStyle } from "@contracts/citation";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { cn } from "@renderer/lib/cn.js";
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconEyeOff,
  IconFolderOpen,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconX,
} from "@renderer/lib/icons.js";
import { PdfBadge } from "./ItemList.js";
import { ItemNotes } from "./ItemNotes.js";
import { LibraryPicker } from "@renderer/components/chat/LibraryPicker.js";

interface Props {
  item: LibraryItem | null;
  job: DownloadJob | null;
  pdfState: PdfState;
  onDownload: (id: string, force: boolean) => void;
  /** 条目被改过(比如刚挂上一份本地 Markdown)—— 让列表重新拉一次。 */
  onChanged?: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <div className="w-20 shrink-0 text-[0.7857em] text-content-subtle">{label}</div>
      <div className="min-w-0 flex-1 break-words text-xs text-content">{children}</div>
    </div>
  );
}

/** 论文的元数据字段表。只有论文用 —— 教材与笔记不显示(理由见下方调用处)。 */
function ItemMetadata({ item }: { item: LibraryItem }) {
  const { t } = useI18n();
  const openUrlInBrowser = useSessionStore((s) => s.openUrlInBrowser);
  return (
    <div>
    {/* 元数据 */}
    <div className="mb-2 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
      {t("library.detail.meta")}
    </div>
    <div className="divide-y divide-edge/40">
      {item.authors.length > 0 && (
        <Field label={t("library.detail.authors")}>{formatAuthorList(item.authors, 6)}</Field>
      )}
      {item.year && <Field label={t("library.detail.year")}>{item.year}</Field>}
      {item.venue && <Field label={t("library.detail.venue")}>{item.venue}</Field>}
      {/* 卷 / 期 / 页码 / 出版商 —— 引用格式要用,也顺带让用户核对有没有抓错 */}
      {(item.volume || item.issue || item.page) && (
        <Field label={t("library.detail.volumeIssue")}>
          {[item.volume, item.issue ? `(${item.issue})` : "", item.page ? `: ${item.page}` : ""]
            .join("")
            .trim()}
        </Field>
      )}
      {item.publisher && (
        <Field label={t("library.detail.publisher")}>{item.publisher}</Field>
      )}
      {item.doi && (
        <Field label={t("library.detail.doi")}>
          <button
            onClick={() => openUrlInBrowser(`https://doi.org/${item.doi}`)}
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            {item.doi}
            <IconExternalLink size={11} />
          </button>
        </Field>
      )}
      {item.arxivId && (
        <Field label={t("library.detail.arxiv")}>
          <button
            onClick={() => openUrlInBrowser(`https://arxiv.org/abs/${item.arxivId}`)}
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            {item.arxivId}
            <IconExternalLink size={11} />
          </button>
        </Field>
      )}
      {item.license && <Field label={t("library.detail.license")}>{item.license}</Field>}
    </div>
    </div>
  );
}

/** 三种引用格式的文案 id。显式映射 —— 模板字面量凑 MessageId 改键名会静默失配。 */
const CITE_LABEL: Record<CitationStyle, MessageId> = {
  gb7714: "library.cite.gb7714",
  apa: "library.cite.apa",
  bibtex: "library.cite.bibtex",
};

/** 缺字段的显示名。 */
const MISSING_LABEL: Record<MissingMetadataField, MessageId> = {
  authors: "library.detail.authors",
  year: "library.detail.year",
  venue: "library.detail.venue",
};

/**
 * 引用格式块:三种格式切换 + 一键复制。
 *
 * 用等宽字体原样显示 —— 用户要把它粘进稿子里,所见即所得比排版好看重要。BibTeX 的
 * 换行是有意义的,所以 `pre` + `break-words`(不能 `wrap` 成流式段落)。
 */
function CitationBlock({ item }: { item: LibraryItem }) {
  const { t } = useI18n();
  const [style, setStyle] = useState<CitationStyle>("gb7714");
  const [copied, setCopied] = useState(false);
  const text = formatCitation(item, style);

  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="rounded border border-edge bg-surface/40 p-2">
      <div className="mb-1.5 flex items-center gap-1">
        {CITATION_STYLES.map((s) => (
          <button
            key={s}
            onClick={() => setStyle(s)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[0.7857em] transition-colors",
              style === s
                ? "bg-surface-hover font-medium text-content"
                : "text-content-subtle hover:bg-surface-hover/60 hover:text-content",
            )}
          >
            {t(CITE_LABEL[s])}
          </button>
        ))}
        <button
          onClick={() => void copy()}
          title={t("library.cite.copy")}
          className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
        >
          {copied ? <IconCheck size={11} /> : <IconCopy size={11} />}
          {copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.7857em] leading-relaxed text-content">
        {text}
      </pre>
    </div>
  );
}

/**
 * 「关联」区 —— 这一条和别的条目之间挂着的线。
 *
 * ## 双向展示,但存储只存一行
 *
 * 数据是一对多、单向存的(见 `contracts/library.ts` 的 `LibraryItemLink`)。这里两个
 * 方向都列:用户给 A 挂了 B,打开 B 的时候也该看到"它被 A 关联着" —— 否则他会在 B 上
 * 再挂一次 A,而那是同一条关系的另一头。主进程的 `viewsOf` 已经把"另一头是谁"算好了
 * (含方向),这里只管画。
 *
 * ## 被屏蔽的**照样显示**,只是灰掉并说明原因
 *
 * 用户明确要屏蔽是硬过滤(挂不上),但**看得见**是另一回事:一条关联从列表里凭空消失,
 * 用户会以为是关联丢了、回头再挂一次。所以这里把屏蔽原因摆出来 —— 「它存在,只是被
 * 挡了」比"什么都没有"好排查得多。
 */
function ItemLinks({ item, onChanged }: { item: LibraryItem; onChanged?: () => void }) {
  const { t } = useI18n();
  const [links, setLinks] = useState<LibraryLinkView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 选择器的开关与锚点 —— 复用「+ → 添加文献库到上下文」那个选择器。 */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api.library.linksOf({ itemId: item.id });
      setLinks(res.links);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [item.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (linkId: string) => {
    if (!window.confirm(t("library.links.removeConfirm"))) return;
    setBusy(true);
    try {
      await api.library.linkRemove({ linkId });
      await reload();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 选择器确认 —— 选中的可能是分类、也可能是单独一篇(键 `c:` / `i:`)。
   *
   * **只接 `i:`**:关联的目标必须是"另一条条目"。用户挑了个分类的话,那不是一个可以
   * 挂关联的对象(关联是条目对条目),所以这里逐个提示而不是静默丢掉 —— 他点了没反应
   * 会以为功能坏了。
   */
  const handlePick = async (picked: Array<{ key: string; name: string }>) => {
    setPickerOpen(false);
    setBusy(true);
    const failures: string[] = [];
    try {
      for (const p of picked) {
        if (!p.key.startsWith("i:")) {
          failures.push(t("library.links.addFailed"));
          continue;
        }
        const targetItemId = p.key.slice(2);
        if (targetItemId === item.id) continue; // 自己关联自己不算
        try {
          await api.library.linkAdd({ itemId: item.id, targetItemId });
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      await reload();
      onChanged?.();
      if (failures.length > 0) setError(failures.join("\n"));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 从磁盘挑一个文件/目录关联上来。
   *
   * ## 为什么先导入再关联,而不是直接存路径
   *
   * 用户的原话是「可以一个关联多个文件,不只是挂 md 文件」。库外的东西**先导入成
   * `linked` 条目**(只记绝对路径,文件原地不动),再关联到那个条目 —— 这样:
   *
   *   - 它在库里有了一个可查、可改名、可查看的条目(而不是一行裸路径);
   *   - 挂载时与库内条目走**完全同一条路**(见 `expandLinks`),chip 也只有一种形态;
   *   - 反正导入器按 `filePath` 去重,同一个文件选两次不会长出两条。
   *
   * `library.linkAdd` 那条吃 `targetPath` 的路留着,给绕过 UI 的调用(将来的 AI 工具)
   * —— 界面这条路不走它。
   */
  const addFromDisk = async () => {
    // 不传 filters = 列所有文件(用户要的是「任何文件」,不该替他预设类型)。
    // 原生框本来就是多选(`multiSelections`),一次挑几个一起关联。
    const picked = await api.pickFiles({});
    if (picked.paths.length === 0) return;
    setBusy(true);
    try {
      const res = await api.library.importGeneric({ paths: picked.paths, mode: "linked" });
      for (const it of res.items) {
        if (it.id === item.id) continue; // 选到了自己
        await api.library.linkAdd({ itemId: item.id, targetItemId: it.id });
      }
      if (res.errors.length > 0) {
        setError(res.errors.map((e) => `${e.path}:${e.error}`).join("\n"));
      }
      await reload();
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 已经在列表里的条目不再进选择器 —— 与 composer 的 chip 去重同一个意思。 */
  const existingOut = (links ?? [])
    .filter((l) => l.direction === "out" && l.otherItemId)
    .map((l) => `i:${l.otherItemId}`);

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center gap-1">
        <span className="text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
          {t("library.links.title")}
        </span>
        <button
          ref={addBtnRef}
          onClick={() => {
            const rect = addBtnRef.current?.getBoundingClientRect();
            if (rect) setAnchor(rect);
            setPickerOpen(true);
          }}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          <IconPlus size={11} />
          {t("library.links.add")}
        </button>
        {/* 库里没有的东西 —— 从磁盘挑一个文件/目录。它会被导入成 linked 条目
            (文件原地不动),再关联上来:用户明确要「可以一个关联多个文件」。 */}
        <button
          onClick={() => void addFromDisk()}
          disabled={busy}
          title={t("library.links.addFromDiskHint")}
          className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          <IconFolderOpen size={11} />
          {t("library.links.addFromDisk")}
        </button>
      </div>

      <p className="mb-1.5 text-[0.7857em] leading-relaxed text-content-subtle">
        {t("library.links.hint")}
      </p>

      {error && (
        <div className="mb-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[0.7857em] text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!links ? (
        <div className="flex items-center gap-1.5 py-1.5 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={11} className="animate-spin" />
        </div>
      ) : links.length === 0 ? (
        <div className="py-1 text-[0.7857em] text-content-subtle">{t("library.links.empty")}</div>
      ) : (
        <div className="divide-y divide-edge/40 rounded border border-edge bg-surface/40">
          {links.map((l) => (
            <div key={l.id} className="group flex items-center gap-2 px-2 py-1.5">
              {/* 方向标注 —— 「关联到」/「被关联」。存储只有一行,但这两件事对用户
                  是不同的意思(我引用了它 / 它引用了我),所以分开标。 */}
              <span className="shrink-0 text-[0.7143em] text-content-subtle">
                {l.direction === "out" ? t("library.links.out") : t("library.links.in")}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  l.suppressedReason ? "text-content-subtle line-through" : "text-content",
                )}
                title={l.otherPath ?? l.title}
              >
                {l.title || l.otherPath || l.otherItemId || "?"}
              </span>
              {/* 被屏蔽的标出来并说清原因 —— 看得见"它存在,只是被挡了" */}
              {l.suppressedReason && (
                <span
                  title={t("library.links.suppressed", { reason: l.suppressedReason })}
                  className="inline-flex shrink-0 items-center gap-0.5 text-[0.7143em] text-amber-600 dark:text-amber-400"
                >
                  <IconEyeOff size={11} />
                  {l.suppressedReason}
                </span>
              )}
              <button
                onClick={() => void remove(l.id)}
                disabled={busy}
                title={t("library.links.remove")}
                className="shrink-0 rounded p-0.5 text-content-subtle opacity-0 transition-opacity hover:text-content group-hover:opacity-100 disabled:opacity-50"
              >
                <IconX size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 选择器复用「+ → 添加文献库到上下文」那一个 —— 同一套搜索/展开/多选,
          用户不用学第二遍。已经关联过的不再列出来。 */}
      <LibraryPicker
        open={pickerOpen}
        anchorRect={anchor}
        excludeCollectionIds={existingOut}
        onPick={(picked) => void handlePick(picked)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

export function ItemDetail({ item, job, pdfState, onDownload, onChanged }: Props) {
  const { t } = useI18n();
  const openUrlInBrowser = useSessionStore((s) => s.openUrlInBrowser);

  // 转换动作的本地状态。hook 必须在下面那个 `if (!item)` 提前返回**之前**。
  const [converting, setConverting] = useState(false);
  const [convertMsg, setConvertMsg] = useState<string | null>(null);

  /**
   * 手动(重)转 Markdown。
   *
   * 为什么需要这个按钮:导入时已经自动转过一次,但那次可能没转成(扫描件没文本层、
   * 或当时失败了)。重新导入同一份 PDF 会被去重挡下、**不会**重转,所以没有这个入口
   * 的话,用户就再也没有第二次机会了。
   *
   * ⚠️ 这条按钮跑的是**软件自己那套本地抽取**(纯文本)。想要配图与排版的,该让 AI 用
   * 外部工具转一份再 `library_adopt_markdown` 挂回来 —— 那条路会**覆盖**这里的结果。
   */
  const runConvert = async () => {
    if (!item) return;
    setConverting(true);
    setConvertMsg(null);
    try {
      const res = await api.library.convert({ ids: [item.id], force: true });
      setConvertMsg(
        res.converted > 0
          ? t("library.convert.done")
          : (res.failed[0]?.error ?? t("library.convert.failed")),
      );
    } catch (err) {
      setConvertMsg((err as Error).message);
    } finally {
      setConverting(false);
    }
  };

  /**
   * 挂上用户**已经转录好的** Markdown,不重新转录。
   *
   * 为什么需要:重新转一遍既有成本、结果又未必更好 —— 他可能早就用自己的工具转过、
   * 或者拿的是别人给的高质量版本。硬转一遍还会**覆盖掉他更满意的那份**。正文里
   * 引用到的图会一起搬过来(按引用搬,不认目录名),免得预览里全是断图。
   */
  const adoptMarkdown = async () => {
    if (!item) return;
    const picked = await api.pickFiles({
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    const path = picked.paths[0];
    if (!path) return;
    setConverting(true);
    setConvertMsg(null);
    try {
      const res = await api.library.adoptMarkdown({ id: item.id, path });
      setConvertMsg(
        res.ok
          ? t("library.convert.adoptDone", { n: res.imageCount })
          : (res.error ?? t("library.convert.failed")),
      );
      if (res.ok) onChanged?.();
    } catch (err) {
      setConvertMsg((err as Error).message);
    } finally {
      setConverting(false);
    }
  };

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <span className="text-xs text-content-subtle">{t("library.detail.noSelection")}</span>
      </div>
    );
  }

  const missing = missingMetadataFields(item);

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {/* 标题 */}
      <div className="mb-3 text-sm font-medium leading-snug text-content">{item.title}</div>

      {/* 元数据不全 —— 放在最上面。这条影响引用格式能不能用,而且要用户动手补,
          藏到列表底下等于没有。
          **只对论文显示**:教材不写进参考文献、笔记更不是文献,对它们来说这条提示
          既没有依据、也没有可做的动作。 */}
      {item.kind === "paper" && missing.length > 0 && (
        <div className="mb-3 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[0.7857em] leading-relaxed text-amber-700 dark:text-amber-400">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            {t("library.detail.missing", {
              fields: missing.map((f) => t(MISSING_LABEL[f])).join("、"),
            })}
          </span>
        </div>
      )}

      {/* PDF 状态与动作 —— 放最上面,因为这是用户最关心的 */}
      <div className="mb-3 rounded border border-edge bg-surface/40 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <PdfBadge state={pdfState} />
          <div className="flex items-center gap-1.5">
            {pdfState === "ready" ? (
              <button
                onClick={() => void api.library.revealFile({ id: item.id, which: "pdf" })}
                className="inline-flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
              >
                <IconFolderOpen size={12} />
                {t("library.pdf.revealFile")}
              </button>
            ) : pdfState === "needs_login" ? (
              // 唯一需要用户动手的状态:直接把登录入口摆出来
              <button
                onClick={() => openUrlInBrowser(item.url ?? "about:blank")}
                className="rounded bg-accent px-2 py-0.5 text-[0.7857em] text-white hover:opacity-90"
              >
                {t("library.pdf.goLogin")}
              </button>
            ) : (
              <button
                onClick={() => onDownload(item.id, pdfState === "failed")}
                disabled={pdfState === "queued" || pdfState === "downloading"}
                className="inline-flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
              >
                <IconRefresh size={12} />
                {pdfState === "failed" ? t("library.pdf.retry") : t("library.action.download")}
              </button>
            )}
          </div>
        </div>
        {/* 失败原因要显示出来 —— 否则用户只看到「失败」却不知道下一步做什么 */}
        {job?.error && (
          <div className="mt-1.5 border-t border-edge/60 pt-1.5 text-[0.7857em] leading-relaxed text-content-muted">
            {job.error}
          </div>
        )}
      </div>

      {/* Markdown 转换 —— 这一段决定「AI 能不能读」,所以单独摆出来而不是塞进
          元数据列表里。软件自己只会本地抽纯文本;带图的那些是外部工具转完挂回来的。 */}
      <div className="mb-3 rounded border border-edge bg-surface/40 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.7857em] text-content-muted">
            {item.mdPath ? t("library.convert.ready") : t("library.convert.none")}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {item.mdPath && (
              <button
                onClick={() => void api.library.revealFile({ id: item.id, which: "md" })}
                title={t("library.convert.revealMd")}
                className="rounded border border-edge p-0.5 text-content-muted hover:bg-surface-hover hover:text-content"
              >
                <IconFolderOpen size={12} />
              </button>
            )}
            <button
              onClick={() => void runConvert()}
              disabled={!item.pdfPath || converting}
              className="inline-flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
            >
              {converting ? (
                <IconLoader2 size={12} className="animate-spin" />
              ) : (
                <IconRefresh size={12} />
              )}
              {item.mdPath ? t("library.convert.redo") : t("library.convert.run")}
            </button>
            {/* 已经有转录好的 md?直接挂上,不用再花一次额度(笔记库没有这一步) */}
            {item.kind !== "note" && (
              <button
                onClick={() => void adoptMarkdown()}
                disabled={converting}
                title={t("library.convert.adoptHint")}
                className="inline-flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
              >
                {t("library.convert.adopt")}
              </button>
            )}
          </div>
        </div>
        {convertMsg && (
          <div className="mt-1.5 border-t border-edge/60 pt-1.5 text-[0.7857em] leading-relaxed text-content-muted">
            {convertMsg}
          </div>
        )}
      </div>

      {/* 元数据 —— **只有论文需要**。教材不写进参考文献、笔记不是文献,对它们来说
          这一串字段既没用处、又占掉半屏;那些屏幕上真正要看的是转换状态与笔记。
          块本身抽在 ItemMetadata 里(原地包一层 if 会让里面几十行凭空多一级缩进)。 */}
      {item.kind === "paper" && <ItemMetadata item={item} />}

      {/* 引用格式 —— 放在元数据之后。它是"把这篇文献带出去"(粘进自己的稿子)
          最常用的东西,所以给足位置:三种格式可切、一键复制。
          **只有论文需要**:教材不写进参考文献,笔记根本不是文献。 */}
      {item.kind === "paper" && (
        <>
          <div className="mb-1 mt-4 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
            {t("library.cite.title")}
          </div>
          <CitationBlock item={item} />
        </>
      )}

      {/* 摘要 */}
      {item.abstract && (
        <>
          <div className="mb-1 mt-4 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
            {t("library.detail.abstract")}
          </div>
          <div className="text-xs leading-relaxed text-content-muted">{item.abstract}</div>
        </>
      )}

      {/* 关联 —— 放在笔记之前:它是"这条和哪些东西是一组",比随手记的笔记更靠前。
          任何 kind 都有(笔记库的条目也能互相关联)。 */}
      <ItemLinks item={item} onChanged={onChanged} />

      {/* 读文献时随手记的笔记(挂在**这一条**上)。笔记库的条目自己就是一篇
          Markdown,不需要再挂"笔记",所以那里不显示这一块。 */}
      {item.kind !== "note" && (
        <div className="mt-4">
          <ItemNotes item={item} />
        </div>
      )}
    </div>
  );
}
