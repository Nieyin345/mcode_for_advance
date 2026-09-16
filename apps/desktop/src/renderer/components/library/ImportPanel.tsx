/**
 * 文献列表**顶部内嵌**的导入条。
 *
 * 早先这里是个占满整栏的独立屏(点「导入」后整个面板被替换掉)。用户明确说
 * 「框太大了,只要一个嵌入到页面里的小窗就行了,同时还要显示当前的文献列表」——
 * 所以它现在是列表上方的一条,列表照旧在下面。
 *
 * 两条入口都在这儿:
 *   - 粘贴 DOI / arXiv ID / BibTeX(不用 AI 也能走的确定路径)
 *   - 选本地 PDF 文件(主入口 —— 用户手上大量是已经下载好的 PDF)
 *
 * **拖入**不在这里处理:整块文献面板都接受从资源管理器拖进来的 PDF,见
 * LibraryPanel 的 onDrop —— 拖放的目标区域大一点才好用。
 */
import { useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { IconX } from "@renderer/lib/icons.js";
import { Input } from "@renderer/components/ui/index.js";
import type { LibraryKind } from "@contracts/library";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";

interface Props {
  onClose: () => void;
  /** 导入的条目归入哪个分类。null = 只进当前库的总列表。 */
  collectionId: string | null;
  /** 收进哪个库。笔记库收的是 Markdown 文件,另外两个库收 PDF。 */
  kind: LibraryKind;
  /** 导入 PDF 后是否立刻转录。有现成 md 的人要能关掉,否则白花一次额度。 */
  autoConvert: boolean;
  onAutoConvertChange: (value: boolean) => void;
  onImported: () => void | Promise<void>;
}

export function ImportBar({
  onClose,
  collectionId,
  kind,
  autoConvert,
  onAutoConvertChange,
  onImported,
}: Props) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** 新建笔记时的标题输入。 */
  const [noteTitle, setNoteTitle] = useState("");

  /** 把 importFiles / import 的返回拼成一句人话回报。 */
  const reportFiles = (
    added: number,
    skipped: number,
    converted: { ok: number; failed: number },
    errors: Array<{ path: string; error: string }>,
  ) => {
    const parts = [t("library.import.pdfResult", { added, skipped })];
    if (converted.failed > 0) parts.push(t("library.import.convertFailed", { n: converted.failed }));
    if (errors.length > 0) {
      const first = errors[0];
      parts.push(
        t("library.import.pdfErrors", { n: errors.length }) +
          ` — ${first.path.split(/[\\/]/).pop()}: ${first.error}`,
      );
    }
    return parts.join(" · ");
  };

  const pickPdfs = async () => {
    const picked = await api.pickFiles({ filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (picked.paths.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.library.importFiles({
        paths: picked.paths,
        collectionIds: collectionId ? [collectionId] : undefined,
        kind,
        convert: autoConvert,
      });
      setMessage(reportFiles(res.added, res.skipped, res.converted, res.errors));
      await onImported();
    } finally {
      setBusy(false);
    }
  };

  /** 新建一篇空笔记,建完直接切到编辑页 —— 用户点「新建」就是想马上开始写。 */
  const createNoteNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.library.createNote({
        title: noteTitle.trim() || t("library.note.untitled"),
        collectionIds: collectionId ? [collectionId] : undefined,
      });
      setNoteTitle("");
      if (res.item) {
        const store = useLibraryStore.getState();
        store.setActiveItem(res.item.id);
        store.setDetailTab("edit");
      }
      await onImported();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 收 Markdown 笔记。
   *
   * 与收 PDF 分开:笔记入库即完成 —— 没有元数据要抓、没有东西要转录,所以结果里
   * 只有「收了几篇 / 跳过几篇 / 哪几个失败了」。
   */
  const pickNotes = async () => {
    const picked = await api.pickFiles({
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }],
    });
    if (picked.paths.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.library.importNotes({
        paths: picked.paths,
        collectionIds: collectionId ? [collectionId] : undefined,
      });
      const parts = [t("library.import.noteResult", { added: res.added, skipped: res.skipped })];
      if (res.errors.length > 0) {
        const first = res.errors[0];
        parts.push(
          t("library.import.pdfErrors", { n: res.errors.length }) +
            ` — ${first.path.split(/[\\/]/).pop()}: ${first.error}`,
        );
      }
      setMessage(parts.join(" · "));
      await onImported();
    } finally {
      setBusy(false);
    }
  };

  const submitText = async () => {
    const raw = text.trim();
    if (!raw) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.library.import({
        text: raw,
        collectionIds: collectionId ? [collectionId] : undefined,
      });
      if (res.items.length === 0) {
        setMessage(t("library.import.nothingParsed"));
      } else {
        setMessage(t("library.import.importedCount", { n: res.items.length }));
        setText("");
      }
      await onImported();
    } finally {
      setBusy(false);
    }
  };

  // 笔记库不需要"粘 DOI / 贴 BibTeX"那一套 —— 它就是收 md 文件。硬把同样的表单
  // 摆出来,用户会以为笔记也得先查元数据。
  if (kind === "note") {
    return (
      <div className="shrink-0 border-b border-edge bg-surface-hover/40 px-3 py-2">
        <div className="flex items-center gap-2">
          {/* 在应用内新建:落一份带标题的骨架文件,然后直接打开编辑器 */}
          <Input
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createNoteNow();
              if (e.key === "Escape") onClose();
            }}
            placeholder={t("library.note.placeholder")}
            className="max-w-[160px] flex-1"
          />
          <button
            onClick={() => void createNoteNow()}
            disabled={busy}
            className="shrink-0 rounded bg-accent px-2 py-1 text-[0.7857em] text-white hover:opacity-90 disabled:opacity-50"
          >
            {t("library.note.create")}
          </button>
          <button
            onClick={() => void pickNotes()}
            disabled={busy}
            className="rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
          >
            {t("library.import.pickNote")}
          </button>
          <span className="min-w-0 flex-1 text-[0.7143em] text-content-subtle">
            {t("library.import.noteHint")}
          </span>
          <button
            onClick={onClose}
            title={t("library.collection.cancel")}
            className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
          >
            <IconX size={13} />
          </button>
        </div>
        {message && (
          <div className="mt-1.5 text-[0.7857em] leading-relaxed text-content-muted">{message}</div>
        )}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-edge bg-surface-hover/40 px-3 py-2">
      <div className="flex items-start gap-2">
        <textarea
          autoFocus
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitText();
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("library.import.placeholder")}
          className="min-w-0 flex-1 resize-none rounded border border-edge bg-surface px-2 py-1 font-mono text-[0.7857em] leading-relaxed text-content placeholder:font-sans placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
        <button
          onClick={onClose}
          title={t("library.collection.cancel")}
          className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
        >
          <IconX size={13} />
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={() => void pickPdfs()}
          disabled={busy}
          className="rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          {t("library.import.pickPdf")}
        </button>
        <button
          onClick={() => void submitText()}
          disabled={busy || !text.trim()}
          className="rounded bg-accent px-2.5 py-1 text-[0.7857em] text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t("library.import.importing") : t("library.import.submit")}
        </button>
        {/* 拖入的提示 —— 放在这里用户才知道能拖 */}
        <span className="text-[0.7143em] text-content-subtle">{t("library.import.dropHint")}</span>
      </div>

      {/* 转录开关。**默认勾上**(多数人手上没有现成的 md),但已经有转录产物的人必须
          能关掉它 —— 否则导入那一刻就把 MinerU 额度花掉了,而那份结果马上就会被
          「用本地 Markdown…」覆盖掉。拖入导入走的是同一个开关(LibraryPanel 持有的
          那份状态),两处行为不一致会让人以为丢文件了。 */}
      <label
        className="mt-1.5 flex cursor-pointer items-start gap-1.5 text-[0.7143em] leading-relaxed text-content-subtle"
        title={t("library.import.autoConvertHint")}
      >
        <input
          type="checkbox"
          checked={autoConvert}
          onChange={(e) => onAutoConvertChange(e.target.checked)}
          className="mt-0.5 h-3 w-3 shrink-0 accent-[var(--accent)]"
        />
        <span>
          {t("library.import.autoConvert")}
          <span className="ml-1 opacity-80">{t("library.import.autoConvertHint")}</span>
        </span>
      </label>

      {message && (
        <div className={cn("mt-1.5 text-[0.7857em] leading-relaxed text-content-muted")}>
          {message}
        </div>
      )}
    </div>
  );
}
