/**
 * **文件历史面板** —— 列出以前的版本并回到某一版（EDIT-09）。
 *
 * ## 为什么它不放在左栏
 *
 * 左栏是**待处理事项**（修订与评论）。历史是"回看过去" —— 两种场景不会同时用，
 * 而且历史列表可能很长。放同一个栏里会让"我现在该处理什么"被一堆旧版本淹没。
 * 所以它是**工具条上的一个入口 + 一个抽屉**（与修订左栏互斥出现）。
 *
 * ## 它知道什么 / 不知道什么
 *
 * - 它只知道**宿主记下来的版本**（每次保存成功记一版，见 `main/document/documentHistory.ts`）；
 * - 它**不做 diff**：二进制格式（docx/xlsx/pptx/pdf）算不出可靠的文本差异，
 *   所以每条只给「时间 + 大小 + 来源」，够用户认出"这是哪一版"；
 * - **回滚前确认**：回滚会覆盖磁盘上的文件，是不可逆的动作（我们会先给当前内容记一版，
 *   但用户当时不该依赖这个细节 —— 所以仍然确认一次）。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";
import { IconClock, IconAlertTriangle, IconRefresh } from "@renderer/lib/icons.js";
import type { DocHistoryVersion } from "@contracts/ipc";

type Translate = ReturnType<typeof useI18n>["t"];

function sourceLabel(t: Translate, source: DocHistoryVersion["source"]): string {
  switch (source) {
    case "ai": return t("history.sourceAi");
    case "restore": return t("history.sourceRestore");
    default: return t("history.sourceUser");
  }
}

/** 人读的大小：1024 进制，一位小数。 */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function FileHistoryPanel({
  filePath, onClose, onRestored,
}: {
  filePath: string;
  onClose: () => void;
  /** 回滚成功后由父组件重新读文件（编辑器里的内容已经过期）。 */
  onRestored?: () => void;
}) {
  const { t } = useI18n();
  const [versions, setVersions] = useState<DocHistoryVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    void api.documentView.historyList({ filePath }).then(
      (result) => {
        if (result.ok) setVersions(result.versions);
        else { setVersions([]); setError(result.reason); }
      },
      (err: unknown) => {
        setVersions([]);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [filePath]);

  useEffect(() => { refresh(); }, [refresh]);

  const restore = useCallback(async (sha256: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.documentView.historyRestore({ filePath, sha256 });
      if (!result.ok) setError(result.reason);
      else { setConfirming(null); refresh(); onRestored?.(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [filePath, refresh, onRestored]);

  return (
    <aside
      data-cds="FileHistoryPanel"
      data-history-file={filePath}
      className="flex h-full min-h-0 w-[280px] shrink-0 flex-col border-r border-edge bg-surface"
      aria-label={t("history.title")}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-edge px-2.5 py-2">
        <IconClock size={12} className="shrink-0 text-content-muted" />
        <span className="text-[length:var(--chat-fs-xs)] font-semibold text-content">
          {t("history.title")}
        </span>
        <span className="text-[length:var(--chat-fs-xs)] text-content-muted">
          {versions === null ? "" : t("history.count", { count: String(versions.length) })}
        </span>
        <button
          type="button"
          className="ml-auto rounded px-1.5 py-0.5 text-[length:var(--chat-fs-xs)] text-content-muted hover:bg-surface-hover active:bg-surface-active"
          onClick={onClose}
        >
          {t("history.close")}
        </button>
      </header>

      {error !== null && (
        <div className="flex items-start gap-1 border-b border-edge px-2.5 py-1.5 text-[length:var(--chat-fs-xs)] text-warning">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {versions !== null && versions.length === 0 && (
          <div className="px-2.5 py-3 text-[length:var(--chat-fs-xs)] text-content-muted">
            {t("history.empty")}
          </div>
        )}
        {/* **从新到旧**：用户要找的通常是"刚才那一版"，所以倒序显示（索引本身是从旧到新）。 */}
        {versions !== null && [...versions].reverse().map((version) => (
          <article
            key={version.sha256}
            data-history-version={version.sha256}
            className="border-b border-edge/60 px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[length:var(--chat-fs-xs)] font-medium text-content">
                {timeLabel(version.savedAt)}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-content-muted">
                {sourceLabel(t, version.source)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-content-muted">
              <span>{sizeLabel(version.bytes)}</span>
              <span className="truncate font-mono">{version.sha256.slice(0, 8)}</span>
            </div>

            {confirming === version.sha256 ? (
              <div data-history-confirm="" className="mt-1.5 flex flex-col gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-1.5">
                <span className="text-[10px] text-content">{t("history.confirmRestore")}</span>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" disabled={busy}
                    onClick={() => void restore(version.sha256)}>
                    {t("common.confirm")}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy}
                    onClick={() => setConfirming(null)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <button type="button" data-history-restore=""
                className="mt-1 flex items-center gap-0.5 text-[10px] text-accent hover:underline"
                onClick={() => setConfirming(version.sha256)}>
                <IconRefresh size={10} />{t("history.restore")}
              </button>
            )}
          </article>
        ))}
      </div>
    </aside>
  );
}
