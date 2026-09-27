/**
 * 记忆库的**人工整理**入口。过期/重复是启发式建议，不自动合并或删除。
 *
 * 默认零勾选 → 查看正文 → 选要删的一份 → 危险操作确认 → 主进程按完整原文指纹
 * 逐条重读并校验。若中途被 AI/其他窗口改写，必须重新扫描。脏编辑器/新建草稿
 * 存在时不允许查看候选或删除，避免无意丢掉用户正在写的内容。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MemoryReviewEntry, MemoryReviewResult } from "@contracts/memory";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog } from "@renderer/components/ui/index.js";
import { reviewSelectionConflict, reviewSelectionHasUnsavedDraft } from "./reviewSelection.js";

interface Props {
  /** 编辑器当前有未保存改动或未落盘的草稿。 */
  dirty: boolean;
  /** 编辑器里保留着未保存草稿的文件（不只是当前打开的那一个）。这些文件不可勾选删除。 */
  unsavedPaths?: readonly string[];
  onOpen: (path: string) => void;
  onDeleted: (paths: readonly string[]) => void;
}

const NO_PATHS: readonly string[] = [];

export function MemoryMaintenanceReview({ dirty, unsavedPaths = NO_PATHS, onOpen, onDeleted }: Props) {
  const { t } = useI18n();
  const [report, setReport] = useState<MemoryReviewResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [outdated, setOutdated] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 扫描期间若收到库变动消息，不能把刚变动的结果标为“新鲜”。 */
  const revisionRef = useRef(0);

  const scan = useCallback(async (): Promise<void> => {
    const revision = revisionRef.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    setSelectedPaths([]);
    try {
      const next = await api.memory.review();
      setReport(next);
      setOutdated(revisionRef.current !== revision);
    } catch (err) {
      setReport(null);
      setOutdated(true);
      setError(t("memory.reviewFailed", { error: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => {
    const off = window.api?.on?.libraryChanged?.(() => {
      revisionRef.current += 1;
      setOutdated(true);
    });
    return off;
  }, []);

  const candidates = useMemo(() => {
    const entries = new Map<string, MemoryReviewEntry>();
    if (report) {
      for (const entry of report.stale) entries.set(entry.path, entry);
      for (const { a, b } of report.duplicates) {
        entries.set(a.path, a);
        entries.set(b.path, b);
      }
    }
    return entries;
  }, [report]);
  const conflict = report !== null && reviewSelectionConflict(report, selectedPaths);
  const draftBlocked = reviewSelectionHasUnsavedDraft(selectedPaths, unsavedPaths);
  const canDelete = report !== null && selectedPaths.length > 0 &&
    !dirty && !outdated && !conflict && !draftBlocked && !loading && !working;

  const toggle = (path: string): void => {
    setSelectedPaths((previous) => previous.includes(path)
      ? previous.filter((p) => p !== path)
      : [...previous, path]);
  };

  /** 每条独立核对版本；失败即停，并准确报告已删除多少条，绝不掩盖部分成功。 */
  const removeSelected = async (): Promise<void> => {
    if (!canDelete) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    const deleted: string[] = [];
    let failure: string | null = null;
    try {
      for (const path of selectedPaths) {
        const entry = candidates.get(path);
        if (!entry) throw new Error(`Missing review candidate: ${path}`);
        const result = await api.memory.reviewDelete({ path, digest: entry.digest });
        if (!result.ok) throw new Error(`${path}: ${result.error ?? t("common.error")}`);
        deleted.push(path);
      }
    } catch (err) {
      failure = (err as Error).message;
    } finally {
      if (deleted.length > 0) onDeleted(deleted);
      setSelectedPaths([]);
      setOutdated(true); // 本轮结果已失效；无论成功还是失败都必须重新扫描。
      setWorking(false);
      if (failure !== null) setError(t("memory.reviewDeleteFailed", { count: deleted.length, error: failure }));
      else setNotice(t("memory.reviewDeleted", { count: deleted.length }));
    }
  };

  const row = (entry: MemoryReviewEntry) => {
    const hasDraft = unsavedPaths.includes(entry.path);
    return (
    <div className="flex min-w-0 items-start gap-2 rounded border border-edge/60 bg-surface px-2 py-1.5">
      <input
        type="checkbox"
        aria-label={t("memory.reviewSelect", { path: entry.path })}
        checked={selectedPaths.includes(entry.path)}
        disabled={dirty || outdated || loading || working || (hasDraft && !selectedPaths.includes(entry.path))}
        onChange={() => toggle(entry.path)}
        className="mt-1 shrink-0 accent-accent"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-1">
          <span className="min-w-0 break-words text-[0.7857em] font-medium text-content">
            {entry.title || entry.path}
          </span>
          <Button size="sm" variant="ghost" disabled={dirty || working}
            onClick={() => onOpen(entry.path)} className="shrink-0">
            {t("memory.reviewOpenFile")}
          </Button>
        </div>
        <code className="block break-all text-[0.7143em] text-content-subtle">
          {entry.path} · {entry.updatedAt > 0
            ? new Date(entry.updatedAt).toLocaleDateString()
            : t("memory.reviewNoDate")}
        </code>
        <p className="break-words text-[0.7143em] text-content-muted">
          {entry.preview || t("memory.reviewNoPreview")}
        </p>
        {hasDraft && <p className="break-words text-[0.7143em] text-warning">{t("memory.reviewUnsavedDraft")}</p>}
      </div>
    </div>
    );
  };

  return (
    <div className="mb-3 rounded border border-edge bg-surface-muted/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[0.8571em] font-semibold text-content">{t("memory.reviewTitle")}</h3>
          <p className="mt-1 text-[0.7143em] leading-relaxed text-content-muted">{t("memory.reviewDesc")}</p>
        </div>
        <Button size="sm" variant="secondary" disabled={loading || working} onClick={() => void scan()}>
          {t("memory.reviewRefresh")}
        </Button>
      </div>

      {dirty && <p className="mt-2 text-[0.7857em] text-warning">{t("memory.reviewDirty")}</p>}
      {outdated && report && <p className="mt-2 text-[0.7857em] text-warning">{t("memory.reviewOutdated")}</p>}
      {error && <p role="alert" className="mt-2 break-words text-[0.7857em] text-danger">{error}</p>}
      {notice && <p role="status" className="mt-2 text-[0.7857em] text-success">{notice}</p>}

      {loading && <p className="mt-2 text-[0.7857em] text-content-subtle">{t("common.loading")}</p>}
      {report && !loading && (
        <>
          <p className="mt-2 text-[0.7857em] text-content-muted">{t("memory.reviewSummary", {
            total: report.totalFiles, shown: report.stale.length, stale: report.staleTotal,
            pairs: report.duplicates.length, pairTotal: report.duplicatePairTotal,
            scanned: report.scannedForDuplicates,
          })}</p>
          {report.staleTruncated && <p className="text-[0.7143em] text-warning">{t("memory.reviewStaleLimit")}</p>}
          {report.duplicateTruncated && <p className="text-[0.7143em] text-warning">{t("memory.reviewDuplicateLimit")}</p>}
          {report.pairTruncated && <p className="text-[0.7143em] text-warning">{t("memory.reviewPairLimit")}</p>}
          {report.tooLong.length > 0 && <p className="break-words text-[0.7143em] text-warning">
            {t("memory.reviewLong", { count: report.tooLong.length, paths: report.tooLong.join(", ") })}
          </p>}
          {report.unreadable.length > 0 && <p className="break-words text-[0.7143em] text-danger">
            {t("memory.reviewUnreadable", { count: report.unreadable.length, paths: report.unreadable.join(", ") })}
          </p>}
          {report.stale.length === 0 && report.duplicates.length === 0 ? (
            <p className="mt-2 text-[0.7857em] text-content-subtle">{t("memory.reviewEmpty")}</p>
          ) : (
            <>
              <div className="mt-2 max-h-72 space-y-3 overflow-y-auto pr-1">
                {report.stale.length > 0 && <div className="space-y-1">
                  <h4 className="text-[0.7857em] font-medium text-content">{t("memory.reviewStale")}</h4>
                  {report.stale.map((entry) => <div key={entry.path}>{row(entry)}</div>)}
                </div>}
                {report.duplicates.length > 0 && <div className="space-y-1">
                  <h4 className="text-[0.7857em] font-medium text-content">{t("memory.reviewDuplicates")}</h4>
                  {report.duplicates.map(({ a, b }) => <div key={`${a.path}|${b.path}`}
                    className="grid gap-1 rounded border border-edge p-1 sm:grid-cols-2">
                    {row(a)}{row(b)}
                  </div>)}
                </div>}
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className={conflict ? "text-[0.7143em] text-danger" : "text-[0.7143em] text-content-muted"}>
                  {conflict ? t("memory.reviewBoth") : t("memory.reviewSelectHint")}
                </span>
                <Button size="sm" variant="danger" disabled={!canDelete} onClick={() => setConfirmOpen(true)}>
                  {t("memory.reviewDelete", { count: selectedPaths.length })}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirmOpen}
        danger
        title={t("memory.reviewConfirmTitle", { count: selectedPaths.length })}
        description={<span className="block">
          {t("memory.reviewConfirmDesc")}
          <span className="mt-2 block max-h-32 overflow-y-auto break-all font-mono text-[0.85em]">
            {selectedPaths.map((path) => <span key={path} className="block">{path}</span>)}
          </span>
        </span>}
        confirmText={t("common.delete")}
        onOpenChange={setConfirmOpen}
        onConfirm={() => { void removeSelected(); }}
      />
    </div>
  );
}
