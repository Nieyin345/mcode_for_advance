/**
 * Provider registry — singleton map of backend → AgentProvider.
 *
 * Add new providers here (one register call each). The rest of the system
 * (RuntimeManager, IPC, frontend) resolves providers by id from this registry.
 *
 * 【MC-013】「新会话默认引擎」**只有一份事实**：常量 `DEFAULT_PROVIDER_ID`
 * (@contracts/ipc/settings.ts)。本注册表**不**提供任何"默认引擎"解析口 ——
 * 从前那个按注册顺序返回第一家的 `default` getter 已删除(审核要求收敛到一处)。
 * 注册顺序只影响 `list()` 的展示顺序，与默认引擎无关。
 */
import type { AgentProvider } from "@contracts/provider";
import { DEFAULT_PROVIDER_ID } from "@contracts/ipc";
import { ClaudeAgentSdkProvider } from "./claude-sdk/ClaudeAgentSdkProvider.js";
import { PiAgentSdkProvider } from "./pi-sdk/PiAgentSdkProvider.js";
import { CodexAgentSdkProvider } from "./codex-sdk/CodexAgentSdkProvider.js";
import { createProviderHealthProbe } from "./providerHealth.js";

/**
 * 【MC-013】注册表类**导出**（生产仍只用下面那个单例）。
 *
 * 导出是为了让「默认引擎与注册顺序无关」这条判据能被**真的变异验证**：单例里内置
 * 引擎的注册顺序固定，拿它测不出一条"按第一家兜底"的回归（就算改回去，第一家恰好
 * 还是 claude-sdk，套件照样绿）。套件用两个独立实例注册相反的次序来判。
 */
export class ProviderRegistry {
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
   * 从前取引擎走 `resolve(id)`(已按 MC-013 删除):它在 id 有值但查不到时**静默返回
   * 默认引擎**(当前注册的第一家 = claude-sdk)。于是一段标着 `pi-sdk` 的历史会话
   * (引擎被卸了 / 存值写错 / 升级不兼容)再发一轮,会**悄悄换 Claude 跑** —— 审批模式、
   * 工具可见性、底层会话记录、成本全对不上用户选的那个场景,而且没有任何地方报出来。
   *
   * 抛错让上层把"引擎不可用"变成一个**结构化失败**(保持原 providerId 与记录不动,
   * 给用户"装回原引擎 / 显式迁移"两条路),而不是换一个引擎继续跑。
   *
   * 新代码取引擎:`get()` 是可容忍缺失的探测口(列表 / 能力清单);凡是**取不到就没法
   * 继续**的路径走本方法 —— 当前正式调用端只有 `lib/sessionFork.ts`(复制对话)。
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

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }

  /**
   * 【MC-013】**只有一个默认引擎出口** —— 就是本方法，它直接读权威常量
   * `DEFAULT_PROVIDER_ID`。
   *
   * 从前这里还有一个 `default` getter，按**注册顺序**返回第一家（恰好也是
   * claude-sdk），于是「默认引擎」同时存在两份事实（常量 + 注册顺序）。审核明确
   * 要求收敛成一份：注册顺序不再参与任何默认值推导，本方法是唯一入口。
   *
   * 常量指向的引擎若没注册（被卸载/构建裁剪），**照常返回该 id**而不是回退到别的
   * 引擎 —— 选择引擎失败必须由下游变成可见的结构化失败（见 {@link getRequired}），
   * 不能在这里悄悄换一个。
   */
  getDefaultProviderId(): string {
    return DEFAULT_PROVIDER_ID;
  }
}

export const providerRegistry = new ProviderRegistry();

// Register built-in providers.
providerRegistry.register(new ClaudeAgentSdkProvider());
providerRegistry.register(new PiAgentSdkProvider());
providerRegistry.register(new CodexAgentSdkProvider());

/** Shared by desktop IPC and mobile RPC: one cache/in-flight map per process. */
export const probeProviderHealth = createProviderHealthProbe((id) => providerRegistry.get(id));
