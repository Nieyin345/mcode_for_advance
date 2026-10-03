// In-memory SettingRepo — mcpMarket only reads/writes `mcp.marketSources`.
const store = new Map<string, string>();
export const SettingRepo = {
  get: (key: string): string | null => store.get(key) ?? null,
  set: (key: string, value: string): void => {
    store.set(key, value);
  },
};
