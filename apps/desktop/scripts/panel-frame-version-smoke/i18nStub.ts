/**
 * `@renderer/lib/i18n/index.js` 替身 —— `t(key)` 原样返回 key(preview-panel 同款)。
 *
 * 判据要落在"用户看到的过渡文案是哪一句"上,所以返回 key 本身最直接:断言能精确到
 * `customUi.panel.loadingNew` / `customUi.panel.loading` 这两句。
 */
export function useI18n() {
  return {
    locale: "zh" as const,
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key,
  };
}
