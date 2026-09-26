/**
 * 右栏:文献详情。
 *
 * 详情面板的第一职责不是展示元数据,而是回答**「这篇能不能读、不能读要做什么」**。
 * 所以 PDF 状态与对应动作(PDF 地址解析失败时的说明、登录过期时的「去登录」)
 * 放在最上方,元数据在下面。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryItem, DownloadJob, PdfState, LibraryLinkView, LibraryCollection } from "@contracts/library";
import { formatAuthorList, missingMetadataFields, type MissingMetadataField } from "@contracts/library";
import { CITATION_STYLES, formatCitation, type CitationStyle } from "@contracts/citation";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";import { api } from "@renderer/lib/api.js";
import { copyText } from "@renderer/lib/clipboard.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
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
  IconDownload,
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

/**
 * 论文的元数据字段表。只有论文用 —— 教材与笔记不显示(理由见下方调用处)。
 *
 * **导出**是因为左栏右键那个「文献信息」浮窗要复用同一份（2026-09-21）——
 * 两处必须长得一样，另写一份必然漂移。
 */
export function ItemMetadata({ item }: { item: LibraryItem }) {
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
/** 引用格式块 —— **导出**同上（「文献信息」浮窗要复用）。 */
export function CitationBlock({ item }: { item: LibraryItem }) {
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
export function ItemLinks({ item, onChanged }: { item: LibraryItem; onChanged?: () => void }) {
  const { t } = useI18n();
  const [links, setLinks] = useState<LibraryLinkView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 选择器的开关与锚点 —— 复用「+ → 添加文献库到上下文」那个选择器。 */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  /** #11:「转录 md + 图床」与本条是一个整体 —— 在关联区把它说出来。 */
  const [mdBundle, setMdBundle] = useState<{ title: string; imageCount?: number } | null>(null);

  // 转录产物不在关联表里(它随条目一起走,没有单独的开关 —— 见 contracts 里
  // `LibraryDeletePreviewLink` 的 `transcript` 那一档),但用户在关联区看不到它,
  // 就会以为"图床不知道挂在哪"。这里**复用删除预览的口径**(同一份实现,不再自己
  // 算一遍),把它作为一行说明摆出来。拉不到就不显示:它只是补充说明,不该挡住
  // 关联列表本身。
  useEffect(() => {
    let cancelled = false;
    setMdBundle(null);
    void api.library
      .deletePreview({ ids: [item.id] })
      .then((res) => {
        if (cancelled) return;
        const transcript = (res.entries[0]?.links ?? []).find((l) => l.form === "transcript");
        if (transcript) {
          setMdBundle({
            title: transcript.title,
            ...(transcript.imageCount !== undefined ? { imageCount: transcript.imageCount } : {}),
          });
        }
      })
      .catch(() => {
        /* 只是补充说明,拉不到就不显示 —— 关联列表自己的错误另有一条通道 */
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

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

      {/* #11:转录 md + 图床是本条的一部分 —— 不是一条可解除的关联,所以不进下面
          的列表,单独一行说明(没有删除按钮,它没有"单独删掉"这个操作)。 */}
      {mdBundle && (
        <div
          title={mdBundle.title}
          className="mb-1.5 rounded border border-edge bg-surface/40 px-2 py-1.5 text-[0.7857em] leading-relaxed text-content-subtle"
        >
          {mdBundle.imageCount !== undefined && mdBundle.imageCount > 0
            ? t("library.links.mdBundle", { count: String(mdBundle.imageCount) })
            : t("library.links.mdBundleNoImages")}
        </div>
      )}

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
        // 关联**只能选条目**（分类不是可挂关联的对象），所以直接把分类展开、
        // 列出条目 —— 用户截图里那个"空的"选择器就是这个（见那个 prop 的说明）。
        autoExpandItems
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
  // kind 退役后的两条行为判据（按字段/扩展名，不再按条目类型）：
  //   · 文献记录 = 带 DOI 或 arXiv ID —— 才有补元数据/引用格式那些动作
  //   · 纯 md 条目 = 没有原文 PDF、本体就是 Markdown —— 不需要挂转录/记笔记
  const isBibliographic = Boolean(item.doi || item.arxivId);
  const isMdOnly = !item.pdfPath && Boolean(item.mdPath?.endsWith(".md"));

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {/* 标题 */}
      <div className="mb-3 text-sm font-medium leading-snug text-content">{item.title}</div>

      {/* 元数据不全 —— 放在最上面。这条影响引用格式能不能用,而且要用户动手补,
          藏到列表底下等于没有。
          **只对文献记录显示**（有 DOI / arXiv ID 的条目）:笔记与通用文件不写进
          参考文献 Gel,对它们来说这条提示既没有依据、也没有可做的动作。 */}
      {isBibliographic && missing.length > 0 && (
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
                onClick={() => onDownload(item.id, pdfState === "failed" || pdfState === "not_found")}
                disabled={pdfState === "queued" || pdfState === "downloading"}
                className="inline-flex items-center gap-1 rounded border border-edge px-2 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
              >
                <IconRefresh size={12} />
                {/* 找不到来源时不写「重试」—— 那句话是在请用户去点一个没用的按钮。
                    见 `derivePdfState` 里那段说明。 */}
                {pdfState === "failed" || pdfState === "not_found"
                  ? t("library.pdf.retry")
                  : t("library.action.download")}
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
            {/* 已经有转录好的 md?直接挂上,不用再花一次额度（纯 md 条目没有这一步） */}
            {!isMdOnly && (
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

      {/* 元数据 —— **只有文献记录需要**（有 DOI / arXiv ID）。
          块本身抽在 ItemMetadata 里(原地包一层 if 会让里面几十行凭空多一级缩进)。 */}
      {isBibliographic && <ItemMetadata item={item} />}

      {/* 引用格式 —— 放在元数据之后。它是"把这篇文献带出去"(粘进自己的稿子)
          最常用的东西,所以给足位置:三种格式可切、一键复制。
          **只有文献记录需要**。 */}
      {isBibliographic && (
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

      {/* 读文献时随手记的笔记(挂在**这一条**上)。纯 Markdown 条目自己就是一篇
          笔记,不需要再挂"笔记",所以那里不显示这一块。 */}
      {!isMdOnly && (
        <div className="mt-4">
          <ItemNotes item={item} />
        </div>
      )}
    </div>
  );
}

/**
 * **关联管理对话框** —— 把 {@link ItemLinks} 那一块装进一个浮层（2026-09-21）。
 *
 * ## 为什么要有它
 *
 * 用户要把右栏那个 `library` tab 删掉，并要求关联的入口「**搬到左栏右键**」。
 * 关联天然是"某一条跟谁关联"，所以入口挂在条目行上是对的；但那一块里有选择器、
 * 列表、增删——塞进右键菜单不合适，用浮层。
 *
 * ⚠️ **内容用的是同一个 `ItemLinks`**，不是另写一份。两处（详情页 / 左栏右键）必须
 * 长得一样、行为一样，否则改了一边另一边不跟着动。
 */
export function ItemLinksDialog({
  item,
  onOpenChange,
  onChanged,
}: {
  /** 要管哪一条的关联。`null` = 关着。 */
  item: LibraryItem | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={item !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        {/*
          ⚠️ **必须 `transform-none`，光写 `translate-x-0` 没用**（2026-09-21）。

          `Dialog.Popup` 的原型是 `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`
          —— 它靠 **transform 居中**。而 CSS 规定：**一个带 `transform` 的元素会成为
          它后代里 `position: fixed` 的包含块**。

          这个 Dialog 里装着 `LibraryPicker`，那个是 `fixed` + 用**视口坐标**
          （`anchorRect`）定位的。于是它的 `fixed` 参照的不是窗口，而是这个居中盒子 ——
          表现就是用户截图里那个"选择器跑到右下角去了"。

          ⚠️ **我第一版修错了，写的是 `translate-x-0 translate-y-0`** —— 那**不解决
          问题**：`transform: translate(0,0)` 的计算值仍然**不是 `none`**，包含块照旧。
          必须显式 `transform-none`。

          居中改成**四边归零 + `m-auto`**。⚠️ 不能用 `inset-0`：tailwind-merge 里
          `inset` 与 `left`/`top` **不是同一组**，它顶不掉 `left-1/2`/`top-1/2`，
          两个值会同时留在 class 里、谁赢看样式表顺序。
        */}
        <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit w-[520px] max-w-[92vw] transform-none p-4">
          {/* ⚠️ **标题里不要拼整条标题**（2026-09-21）。用户发来的截图里它成了
              「关联 · Wavelength Selection for Satellite Quantum Key Distribution」——
              一条论文标题能长到把标题栏撑满，而真正要说的只有"这是哪一条的关联"。
              改成一个定宽可截断的副标题。 */}
          <Dialog.Title className="flex items-baseline gap-2">
            <span className="shrink-0">{t("library.links.title")}</span>
            {item && (
              <span className="min-w-0 flex-1 truncate text-[0.8571em] font-normal text-content-muted">
                {item.title}
              </span>
            )}
          </Dialog.Title>
          <div className="mt-2 max-h-[60vh] overflow-y-auto">
            {item && <ItemLinks item={item} onChanged={onChanged} />}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * **「分类信息」卡片** —— 分类行右键打开（2026-09-21）。
 *
 * ## 它替掉了什么
 *
 * 从前分类行右键里平铺着**三项导出引用**（BibTeX / GB-T 7714 / APA）。★ 用户：
 * 「现在右键 collection 会有论文信息的导出，元信息已经放到文件的右键里面去了，可以查看，
 * 然后**这里的导出放进弹出的卡片里面**」。
 *
 * 那三项把菜单撑得很长，而"导出整批引用"是偶尔做一次的事。收进卡片之后：
 *
 *   - 菜单里只剩一个「分类信息」入口；
 *   - 卡片里先告诉用户**这个分类有多少条**（导之前就知道会导出多少），再给三个格式按钮；
 *   - 导出完还可以直接打开落盘的那个文件夹（`reveal` 由主进程拼路径）。
 *
 * ## 为什么条目数在这里现拉一次
 *
 * `collection.items` 那类缓存可能是**上一屏的**（左栏按页拉，默认 200 条上限）。这里
 * 要的是"这个分类里到底有多少"，所以用同一个 `library.list` 问一次总数 —— 它回的
 * `total` 是全量计数，不受 `limit` 影响。
 */
export function CollectionInfoDialog({
  collection,
  onOpenChange,
  onExport,
}: {
  /** 要看哪个分类。`null` = 关着。 */
  collection: LibraryCollection | null;
  onOpenChange: (open: boolean) => void;
  /** 导出这一批。落盘与 toast 由左栏那一侧负责（与原来菜单项走的是同一个函数）。 */
  onExport: (c: LibraryCollection, style: CitationStyle) => void;
}) {
  const { t } = useI18n();
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const id = collection?.id ?? null;
  useEffect(() => {
    setTotal(null);
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        // `limit: 1` —— 只要那个 `total`（它不受 limit 影响）。
        const res = await api.library.list({ collectionId: id, limit: 1 });
        if (!cancelled) setTotal(res.total);
      } catch {
        // 拉不到就不显示条数 —— 比显示一个错的数字好
        if (!cancelled) setTotal(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  /**
   * 导出。
   *
   * **`reveal: true` 是刻意的**：导出落盘在库根的 `exports/` 里，路径由主进程自己
   * 拼（渲染端始终没有"打开任意路径"的能力 —— 见 `LibraryExportSchema.reveal`）。
   * 从前那条工具条就是这么做的，这里保持同一个行为；不这样的话用户拿到一句
   * 「已导出 → D:\...」然后得自己去文件管理器里找。
   */
  const runExport = async (style: CitationStyle) => {
    if (!collection) return;
    setBusy(true);
    try {
      await api.library.exportCitations({ style, collectionId: collection.id, reveal: true });
      onExport(collection, style);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={collection !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        {/* ⚠️ `transform-none` + 四边归零居中 —— 理由见 `ItemLinksDialog` 那段
            （`Dialog.Popup` 原型靠 transform 居中，而它会成为后代 `fixed` 的包含块）。 */}
        <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit w-[440px] max-w-[92vw] transform-none p-4">
          <Dialog.Title className="flex items-baseline gap-2">
            <span className="shrink-0">{t("library.collection.info")}</span>
            {collection && (
              <span className="min-w-0 flex-1 truncate text-[0.8571em] font-normal text-content-muted">
                {collection.name}
              </span>
            )}
          </Dialog.Title>

          <div className="mt-3">
            {/* 导之前先知道会导出多少 —— 比导完看 toast 好 */}
            {total !== null && (
              <div className="text-[0.7857em] text-content-subtle">
                {t("library.collection.itemCount", { n: total })}
              </div>
            )}

            {/* 空分类导出来是个空文件，先把那句话说了 —— 不给一排点了白点的按钮。 */}
            {total === 0 ? (
              <div className="mt-2 text-xs text-content-muted">
                {t("library.collection.empty")}
              </div>
            ) : (
              <div className="mt-3">
                <div className="mb-1.5 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
                  {t("library.export.label")}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(["bibtex", "gb7714", "apa"] as const).map((style) => (
                    <button
                      key={style}
                      onClick={() => void runExport(style)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
                    >
                      <IconDownload size={11} />
                      {t(`library.export.${style}` as MessageId)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * **文献信息浮窗** —— 元数据 + 引用 + 摘要（2026-09-21）。
 *
 * ## 它从哪来
 *
 * 用户的原话：「元数据表是**只有论文有**，**右键的时候会打开一个浮窗**显示，
 * 然后**引用啥的也都放在一起**」。
 *
 * 这几块原来都长在右栏详情页里。而右栏那个 `library` tab 是要删掉的（用户要把文献
 * 预览统一到中间栏），所以这些"就这一条本身"的信息得有新去处 —— 和「关联」一样，
 * 挂到左栏右键。
 *
 * ## 只有论文显示元数据与引用
 *
 * 这是详情页原来就有的规矩（那里写着"教材不写进参考文献、笔记根本不是文献"），
 * 这里原样带过来：教材/笔记打开只看到摘要。
 *
 * ⚠️ 内容用的是**同一个** `ItemMetadata` / `CitationBlock`，不是另写一份。
 */
export function ItemInfoDialog({
  item,
  onOpenChange,
}: {
  /** 要看哪一条。`null` = 关着。 */
  item: LibraryItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const isPaper = Boolean(item && (item.doi || item.arxivId));
  return (
    <Dialog.Root open={item !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        {/* ⚠️ `transform-none` + 四边归零居中 —— 理由见 `ItemLinksDialog` 那段
            （`Dialog.Popup` 原型靠 transform 居中，而它会成为后代 `fixed` 的包含块）。 */}
        <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit w-[520px] max-w-[92vw] transform-none p-4">
          <Dialog.Title className="flex items-baseline gap-2">
            <span className="shrink-0">{t("library.info.title")}</span>
            {item && (
              <span className="min-w-0 flex-1 truncate text-[0.8571em] font-normal text-content-muted">
                {item.title}
              </span>
            )}
          </Dialog.Title>
          <div className="mt-2 max-h-[65vh] overflow-y-auto">
            {item && (
              <div>
                {isPaper && <ItemMetadata item={item} />}
                {isPaper && (
                  <>
                    <div className="mb-1 mt-4 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
                      {t("library.cite.title")}
                    </div>
                    <CitationBlock item={item} />
                  </>
                )}
                {item.abstract && (
                  <>
                    <div className="mb-1 mt-4 text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
                      {t("library.detail.abstract")}
                    </div>
                    <div className="text-xs leading-relaxed text-content-muted">{item.abstract}</div>
                  </>
                )}
              </div>
            )}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
