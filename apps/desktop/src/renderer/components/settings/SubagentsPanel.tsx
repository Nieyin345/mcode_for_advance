import { useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { CLAUDE_SUBAGENTS_SETTING_KEY } from "@contracts/ipc";
import type { SubagentDefinition } from "@contracts/claudeSubagent.js";
import { PanelHeader } from "./PanelHeader.js";
import { SettingsSection } from "./SettingsSection.js";
import { IconPlus, IconTrash, IconRobot } from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";

/** Editor-row shape: tools kept as free text (comma-separated) while editing;
 *  split/normalized only at save time — matching how the user thinks about
 *  the list, not how it's stored. */
interface Row {
  name: string;
  description: string;
  prompt: string;
  toolsText: string;
  model: string;
}

const toRow = (d: SubagentDefinition): Row => ({
  name: d.name,
  description: d.description,
  prompt: d.prompt,
  toolsText: (d.tools ?? []).join(", "),
  model: d.model ?? "",
});

const toDef = (r: Row): SubagentDefinition => {
  const tools = r.toolsText.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    name: r.name.trim(),
    description: r.description.trim(),
    prompt: r.prompt,
    ...(tools.length > 0 ? { tools } : {}),
    ...(r.model.trim() ? { model: r.model.trim() } : {}),
  };
};

/**
 * Settings → 子代理: custom subagent definitions for the Claude provider
 * (gated on capabilities.supportsCustomSubagents). Definitions ride the
 * settings table (`claude.subagents`) and are read fresh at every
 * claude-sdk startTurn, so a save applies from the next turn on — no restart.
 *
 * Whole-list save (add/edit/delete happen locally, one 保存 button) — the
 * RPC returns the normalized list and the editor snaps to it, so what's on
 * screen is always what actually landed.
 */
export function SubagentsPanel() {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null); // null = still loading
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { value } = await api.setting.get({ key: CLAUDE_SUBAGENTS_SETTING_KEY });
        if (!alive) return;
        const parsed: unknown = value ? JSON.parse(value) : [];
        setRows(Array.isArray(parsed) ? (parsed as SubagentDefinition[]).map(toRow) : []);
      } catch {
        if (alive) setRows([]); // unreadable store = empty editor, not a dead panel
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (rows === null) return null;

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const { subagents } = await api.claude.saveSubagents({ subagents: rows.map(toDef) });
      setRows(subagents.map(toRow)); // snap to the normalized/validated list
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PanelHeader title={t("settings.subagents.title")} icon={IconRobot} />
      <SettingsSection title={t("settings.subagents.sectionTitle")} desc={t("settings.subagents.sectionDesc")}>
        <div className="space-y-3">
          {rows.length === 0 && (
            <p className="text-[0.8571em] text-content-subtle">{t("settings.subagents.empty")}</p>
          )}
          {rows.map((r, i) => (
            <div key={i} className="rounded border border-edge bg-surface p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[0.8571em] font-medium text-content">
                  <IconRobot size={14} className="text-content-muted" />
                  {r.name.trim() || t("settings.subagents.unnamed")}
                </span>
                <button
                  onClick={() => setRows((rs) => rs!.filter((_, j) => j !== i))}
                  className="rounded p-1 text-content-subtle transition-colors hover:bg-surface-hover hover:text-danger"
                  title={t("settings.subagents.delete")}
                >
                  <IconTrash size={14} />
                </button>
              </div>
              <div className="grid grid-cols-[1fr_1fr] gap-2">
                <label className="block">
                  <span className="mb-1 block text-[0.7857em] text-content-muted">{t("settings.subagents.name")}</span>
                  <Input
                    value={r.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder={t("settings.subagents.namePh")}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[0.7857em] text-content-muted">{t("settings.subagents.model")}</span>
                  <Input
                    value={r.model}
                    onChange={(e) => update(i, { model: e.target.value })}
                    placeholder={t("settings.subagents.modelPh")}
                  />
                </label>
              </div>
              <label className="mt-2 block">
                <span className="mb-1 block text-[0.7857em] text-content-muted">{t("settings.subagents.description")}</span>
                <Input
                  value={r.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                  placeholder={t("settings.subagents.descriptionPh")}
                />
              </label>
              <label className="mt-2 block">
                <span className="mb-1 block text-[0.7857em] text-content-muted">{t("settings.subagents.prompt")}</span>
                <textarea
                  value={r.prompt}
                  onChange={(e) => update(i, { prompt: e.target.value })}
                  placeholder={t("settings.subagents.promptPh")}
                  rows={4}
                  className="w-full resize-y rounded border border-edge bg-surface px-2.5 py-1.5 font-mono text-xs text-content placeholder:text-content-subtle outline-none transition-colors focus:border-accent"
                />
              </label>
              <label className="mt-2 block">
                <span className="mb-1 block text-[0.7857em] text-content-muted">{t("settings.subagents.tools")}</span>
                <Input
                  value={r.toolsText}
                  onChange={(e) => update(i, { toolsText: e.target.value })}
                  placeholder={t("settings.subagents.toolsPh")}
                />
              </label>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => setRows((rs) => [...rs!, { name: "", description: "", prompt: "", toolsText: "", model: "" }])}>
              <IconPlus size={14} />
              {t("settings.subagents.add")}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? t("settings.subagents.saving") : t("settings.subagents.save")}
            </Button>
            {justSaved && !error && (
              <span className="text-[0.8571em] text-success">{t("settings.subagents.saved")}</span>
            )}
            {error && (
              <span className={cn("text-[0.8571em] text-danger")}>{error}</span>
            )}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
