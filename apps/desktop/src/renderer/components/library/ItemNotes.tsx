/**
 * 详情面板里的「笔记」——挂在**这一条**下面的小段文字。
 *
 * ## 与「笔记库」不是一回事
 *
 *   - 笔记库(kind === "note"):一条 = 一篇 Markdown 文件,它**自己就是一个条目**;
 *   - 这里:读某篇论文/教材时随手记的几句,**依附于那个条目**(Zotero 的 child notes)。
 *
 * 表在建库时就备好了(`library_notes`),一直没接 UI —— 详情页那块写着"将在后续版本
 * 提供"的占位就是它。现在接上。
 *
 * ## 这些笔记 AI 也看得到
 *
 * 主进程生成文献清单时会把这些笔记附在「## 我的笔记」一段里(见 `library.manifest`)。
 * 用户记的"这一章的重点""这里推导没看懂"对模型是最直接的信号,而清单正是它读文献时
 * 唯一会看的东西 —— 记了不给它看,等于白记。
 */
import { useCallback, useEffect, useState } from "react";
import type { LibraryItem, LibraryNote } from "@contracts/library";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { IconLoader2, IconPencil, IconPlus, IconTrash } from "@renderer/lib/icons.js";

/** 段落输入框的样式 —— 与 GitPanel 那种"写一段话"的输入同款(不是单行 Input)。 */
const TEXTAREA_CLASS =
  "w-full resize-y rounded-md border border-edge-input bg-surface px-2.5 py-1.5 " +
  "text-[0.8571em] leading-relaxed text-content outline-none focus:border-accent";

export function ItemNotes({ item }: { item: LibraryItem }) {
  const { t } = useI18n();
  const [notes, setNotes] = useState<LibraryNote[] | null>(null);
  /** 正在编辑的笔记 id;`"new"` 表示在写一条新的。null = 不在编辑态。 */
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    setEditing(null);
    setError(null);
    // async IIFE:手机端的 web shim 对没映射的命名空间是同步抛错的,直接挂 .then 会让
    // 异常甩出 effect,React 19 会因此整棵卸载(见 webApi.ts 的说明)
    void (async () => {
      try {
        const res = await api.library.listNotes({ itemId: item.id });
        if (!cancelled) setNotes(res.notes);
      } catch {
        if (!cancelled) {
          setNotes([]);
          setError(t("library.itemNote.loadFailed"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const startNew = () => {
    setEditing("new");
    setDraft("");
    setError(null);
  };

  const startEdit = (n: LibraryNote) => {
    setEditing(n.id);
    setDraft(n.content);
    setError(null);
  };

  const save = useCallback(async () => {
    const content = draft.trim();
    if (!content) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.library.saveNote({
        // "new" 不给 id —— 主进程据此判断是新建还是改写
        ...(editing && editing !== "new" ? { id: editing } : {}),
        itemId: item.id,
        content,
      });
      setNotes(res.notes);
      setEditing(null);
      setDraft("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [draft, editing, item.id]);

  const remove = async (n: LibraryNote) => {
    if (!window.confirm(t("library.itemNote.deleteConfirm"))) return;
    setBusy(true);
    try {
      const res = await api.library.deleteNote({ id: n.id });
      setNotes(res.notes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const editor = (
    <div className="space-y-1.5">
      <textarea
        autoFocus
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter 保存(与其它多行输入一致);Esc 放弃
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === "Escape") {
            setEditing(null);
            setDraft("");
          }
        }}
        placeholder={t("library.itemNote.placeholder")}
        className={TEXTAREA_CLASS}
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={() => {
            setEditing(null);
            setDraft("");
          }}
          className="rounded border border-edge px-2 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
        >
          {t("library.collection.cancel")}
        </button>
        <button
          onClick={() => void save()}
          disabled={busy || !draft.trim()}
          className="rounded bg-accent px-2 py-0.5 text-[0.7857em] text-white hover:opacity-90 disabled:opacity-50"
        >
          {t("library.note.save")}
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.7143em] font-medium uppercase tracking-wider text-content-subtle">
          {t("library.detail.notes")}
        </span>
        {editing !== "new" && (
          <button
            onClick={startNew}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.7857em] text-content-muted hover:bg-surface-hover hover:text-content"
          >
            <IconPlus size={11} />
            {t("library.itemNote.add")}
          </button>
        )}
      </div>

      {notes === null ? (
        <div className="flex items-center gap-1.5 py-1 text-[0.7857em] text-content-subtle">
          <IconLoader2 size={12} className="animate-spin" />
          {t("common.loading")}
        </div>
      ) : (
        <>
          {notes.length === 0 && editing !== "new" && (
            <div className="text-[0.7857em] leading-relaxed text-content-subtle">
              {t("library.itemNote.empty")}
            </div>
          )}

          <ul className="space-y-1.5">
            {notes.map((n) =>
              editing === n.id ? (
                <li key={n.id}>{editor}</li>
              ) : (
                <li
                  key={n.id}
                  className="group rounded border border-edge bg-surface/40 px-3 py-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[0.8571em] leading-relaxed text-content">
                      {n.content}
                    </div>
                    {/* 悬停才出现的行内操作 —— 与左栏其它行同一套 */}
                    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <button
                        onClick={() => startEdit(n)}
                        title={t("library.collection.rename")}
                        className="rounded p-0.5 text-content-subtle hover:bg-surface hover:text-content"
                      >
                        <IconPencil size={12} />
                      </button>
                      <button
                        onClick={() => void remove(n)}
                        disabled={busy}
                        title={t("library.collection.delete")}
                        className="rounded p-0.5 text-content-subtle hover:bg-surface hover:text-red-500 disabled:opacity-40"
                      >
                        <IconTrash size={12} />
                      </button>
                    </span>
                  </div>
                </li>
              ),
            )}
            {editing === "new" && <li>{editor}</li>}
          </ul>
        </>
      )}

      {error && <div className={cn("text-[0.7857em] text-red-500")}>{error}</div>}
    </div>
  );
}
