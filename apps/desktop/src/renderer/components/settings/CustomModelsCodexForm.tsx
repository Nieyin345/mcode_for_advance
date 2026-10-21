/** T24: AST-extracted Codex provider form; keep the model state in the parent module. */
import { useState } from "react";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, HintLabel, Input, Spinner, Switch } from "@renderer/components/ui/index.js";
import { IconDownload, IconPlugConnected, IconTrash } from "@renderer/lib/icons.js";
import { type TestState, Field, SecretInput, HeadersEditor, EndpointActionRow, ModelListSection, ProviderFormShell, FormActions } from "./CustomModelsPanelParts.js";
import type { CodexFormState, CodexModelFormState } from "./CustomModelsPanel.js";

export function CodexProviderForm({
  form,
  setForm,
  saving,
  error,
  test,
  revealToken,
  isEdit,
  onTest,
  onPullModels,
  onSave,
  onCancel,
  onDelete,
}: {
  form: CodexFormState;
  setForm: (f: CodexFormState | null) => void;
  saving: boolean;
  error: string | null;
  test: TestState;
  revealToken: () => Promise<string | null>;
  isEdit: boolean;
  onTest: (idx: number) => void;
  onPullModels: () => void | Promise<void>;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    setPulling(true);
    try {
      await onPullModels();
    } finally {
      setPulling(false);
    }
  };
  const update = <K extends keyof CodexFormState>(key: K, value: CodexFormState[K]) =>
    setForm({ ...form, [key]: value });
  const updateModel = (idx: number, patch: Partial<CodexModelFormState>) =>
    setForm({ ...form, models: form.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  const addModel = () => setForm({ ...form, models: [...form.models, { id: "", context1m: false }] });
  const removeModel = (idx: number) => setForm({ ...form, models: form.models.filter((_, i) => i !== idx) });

  return (
    <ProviderFormShell
      engine="codex"
      name={
        <Field label={t("settings.customModels.providerNameLabel")}>
          <Input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="DeepSeek" />
        </Field>
      }
      identity={
        <Field label={t("settings.customModels.codexIdLabel")} hint={t("settings.customModels.codexIdHint")}>
          <Input
            value={form.id}
            onChange={(e) => update("id", e.target.value)}
            disabled={isEdit}
            placeholder="deepseek"
          />
        </Field>
      }
      baseUrl={
        <Field label={t("settings.customModels.baseUrlLabel")} hint={t("settings.customModels.codexResponsesNote")}>
          <Input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://api.deepseek.com/v1" />
        </Field>
      }
      credential={
        <Field label={t("settings.customModels.apiKeyLabel")} hint={t("settings.customModels.apiKeyHint")}>
          <SecretInput
            value={form.apiKey}
            onChange={(v) => update("apiKey", v)}
            placeholder={isEdit ? t("settings.customModels.apiKeyKeepPlaceholder") : "sk-..."}
            onReveal={revealToken}
          />
        </Field>
      }
      headers={
        <HeadersEditor rows={form.customHeaders} onChange={(rows) => update("customHeaders", rows)} />
      }
      pull={
        <EndpointActionRow
          icon={<IconDownload size={12} />}
          label={t("settings.customModels.pullModels")}
          hint={form.baseUrl.trim() ? t("settings.customModels.pullModelsHint") : t("settings.customModels.pullModelsNeedUrl")}
          disabled={pulling || !form.baseUrl.trim()}
          busy={pulling}
          onClick={() => void pull()}
        />
      }
      models={
        <ModelListSection
          count={form.models.filter((m) => m.id.trim()).length}
          onAdd={addModel}
          isEmpty={form.models.length === 0}
        >
          {form.models.map((m, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-1.5 rounded border border-edge bg-surface/40 p-2">
              <Input value={m.id} onChange={(e) => updateModel(idx, { id: e.target.value })} placeholder={t("settings.customModels.modelIdPlaceholder")} />
              <label className="flex items-center gap-1 justify-self-center" title={t("settings.customModels.enable1m")}>
                <Switch checked={m.context1m} onCheckedChange={(v) => updateModel(idx, { context1m: v })} label={t("settings.customModels.enable1m")} />
                <span className="text-[0.6428em] text-content-muted">1M</span>
              </label>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onTest(idx)}
                disabled={test.status === "testing"}
                title={t("settings.customModels.testWithModel")}
              >
                {test.status === "testing" && test.idx === idx
                  ? <Spinner size="xs" />
                  : <IconPlugConnected size={12} />}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => removeModel(idx)} title={t("settings.customModels.deleteModel")}>
                <IconTrash size={12} />
              </Button>
            </div>
          ))}
        </ModelListSection>
      }
      // Codex 特有：图片生成开关（往 config.toml 的 http_headers 补一条 actor 头，
      // 解锁 codex 的 imagegen 工具）。默认折叠 —— 它是可选的解锁项，不是必填。
      advanced={
        <div className="flex items-start justify-between gap-3 rounded border border-edge bg-surface/40 p-2.5">
          <HintLabel hint={t("settings.customModels.imageGenHint")} className="text-[0.7857em] font-medium text-content">
            {t("settings.customModels.imageGen")}
          </HintLabel>
          <Switch
            checked={form.imageGeneration}
            onCheckedChange={(v) => update("imageGeneration", v)}
            label={t("settings.customModels.imageGen")}
          />
        </div>
      }
      error={error}
      actions={
        <FormActions
          testStatus={test}
          onDelete={onDelete}
          onCancel={onCancel}
          onSave={onSave}
          saving={saving}
          isEdit={isEdit}
        />
      }
    />
  );
}
