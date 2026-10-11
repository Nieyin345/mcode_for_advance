/**
 * 【MC-055】`SettingRepo` 的内存桩 —— projectMcp.ts 唯一的持久化依赖。
 *
 * 真实 `SettingRepo` 走 sql.js(sql.js 的 `db.export()` 会重写整个 `mcode.db`,
 * 无头验证时指向真库会毁数据),而本套件要验的是**纯身份/指纹逻辑**,与存储无关。
 * 这里用一张 Map 顶替,`get`/`set` 语义与真实实现一致(缺 key 返回 null)。 */
const store = new Map<string, string>();

export const SettingRepo = {
  get(key: string): string | null {
    return store.has(key) ? (store.get(key) as string) : null;
  },
  set(key: string, value: string): void {
    store.set(key, value);
  },
  keysWithPrefix(prefix: string): string[] {
    return [...store.keys()].filter((k) => k.startsWith(prefix));
  },
  /** 本套件专用:清空,测试之间互不污染。 */
  __reset(): void {
    store.clear();
  },
};
