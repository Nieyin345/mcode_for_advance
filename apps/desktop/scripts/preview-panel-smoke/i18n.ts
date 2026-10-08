/**
 * `@renderer/lib/i18n/index.js` 替身 —— `t(key)` 原样返回 key。
 *
 * 判据是"顶栏那个按钮的可见文字是哪个 key",所以返回 key 本身最直接:拿到的字符串
 * 就是词典键名,断言可以精确到 `library.ctx.offerMd` / `library.ctx.viewTranscript`。
 */
export function useI18n() {
  return { t: (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key };
}
