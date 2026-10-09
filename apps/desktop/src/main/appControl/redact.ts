/**
 * 把 RPC 的返回值变成**能给模型看**的文本:
 *   - 凭据一律打码(按字段名 + 按值的样子两道);
 *   - 二进制(Buffer / Uint8Array / ArrayBuffer)只报长度;
 *   - 超长截断,并说清截掉了多少。
 */

const SECRET_KEY = /(token|secret|api[-_.]?key|apikey|password|passwd|cookie|credential|jwt|private[-_.]?key|authorization)/i;
/**
 * 字段名**按形状**看不像凭据、而值又天然是长十六进制的:git 的提交/父提交 SHA、库里的
 * 内容寻址哈希(`pdfSha256`)、ETag 等。这些**不是秘密** —— 外面那个 agent 要靠它们串起
 * `git.log` → `git.showCommit`,或者按 sha 引用库文件。
 *
 * 不加这条豁免,下面 SECRET_VALUE 里那格 `[A-Fa-f0-9]{40,}` 会把它们一律打码成 `[已隐藏]`:
 * git 的 40 位 SHA、PDF 的 64 位 sha256 全中招,留下一堆 `hash: "[已隐藏]"`,而那正是
 * `appControl` 交给模型的"真数据"该有的样子。**只在字段名像哈希时才豁免**;字段名本身像
 * 凭据(含 password/token/key…)仍走 SECRET_KEY 的 strict,严格优先。
 */
const HASH_KEY = /(hash|sha\d*|md5|digest|etag|checksum|parent)/i;
/** 值本身长得像密钥的:sk-…、ghp_…、xox…、公网 MCP 路径里的密钥、长串十六进制。 */
const SECRET_VALUE_PREFIXED = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|\/mcp\/[A-Za-z0-9_-]{24,})/g;
const SECRET_VALUE_HEX = /\b[A-Fa-f0-9]{40,}\b/g;
export const REDACTED = "[已隐藏]";

/** 打码。`allowHex=false` 时跳过"长十六进制"那一格(字段名是哈希,见 HASH_KEY)。 */
export function redactString(s: string, allowHex = true): string {
  const out = s.replace(SECRET_VALUE_PREFIXED, REDACTED);
  return allowHex ? out.replace(SECRET_VALUE_HEX, REDACTED) : out;
}

/**
 * 深拷贝并打码。环引用、函数、过深的层级都安全处理。
 * `strict` = 处在凭据字段之下(如 `credentials: {...}`):里面的字符串一律隐藏。
 * `hashCtx` = 处在哈希字段之下(如 `hash` / `parents` / `pdfSha256`):这里的字符串值不按
 * "长十六进制"打码,免得把 git SHA / 内容哈希当密钥抹掉。**凭据字段严格优先于它**。
 * 数字/布尔从不隐藏 —— `inputTokens: 1200`、`hasToken: true` 这种是统计和状态,不是密钥。
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>(), strict = false, hashCtx = false): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return strict && value !== "" ? REDACTED : redactString(value, !hashCtx);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth > 12) return "[层级过深,已省略]";
  if (value instanceof Uint8Array) return `[二进制 ${value.byteLength} 字节]`;
  if (value instanceof ArrayBuffer) return `[二进制 ${value.byteLength} 字节]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return redactValue(Object.fromEntries(value), depth + 1, seen, strict, hashCtx);
  if (value instanceof Set) return redactValue([...value], depth + 1, seen, strict, hashCtx);
  if (typeof value === "object") {
    if (seen.has(value)) return "[循环引用]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen, strict, hashCtx));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, depth + 1, seen, strict || SECRET_KEY.test(k), hashCtx || HASH_KEY.test(k));
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
