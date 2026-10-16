/**
 * Provider registry — singleton map of backend → AgentProvider.
 *
 * Add new providers here (one register call each). The rest of the system
 * (RuntimeManager, IPC, frontend) resolves providers by id from this registry.
 *
 * 【MC-013】「新会话默认引擎」**不由**本注册表的注册顺序决定 —— 权威是常量
 * `DEFAULT_PROVIDER_ID`(@contracts/ipc/settings.ts)。见下方 default getter 的说明。
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
   * 【MC-013】**不**是「新会话默认引擎」的解析口 —— 别再往这个方向用它。
   *
   * 「新会话默认引擎」的权威是常量 `DEFAULT_PROVIDER_ID`(@contracts/ipc/settings.ts),
   * 由 `sessionStart.ts` / `delegateHost.ts` / `automationRunner.ts` / `publicMcpSession.ts`
   * 等入口直接引用。本 getter 只是**注册顺序的偶然结果**(当前 = 第一家 = claude-sdk),
   * 两个事实目前**恰好相等**,但改注册顺序不会改默认引擎 —— 想改默认,改常量。
   *
   * ⚠️ **未决(MC-013 remaining)**:「常量硬编码 vs 注册表首家」的取舍需产品定。
   * 现状是两份事实并存、由本注释钉住权威;待产品拍板后收敛成一份(删本 getter 的
   * 「第一家」语义,或让常量从注册表解析)。
   *
   * 目前**全仓无调用端**(2026-10-17 实测;连同已删的 `resolve()` / `getDefaultForNewSession()`
   * 一起核查过) —— 保留它是因为语义本身没错,需要「按注册顺序兜底」时仍可用;
   * 若将来长期无调用,可一并删除。
   */
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
