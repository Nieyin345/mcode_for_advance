import { useState } from "react";
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryManageInput } from "@contracts/memory";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, ErrorNote } from "@renderer/components/ui/index.js";
import { SettingsSection } from "@renderer/components/settings/SettingsSection.js";

const selectClass = "w-full rounded border border-edge bg-surface px-2 py-2 text-sm";

export function MemoryTransferPanel() {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [history, setHistory] = useState("");
  const [destination, setDestination] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("project");
  const [pending, setPending] = useState<MemoryManageInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const list = useRpc(() => api.memory.manage({ action: "list" }), []);
  const preview = useRpc(async () => ({ source, result: await api.memory.manage({ action: "preview", source }) }), [source], { enabled: !!source });
  const archived = useRpc(async () => ({ id: history, result: await api.memory.manage({ action: "history", id: history }) }), [history], { enabled: !!history });
  const previewResult = preview.data?.source === source ? preview.data.result : undefined;
  const historyResult = archived.data?.id === history ? archived.data.result : undefined;
  const ready = !preview.loading && previewResult?.ok && !!previewResult.digest;

  async function commit() {
    const input = pending;
    setPending(null);
    if (!input || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await api.memory.manage(input);
      setNotice(result.ok ? t("memory.transferDone") : result.error ?? t("common.error"));
      if (result.ok) { setSource(""); setHistory(""); }
      await list.refetch();
    } catch (err) { setNotice(String(err)); } finally { setBusy(false); }
  }

  return <div className="space-y-4 pb-4">
    <SettingsSection title={t("memory.importTitle")} desc={t("memory.importHint")}>
      <div className="space-y-3 px-4 py-3">
        {(list.error || list.data?.error) && <ErrorNote>{list.error?.message ?? list.data?.error}</ErrorNote>}
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm text-content-muted">{t("memory.source")}
            <select value={source} onChange={e => setSource(e.target.value)} className={`mt-1 ${selectClass}`}>
              <option value="">{t("memory.chooseSource")}</option>
              {list.data?.sources?.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="text-sm text-content-muted">{t("memory.destination")}
            <select value={destination} onChange={e => setDestination(e.target.value)} className={`mt-1 ${selectClass}`}>
              <option value="">{t("memory.chooseDestination")}</option>
              <option value="global">{t("memory.globalScope")}</option>
              {list.data?.projects?.map(p => <option key={p.id} value={`projects/${p.id}`}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-sm text-content-muted">{t("memory.category")}
            <select value={category} onChange={e => setCategory(e.target.value as MemoryCategory)} className={`mt-1 ${selectClass}`}>
              {MEMORY_CATEGORIES.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        {source && <>
          <p className="text-xs text-content-muted">{t("memory.previewLabel")}</p>
          {previewResult?.error && <ErrorNote>{previewResult.error}</ErrorNote>}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-edge bg-surface-subtle p-3 text-xs">{preview.loading ? t("common.loading") : previewResult?.content}</pre>
        </>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy || list.loading} onClick={() => void list.refetch()}>{t("memory.refreshSources")}</Button>
          <Button variant="primary" disabled={!ready || !destination || busy} onClick={() => {
            if (!ready || !previewResult?.digest) return;
            setPending({ action: "import", source, digest: previewResult.digest, category, global: destination === "global",
              ...(destination.startsWith("projects/") ? { projectId: destination.slice(9) } : {}), confirmed: true });
          }}>{t("memory.confirmImport")}</Button>
        </div>
      </div>
    </SettingsSection>

    <SettingsSection title={t("memory.historyTitle")} desc={t("memory.historyHint")}>
      <div className="space-y-3 px-4 py-3">
        <select aria-label={t("memory.historyTitle")} value={history} onChange={e => setHistory(e.target.value)} className={selectClass}>
          <option value="">{t("memory.chooseHistory")}</option>
          {list.data?.history?.map(h => <option key={h.id} value={h.id}>{new Date(h.at).toLocaleString()} — {h.path}</option>)}
        </select>
        {history && <>
          {historyResult?.error && <ErrorNote>{historyResult.error}</ErrorNote>}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-edge bg-surface-subtle p-3 text-xs">{archived.loading ? t("common.loading") : historyResult?.content}</pre>
          <div className="flex justify-end"><Button disabled={busy || archived.loading || !historyResult?.ok || !historyResult.digest}
            onClick={() => historyResult?.digest && setPending({ action: "restore", id: history, digest: historyResult.digest, confirmed: true })}>{t("memory.restore")}</Button></div>
        </>}
      </div>
    </SettingsSection>
    {notice && <p role="status" className="text-sm text-content-muted">{notice}</p>}
    <ConfirmDialog open={pending !== null} title={t("memory.confirmTransfer")} description={t("memory.transferSafety")}
      confirmText={t("common.confirm")} onOpenChange={open => { if (!open) setPending(null); }} onConfirm={() => void commit()} />
  </div>;
}
