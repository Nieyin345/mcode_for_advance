/**
 * 回显 MessageId 本身，并按 `{name}` 占位替换参数。
 *
 * 断言要验的是「提示出现了、且占位符被填上了」，不是具体译文措辞 ——
 * 措辞归 i18n 词典管，那有 `MessageId` 类型在守。
 */
import type { MessageId } from "@renderer/lib/i18n/core";

export function useI18n() {
  return {
    locale: "zh" as const,
    t: (id: MessageId, vars?: Record<string, string | number>) =>
      vars ? String(id).replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? `{${k}}`)) : String(id),
  };
}
