import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MemoryInjectionReceipt } from "@contracts/memory";

export function MemoryInjectionPreview({ receipts }: { receipts?: MemoryInjectionReceipt[] }) {
  const { t } = useI18n();
  const list = receipts ?? [];
  return (
    <details className="mt-5 border-t border-edge pt-3">
      <summary className="cursor-pointer text-sm font-medium text-content-muted">
        {t("memory.assistant.injections")} ({list.length})
      </summary>
      {list.length === 0 ? (
        <p className="mt-2 text-sm text-content-subtle">
          {t("memory.assistant.injectionsEmpty")}
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {list.map((r) => {
            const phaseLabel =
              r.phase === "submitted"
                ? t("memory.assistant.injectionsPhase.submitted")
                : r.phase === "start-failed"
                  ? t("memory.assistant.injectionsPhase.startFailed")
                  : t("memory.assistant.injectionsPhase.preparing");
            const displayName = r.nodeTitle || r.title || r.nodeId || r.sessionId;
            return (
              <details
                key={r.id}
                data-memory-receipt={r.id}
                className="rounded border border-edge bg-surface-subtle/30 p-2 text-xs"
              >
                <summary className="cursor-pointer font-medium text-content hover:text-accent">
                  <span>{displayName}</span>
                  <span className="ml-2 font-normal text-content-muted">
                    ({r.kind === "node" ? `node: ${r.nodeId ?? ""} · ` : ""}
                    {phaseLabel} · turn {r.turnNumber})
                  </span>
                </summary>
                <div className="mt-2 space-y-2 border-t border-edge/60 pt-2">
                  {r.sections.map((s, idx) => (
                    <div key={idx} className="space-y-1">
                      {s.state === "off" ? (
                        <p className="text-content-muted">
                          {r.nodeId ? `[${r.nodeId}] ` : ""}
                          {t("memory.assistant.injectionsState.off")}
                        </p>
                      ) : s.state === "empty" ? (
                        <p className="text-content-muted">
                          {t("memory.assistant.injectionsState.empty")}
                        </p>
                      ) : s.state === "error" ? (
                        <p className="text-danger">
                          {s.error || t("common.error")}
                        </p>
                      ) : s.state === "included" ? (
                        <div>
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-content">
                            {s.text}
                          </pre>
                          {s.previewTruncated && (
                            <span className="text-[10px] text-content-subtle">
                              {t("memory.assistant.injectionsTruncated")}
                            </span>
                          )}
                        </div>
                      ) : (
                        <p className="text-content-muted">
                          {/* Explicit map: the contract value is kebab-case ("not-automatic")
                              while the dictionary key is camelCase — a template-literal
                              key rendered the raw id, since translate() falls back to the key. */}
                          {s.state === "not-automatic"
                            ? t("memory.assistant.injectionsState.notAutomatic")
                            : s.state === "unavailable"
                              ? t("memory.assistant.injectionsState.unavailable")
                              : s.state}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </details>
  );
}
