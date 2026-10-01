/**
 * 把 RPC 的返回值变成**能给模型看**的文本:
 *   - 凭据一律打码(按字段名 + 按值的样子两道);
 *   - 二进制(Buffer / Uint8Array / ArrayBuffer)只报长度;
 *   - 超长截断,并说清截掉了多少。
 */

const SECRET_KEY = /(token|secret|api[-_.]?key|apikey|password|passwd|cookie|credential|jwt|private[-_.]?key|authorization)/i;
/** 值本身长得像密钥的:sk-…、ghp_…、xox…、长串十六进制、公网 MCP 路径里的密钥。 */
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|\b[A-Fa-f0-9]{40,}\b|\/mcp\/[A-Za-z0-9_-]{24,})/g;
export const REDACTED = "[已隐藏]";

export function redactString(s: string): string {
  return s.replace(SECRET_VALUE, REDACTED);
}

/**
 * 深拷贝并打码。环引用、函数、过深的层级都安全处理。
 * `strict` = 处在凭据字段之下(如 `credentials: {...}`):里面的字符串一律隐藏。
 * 数字/布尔从不隐藏 —— `inputTokens: 1200`、`hasToken: true` 这种是统计和状态,不是密钥。
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>(), strict = false): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return strict && value !== "" ? REDACTED : redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth > 12) return "[层级过深,已省略]";
  if (value instanceof Uint8Array) return `[二进制 ${value.byteLength} 字节]`;
  if (value instanceof ArrayBuffer) return `[二进制 ${value.byteLength} 字节]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return redactValue(Object.fromEntries(value), depth + 1, seen, strict);
  if (value instanceof Set) return redactValue([...value], depth + 1, seen, strict);
  if (typeof value === "object") {
    if (seen.has(value)) return "[循环引用]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen, strict));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, depth + 1, seen, strict || SECRET_KEY.test(k));
    }
    return out;
  }
  return String(value);
}

export const MAX_RESULT_CHARS = 40_000;

/** 打码 + 序列化 + 截断。 */
export function renderResult(value: unknown, maxChars = MAX_RESULT_CHARS): string {
  if (value === undefined) return "完成(无返回值)";
  const safe = redactValue(value);
  let text: string;
  try {
    text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 1);
  } catch {
    text = String(safe);
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…[已截断:共 ${text.length} 字符,只显示前 ${maxChars}。请用 limit/offset/query 等参数缩小范围]`;
  }
  return text;
}
