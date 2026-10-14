/** SettingRepo 内存桩(Map),避免 sql.js 触碰真库。 */
const store = new Map<string, string>();
export const SettingRepo = {
  get: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  set: (k: string, v: string) => { store.set(k, v); },
  keysWithPrefix: (p: string) => [...store.keys()].filter((k) => k.startsWith(p)),
  __reset: () => store.clear(),
};
export const SessionRepo = { get: () => null, list: () => [] };
export const CollectionRepo = { list: () => [] };
export const LibraryRepo = { list: () => [] };
