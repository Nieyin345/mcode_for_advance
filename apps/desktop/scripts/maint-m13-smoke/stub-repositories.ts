/** MAINT-M13 smoke: in-memory SettingRepo (the real one needs sql.js + electron). */
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
};
