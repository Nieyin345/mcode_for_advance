// One saved-version dashboard: status and history share a read/refresh lifecycle.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationTriggerFacts } from "@contracts/ipc";
import { latestFailureOf } from "@contracts/ipc";
import type { NodeTypeCatalog } from "@contracts/nodeType";
import type { WorkflowDoc } from "@contracts/workflow";
import { api } from "@renderer/lib/api.js";
import { cn } from "@renderer/lib/cn.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { formatFullTime } from "@renderer/lib/time.js";
import { IconPlayerPlay, IconRefresh } from "@renderer/lib/icons.js";
import { findNodeType, nodeTitle } from "./workflowView.js";
import { RunHistorySection } from "./RunHistorySection.js";
import { triggerKindLabel } from "./workflowPresentation.js";

export function AutomationRunSection({ doc, catalog, dirty = false }: {
  doc: WorkflowDoc; catalog: NodeTypeCatalog; dirty?: boolean;
}) {
  const { t } = useI18n();
  const triggers = doc.nodes.filter(n => findNodeType(catalog.entries, n.type)?.manifest.runner.kind === "trigger");
  const [selectedTrigger, setSelectedTrigger] = useState<string | null>(null);
  const triggerNodeId = triggers.some(n => n.id === selectedTrigger) ? selectedTrigger : triggers[0]?.id ?? null;
  const trigger = triggers.find(n => n.id === triggerNodeId);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const read = useRpc(async () => {
    const [result, facts] = await Promise.all([
      api.automation.runs({ workflowId: doc.id, limit: 50 }), api.automation.statusAll(),
    ]);
    return { workflowId: doc.id, runs: result.runs, facts: facts.filter(f => f.workflowId === doc.id), readAt: Date.now() };
  }, [doc.id, doc.updatedAt, doc.nodes], { toastOnError: false });
  const data = read.data?.workflowId === doc.id ? read.data : undefined;
  const running = data?.runs.some(r => r.status === "running") ?? false;
  const refresh = useCallback(async () => { if (alive.current) await read.refetch(); }, [read.refetch]);
  const current = useRef({ loading: read.loading, error: read.error });
  current.current = { loading: read.loading, error: read.error };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    // Only a visible dashboard polls. Failed reads stop automatic retries; the
    // inline Retry is explicit. No requests pile up behind a slow connection.
    const tick = () => {
      if (!document.hidden && !current.current.loading && !current.current.error) void refresh();
    };
    const timer = setInterval(tick, running ? 1000 : 5000);
    const focus = () => { if (!current.current.loading) void refresh(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", tick); };
  }, [refresh, running]);

  const runNow = async () => {
    if (dirty || busyRef.current || running || !triggerNodeId) return;
    busyRef.current = true; setBusy(true); setNotice(null);
    try {
      const result = await api.automation.run({ workflowId: doc.id, triggerNodeId });
      if (alive.current && !result.ok) setNotice(result.error ?? t("settings.automation.runFailed"));
    } catch (error) {
      if (alive.current) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) await refresh();
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const factsById = new Map<string, AutomationTriggerFacts>((data?.facts ?? []).map(f => [f.nodeId, f]));
  return <section className="mt-3 border-t border-edge pt-3" aria-label={t("settings.automation.dashboard")}>
    <div className="mb-2 flex items-center gap-2">
      <span className="text-[0.7857em] font-medium text-content-muted">{t("settings.automation.dashboard")}</span>
      <Button size="sm" variant="ghost" disabled={read.loading} aria-label={t("settings.automation.refresh")} onClick={() => void refresh()}><IconRefresh size={12}/></Button>
    </div>
    {read.loading && !data && <p role="status" className="text-[0.7143em] text-content-subtle">{t("common.loading")}</p>}
    {read.error && <ErrorNote action={<Button size="sm" variant="secondary" onClick={() => void refresh()}>{t("common.retry")}</Button>}>
      {t("settings.automation.loadFailed", { error: read.error.message })}
      {data && <p>{t("settings.automation.staleData")}</p>}
    </ErrorNote>}
    <div className="space-y-1.5" aria-label={t("settings.automation.savedTriggers")}>
      {triggers.map(node => {
        const fact = factsById.get(node.id);
        const kind = node.params.triggerKind;
        return <div key={node.id} data-automation-trigger={node.id} className="rounded border border-edge p-2 text-[0.7143em]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-content">{nodeTitle(node, findNodeType(catalog.entries, node.type))}</span>
            <span className="text-content-muted">{triggerKindLabel(kind, t)}</span>
            {fact && <span className={cn(fact.armed ? "text-success" : fact.enabled === false ? "text-content-subtle" : "text-warning")}>
              {t(fact.armed ? "settings.automation.facts.armed" : fact.enabled === false ? "settings.automation.facts.off" : "settings.automation.facts.disarmed")}
            </span>}
          </div>
          {fact?.detail && <p className="break-words text-content-subtle">{fact.detail}</p>}
          {fact && latestFailureOf(fact) && <p className="break-words text-danger">{latestFailureOf(fact)}</p>}
        </div>;
      })}
    </div>
    <label className="mt-3 mb-1 block text-[0.7857em] text-content-muted">
      {t("settings.automation.runTrigger")}
      <select aria-label={t("settings.automation.runTrigger")} className="mt-1 w-full rounded border border-edge bg-surface p-1 text-content"
        value={triggerNodeId ?? ""} disabled={busy || dirty} onChange={e => setSelectedTrigger(e.target.value)}>
        {triggers.map(n => <option key={n.id} value={n.id}>{nodeTitle(n, findNodeType(catalog.entries, n.type))}</option>)}
      </select>
    </label>
    <Button variant="secondary" size="sm" className="gap-1" disabled={!triggerNodeId || busy || dirty || running} onClick={() => void runNow()}>
      <IconPlayerPlay size={11}/>{t("settings.automation.runNow")}
    </Button>
    {dirty ? <p role="status" className="mt-1 text-[0.7143em] text-warning">{t("settings.automation.saveBeforeRun")}</p>
      : !trigger ? <p className="mt-1 text-[0.7143em] text-warning">{t("settings.automation.runNoTrigger")}</p>
      : <p className="mt-1 text-[0.7143em] text-content-subtle">{t("settings.automation.runNowHint", { name: nodeTitle(trigger, findNodeType(catalog.entries, trigger.type)) })}</p>}
    <p className="mt-1 text-[0.7143em] text-content-subtle">{t("settings.automation.manualPayloadHint")}</p>
    {notice && <ErrorNote className="mt-2">{notice}</ErrorNote>}
    {data && <p className="mt-2 text-[0.7143em] text-content-subtle">{t("settings.automation.lastUpdated", { time: formatFullTime(data.readAt) })}</p>}
    <RunHistorySection runs={data?.runs ?? []} loading={read.loading && !data} failed={read.error !== null}/>
  </section>;
}