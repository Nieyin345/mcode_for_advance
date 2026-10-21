import type { ContextSnapshot } from "@contracts/runtime";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { fmtTokens, getContextBreakdown } from "@renderer/lib/contextWindow.js";
import { modelTokenGauge } from "./modelTokenGauge.js";

/** The live half of REA ModelSwitcherWithTokenGauge (not demo model ids).
 * Snapshot is per-session and already normalized by the provider. */
export function ModelTokenGauge({ snapshot }: { snapshot?: ContextSnapshot }) {
  const { t } = useI18n();
  const gauge = modelTokenGauge(snapshot?.usedTokens ?? NaN, snapshot?.maxTokens ?? NaN);
  const breakdown = snapshot ? getContextBreakdown(snapshot) : null;
  return (
    <section className="mx-2 mt-1 mb-2 rounded-lg border border-edge/60 bg-surface-muted/50 p-2.5" aria-label={t("chat.context.stats")}>
      <div className="flex items-center gap-2">
        <svg className="h-7 w-7 -rotate-90 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2.5" className="stroke-content-subtle/20" />
          {gauge.known && (
            <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2.5"
              strokeLinecap="round" strokeDasharray={gauge.circumference} strokeDashoffset={gauge.dashoffset}
              className={gauge.nearLimit ? "stroke-warning transition-[stroke-dashoffset] duration-300" : "stroke-accent transition-[stroke-dashoffset] duration-300"} />
          )}
        </svg>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-content">
            <span>{t("chat.context.rowLabel")}</span>
            <span className="tabular-nums">{gauge.percent === null ? "--" : `${gauge.percent}%`}</span>
          </div>
          <div className="truncate text-[10px] tabular-nums text-content-muted">
            {snapshot ? `${fmtTokens(snapshot.usedTokens)} / ${fmtTokens(snapshot.maxTokens)}` : t("chat.context.noData")}
          </div>
        </div>
      </div>
      {breakdown && (
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-edge/60 pt-2">
          {breakdown.rows.map((row) => (
            <div key={row.key} className="flex min-w-0 items-center justify-between gap-1 text-[10px]">
              <span className="truncate text-content-subtle">{row.label}</span>
              <span className="shrink-0 tabular-nums text-content">{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
