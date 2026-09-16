import { useEffect, useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { api } from "@renderer/lib/api.js";
import { Input, Switch } from "@renderer/components/ui/index.js";
import {
  TURN_BUDGET_SETTING_KEY,
  RUNTIME_FALLBACK_MODELS_SETTING_KEY,
} from "@contracts/ipc";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";

/**
 * Runtime turn-policy panels — the preference UI for the S3 per-turn budget
 * caps and the S4 failure fallback chain (both enforced host-side by
 * RuntimeManager, read fresh at every sendTurn).
 *
 * Both panels self-persist: any edit is debounced (~500 ms) into a
 * `setting.set` write of the same JSON shape the host parsers accept.
 * Malformed input simply drops that field (the host treats absent/invalid
 * fields as "no cap"), so no explicit save button or error state is needed.
 */

/** Debounce window for persisting edits, ms. */
const PERSIST_DEBOUNCE_MS = 500;

/* ─────────────────────────── 回合预算 ─────────────────────────── */

/** Editable string form of the three numeric caps ("" = unset). */
interface BudgetForm {
  maxTurns: string;
  maxUsd: string;
  maxTotalTokens: string;
}

/** Parse a form field into a positive finite number, or undefined. */
function positiveOrNull(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function TurnBudgetPanel() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState<BudgetForm>({ maxTurns: "", maxUsd: "", maxTotalTokens: "" });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { value } = await api.setting.get({ key: TURN_BUDGET_SETTING_KEY });
        if (!alive) return;
        const parsed = value ? (JSON.parse(value) as Record<string, unknown>) : null;
        const num = (k: string) =>
          typeof parsed?.[k] === "number" && Number.isFinite(parsed[k]) ? String(parsed[k]) : "";
        setEnabled(parsed?.enabled === true);
        setForm({
          maxTurns: num("maxTurns"),
          maxUsd: num("maxUsd"),
          maxTotalTokens: num("maxTotalTokens"),
        });
      } catch {
        // unreadable store = caps off, not a dead panel
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Debounced persist — the shape mirrors the host's parseTurnBudget: caps
  // absent or invalid are simply omitted (parsed as "no cap" host-side).
  useEffect(() => {
    if (!loaded || !dirty) return;
    const id = setTimeout(() => {
      const payload: Record<string, unknown> = { enabled };
      const maxTurns = positiveOrNull(form.maxTurns);
      const maxUsd = positiveOrNull(form.maxUsd);
      const maxTotalTokens = positiveOrNull(form.maxTotalTokens);
      if (maxTurns !== undefined) payload.maxTurns = maxTurns;
      if (maxUsd !== undefined) payload.maxUsd = maxUsd;
      if (maxTotalTokens !== undefined) payload.maxTotalTokens = maxTotalTokens;
      void api.setting.set({ key: TURN_BUDGET_SETTING_KEY, value: JSON.stringify(payload) });
      setDirty(false);
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [loaded, dirty, enabled, form]);

  if (!loaded) return null;

  const markDirty = (patch: Partial<BudgetForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };

  return (
    <SettingsSection title={t("settings.turnBudget.sectionTitle")} desc={t("settings.turnBudget.sectionDesc")}>
      <SettingRow title={t("settings.turnBudget.enabled")} desc={t("settings.turnBudget.enabledDesc")}>
        <Switch
          id="setting-turnbudget-enabled"
          checked={enabled}
          onCheckedChange={(v) => {
            setEnabled(v);
            setDirty(true);
          }}
          label={enabled ? t("settings.on") : t("settings.off")}
        />
      </SettingRow>
      <SettingRow
        title={t("settings.turnBudget.maxTurns")}
        desc={t("settings.turnBudget.maxTurnsDesc")}
        htmlFor="setting-turnbudget-turns"
      >
        <Input
          id="setting-turnbudget-turns"
          type="number"
          min={1}
          step={1}
          disabled={!enabled}
          placeholder={t("settings.turnBudget.unset")}
          value={form.maxTurns}
          onChange={(e) => markDirty({ maxTurns: e.target.value })}
          className="w-full disabled:opacity-50"
        />
      </SettingRow>
      <SettingRow
        title={t("settings.turnBudget.maxUsd")}
        desc={t("settings.turnBudget.maxUsdDesc")}
        htmlFor="setting-turnbudget-usd"
      >
        <Input
          id="setting-turnbudget-usd"
          type="number"
          min={0}
          step="0.01"
          disabled={!enabled}
          placeholder={t("settings.turnBudget.unset")}
          value={form.maxUsd}
          onChange={(e) => markDirty({ maxUsd: e.target.value })}
          className="w-full disabled:opacity-50"
        />
      </SettingRow>
      <SettingRow
        title={t("settings.turnBudget.maxTokens")}
        desc={t("settings.turnBudget.maxTokensDesc")}
        htmlFor="setting-turnbudget-tokens"
      >
        <Input
          id="setting-turnbudget-tokens"
          type="number"
          min={1}
          step={1000}
          disabled={!enabled}
          placeholder={t("settings.turnBudget.unset")}
          value={form.maxTotalTokens}
          onChange={(e) => markDirty({ maxTotalTokens: e.target.value })}
          className="w-full disabled:opacity-50"
        />
      </SettingRow>
    </SettingsSection>
  );
}

/* ─────────────────────────── 失败自动回退 ─────────────────────────── */

export function FallbackModelsPanel() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState(false);
  const [modelsText, setModelsText] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { value } = await api.setting.get({ key: RUNTIME_FALLBACK_MODELS_SETTING_KEY });
        if (!alive) return;
        const parsed: unknown = value ? JSON.parse(value) : [];
        setModelsText(
          Array.isArray(parsed)
            ? parsed
                .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
                .join(", ")
            : "",
        );
      } catch {
        // unreadable store = empty chain, not a dead panel
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Debounced persist — comma/free-whitespace separated input, stored as the
  // JSON string array the host's parseFallbackModels accepts. Empty text = no
  // fallback (stored as "[]").
  useEffect(() => {
    if (!loaded || !dirty) return;
    const id = setTimeout(() => {
      const chain = modelsText
        .split(/[,\s]+/)
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      void api.setting.set({
        key: RUNTIME_FALLBACK_MODELS_SETTING_KEY,
        value: JSON.stringify(chain),
      });
      setDirty(false);
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [loaded, dirty, modelsText]);

  if (!loaded) return null;

  return (
    <SettingsSection title={t("settings.fallback.sectionTitle")} desc={t("settings.fallback.sectionDesc")}>
      <SettingRow
        title={t("settings.fallback.chain")}
        desc={t("settings.fallback.chainDesc")}
        htmlFor="setting-fallback-chain"
      >
        <Input
          id="setting-fallback-chain"
          type="text"
          placeholder={t("settings.fallback.chainPh")}
          value={modelsText}
          onChange={(e) => {
            setModelsText(e.target.value);
            setDirty(true);
          }}
          className="w-full"
        />
      </SettingRow>
    </SettingsSection>
  );
}
