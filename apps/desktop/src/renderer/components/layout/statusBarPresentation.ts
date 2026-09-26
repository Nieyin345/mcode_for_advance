import type { MessageId } from "@renderer/lib/i18n/core.js";
import type { ProviderHealthStatusCode } from "@contracts/ipc";

const CLAUDE_MODEL_LABELS: Record<string, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
};

interface StatusBarInput {
  providerId: string;
  providerName?: string;
  health?: {
    loading: boolean; ok: boolean | null; code?: ProviderHealthStatusCode;
    version?: string; error?: string;
  };
  model: string;
  customModelName?: string;
  t: (key: MessageId) => string;
}

/** Present only the active provider's own probe result. */
export function describeStatusBar({
  providerId, providerName, health, model, customModelName, t,
}: StatusBarInput) {
  const isClaude = providerId === "claude-sdk";
  const name = providerName ?? providerId;
  const checking = !health || health.loading || health.ok === null;
  const statusMissing = !checking && health.ok === false;
  const failedLabel = health?.code === "timeout" ? t("layout.status.healthTimeout")
    : health?.code === "not_registered" ? t("layout.status.providerNotRegistered")
      : health?.code === "unsupported" ? t("layout.status.healthUnsupported")
        : t("layout.status.providerUnavailable");
  const suffix = checking ? t("layout.status.checkingProvider")
    : statusMissing ? failedLabel
      : health.version ? `${t("layout.status.ready")} · ${health.version}`
        : t("layout.status.ready");
  const statusText = `${name} · ${suffix}`;
  const statusTitle = statusMissing ? health.error : undefined;
  const statusColor = statusMissing ? "text-danger"
    : health?.ok === true ? "text-accent" : "text-content-subtle";
  const baseModelLabel = isClaude
    ? model === "default" ? t("layout.status.auto") : CLAUDE_MODEL_LABELS[model] ?? model
    : model === "default" ? t("layout.status.selectModel") : model;
  const modelLabel = isClaude && customModelName
    ? `${customModelName} · ${baseModelLabel}` : baseModelLabel;
  return { statusText, statusColor, statusMissing, statusTitle, modelLabel };
}
