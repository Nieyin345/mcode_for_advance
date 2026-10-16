/**
 * `@main/lib/codexModelsStore.js` 的替身 —— 供 codex-effort-smoke 驱动**真的**
 * `CodexAgentSdkProvider`，而**不动真设置库**（真的那个走 sql.js + safeStorage）。
 *
 * 与 resume-fault-smoke 的同名桩同形，多一件事：模型条目**可以带
 * `thinkingLevelMap`** —— 本套要断的正是「provider 从**选中模型**的这张表把会话档位
 * 翻成 `turn/start` 的 effort」，所以注册表必须能把映射喂进去。测试用
 * `globalThis.__codexModelsStub.set([...])` 装入若干虚构端点。
 */
type StubModel = {
  id: string;
  label?: string;
  hint?: string;
  contextWindow?: number;
  thinkingLevelMap?: Record<string, unknown>;
};
type StubProvider = { id: string; models: StubModel[]; hasApiKey: boolean; apiKey?: string };

interface Registry {
  providers: StubProvider[];
  set(list: StubProvider[]): void;
}

function registry(): Registry {
  const g = globalThis as unknown as { __codexModelsStub?: Registry };
  if (!g.__codexModelsStub) {
    g.__codexModelsStub = {
      providers: [],
      set(list: StubProvider[]) {
        this.providers = list.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }));
      },
    };
  }
  return g.__codexModelsStub;
}

export function codexHomePath(): string {
  return (process.env.MCODE_SMOKE_DATA_ROOT as string) + "/codex-home";
}
export function codexKeyEnvVar(id: string): string {
  return `MCODE_CODEX_KEY_${id.toUpperCase()}`;
}
export const CodexModelsStore = {
  async listPublic() {
    return registry().providers.map((p) => ({ id: p.id, hasApiKey: p.hasApiKey, models: p.models }));
  },
  async ensureConfigMaterialized() {},
  async listMaterializedMcpServers() {
    return [];
  },
  resolveApiKey(providerId: string): string | null {
    const p = registry().providers.find((x) => x.id === providerId);
    return p?.apiKey ?? null;
  },
};

/* 模块加载即建立注册表，让 main.ts 在跑任何用例前就能 set()。 */
registry();
