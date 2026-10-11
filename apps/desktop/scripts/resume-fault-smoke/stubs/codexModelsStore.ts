/**
 * `@main/lib/codexModelsStore.js` 的替身 —— 供 resume-fault-smoke 驱动真的
 * `CodexAgentSdkProvider`,而**不动真设置库**(真的那个走 sql.js + safeStorage)。
 *
 * 【MC-079】从「固定一个 testprov」升级为**可配置的多端点注册表**:测试用
 * `globalThis.__codexModelsStub.set([...])` 装入若干虚构端点(各有独立密钥),
 * `listPublic` / `resolveApiKey` 都从这里读。密钥只做存在性检查,不读真实凭据。
 *
 * 默认仍是原来的单端点 `testprov`(MC-057 的恢复用例依赖它),所以那几条不受影响。
 */
type StubProvider = {
  id: string;
  hasApiKey: boolean;
  models: Array<{ id: string }>;
  /** 明文密钥;只在需要"注入"时给(listPublic.hasApiKey 决定是否解析)。 */
  apiKey?: string;
};

interface Registry {
  providers: StubProvider[];
  set(list: StubProvider[]): void;
  reset(): void;
}

const DEFAULT: StubProvider[] = [
  { id: "testprov", hasApiKey: true, models: [{ id: "gpt-fake" }], apiKey: "sk-fake" },
];

function registry(): Registry {
  const g = globalThis as unknown as { __codexModelsStub?: Registry };
  if (!g.__codexModelsStub) {
    g.__codexModelsStub = {
      providers: DEFAULT.map((p) => ({ ...p })),
      set(list: StubProvider[]) {
        this.providers = list.map((p) => ({ ...p }));
      },
      reset() {
        this.providers = DEFAULT.map((p) => ({ ...p }));
      },
    };
  }
  return g.__codexModelsStub;
}

export function codexHomePath() {
  return (process.env.MCODE_SMOKE_DATA_ROOT as string) + "/codex-home";
}
export function codexKeyEnvVar(id: string) {
  return `MCODE_CODEX_KEY_${id.toUpperCase()}`;
}
export const CodexModelsStore = {
  async listPublic() {
    return registry().providers.map((p) => ({
      id: p.id,
      hasApiKey: p.hasApiKey,
      models: p.models,
    }));
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

/* 模块加载即建立注册表,让 main.ts 在跑任何用例前就能 set()。 */
registry();
