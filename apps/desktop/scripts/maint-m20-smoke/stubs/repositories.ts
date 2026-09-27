/** No sqlite DB: only the voice setting keys exist in this test. */
const settings = new Map<string, string>();
export const SettingRepo = {
  get(key: string): string | null { return settings.get(key) ?? null; },
  set(key: string, value: string): void { settings.set(key, value); },
};
