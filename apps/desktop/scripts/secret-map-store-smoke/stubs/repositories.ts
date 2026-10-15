/** `@main/store/repositories.js` 的替身 —— 只要 `SettingRepo` 的 get/set(内存表)。
 *
 *  形状与**真模块**一致(get/set 两个真 API),所以 main.ts 里 `SettingRepo.set(key, raw)`
 *  既能过 `tsc`,又真的往这张内存表里塞 —— 不需要桩专有导出。 */
const table = new Map<string, string>();
export const SettingRepo = {
  get: (key: string): string | null => table.get(key) ?? null,
  set: (key: string, value: string): void => {
    table.set(key, value);
  },
};
