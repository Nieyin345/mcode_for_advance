/**
 * `@main/store/repositories.js` 的替身 —— 内存版 SettingRepo,只为本套无头脚本存在。
 *
 * 真的那个会拉进 `sql.js` + `electron` 的 `app`;`ipc/plugins.ts` 这条路上被用到的
 * 只有 `SettingRepo.get/set`(`pluginManager` 读写三个设置键),换成内存表就够了。
 *
 * ⚠️ 本套不碰真数据根 —— run.sh 把 HOME/USERPROFILE 指到临时目录,main.ts 里再
 * 断言一次 `PLUGINS_ROOT` 落在那个临时目录下才继续(见 main.ts 第 0 节)。
 *
 * 本套自己抄一份而不复用 `plugins-smoke/stub-repositories.ts`:那支是别的套件目录里的
 * 文件,共用一个会在别人改它的时候连带改到这里(规则第 1 条)。
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
  /** 仅供本套断言用:看设置表里到底写了什么(残留/幂等那几条要用)。 */
  __dump(): Record<string, string> {
    return Object.fromEntries(store);
  },
  /** 仅供本套断言用:清空,给"全新用户"的场景用。 */
  __clear(): void {
    store.clear();
  },
};
