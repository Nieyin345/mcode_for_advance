/**
 * `@main/providers/registry.js` 的替身 —— 只给 `mcode-agent-capability-smoke` 用。
 *
 * 真的那个在模块底部就 `register(new ClaudeAgentSdkProvider())` 等三家:那条链会把
 * 三个 SDK 实现、它们的 MCP 工具表、`?raw` 的 `.py` 资源和原生模块全拉进 bundle,
 * 无头跑不起来(node-live-smoke 文件头记着同一件事)。
 *
 * **但这里保留注册表的真行为** —— `ProviderRegistry` 类逐字照抄真身的语义:
 * `register` 重复 id 抛错、`get` 可缺失、`getRequired` 抛带 `PROVIDER_UNAVAILABLE`
 * 的错。本套自己 `register` 一个假 provider(`main.ts` 里),所以被测代码像在生产里
 * 那样经同一条注册表路径拿到引擎。
 *
 * ⚠️ **不能只留一个空对象**:`RuntimeManager.sendTurnBound` 里 `providerRegistry.get`
 * 找不到引擎时会抛「引擎不可用」,那会让整条被测链在真正到达 provider 之前就断了。
 */
export interface AgentProviderLike {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: unknown;
  startTurn(req: never, ctx: never): Promise<unknown>;
}

export class ProviderRegistry {
  private providers = new Map<string, unknown>();

  register(p: { id: string }): void {
    if (this.providers.has(p.id)) {
      throw new Error(`Provider already registered: ${p.id}`);
    }
    this.providers.set(p.id, p);
  }

  get(id: string): unknown {
    return this.providers.get(id);
  }

  getRequired(id: string): unknown {
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

  list(): unknown[] {
    return [...this.providers.values()];
  }
}

export const providerRegistry = new ProviderRegistry();

/** `probeProviderHealth` —— 真身是注册表外面一层缓存。本套不探测,原样透传。 */
export function probeProviderHealth(id: string) {
  return providerRegistry.get(id);
}
