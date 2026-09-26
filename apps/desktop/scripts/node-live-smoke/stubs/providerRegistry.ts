/**
 * `@main/providers/registry.js` 的替身 —— 真的那个在模块底部**注册三家引擎**
 * (`ClaudeAgentSdkProvider` / `PiAgentSdkProvider` / `CodexAgentSdkProvider`),
 * 于是每个 SDK、每个的 MCP 工具表、以及 `workflows/seed.js` 那一坨 `?raw` 全在链上。
 *
 * ## 为什么这一刀切在这里,而不是切 RuntimeManager 就够了
 *
 * 这一套的 `runner.ts` **自己也**直接 import 了注册表:
 *   - `runInNodeSession` 开头那句"这一步指定的引擎装了没有"的判据(`providerRegistry.get`);
 *   - 能力清单那一段的 `providerRegistry.list()`(engines 那一栏)。
 *
 * 那两句都是被测路径的一部分,所以注册表不能整个换掉 —— 只能让它**空着**。空着正是
 * 这一套要的状态:夹具里没有任何一步指定引擎,于是"引擎没装"那条路不会被触发,而
 * `list()` 拿到空数组也不影响别的断言(`collectCapabilityInventory` 会记一条"没装"的
 * 问题,那是**诚实**的:这个无头环境里确实一个引擎都没装)。
 *
 * ⚠️ **不是空文件。** `get` 返回 `undefined` 是正确的("没装");而 `resolve` 在真的
 * 那边认不出 id 时会抛 —— 这一套**不该**走到它(走到了说明有代码绕过了前面那道判据,
 * 那正是要显形的事)。
 */
import type { AgentProvider } from "@contracts/provider";
const smokeProvider = { id: "claude-sdk", displayName: "Smoke Provider" } as AgentProvider;

// runner.ts imports this probe for capability inventory; this suite has no installed providers.
export async function probeProviderHealth(_id: string): Promise<{ ok: true; code: "ok" }> {
  // The stubbed engine registry is intentionally empty; treat its absent health probe as neutral.
  return { ok: true, code: "ok" };
}

export const providerRegistry = {
  get(_id: string): AgentProvider | undefined {
    return smokeProvider;
  },
  list(): AgentProvider[] {
    return [];
  },
  resolve(_id?: string): AgentProvider {
    throw new Error(
      "node-live-smoke:不该走到 providerRegistry.resolve —— 夹具里没有任何一步指定引擎",
    );
  },
  get default(): AgentProvider {
    throw new Error("node-live-smoke:没有注册任何引擎");
  },
  register(_p: AgentProvider): void {
    /* 无头脚本里不注册引擎 */
  },
};
