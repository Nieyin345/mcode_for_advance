/** T59: load the selected *saved* library document before showing Node-RED.
 * A mere tab switch could otherwise display an empty or previous canvas. */
import { useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";

export function WorkflowNativeEditorEntry({
  workflowId, dirty, onOpen,
}: { workflowId: string; dirty: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const load = async (confirmReplace: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setReason(null);
    setNeedsConfirm(false);
    try {
      const result = await api.workflowEngine.load({ workflowId, confirmReplace });
      if (result.ok) {
        // Also refresh an editor hosted in the right-hand flow dock.
        window.dispatchEvent(new Event("mcode:native-canvas-loaded"));
        onOpen();
      }
      else {
        setReason(result.reason);
        setNeedsConfirm(result.requiresConfirmation === true);
      }
    } catch (err) {
      setReason(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-md border border-edge bg-surface-muted/50 px-6 text-center" aria-label={t("settings.workflows.openNativeEditor")}>
      <h3 className="text-[0.9286em] font-medium text-content">{t("settings.workflows.nativeEditorTitle")}</h3>
      <p className="max-w-lg text-[0.7857em] leading-relaxed text-content-muted">{t("settings.workflows.nativeEditorNote")}</p>
      {dirty && <p role="alert" className="text-xs text-content-muted">请先保存工作流库中的未保存草稿，再装载到 Node-RED。</p>}
      {reason && <p role="alert" className="max-w-xl whitespace-pre-wrap break-words text-xs text-content">{reason}</p>}
      {needsConfirm
        ? <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setNeedsConfirm(false); setReason(null); }}>取消</Button>
            <Button variant="primary" size="sm" disabled={busy || dirty} onClick={() => void load(true)}>确认替换当前画布</Button>
          </div>
        : <Button variant="primary" size="sm" disabled={busy || dirty} onClick={() => void load(false)}>{busy ? t("common.loading") : t("settings.workflows.openNativeEditor")}</Button>}
    </section>
  );
}
