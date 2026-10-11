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
const SECRET_VALUE_HEX = /(?<![A-Za-z0-9])[A-Fa-f0-9]{40,}(?![A-Za-z0-9])/g;
export const REDACTED = "[已隐藏]";

/**
 * 打码长十六进制,但**放行"内容寻址的文件路径"**。
 *
 * ## 为什么
 *
 * 资料库的文件按**内容哈希**寻址(`papers/<2>/<2>/<sha256>.pdf`,见 `library/`),
 * 于是 `pdfPath` / `mdPath` / `entryPath` 这类字段的值整串都是 64 位 hex。它们**不是
 * 秘密** —— 恰恰相反,agent 要用这个路径去 `Read` 那份 PDF。可 `SECRET_VALUE_HEX`
 * 一律把 40+ 位 hex 打成 `[已隐藏]`,结果路径变成 `papers/66/1b/[已隐藏].pdf` ——
 * **指不到文件**(报告真机实测 NEW-1)。同一篇的 `pdfSha256` 字段却因字段名像哈希
 * (`HASH_KEY` 豁免)而原样返回,于是"遮了无害的路径、露了哈希",里外不一致。
 *
 * 判据:**这一段 hex 是路径里的一节**就放行 —— 左边是 `/` 或 `\`,右边是 `.` / `/` / `\`。
 * 只挡"整串就是一个 token / 散在文字里的裸 hex"(那些仍按密钥打)。路径分隔符是有力的
 * 上下文:真凭据极少正好被两边的分隔符夹住、且后面紧跟扩展名。
 */
function redactHexRuns(s: string): string {
  return s.replace(SECRET_VALUE_HEX, (run, off: number, whole: string) => {
    const before = whole[off - 1];
    const after = whole[off + run.length];
    const leftSep = before === "/" || before === "\\";
    const rightPath = after === "." || after === "/" || after === "\\";
    return leftSep && rightPath ? run : REDACTED;
  });
}

/** 打码。`allowHex=false` 时跳过"长十六进制"那一格(字段名是哈希,见 HASH_KEY)。 */
export function redactString(s: string, allowHex = true): string {
  const out = s.replace(SECRET_VALUE_PREFIXED, REDACTED);
  return allowHex ? redactHexRuns(out) : out;
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

/**
 * 给 agent 看的返回值里,**把"会话列表"里每一行的那几个"整份内容"级大字段摘掉**。
 *
 * ## 为什么
 *
 * `Session` 为了渲染端"重启后恢复界面"这类需求,带了几份 JSON blob:
 * `turnFiles`(本轮每个文件**改动前后全文**,单条就能几万字符)、`usageHistory`(逐轮
 * token/成本)、`subagents`(子代理 transcript 快照)、`todos`、`planDraft`。
 * 渲染端要它们;但 **`session.listAll` 一次列几十条**,把这些原样塞给模型 → 报告真机
 * 实测 NEW-2:一次"列会话"就把上下文打爆(>4 万字符,当次输出被截断)。而孪生的
 * `mcode-* session_list` 工具是**轻量**的(只标题/id/时间),两条路差了一个数量级。
 *
 * ## 只动"列表",不动"单条"
 *
 * 判据收得很窄:**一个会话对象处在数组里**(`{sessions:[…]}` / `project.sessions` /
 * 任何列表)才摘。单条读出(如 `session.get` 那个对象在顶层或 `{session:{…}}`)保持完整
 * —— agent 确实可能想看"这一轮改了哪些文件"。列表里没有这个需要。
 *
 * 摘掉不是隐藏:改成 `3 项(已省略…)` 的计数,agent 知道"有东西",要细节走单条读法。
 * 深度有界、环引用安全,非会话形状的数组元素一律不动。
 */
const HEAVY_SESSION_KEYS = [
  "turnFiles", // 本轮每个文件改动前后全文
  "usageHistory", // 逐轮 token/成本
  "subagents", // 子代理**状态**快照(轻)
  "subagentTranscripts", // 子代理**整轮 transcript**(重 —— 与 subagents 是两个字段,别漏)
  "contextSnapshot", // 会话上下文快照
  "bookmarks",
  "todos",
  "planDraft",
] as const;

function looksLikeSession(o: Record<string, unknown>): boolean {
  return typeof o.id === "string" && (typeof o.kind === "string" || typeof o.providerId === "string");
}

export function slimSessions(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number, inList: boolean): unknown => {
    if (v === null || typeof v !== "object" || depth > 12) return v;
    if (v instanceof Uint8Array || v instanceof ArrayBuffer || v instanceof Date) return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, true));
    const obj = v as Record<string, unknown>;
    const slim = inList && looksLikeSession(obj);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      if (slim && (HEAVY_SESSION_KEYS as readonly string[]).includes(k)) {
        out[k] = Array.isArray(val) ? `${val.length} 项(列表里已省略;要看这一条的内容,单独读该会话)` : val === null ? null : "已省略";
      } else {
        out[k] = walk(val, depth + 1, false);
      }
    }
    return out;
  };
  return walk(value, 0, false);
}
