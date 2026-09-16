/**
 * 用量统计(设置面板):按天 / 按模型聚合的只读查询。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";

/* ── Usage stats (settings panel) ──
 *  Aggregates the per-turn usage history persisted on each session row
 *  (`sessions.usage_history`, one TurnUsageRecord per completed turn) into
 *  daily / per-model / summary views. Read-only. */

/** Time ranges offered by the usage panel. `today` starts at local midnight;
 *  `7d` / `30d` span N-1 midnights back from today (today inclusive);
 *  `all` covers everything. */
export const USAGE_STATS_PRESETS = ["today", "7d", "30d", "all"] as const;
export type UsageStatsPreset = (typeof USAGE_STATS_PRESETS)[number];

export const UsageStatsSchema = z.object({
  preset: z.enum(USAGE_STATS_PRESETS),
});
export type UsageStatsInput = z.infer<typeof UsageStatsSchema>;

/** Per-day aggregate. `date` is the LOCAL calendar day as YYYY-MM-DD —
 *  "today" must mean the user's today, not UTC's. */
export interface UsageDayStat {
  date: string;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Per-model aggregate over the selected range, keyed by (vendor, model):
 *  the same model name from different vendors (e.g. "deepseek-v4-flash" via
 *  the official API vs a gateway) must not be lumped together.
 *  `model: null` groups turns whose record carried no model id. */
export interface UsageModelStat {
  /** Vendor/endpoint label the turns ran under: "Anthropic" for the built-in
   *  Claude path, the custom-model config's user-chosen name for a gateway
   *  endpoint, "Pi" for Pi-agent sessions. null = unknown (e.g. the binding
   *  config was deleted). */
  vendor: string | null;
  model: string | null;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** Range totals over the selected range. */
export interface UsageSummaryStat {
  turns: number;
  /** Distinct sessions that contributed at least one turn in the range. */
  sessions: number;
  totalTokens: number;
  /** Tokens attributed to Task-tool subagents (main-loop tokens excluded —
   *  see TurnUsageRecord.subagentTokens). Not attributed per model. */
  subagentTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** `usage.stats` response. `summary` / `models` aggregate the selected range;
 *  `daily` always covers the last 183 days (26 weeks, today inclusive) so the
 *  heatmap can render a fixed half-year grid regardless of the preset. */
export interface UsageStatsResult {
  summary: UsageSummaryStat;
  models: UsageModelStat[];
  daily: UsageDayStat[];
}

