import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ErrorNote, LoadingNote, Input, Switch } from "@renderer/components/ui/index.js";
import {
  TURN_BUDGET_SETTING_KEY,
  RUNTIME_FALLBACK_MODELS_SETTING_KEY,
} from "@contracts/ipc";
import { SettingRow } from "./SettingRow.js";
import { SettingsSection } from "./SettingsSection.js";
import { createPolicyDraft, usePolicyDraft } from "./runtimePolicyDraft.js";

/** Important execution limits use explicit Apply, not lossy debounce.
 * Unsaved forms and in-flight writes survive settings navigation. */

/* ─────────────────────────── 回合预算 ─────────────────────────── */

/** Editable string form of the three numeric caps ("" = unset). */
interface BudgetForm {
  maxTurns: string;
  maxUsd: string;
  maxTotalTokens: string;
}

type BudgetDraft = { enabled: boolean; form: BudgetForm };
const budgetDraft = createPolicyDraft<BudgetDraft>();
const fallbackDraft = createPolicyDraft<string>();

function decodeBudget(value: string | null): BudgetDraft {
  const parsed: unknown = value ? JSON.parse(value) : {};
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid turn budget configuration");
  const data = parsed as Record<string, unknown>;
  const num = (key: string) => typeof data[key] === "number" ? String(data[key]) : "";
  return { enabled: data.enabled === true, form: { maxTurns: num("maxTurns"), maxUsd: num("maxUsd"), maxTotalTokens: num("maxTotalTokens") } };
}
function decodeFallback(value: string | null): string {
  const parsed: unknown = value ? JSON.parse(value) : [];
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) throw new Error("Invalid fallback model configuration");
  return parsed.join(", ");
}
/** Empty is an explicit opt-out. Invalid and in-progress text is never an opt-out. */
function validLimit(raw: string, integer: boolean): boolean {
  if (raw.trim() === "") return true;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && (!integer || Number.isSafeInteger(n));
}

export function TurnBudgetPanel() {
  const { t } = useI18n();
  const { state, read } = usePolicyDraft(TURN_BUDGET_SETTING_KEY, budgetDraft, decodeBudget);
  if (state.value === null) return read.error
    ? <ErrorNote action={<Button onClick={() => void read.refetch()}>{t("common.retry")}</Button>}>{read.error.message}</ErrorNote>
    : <LoadingNote label={t("common.loading")} />;
  const { enabled, form } = state.value;
  const valid = validLimit(form.maxTurns, true) && validLimit(form.maxUsd, false) && validLimit(form.maxTotalTokens, true);
  const markDirty = (patch: Partial<BudgetForm>) => budgetDraft.edit({ enabled, form: { ...form, ...patch } });
  const save = async () => {
    if (!valid || read.error) return;
    const payload: Record<string, number | boolean> = { enabled };
    for (const key of ["maxTurns", "maxUsd", "maxTotalTokens"] as const) {
      if (form[key].trim() !== "") payload[key] = Number(form[key]);
    }
    await budgetDraft.save(TURN_BUDGET_SETTING_KEY, JSON.stringify(payload));
  };

  return (
    <SettingsSection title={t("settings.turnBudget.sectionTitle")} desc={t("settings.turnBudget.sectionDesc")}>
      <SettingRow title={t("settings.turnBudget.enabled")} desc={t("settings.turnBudget.enabledDesc")}>
        <Switch
          id="setting-turnbudget-enabled"
          checked={enabled}
          onCheckedChange={(v) => {
            budgetDraft.edit({ enabled: v, form });
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
          type="text"
          inputMode="decimal"
          disabled={!enabled}
          placeholder={t("settings.turnBudget.unset")}
          aria-invalid={!validLimit(form.maxTurns, true)}
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
          type="text"
          inputMode="decimal"
          disabled={!enabled}
          placeholder={t("settings.turnBudget.unset")}
          aria-invalid={!validLimit(form.maxUsd, false)}
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
          type="text"
          inputMode="decimal"
          disabled={!enabled}
          placeholder={t("settings.turnBudget.unset")}
          aria-invalid={!validLimit(form.maxTotalTokens, true)}
          value={form.maxTotalTokens}
          onChange={(e) => markDirty({ maxTotalTokens: e.target.value })}
          className="w-full disabled:opacity-50"
        />
      </SettingRow>
      <div className="space-y-2 px-4 py-3">
        {!valid && <ErrorNote>{t("settings.runtimePolicy.invalidLimit")}</ErrorNote>}
        {(state.error || read.error) && <ErrorNote action={<Button onClick={() => { if (read.error) void read.refetch(); else void save(); }}>{t("common.retry")}</Button>}>{state.error ?? read.error?.message}</ErrorNote>}
        <div className="flex items-center gap-2">
          <Button data-testid="budget-save" variant="primary" disabled={!state.dirty || state.saving || !valid || !!read.error} onClick={() => void save()}>{t("common.save")}</Button>
          <Button disabled={!state.dirty || state.saving} onClick={() => budgetDraft.discard()}>{t("common.discardChanges")}</Button>
          <span role="status" className="text-xs text-content-muted">{t(state.saving ? "common.saving" : state.dirty ? "common.unsavedRetained" : "common.saved")}</span>
        </div>
      </div>
    </SettingsSection>
  );
}

/* ─────────────────────────── 失败自动回退 ─────────────────────────── */

export function FallbackModelsPanel() {
  const { t } = useI18n();
  const { state, read } = usePolicyDraft(RUNTIME_FALLBACK_MODELS_SETTING_KEY, fallbackDraft, decodeFallback);
  if (state.value === null) return read.error
    ? <ErrorNote action={<Button onClick={() => void read.refetch()}>{t("common.retry")}</Button>}>{read.error.message}</ErrorNote>
    : <LoadingNote label={t("common.loading")} />;
  const modelsText = state.value;
  const save = async () => {
    if (read.error) return;
    const chain = modelsText.split(/[,\s]+/).map((m) => m.trim()).filter(Boolean);
    await fallbackDraft.save(RUNTIME_FALLBACK_MODELS_SETTING_KEY, JSON.stringify(chain));
  };

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
            fallbackDraft.edit(e.target.value);
          }}
          className="w-full"
        />
      </SettingRow>
      <div className="space-y-2 px-4 py-3">
        {(state.error || read.error) && <ErrorNote action={<Button onClick={() => { if (read.error) void read.refetch(); else void save(); }}>{t("common.retry")}</Button>}>{state.error ?? read.error?.message}</ErrorNote>}
        <div className="flex items-center gap-2">
          <Button data-testid="fallback-save" variant="primary" disabled={!state.dirty || state.saving || !!read.error} onClick={() => void save()}>{t("common.save")}</Button>
          <Button disabled={!state.dirty || state.saving} onClick={() => fallbackDraft.discard()}>{t("common.discardChanges")}</Button>
          <span role="status" className="text-xs text-content-muted">{t(state.saving ? "common.saving" : state.dirty ? "common.unsavedRetained" : "common.saved")}</span>
        </div>
      </div>
    </SettingsSection>
  );
}
