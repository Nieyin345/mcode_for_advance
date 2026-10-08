/** `@renderer/lib/i18n/index.js` 替身 —— `t(key)` 原样返回 key(断言只关心选项,不关心文案)。 */
export function useI18n() {
  return { locale: "en" as const, t: (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${JSON.stringify(vars)}` : key) };
}
