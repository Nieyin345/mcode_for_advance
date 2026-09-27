// Only workflow review markers are needed; real databases are never opened.
const settings = new Map<string, string>();
export const SettingRepo = {
  get: (key: string): string | null => settings.get(key) ?? null,
  set: (key: string, value: string): void => { settings.set(key, value); },
};
