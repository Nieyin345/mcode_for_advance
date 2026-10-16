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
  /** 【MC-027】记下每一次补偿删除的调用 —— 断言"本地写失败后引擎侧那份被删掉/登记了"靠它。 */
  deleteCalls: Array<{ providerSessionId: string; cwd: string }>;
  deleteSession?: (providerSessionId: string, opts: { cwd: string }) => Promise<void>;
}

const providers = new Map<string, FakeProvider>();

/** 摆一个引擎(脚本在跑之前调)。 */
export function setFakeProvider(provider: FakeProvider): void {
  providers.set(provider.id, provider);
}

export const providerRegistry = {
  /** 【MC-013】真注册表的 `resolve` **已删除**（全仓无调用端）。本桩保留它仅为历史对照：
   *  上一版这里必须与真注册表的回退语义逐字一致，好让「把 getRequired 退回 resolve」的
   *  变异能被测到（当时给空对象会让 MC-056 那条断言在变异下照样绿 —— 空对象没有
   *  forkSession，报的是"不支持分叉"而不是"引擎不可用"，断言测到了别人的职责）。
   *  真方法既已不存在，"退回"这条路也在编译期就断了；留此成员只为不抹掉那段来历。 */
  resolve(id: string): FakeProvider {
    const found = providers.get(id);
    if (found) return found;
    const dflt = [...providers.values()][0];
    return dflt ?? { id, calls: [], deleteCalls: [] };
  },
  /** 【MC-056】真注册表语义:取不到就**抛** —— 调用方(forkSession)靠它拒绝在引擎
   *  不可用时静默换默认引擎。这正是它当初要与 `resolve` 的"回退默认"区分开的理由。 */
  getRequired(id: string): FakeProvider {
    const found = providers.get(id);
    if (!found) {
      const err = new Error(`引擎「${id}」现在不可用(被卸载、升级不兼容,或配置里存的值已失效)。`) as Error & { code?: string };
      err.code = "PROVIDER_UNAVAILABLE";
      throw err;
    }
    return found;
  },
};
