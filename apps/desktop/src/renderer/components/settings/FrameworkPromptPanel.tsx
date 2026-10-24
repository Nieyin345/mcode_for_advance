import { useCallback, useEffect, useState } from "react";
import type { FrameworkSectionEntry } from "@contracts/ipc";
import { Button } from "@renderer/components/ui/button.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { ErrorNote, LoadingNote } from "@renderer/components/ui/index.js";
import { SettingsSection } from "./SettingsSection.js";

/**
 * T64 — only framework wording is editable. Runtime graph facts, output
 * variables, memory snapshot and permission/tool protocols remain host-owned.
 * Saving changes the next workflow run, never the active run's frozen snapshot.
 */
export function FrameworkPromptPanel() {
  const { t } = useI18n();
  const [sections, setSections] = useState<FrameworkSectionEntry[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(() => {
    api.framework.list({}).then((res) => setSections(res.sections)).catch((err: unknown) => {
      setError(String(err));
    });
  }, []);

  useEffect(refresh, [refresh]);

  const persist = async (id: "flow" | "output", reset: boolean) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = reset
        ? await api.framework.reset({ id })
        : await api.framework.save({ id, content: draft });
      setSections(result.sections);
      setEditing(null);
      setNotice(t("settings.framework.nextRun"));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t("settings.framework.title")}
      desc={t("settings.framework.desc")}
    >
      <div className="space-y-3 p-4">
        {sections === null && !error ? <LoadingNote label={t("common.loading")} /> : null}
        {sections?.map((section) => {
          const isEditing = editing === section.id;
          return (
            <div
              key={section.id}
              className={`rounded-md border border-border p-3 ${!section.editable ? "opacity-55" : ""}`}
              aria-disabled={!section.editable ? "true" : undefined}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-body font-medium">{section.title}</div>
                  <div className="text-code text-content-subtle">
                    {section.editable
                      ? (section.customized
                          ? t("settings.framework.customized")
                          : t("settings.framework.default"))
                      : t("settings.framework.locked")}
                  </div>
                </div>
                {section.editable && (section.id === "flow" || section.id === "output") ? (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditing(isEditing ? null : section.id);
                        setDraft(section.content);
                        setNotice("");
                      }}
                    >
                      {t(isEditing ? "settings.framework.cancel" : "settings.framework.edit")}
                    </Button>
                    <Button
                      type="button"
                      disabled={busy || !section.customized}
                      onClick={() => void persist(section.id as "flow" | "output", true)}
                    >
                      {t("settings.framework.reset")}
                    </Button>
                  </div>
                ) : (
                  <span className="text-code text-content-subtle" aria-label={t("settings.framework.locked")}>
                    {t("settings.framework.locked")}
                  </span>
                )}
              </div>
              <p className="mt-2 text-code text-content-subtle">{section.description}</p>
              {isEditing && section.editable ? (
                <div className="mt-3 space-y-2">
                  <textarea
                    aria-label={section.title}
                    className="min-h-32 w-full rounded-md border border-border bg-surface p-2 text-body text-content"
                    value={draft}
                    maxLength={200000}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                  />
                  <p className="text-code text-content-subtle">{t("settings.framework.emptyHint")}</p>
                  <Button type="button" disabled={busy} onClick={() => void persist(section.id as "flow" | "output", false)}>
                    {t("settings.framework.save")}
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
        {notice ? <p role="status" className="text-code text-content-subtle">{notice}</p> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </SettingsSection>
  );
}
