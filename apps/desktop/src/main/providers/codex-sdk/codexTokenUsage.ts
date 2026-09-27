/**
 * Codex usage → provider-neutral ContextSnapshot.
 *
 * The app-server's ThreadTokenUsage carries camelCase TokenUsageBreakdown
 * (`{inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens,
 * totalTokens}`) plus `modelContextWindow` — the model's real context window
 * when known (falls back to a model-family heuristic here).
 */
import type { ContextSnapshot } from "@contracts/runtime";

/** Raw usage counters as reported by app-server (TokenUsageBreakdown). */
export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens?: number;
}

/** Build the display-ready snapshot, or undefined when nothing has been
 *  reported yet (skip-emit semantics mirror the Pi adapter).
 *
 *  - `usage` = the final request (`last`) → occupancy (`usedTokens`/`pct`).
 *  - `turnUsage` = what the whole turn processed across all its requests
 *    (thread `total` delta). ContextSnapshot is per-turn cumulative — the
 *    budget guard and usage stats read `totalProcessedTokens` as such — so a
 *    multi-request turn must not report only its last request. Falls back to
 *    `usage` when the server never sent `total`.
 *
 *  ⚠️ Codex/OpenAI `inputTokens` already INCLUDES `cachedInputTokens`
 *  (upstream `non_cached_input = input - cached`, `total = input + output`).
 *  Adding the cached count on top double-counted every cache hit. */
export function buildCodexTokenSnapshot(
  usage: CodexUsage | null,
  modelContextWindow?: number,
  turnUsage?: CodexUsage | null,
): ContextSnapshot | undefined {
  if (!usage) return undefined;
  const inputTokens = Math.max(0, usage.inputTokens ?? 0);
  const acc = turnUsage ?? usage;
  const turnInput = Math.max(0, acc.inputTokens ?? 0);
  const outputTokens = Math.max(0, acc.outputTokens ?? 0);
  const cacheRead = Math.min(turnInput, Math.max(0, acc.cachedInputTokens ?? 0));
  // Codex counts reasoning output inside output_tokens; occupancy = the
  // final request's input (what the model had in context).
  const totalProcessed = turnInput + outputTokens;
  if (totalProcessed === 0) return undefined;

  const maxTokens = modelContextWindow && modelContextWindow > 0 ? modelContextWindow : 272_000;
  const usedTokens = Math.min(inputTokens, maxTokens);
  const pct = Math.min(100, Math.max(0, Math.round((usedTokens / maxTokens) * 100)));
  const warnings: ContextSnapshot["warnings"] = [];
  let warning: ContextSnapshot["warning"] = "ok";
  if (pct >= 90) {
    warning = "critical";
    warnings.push("near-window");
  } else if (pct >= 70) {
    warning = "near-window";
    warnings.push("near-window");
  }

  return {
    usedTokens,
    totalProcessedTokens: totalProcessed,
    maxTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    pct,
    warning,
    warnings,
  };
}
