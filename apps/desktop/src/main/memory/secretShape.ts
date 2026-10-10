/**
 * 「这看起来像凭据吗」的**唯一一份**判据 —— 记忆侧两处都用它。
 *
 * ## 为什么单开这个文件
 *
 * 同一条规则从前在**两处各写了一遍**,而且已经漂了:
 *
 *   - `memory/store.ts` 的保存闸门(拒收)—— PEM 那支只要求**一行** `BEGIN … PRIVATE
 *     KEY`(不要求有 END);
 *   - `memory/sourceText.ts` 的 `redactSecrets`(送进模型前遮蔽)—— PEM 那支要求
 *     **完整的 BEGIN…END 块**。
 *
 * `sk-…` / `AKIA…` 两支是逐字相同的,只有 PEM 漂了。后果不是报错,是**弱的一侧漏风**:
 * 一条被截断/畸形的私钥块(只有 BEGIN、没有 END)在保存时会被拒,但在**面向模型**的遮蔽
 * 里原样漏过去 —— 而模块自己的文件头写的正是"截断会毁掉结束定界符"。同一份内容,两处
 * 判定必须一致。
 *
 * 这里是**零 import 的叶子**(`sourceText.ts` 本身是纯的、无头可测,引它不能带进
 * electron / db)。
 */

/** PEM 私钥块:**BEGIN…END 之间任意内容**;没配到 END 时(被截断 / 畸形)**只到
 *  下一个 `-----` 行或串尾**——总之从 BEGIN 起就不再信任。
 *
 *  ⚠️ **不能要求必须有 END。** 有 END 是最常见的形状,但"只有 BEGIN、后半截被裁掉/写坏"
 *  恰恰是最该挡的那一种,而且模块里的裁剪(见 `sourceText.clampSourceContext`)本来就会
 *  制造这种形状。判据落在"出现了 PRIVATE KEY 的开头定界符"上,而不是"有一个完整块"上。 */
export const PEM_PRIVATE_KEY_RE =
  /-----BEGIN[^\n-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^\n-]*PRIVATE KEY-----|$|(?=-----))/;

/** `sk-…` / `sk-proj-…` / `AKIA…` 这类访问密钥。 */
export const ACCESS_KEY_RE = /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/;

/**
 * **带前缀的令牌** —— GitHub(`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`)、Slack
 * (`xoxa/xoxb/xoxp/xoxr/xoxs-`)、以及公网 MCP 链接里的明文密钥(`/mcp/<secret>`，报告
 * 附录 F 的 M2)。
 *
 * ⚠️ **这几支应用自己早就认得** —— `appControl/redact.ts` 的 `SECRET_VALUE_PREFIXED`
 * 就是同一批形状,它们在返回值里会被打码。而记忆这边从前只认 `sk-…` / `AKIA…` ——
 * 于是用户可以**把一条 GitHub token(`ghp_…`)存进记忆而不被拒**,尽管应用别处明知
 * 这种形状是密钥。**两者必须一致**:同一条内容,一个地方当秘密、另一个地方当场外,
 * 就是"密钥换条路就漏"。这几支的字符集 / 长度阈值照抄 `redact.ts`,别各写一份。
 */
export const PREFIXED_TOKEN_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|\/mcp\/[A-Za-z0-9_-]{24,})\b/;

/** 整条"疑似凭据"判据(PEM / 访问密钥 / 带前缀令牌)。两处共用,不再各写一份。 */
export const SECRET_SHAPE_RE = new RegExp(
  `(?:${PEM_PRIVATE_KEY_RE.source}|${ACCESS_KEY_RE.source}|${PREFIXED_TOKEN_RE.source})`,
);

/** 文本里是否含疑似凭据。 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPE_RE.test(text);
}
