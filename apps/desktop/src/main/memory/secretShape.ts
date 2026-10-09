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

/** 整条"疑似凭据"判据(PEM 或访问密钥)。两处共用,不再各写一份。 */
export const SECRET_SHAPE_RE = new RegExp(
  `(?:${PEM_PRIVATE_KEY_RE.source}|${ACCESS_KEY_RE.source})`,
);

/** 文本里是否含疑似凭据。 */
export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPE_RE.test(text);
}
