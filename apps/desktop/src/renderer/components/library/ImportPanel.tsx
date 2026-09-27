/**
 * 导入条 —— **通用导入**（kind 退役后的形态，2026-09-24）。
 *
 * 从前这里按分类的 kind 分两条路：note 分类才能新建/收 Markdown，其余只收 PDF ——
 * 那正是"文件系统只能导 PDF、建不了 md"的根源。现在所有分类共用同一组入口：
 *
 *   - 新建 md（任何分类都可以，建完直接开编辑器）
 *   - 导入文件（全类型：pdf 走文献管线、md/txt 走笔记管线、其余按通用文件收）
 *   - 导入文件夹（**整个文件夹 = 一个条目**，不拆开、可展开浏览 —— latex 模版这类
 *     "一个文件夹是一个整体"的资料用这条）
 *   - 批量导入（选一个文件夹，把第一层文件拆开、子文件夹作为 linked 条目收进；
 *     与上一条是两个不同的动作）
 *
 * **拖入**不在这里处理：整块文献面板都接受从资源管理器拖进来的文件，见
 * LibraryPanel 的 onDrop —— 拖放的目标区域大一点才好用。
 */
import { useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { IconX } from "@renderer/lib/icons.js";
import { Input } from "@renderer/components/ui/index.js";
import { useLibraryStore } from "@renderer/stores/libraryStore.js";

interface Props {
  onClose: () => void;
  /** 导入的条目归入哪个分类。null = 只进总列表。 */
  collectionId: string | null;
  onImported: () => void | Promise<void>;
}

export function ImportBar({
  onClose,
  collectionId,
  onImported,
}: Props) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** 新建笔记时的标题输入。 */
  const [noteTitle, setNoteTitle] = useState("");

  /** 把 importFiles / import 的返回拼成一句人话回报。 */
  const reportFiles = (
    added: number,
    skipped: number,
    errors: Array<{ path: string; error: string }>,
  ) => {
    const parts = [t("library.import.pdfResult", { added, skipped })];
    if (errors.length > 0) {
      const first = errors[0];
      parts.push(
        t("library.import.pdfErrors", { n: errors.length }) +
          ` — ${first.path.split(/[\\/]/).pop()}: ${first.error}`,
      );
    }
    return parts.join(" · ");
  };

  /** 系统对话框、IPC 或刷新失败都要留在导入条里，不能只形成未处理的 Promise。 */
  const reportError = (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    setMessage(t("library.import.operationFailed", { reason }));
  };

  /** 通用文件导入：全类型，主进程按扩展名分派（pdf/md/其他三条管线）。 */
  const pickFiles = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await api.pickFiles({
        filters: [
          {
            name: "全部支持的文件",
            extensions: [
              "pdf", "md", "markdown", "mdown", "txt",
              "doc", "docx", "ppt", "pptx", "xls", "xlsx", "html", "htm",
              "png", "jpg", "jpeg", "jp2", "webp", "gif", "bmp", "svg",
            ],
          },
        ],
      });
      if (picked.paths.length === 0) return;
      const res = await api.library.importFiles({
        paths: picked.paths,
        collectionIds: collectionId ? [collectionId] : undefined,
      });
      setMessage(reportFiles(res.added, res.skipped, res.errors));
      await onImported();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  /**
   * **新建一篇空笔记** —— 建完直接切到编辑页。任何分类都可以建（kind 退役后
   * 不再限制"只有笔记分类能建 md"）。
   */
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
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  /**
   * **文件夹 = 一个条目**：linked 模式收进来，不拆开。点开能浏览里面的文件
   * （relPath 机制现成），也能像其他条目一样框选引用 —— latex 模版这类
   * "一个文件夹是一个整体"的资料用这条。
   */
  const pickFolder = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await api.pickFolder();
      if (!picked?.path) return;
      const res = await api.library.importFiles({
        paths: [picked.path],
        collectionIds: collectionId ? [collectionId] : undefined,
        mode: "folder",
      });
      setMessage(reportFiles(res.added, res.skipped, res.errors));
      await onImported();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  /**
   * **批量导入**：选一个文件夹，把第一层文件**拆开**、子文件夹作为独立条目。
   * 与"文件夹=条目"是两个不同的动作 —— 用户按需选。
   */
  const explodeFolder = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await api.pickFolder();
      if (!picked?.path) return;
      const res = await api.library.importFiles({
        paths: [picked.path],
        collectionIds: collectionId ? [collectionId] : undefined,
        mode: "explode",
      });
      setMessage(reportFiles(res.added, res.skipped, res.errors));
      await onImported();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

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
          onClick={() => void pickFiles()}
          disabled={busy}
          className="rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          {t("library.import.pickFile")}
        </button>
        <button
          onClick={() => void pickFolder()}
          disabled={busy}
          className="rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          {t("library.import.pickFolder")}
        </button>
        <button
          onClick={() => void explodeFolder()}
          disabled={busy}
          className="rounded border border-edge px-2 py-1 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content disabled:opacity-50"
        >
          {t("library.import.explodeFolder")}
        </button>
        <span className="min-w-0 flex-1 text-[0.7143em] text-content-subtle">
          {t("library.import.hint")}
        </span>
        <button
          onClick={onClose}
          title={t("library.collection.cancel")}
          className="shrink-0 rounded p-1 text-content-subtle hover:bg-surface-hover hover:text-content"
        >
          <IconX size={13} />
        </button>
      </div>

      {/* 转录只由工作流触发器控制。旧版逐次导入的 convert 开关已被核心忽略，
          继续显示会让用户误以为取消勾选就能阻止向 MinerU 上传。 */}
      <p className="mt-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("library.import.automationHint")}
      </p>

      {message && (
        <div className={cn("mt-1.5 text-[0.7857em] leading-relaxed text-content-muted")}>
          {message}
        </div>
      )}
    </div>
  );
}
