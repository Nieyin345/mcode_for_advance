/**
 * `@renderer/lib/api.js` 替身 —— **按场景可编程**的那一半。
 *
 * 这套要验的是 `SkillNodesView` 的读取完整度:两份工作流,一份读得回来、一份
 * `workflow.get` 抛错。所以 `workflow.list` / `workflow.get` / `workflow.agentProfiles`
 * 由测试用 `__setScenario()` 喂,不再走万能 Proxy(那会掩盖"忘了接哪条")。
 *
 * 未声明的命名空间仍走 Proxy(别的传递依赖可能顺手读一个) —— 但那几条不在本套
 * 判据里,调用了也不会被断言。
 */
export const calls: Array<{ method: string; input: unknown }> = [];
export function resetCalls(): void {
  calls.length = 0;
}

type GetResult = { workflow: unknown };
interface Scenario {
  profiles: Array<{ id: string; name: string; params?: Record<string, unknown> }>;
  list: Array<{ id: string; name: string }>;
  /** id → 结果;缺省 = 成功但 workflow:null;`{ error }` = 抛。 */
  gets: Record<string, GetResult | { error: string }>;
}
let scenario: Scenario = { profiles: [], list: [], gets: {} };
export function __setScenario(next: Scenario): void {
  scenario = next;
}

export const api = {
  workflow: {
    agentProfiles: async () => {
      calls.push({ method: "workflow.agentProfiles", input: undefined });
      return { profiles: scenario.profiles };
    },
    list: async () => {
      calls.push({ method: "workflow.list", input: undefined });
      return { workflows: scenario.list };
    },
    get: async (input: { id: string }) => {
      calls.push({ method: "workflow.get", input });
      const got = scenario.gets[input.id];
      if (got && "error" in got) throw new Error(got.error);
      return got ?? { workflow: null };
    },
  },
};
