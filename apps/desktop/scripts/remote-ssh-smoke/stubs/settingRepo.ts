/**
 * `@main/store/repositories.js` 的替身 —— 内存版 SettingRepo,只为本套无头脚本存在。
 *
 * `agentRemoteSsh.ts` 现在用 `SettingRepo` 存 known_hosts(主机指纹 TOFU)。真的那个会
 * 拉进 `sql.js` + `electron` 的 `app`,而无头脚本里既没有 electron 也没必要碰真库 ——
 * 换成内存表就够,本套一行 sqlite 都不碰。
 *
 * 本套自己抄一份,不复用别的套件目录里的替身(规则第 1 条:共用一个会在别人改它时连带
 * 改到这里)。
 */
const store = new Map<string, string>();

export const SettingRepo = {
  get(key: string): string | null {
    return store.get(key) ?? null;
  },
  getMany(keys: string[]): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const k of keys) out[k] = store.get(k) ?? null;
    return out;
  },
  set(key: string, value: string): void {
    store.set(key, value);
  },
  delete(key: string): void {
    store.delete(key);
  },
  /** 仅供本套断言用:看设置表里到底写了什么。 */
  __dump(): Record<string, string> {
    return Object.fromEntries(store);
  },
  /** 仅供本套断言用:清空,给"全新用户"的场景用。 */
  __clear(): void {
    store.clear();
  },
};
