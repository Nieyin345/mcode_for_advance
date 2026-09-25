/**
 * `@main/store/repositories.js` 的替身 —— 只给出 `groupRegistry` 要的那一个 `SettingRepo`。
 *
 * ## 为什么这一套需要它
 *
 * 场景 5b 要断言的是**真货的参数表**(`nodeTypes.ts` 的内置清单)—— 而 `ioParams()`
 * 那一格「资料」的下拉候选是照着**大类表 + 模版类目**算的(`loadLibraryGroups`),
 * 大类表真身在 settings 表里,于是 `nodeTypes.ts` 会一路 import 到 sql.js 的库上。
 * 无头脚本里 `initDb()` 没跑过,报的是 `getDb() called before initDb() resolved`。
 *
 * 这一套**不需要**真的 settings 表:大类表读不到就退出厂两组(见 `groupRegistry` 里那条
 * 兜底),而出厂那两组正是我们要的那种"资料"下拉。所以给一个内存版,`get` 一律返回 null
 * —— 这跟"用户从没动过大类"逐字一致。
 *
 * ⚠️ **绝不能让真的那个被 import 进来**:真的 `SettingRepo.set` 内部就是 `persist()`,
 * 一次写入就够整份重写用户的 `mcode.db`。给桩是**安全前提**,不只是省事。
 *
 * (与 `mcode-admin-smoke/stubs/repositories.ts` 是同一份形状的收窄版 —— 那一份还带
 *  一个内存版 `WorkflowRepo`,这一套用不着。)
 */
export const SettingRepo = {
  get(_key: string): string | null {
    return null;
  },
  getMany(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = null;
    return out;
  },
  set(_key: string, _value: string): void {
    // 只读桩:这一套不该有任何东西往 settings 里写。真写了就抛,而不是默默吞掉 ——
    // 那说明被测的那条路比预想的更靠下,得回来看一眼。
    throw new Error("memory-smoke 的 SettingRepo 是只读桩 —— 有东西想往 settings 里写");
  },
};
