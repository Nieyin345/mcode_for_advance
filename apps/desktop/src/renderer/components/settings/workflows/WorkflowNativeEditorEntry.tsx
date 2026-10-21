/** T45: workflow-library entry into the already hosted native Node-RED editor.
 * This is an entry/control, not a second renderer for workflow nodes and edges. */
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button } from "@renderer/components/ui/index.js";

export function WorkflowNativeEditorEntry({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-md border border-edge bg-surface-muted/50 px-6 text-center" aria-label={t("settings.workflows.openNativeEditor")}>
      <h3 className="text-[0.9286em] font-medium text-content">{t("settings.workflows.nativeEditorTitle")}</h3>
      <p className="max-w-lg text-[0.7857em] leading-relaxed text-content-muted">{t("settings.workflows.nativeEditorNote")}</p>
      <Button variant="primary" size="sm" onClick={onOpen}>{t("settings.workflows.openNativeEditor")}</Button>
    </section>
  );
}
