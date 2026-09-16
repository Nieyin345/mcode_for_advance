/**
 * 三个 parser 共用的取值小工具。
 *
 * 独立成文件（而不是塞进 `types.ts` 或 `index.ts`）是为了避开循环 import：
 * parser 模块需要它，而 `index.ts` 又要 import 各 parser。
 */

/**
 * 尝试把载荷当 JSON 解析。
 *
 * 先看首字符再 parse —— 不只是省一次异常：**纯文本载荷（如心跳、
 * `data: ping`）不该被当成坏 JSON 报 unknown**，而那正是"首字符不是
 * `{`/`[`"这一条能干净区分开的。
 */
export function tryParseJson(payload: string): unknown {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** 是"普通对象"（排除 null 与数组 —— JSON.parse 出来的三种可能之一）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 依次试几个字段名，返回第一个非空字符串。
 *
 * 用于吸收实测中真实存在的命名分歧（例如思考链字段在 `reasoning_content` /
 * `reasoning` / `thinking` 之间摇摆），比在每个调用点写一串 `typeof` 判断清楚。
 */
export function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}