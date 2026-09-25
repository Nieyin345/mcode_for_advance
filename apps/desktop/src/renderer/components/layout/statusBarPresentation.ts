import type { MessageId } from "@renderer/lib/i18n/core.js";

const CLAUDE_MODEL_LABELS: Record<string, string> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
};

interface StatusBarInput {
  providerId: string;
  providerName?: string;
  claudeInstalled: boolean | null;
  model: string;
  customModelName?: string;
  t: (key: MessageId) => string;
}

/** The only health probe in the store is for Claude. Never present its result
 *  as a Pi, Codex or browser-provider installation check. */
export function describeStatusBar({
  providerId, providerName, claudeInstalled, model, customModelName, t,
}: StatusBarInput) {
  const isClaude = providerId === "claude-sdk";
  const statusMissing = isClaude && claudeInstalled === false;
  const statusText = isClaude
    ? claudeInstalled === false ? t("layout.status.claudeMissing")
      : claudeInstalled === true ? t("layout.status.claudeReady")
        : t("layout.status.checkingClaude")
    : providerName ?? providerId;
  const statusColor = !isClaude ? "text-content-subtle"
    : statusMissing ? "text-danger"
      : claudeInstalled === true ? "text-accent" : "text-content-subtle";
  const baseModelLabel = isClaude
    ? model === "default" ? t("layout.status.auto") : CLAUDE_MODEL_LABELS[model] ?? model
    : model === "default" ? t("layout.status.selectModel") : model;
  const modelLabel = isClaude && customModelName
    ? `${customModelName} · ${baseModelLabel}` : baseModelLabel;
  return { statusText, statusColor, statusMissing, modelLabel };
}
