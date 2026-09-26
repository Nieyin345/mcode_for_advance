// Presentational: the automation dashboard owns the single read/refresh lifecycle.
import type { ComponentType } from "react";
import type { AutomationRunEntry } from "@contracts/ipc";
import type { NodeOutcomeStatus } from "@contracts/nodeType";
import { cn } from "@renderer/lib/cn.js";
import { useI18n, type MessageId } from "@renderer/lib/i18n/index.js";
import { IconAlertTriangle, IconCircleCheck, IconCircleOff, IconLoader2 } from "@renderer/lib/icons.js";
import { formatFullTime, formatRelativeTime } from "@renderer/lib/time.js";

export const RUN_STATUS_META: Record<string, { Icon: ComponentType<{ size: number; className?: string }>; tone: string; labelKey: MessageId }> = {
  success: { Icon: IconCircleCheck, tone: "text-success", labelKey: "settings.automation.runStatus.success" },
  failed: { Icon: IconAlertTriangle, tone: "text-danger", labelKey: "settings.automation.runStatus.failed" },
  running: { Icon: IconLoader2, tone: "text-accent", labelKey: "settings.automation.runStatus.running" },
  interrupted: { Icon: IconAlertTriangle, tone: "text-warning", labelKey: "settings.automation.runStatus.interrupted" },
  cancelled: { Icon: IconCircleOff, tone: "text-content-muted", labelKey: "settings.automation.runStatus.cancelled" },
};
const STEP_LABELS: Record<NodeOutcomeStatus, MessageId> = {
  success: "settings.automation.stepStatus.success", failed: "settings.automation.stepStatus.failed",
  cancelled: "settings.automation.stepStatus.cancelled", skipped: "settings.automation.stepStatus.skipped",
  unselected: "settings.automation.stepStatus.unselected",
};
export function RunHistorySection({ runs, loading = false, failed = false }: {
  runs: AutomationRunEntry[]; loading?: boolean; failed?: boolean;
}) {
  const { t } = useI18n();
  const stepLabel = (status: string): string => Object.hasOwn(STEP_LABELS, status)
    ? t(STEP_LABELS[status as NodeOutcomeStatus]) : status;
  return <section className="mt-3 border-t border-edge pt-3" aria-label={t("settings.runHistory.title")}>
    <h3 className="mb-2 text-[0.7857em] font-medium text-content-muted">{t("settings.runHistory.title")}</h3>
    {runs.length === 0 && !loading && !failed && <p className="text-[0.7143em] text-content-subtle">{t("settings.automation.runHistoryEmpty")}</p>}
    <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">{runs.map(run => {
      const meta = RUN_STATUS_META[run.status];
      const Icon = meta?.Icon ?? IconCircleOff;
      return <details key={run.runId} data-run-id={run.runId} data-run-status={run.status} className="rounded border border-edge bg-surface p-2" open={run.status === "running" || run.status === "failed"}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-1.5 text-[0.7143em]">
          <Icon size={12} className={cn("shrink-0", meta?.tone)}/>
          <span className={cn("font-medium", meta?.tone)}>{meta ? t(meta.labelKey) : run.status}</span>
          <time className="text-content-subtle" title={formatFullTime(run.startedAt)}>{formatRelativeTime(run.startedAt)}</time>
          <span className="text-content-muted">{t("settings.automation.settledCount", { n: run.steps.length })}</span>
        </summary>
        <div className="mt-2 space-y-1 text-[0.7143em]">
          <p className="break-all text-content-subtle"><code>{run.runId}</code> · {formatFullTime(run.updatedAt)}</p>
          {run.steps.map(step => <div key={step.nodeId} className="break-words">
            <span className="text-content-muted">{step.title}</span>
            <span className="text-content-subtle"> · {stepLabel(step.status)}</span>
            {step.error ? <p className="text-danger">{step.error}</p> : step.summary && <p className="text-content-subtle">{step.summary}</p>}
          </div>)}
        </div>
      </details>;
    })}</div>
  </section>;
}
