/**
 * `@main/providers/registry.js` 的替身 —— 真的那个会把三个引擎实现全拉进来(Claude /
 * Pi / Codex),每一个都拖着 SDK 和一堆 IPC 依赖,无头脚本不需要那些。
 *
 * `forkSession` 这一条路要验的**只有一件事**:调用方有没有把正确的
 * (引擎侧会话 id / 目录 / 标题)交给引擎。所以这里让脚本自己摆一个引擎进去 ——
 * 它记得住自己被怎么调的,也能被摆成"不支持分叉"或"调用即失败"。
 */
export interface FakeProvider {
  id: string;
  /** 记下每一次调用 —— 断言"传对了没有"靠它。 */
  calls: Array<{ providerSessionId: string; cwd: string; title: string }>;
  forkSession?: (providerSessionId: string, opts: { cwd: string; title: string }) => Promise<string>;
}

const providers = new Map<string, FakeProvider>();

/** 摆一个引擎(脚本在跑之前调)。 */
export function setFakeProvider(provider: FakeProvider): void {
  providers.set(provider.id, provider);
}

export const providerRegistry = {
  resolve(id: string): FakeProvider {
    const found = providers.get(id);
    // 认不出来时给一个"没有 forkSession"的空引擎 —— 与真注册表认不出 id 时的表现
    // (返回 undefined、调用方自己处理)不同,但这里要验的是**调用方在引擎不支持分叉
    // 时会不会停手**,给个空对象比让它崩掉更能验到那一条。
    return found ?? { id, calls: [] };
  },
};
