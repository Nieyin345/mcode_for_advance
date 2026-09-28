/** `@main/store/repositories.js` 的替身 —— 只要 `SettingRepo` 的 get/set(内存表)。 */
const table = new Map<string, string>();
export const SettingRepo = {
  get: (key: string): string | null => table.get(key) ?? null,
  set: (key: string, value: string): void => {
    table.set(key, value);
  },
};
