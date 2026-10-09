/**
 * **彻底删除**的确认框 —— 先把"会跟着一起没的东西"摆出来，让用户一件件勾。
 *
 * ## 为什么不能只问一句"确定吗"
 *
 * 删一条文献是**库里唯一不可逆的操作**（回收站只是"不属于任何分类"，记录和文件都还在）。
 * 而它带走的往往不止它自己：用户手挂的关联、以及**这条 PDF 自己的转录产物 + 那一包图床**
 * （md 里的 `![](images/…)` 指着它，只删正文会把几十张图永远留在盘上）。
 *
 * 用户的原话：「如果删 A 的话会有一个列表显示当前 A 链接的文件，**可以选择性的删或者
 * 不删**，这个功能主要是在**删 pdf 的时候把转录的也一起删掉**的作用」。
 *
 * ## 清单从哪来
 *
 * `api.library.deletePreview({ ids })` —— 主进程早就算好了（`deletePreviewCore`），
 * 契约也定好了三档形态（`item` / `path` / `transcript`）。**这一版之前那个 RPC 一次都
 * 没被调用过**，界面那头一直是 `window.confirm` 一句话。
 *
 * ## 勾 = 「这条也一起删」
 *
 * 用户的原话：「会把**你选择的文件所链接的文件**一并展示出来，由用户选择**是否连带
 * 链接文件也一起删掉**」。勾上的并进这一批一起删（`cascadeLinks`）。
 *
 * ⚠️ 一开始按"勾 = 保留关联"写，**测试红了才发现方向反了**：`library_item_links`
 * 的两列都带 `ON DELETE CASCADE`（见 `store/db.ts` 建表），删掉一头那条关联行就被
 * 数据库自动带走了 —— "保留关联"根本做不到，而且只剩一头也没有意义。
 *
 * ## 哪些档位**没有勾**
 *
 * `transcript`（转录产物 + 图床）：它和正文是一个整体，随条目一起走，没有单独的开关。
 * `path`（库外文件）：删它只是断一条记录，用户磁盘上的文件一个字节都不动 ——
 * 没有"那个文件要不要删"这个问题，所以也不给勾。
 *
 * 两档都**如实显示**（"转录产物 + 图床（12 张图）" / "库外文件"），只是不给开关 ——
 * 显示了不给开关，比给一个假的开关诚实。
 */
import { useEffect, useState } from "react";
import type {
  LibraryDeleteFailure,
  LibraryDeletePreviewEntry,
  LibraryDeletePreviewLink,
} from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { Button } from "@renderer/components/ui/button.js";
import { IconAlertTriangle } from "@renderer/lib/icons.js";

/** 一行清单项的键：库内条目用 id，库外路径用路径。与 `keepLinks` 的字段一一对应。 */
function keyOf(link: LibraryDeletePreviewLink): string {
  return link.targetItemId ?? link.targetPath ?? "";
}

export function DeleteItemsDialog({
  open,
  ids,
  onOpenChange,
  onConfirmed,
}: {
  open: boolean;
  /** 要删的那几条（批量删时不止一条）。 */
  ids: readonly string[];
  onOpenChange: (open: boolean) => void;
  /** 这些记录已不再保留 —— 宿主据此清掉选中态并刷新列表。 */
  onConfirmed: (deletedIds: readonly string[]) => void;
}) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<LibraryDeletePreviewEntry[] | null>(null);
  /** 首次请求的条目；部分失败后只留下仍保留、可重试的记录。 */
  const [remainingIds, setRemainingIds] = useState<string[]>([]);
  const [finishedWithFailures, setFinishedWithFailures] = useState(false);
  /** 勾了的那些 —— 意思是「这条也一起删」（见文件头）。 */
  const [cascade, setCascade] = useState<ReadonlySet<string>>(new Set());
  /** **取消勾**了转录档的条目 id —— 意思是「这条的转录产物**留在盘上**」
      (2026-09-28,用户:「弹出的窗口要可以选择的」)。默认空 = 全删(主用例:
      删 PDF 连转录一起收,这也是这个弹窗当年被要出来的原因)。 */
  const [skipTranscripts, setSkipTranscripts] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时拉一次预览。拉不到就**如实说**，不拿一个空清单冒充"没有关联" ——
  // 那两句在用户眼里一模一样，但一句是真的、一句是骗他点删除。
  useEffect(() => {
    if (!open || ids.length === 0) return;
    let cancelled = false;
    setEntries(null);
    setRemainingIds([...ids]);
    setFinishedWithFailures(false);
    setCascade(new Set());
    setSkipTranscripts(new Set());
    setError(null);
    void api.library
      .deletePreview({ ids: [...ids] })
      .then((res) => {
        if (!cancelled) setEntries(res.entries);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, ids]);

  /** 能勾的那些(库内条目 + 转录档;库外路径仍只显示)。它决定摆哪一句说明。 */
  const tickableLinks = (entries ?? []).reduce(
    (n, e) => n + e.links.filter((l) => l.form === "item" || l.form === "transcript").length,
    0,
  );
  /** 全部会一起没的（三档都算）—— 都要显示出来。 */
  const totalLinks = (entries ?? []).reduce((n, e) => n + e.links.length, 0);

  const confirm = async (): Promise<void> => {
    if (remainingIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const cascadeIds = [...cascade];
      const result = await api.library.deleteItems({
        ids: [...remainingIds],
        deleteFiles: true,
        // 勾上的并进这一批一起删（见文件头：勾 = 这条也一起删）。
        ...(cascadeIds.length > 0 ? { cascadeLinks: cascadeIds } : {}),
        // 转录档被**取消勾**的那些:产物留盘(keepTranscripts,方向与 cascade 相反)。
        ...(skipTranscripts.size > 0 ? { keepTranscripts: [...skipTranscripts] } : {}),
      });
      const affectedIds = [...new Set([...remainingIds, ...cascadeIds])];
      const retainedIds = [
        ...new Set(result.failed.filter((failure) => failure.recordRetained).map((failure) => failure.id)),
      ];
      const retained = new Set(retainedIds);
      onConfirmed(affectedIds.filter((id) => !retained.has(id)));

      if (result.failed.length === 0) {
        onOpenChange(false);
        return;
      }

      const failureMessage = [
        t("library.del.failureSummary", { n: String(result.failed.length) }),
        ...result.failed.map((failure: LibraryDeleteFailure) =>
          // `failure.kind` 是机器哨兵(`pdf` / `markdown` / `file`),直接把英文摊在
          // 中文界面上就是一句「file: C:\…」。按三档翻成人话 —— 与上面的
          // `library.del.form.*` 同一条口径。
          `${t(`library.del.kind.${failure.kind}`)}: ${failure.path}\n${failure.error}\n${t(
            failure.recordRetained ? "library.del.recordRetained" : "library.del.recordRemoved",
          )}`,
        ),
      ].join("\n\n");
      setError(failureMessage);
      setRemainingIds(retainedIds);
      setCascade(new Set());
      setFinishedWithFailures(retainedIds.length === 0);

      if (retainedIds.length === 0) {
        setEntries([]);
        return;
      }

      try {
        const preview = await api.library.deletePreview({ ids: retainedIds });
        setEntries(preview.entries);
      } catch (previewError: unknown) {
        setEntries(null);
        setError(
          `${failureMessage}\n\n${previewError instanceof Error ? previewError.message : String(previewError)}`,
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const title = finishedWithFailures
    ? t("library.del.doneWithWarnings")
    : entries !== null && entries.length === 1
      ? t("library.del.title", { title: entries[0]!.title })
      : t("library.del.titleMultiple", { n: String(remainingIds.length || ids.length) });

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[440px] max-w-[92vw] p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
              <IconAlertTriangle size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-content-muted">
                {finishedWithFailures
                  ? t("library.del.doneWithWarningsDescription")
                  : remainingIds.length === 1
                    ? t("library.del.ownLine")
                    : t("library.del.ownLineMultiple", { n: String(remainingIds.length) })}
              </Dialog.Description>
            </div>
          </div>

          <div className="mt-3 max-h-[45vh] overflow-y-auto">
            {error !== null && (
              <div className="mb-2 whitespace-pre-wrap break-words rounded border border-danger/40 bg-danger/5 px-2 py-1.5 text-[12px] text-danger">
                {error}
              </div>
            )}
            {entries === null ? (
              error === null ? <div className="px-1 py-2 text-[12px] text-content-subtle">…</div> : null
            ) : finishedWithFailures ? null : totalLinks === 0 ? (
              <div className="px-1 py-2 text-[12px] text-content-subtle">{t("library.del.noLinks")}</div>
            ) : (
              <>
                <div className="px-1 pb-1 text-[12px] text-content-muted">
                  {tickableLinks > 0 ? t("library.del.linksHead") : t("library.del.linksHeadNoTick")}
                </div>
                <ul className="space-y-0.5">
                  {entries.flatMap((entry) =>
                    entry.links.map((link) => {
                      const key = keyOf(link);
                      // 库内条目与**转录档**都能勾(2026-09-28):条目档 勾=一起删
                      // (默认不勾);转录档 勾=一起删(默认勾,取消=产物留盘)。
                      // 库外路径仍只显示 —— 删的只是记录,没有"要不要删文件"的问题。
                      const tickable = link.form === "item" || link.form === "transcript";
                      const checked =
                        link.form === "transcript"
                          ? !skipTranscripts.has(entry.id)
                          : tickable && cascade.has(key);
                      const label =
                        link.form === "transcript"
                          ? t("library.del.form.transcript", { n: link.imageCount ?? 0 })
                          : link.form === "path"
                            ? t("library.del.form.path")
                            : t("library.del.form.item");
                      return (
                        <li
                          key={`${entry.id}:${key}:${link.form}`}
                          className={cn(
                            "flex items-start gap-2 rounded px-1 py-1 text-[12px]",
                            tickable ? "hover:bg-surface-muted/60" : "opacity-80",
                          )}
                        >
                          {tickable ? (
                            <input
                              type="checkbox"
                              className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-current"
                              // **可访问名**:旁边的 `link.title` 是兄弟节点,screen reader
                              // 不会把它当成这个 checkbox 的名字 —— 不写的话它只会念
                              // "复选框,已选中",用户不知道勾的是哪一条。左栏 `ItemList`
                              // 的每个 checkbox 都带 `aria-label`(同一套规则)。
                              aria-label={link.title}
                              checked={checked}
                              onChange={(e) => {
                                if (link.form === "transcript") {
                                  const next = new Set(skipTranscripts);
                                  if (e.target.checked) next.delete(entry.id);
                                  else next.add(entry.id); // 取消勾 = 保留这条的转录
                                  setSkipTranscripts(next);
                                } else {
                                  const next = new Set(cascade);
                                  if (e.target.checked) next.add(key);
                                  else next.delete(key);
                                  setCascade(next);
                                }
                              }}
                            />
                          ) : (
                            <span className="mt-[3px] h-3.5 w-3.5 shrink-0" aria-hidden />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-content">{link.title}</span>
                            <span className="block text-[11px] text-content-subtle">{label}</span>
                          </span>
                        </li>
                      );
                    }),
                  )}
                </ul>
              </>
            )}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
              {finishedWithFailures ? t("library.del.done") : t("library.del.cancel")}
            </Button>
            {!finishedWithFailures && (
              <Button
                variant="danger"
                size="sm"
                disabled={busy || entries === null || remainingIds.length === 0}
                onClick={() => void confirm()}
              >
                {t("library.del.confirm")}
              </Button>
            )}
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
