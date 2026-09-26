import { useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog, ErrorNote } from "@renderer/components/ui/index.js";
import type { MemoryManageInput } from "@contracts/memory";
export function MemoryTransferPanel() {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [history, setHistory] = useState("");
  const [destination, setDestination] = useState("");
  const [pending, setPending] = useState<MemoryManageInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const list = useRpc(() => api.memory.manage({ action: "list" }), []);
  const preview = useRpc(async () => ({ source, result: await api.memory.manage({ action: "preview", source }) }), [source], { enabled: !!source });
  const archived = useRpc(async () => ({ id: history, result: await api.memory.manage({ action: "history", id: history }) }), [history], { enabled: !!history });
  const ready = !preview.loading && preview.data?.source === source && preview.data.result.ok && !!preview.data.result.digest;
  async function commit() {
    const input = pending; setPending(null); if (!input || busy) return;
    setBusy(true);
    try {
      const result = await api.memory.manage(input);
      setNotice(result.ok ? t("memory.transferDone") : result.error ?? t("common.error"));
      await list.refetch();
    } catch (err) { setNotice(String(err)); } finally { setBusy(false); }
  }
  return <section className="my-4 space-y-3 rounded border border-edge p-3">
    <h3 className="font-medium">{t("memory.transferTitle")}</h3>
    <p className="text-sm text-content-muted">{t("memory.transferHint")}</p>
    {(list.error || list.data?.error) && <ErrorNote>{list.error?.message ?? list.data?.error}</ErrorNote>}
    <div className="flex flex-wrap gap-2">
      <select aria-label={t("memory.source")} value={source} onChange={e => setSource(e.target.value)} className="max-w-full bg-surface p-2">
        <option value="">{t("memory.source")}</option>
        {list.data?.sources?.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <select aria-label={t("memory.destination")} value={destination} onChange={e => setDestination(e.target.value)} className="bg-surface p-2">
        <option value="">{t("memory.destination")}</option>
        <option value="global">{t("memory.globalScope")}</option>
        {list.data?.projects?.map(p => <option key={p.id} value={`projects/${p.id}`}>{p.name}</option>)}
      </select>
      <Button disabled={!ready || !destination || busy} onClick={() => {
        if (!ready || !preview.data?.result.digest) return;
        setPending({ action: "import", source, digest: preview.data.result.digest, global: destination === "global",
          ...(destination.startsWith("projects/") ? { projectId: destination.slice(9) } : {}), confirmed: true });
      }}>{t("memory.confirmImport")}</Button>
      <Button disabled={busy || list.loading} onClick={() => void list.refetch()}>{t("memory.refreshSources")}</Button>
    </div>
    {source && preview.data?.source === source && <>
      {preview.data.result.error && <ErrorNote>{preview.data.result.error}</ErrorNote>}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{preview.data.result.content}</pre>
      <code className="break-all text-xs">{preview.data.result.digest}</code>
    </>}
    <h4>{t("memory.historyTitle")}</h4>
    <select aria-label={t("memory.historyTitle")} value={history} onChange={e => setHistory(e.target.value)} className="max-w-full bg-surface p-2">
      <option value="">{t("memory.historyTitle")}</option>
      {list.data?.history?.map(h => <option key={h.id} value={h.id}>{new Date(h.at).toLocaleString()} — {h.path}</option>)}
    </select>
    {history && archived.data?.id === history && <>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{archived.data.result.content}</pre>
      {archived.data.result.error && <ErrorNote>{archived.data.result.error}</ErrorNote>}
      <Button disabled={busy || archived.loading || !archived.data.result.ok} onClick={() => setPending({ action: "restore", id: history, digest: archived.data!.result.digest!, confirmed: true })}>{t("memory.restore")}</Button>
    </>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <ConfirmDialog open={pending !== null} title={t("memory.confirmTransfer")} description={t("memory.transferSafety")}
      confirmText={t("common.confirm")} onOpenChange={open => { if (!open) setPending(null); }} onConfirm={() => void commit()} />
  </section>;
}
