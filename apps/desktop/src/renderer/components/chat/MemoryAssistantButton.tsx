import { useEffect, useRef, useState } from "react";
import type { MemoryAssistantInput, MemoryAssistantJob, MemoryAssistantKind, MemoryAssistantResult } from "@contracts/memoryAssistant";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { Button, Dialog, ErrorNote } from "@renderer/components/ui/index.js";
import { IconClipboardText } from "@renderer/lib/icons.js";
import { MemoryInjectionPreview } from "../memory/MemoryInjectionPreview.js";

export function MemoryAssistantButton({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MemoryAssistantResult>({ jobs: [], injections: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [targetId, setTargetId] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);
  const all = useSessionStore(s => s.sessionsByProject);
  const sessions = Object.values(all).flat();
  const source = sessions.find(s => s.id === sessionId);
  const targets = sessions.filter(s => s.projectId === source?.projectId && s.id !== sessionId && s.kind === "chat" && !s.archived);
  const running = data.jobs.some(j => j.status === "running");
  useSuppressBrowserView(open);

  const read = async () => {
    if (lock.current) return;
    const own = generation.current;
    try {
      const next = await api.memory.assistant({ op: "list", sessionId });
      if (!lock.current && own === generation.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (own === generation.current) setError(String(e));
    }
  };

  useEffect(() => {
    generation.current++;
    lock.current = false;
    setBusy(false);
    setData({ jobs: [], injections: [] });
    setTargetId("");
    setError("");
    setOpen(false);
  }, [sessionId]);

  useEffect(() => {
    let alive = true, fetching = false;
    const poll = async () => {
      if (fetching || lock.current) return;
      fetching = true;
      const own = generation.current;
      try {
        const next = await api.memory.assistant({ op: "list", sessionId });
        if (alive && !lock.current && own === generation.current) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (alive && own === generation.current) setError(String(e));
      } finally {
        fetching = false;
      }
    };
    void poll();
    const timer = open || running || data.incoming ? setInterval(() => void poll(), 2000) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [sessionId, open, running, data.incoming?.id]);

  const perform = async (input: MemoryAssistantInput) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); const own = ++generation.current;
    try {
      const next = await api.memory.assistant(input);
      if (own !== generation.current) return;
      setData(next);
      if (input.op === "start") setOpen(false); // Do not cover approval cards in the source conversation.
      if (next.target) {
        useSessionStore.setState(s => ({ sessionsByProject: { ...s.sessionsByProject,
          [next.target!.projectId]: [next.target!, ...(s.sessionsByProject[next.target!.projectId] ?? []).filter(v => v.id !== next.target!.id)] } }));
        await useSessionStore.getState().openTab(next.target.id);
        setOpen(false);
      }
    } catch (e) { if (own === generation.current) setError(String(e)); }
    finally { if (own === generation.current) { lock.current = false; setBusy(false); } }
  };

  const label = (kind: MemoryAssistantKind) => t(kind === "capture" ? "memory.assistant.capture" : kind === "checkpoint" ? "memory.assistant.checkpoint" : "memory.assistant.health");
  const status = (job: MemoryAssistantJob) => t(`memory.assistant.status.${job.status}`);

  return <>
    <Button size="sm" variant="ghost" className="gap-1 shrink-0" onClick={() => setOpen(true)} title={t("memory.assistant.scope")}>
      <IconClipboardText size={14}/>{t(running ? "memory.assistant.running" : data.incoming ? "memory.assistant.incoming" : "memory.assistant.title")}
    </Button>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal><Dialog.Backdrop/><Dialog.Popup className="w-[min(720px,94vw)] max-h-[80vh] overflow-y-auto p-5">
        <Dialog.Title>{t("memory.assistant.title")}</Dialog.Title><Dialog.Close/>
        <div className="mt-2 flex items-center justify-between gap-2">
          <Dialog.Description className="text-sm text-content-muted">{t("memory.assistant.scope")}</Dialog.Description>
          <Button size="sm" variant="ghost" onClick={() => void read()} disabled={busy}>{t("memory.assistant.refresh")}</Button>
        </div>
        {error && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
            <span>{error}</span>
            <Button size="sm" variant="secondary" onClick={() => void read()}>{t("memory.assistant.retry")}</Button>
          </div>
        )}
        {data.incoming && <section className="mt-3 rounded border border-edge p-3">
          <h3 className="font-medium">{t("memory.assistant.incoming")}</h3>
          <p className="text-sm text-content-muted">{t("memory.assistant.receiveHint")}</p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{data.incoming.result}</pre>
        </section>}
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {(["capture", "checkpoint", "health"] as const).map(kind => <div key={kind} className="flex flex-col rounded-lg border border-edge p-3">
            <h3 className="text-sm font-medium">{label(kind)}</h3>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-content-muted">{t(`memory.assistant.hint.${kind}`)}</p>
            <Button className="mt-3 w-full" variant={kind === "capture" ? "primary" : "secondary"} disabled={busy || running}
              onClick={() => void perform({ op: "start", sessionId, kind })}>{t("memory.assistant.start")}</Button>
          </div>)}
        </div>
        <details className="mt-5 border-t border-edge pt-3">
          <summary className="cursor-pointer text-sm font-medium text-content-muted">{t("memory.assistant.records")} ({data.jobs.length})</summary>
          {!data.jobs.length && <p className="mt-2 text-sm text-content-subtle">{t("memory.assistant.empty")}</p>}
          {data.jobs.map(job => <section key={job.id} className="mt-3 rounded border border-edge p-3">
          <div className="flex justify-between gap-2"><span>{label(job.kind)}</span><span className="text-sm text-content-muted">{status(job)}</span></div>
          {job.error && <ErrorNote className="mt-2">{job.error}</ErrorNote>}
          {job.result && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-sm">{job.result}</pre>}
          {job.status === "running" && <><p className="mt-2 text-sm text-content-subtle">{t("memory.assistant.approvalHint")}</p><Button size="sm" variant="secondary" disabled={busy} onClick={() => void perform({ op: "cancel", sessionId, jobId: job.id })}>{t("memory.assistant.stop")}</Button></>}
          {job.kind === "checkpoint" && job.status === "ready" && <div className="mt-3 space-y-2">
            <label className="block text-sm">{t("memory.assistant.target")}
              <select className="mt-1 w-full rounded border border-edge bg-surface p-2" value={targetId} onChange={e => setTargetId(e.target.value)}>
                <option value="">{t("memory.assistant.newChat")}</option>
                {targets.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </label>
            <Button size="sm" disabled={busy} onClick={() => void perform({ op: "deliver", sessionId, jobId: job.id, ...(targetId ? { targetSessionId: targetId } : {}) })}>{t("memory.assistant.deliver")}</Button>
          </div>}
          {job.status === "queued" && <p className="mt-2 text-sm text-content-muted">{t("memory.assistant.queuedHint")}</p>}
          {(job.status === "ready" || job.status === "queued") && <Button size="sm" className="mt-2" variant="ghost" disabled={busy} onClick={() => void perform({ op: "discard", sessionId, jobId: job.id })}>{t("memory.assistant.discard")}</Button>}
          </section>)}
        </details>
        <MemoryInjectionPreview receipts={data.injections} />
      </Dialog.Popup></Dialog.Portal>
    </Dialog.Root>
  </>;
}
