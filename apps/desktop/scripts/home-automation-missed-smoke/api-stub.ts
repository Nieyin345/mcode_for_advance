/**
 * `@renderer/lib/api.js` 替身 —— 只服务首屏那三块 RPC(`automation.statusAll` /
 * `workflow.list` / `library.list` / `usage.stats`)。事实表由测试用 `setFacts` 现灌。
 *
 * 判据是"错过定时的自动化在首屏那行字里说不说得出来",所以 statusAll 直接回测试给的
 * 那几条事实,其余命名空间一律返回空壳 —— 别的调用不该在这条路径上发生。
 */
export interface Fact {
  key: string;
  workflowId: string;
  nodeId: string;
  title: string;
  kind: string;
  enabled?: boolean;
  armed: boolean;
  detail?: string;
  lastFireAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  missedCount?: number;
  lastMissedAt?: number;
  queuedCount?: number;
  queuedAt?: number;
}

const state = { facts: [] as Fact[] };

export function setFacts(facts: Fact[]): void {
  state.facts = facts;
}

export function resetApi(): void {
  state.facts = [];
}

export const api = {
  usage: { stats: async (): Promise<{ summary: { turns: number; totalTokens: number } }> => ({ summary: { turns: 0, totalTokens: 0 } }) },
  workflow: { list: async (): Promise<{ workflows: unknown[] }> => ({ workflows: [] }) },
  library: { list: async (): Promise<{ items: unknown[] }> => ({ items: [] }) },
  automation: { statusAll: async (): Promise<Fact[]> => state.facts },
} as unknown;
