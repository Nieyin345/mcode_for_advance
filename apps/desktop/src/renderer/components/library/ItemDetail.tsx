/**
 * 右栏:文献详情。
 *
 * 详情面板的第一职责不是展示元数据,而是回答**「这篇能不能读、不能读要做什么」**。
 * 所以 PDF 状态与对应动作(PDF 地址解析失败时的说明、登录过期时的「去登录」)
 * 放在最上方,元数据在下面。
 */
import { useState } from "react";
import type { LibraryItem, DownloadJob, PdfState } from "@contracts/library";
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
  IconFolderOpen,
  IconLoader2,
  IconRefresh,
} from "@renderer/lib/icons.js";
import { PdfBadge } from "./ItemList.js";
import { ItemNotes } from "./ItemNotes.js";

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

export function ItemDetail({ item, job, pdfState, onDownload, onChanged }: Props) {
  const { t } = useI18n();
  const openUrlInBrowser = useSessionStore((s) => s.openUrlInBrowser);

  // 转换动作的本地状态。hook 必须在下面那个 `if (!item)` 提前返回**之前**。
  const [converting, setConverting] = useState(false);
  const [convertMsg, setConvertMsg] = useState<string | null>(null);

  /**
   * 手动(重)转 Markdown。
   *
   * 为什么需要这个按钮:导入时已经自动转过一次,但那次可能走的是本地兜底(没配
   * MinerU、或 MinerU 当时失败)。重新导入同一份 PDF 会被去重挡下、**不会**重转,
   * 所以没有这个入口的话,用户就再也换不成 MinerU 的结果了。
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
   * 为什么需要:转录要花 MinerU 额度,而且同一份 PDF 的结果未必比用户手上那份好 ——
   * 他可能早就转过了、或者拿的是别人的高质量版本。重转一遍既费额度,还会**覆盖掉他
   * 更满意的那份**。同类文件里的 `images/` 会一起搬过来,免得正文里的图全断。
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
          元数据列表里。配了 MinerU 走 MinerU,没配走本地 pdf.js。 */}
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
