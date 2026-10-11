/**
 * Provider registry — singleton map of backend → AgentProvider.
 *
 * Add new providers here (one register call each). The rest of the system
 * (RuntimeManager, IPC, frontend) resolves providers by id from this registry.
 */
import type { AgentProvider } from "@contracts/provider";
import { ClaudeAgentSdkProvider } from "./claude-sdk/ClaudeAgentSdkProvider.js";
import { PiAgentSdkProvider } from "./pi-sdk/PiAgentSdkProvider.js";
import { CodexAgentSdkProvider } from "./codex-sdk/CodexAgentSdkProvider.js";
import { createProviderHealthProbe } from "./providerHealth.js";

class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();

  register(p: AgentProvider): void {
    if (this.providers.has(p.id)) {
      throw new Error(`Provider already registered: ${p.id}`);
    }
    this.providers.set(p.id, p);
  }

  get(id: string): AgentProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * 【MC-056】取**指定**引擎,取不到就抛 —— 绝不回退默认。
   *
   * 已有会话(`session.providerId` 有值)的回合、分叉**必须**走这一条。从前它们调
   * {@link resolve},而 `resolve` 在 id 有值但查不到时**静默返回默认引擎**(当前注册的
   * 第一家 = claude-sdk)。于是一段标着 `pi-sdk` 的历史会话(引擎被卸了 / 存值写错 /
   * 升级不兼容)再发一轮,会**悄悄换 Claude 跑** —— 审批模式、工具可见性、底层会话
   * 记录、成本全对不上用户选的那个场景,而且没有任何地方报出来。
   *
   * 抛错让上层把"引擎不可用"变成一个**结构化失败**(保持原 providerId 与记录不动,
   * 给用户"装回原引擎 / 显式迁移"两条路),而不是换一个引擎继续跑。
   */
  getRequired(id: string): AgentProvider {
    const p = this.providers.get(id);
    if (!p) {
      const err = new Error(
        `引擎「${id}」现在不可用(被卸载、升级不兼容,或配置里存的值已失效)。`,
      ) as Error & { code?: string };
      err.code = "PROVIDER_UNAVAILABLE";
      throw err;
    }
    return p;
  }

  /**
   * 【MC-056】**只为新建且用户未指定引擎的会话**取默认(第一家注册的)。
   *
   * 与 {@link resolve} 的区别是语义:这个名字明说"这是给新会话兜底的",将来谁想把它
   * 用在已有会话上,名字就会刺眼。已有会话一律走 {@link getRequired}。
   */
  getDefaultForNewSession(): AgentProvider {
    return this.default;
  }

  /**
   * ⚠️ **已弃用于已有会话。** 只要 `id` 有值(missing)就静默回退默认 —— 这正是 MC-056
   * 那个"悄悄换引擎"的根。新代码:新建未指定用 {@link getDefaultForNewSession},已有
   * 会话用 {@link getRequired}。保留本方法只为不打断别处尚未迁移的调用点,别再新增。
   */
  resolve(id?: string): AgentProvider {
    if (id) {
      const p = this.providers.get(id);
      if (p) return p;
    }
    return this.default;
  }

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }

  get default(): AgentProvider {
    const first = this.providers.values().next().value as AgentProvider | undefined;
    if (!first) throw new Error("No providers registered");
    return first;
  }
}

export const providerRegistry = new ProviderRegistry();

// Register built-in providers.
providerRegistry.register(new ClaudeAgentSdkProvider());
providerRegistry.register(new PiAgentSdkProvider());
providerRegistry.register(new CodexAgentSdkProvider());

/** Shared by desktop IPC and mobile RPC: one cache/in-flight map per process. */
export const probeProviderHealth = createProviderHealthProbe((id) => providerRegistry.get(id));
