/**
 * 记忆助手「来源材料」的**纯**文本处理 —— 遮蔽与预算。
 *
 * 从 `assistant.ts` 抽出来的原因和 `maintenance.ts` 从 `review.ts` 抽出来一样:
 * 这几件事不碰库、不碰时钟、不碰运行时,但它们恰恰是**最该被断言**的一层
 * (一次切错顺序就是把用户的私钥送进模型上下文)。留在 `assistant.ts` 里就只能靠
 * 拉起 RuntimeManager + runner + 仓储的整条链去验,无头套件喂不进去。
 *
 * 这里只放三样:凭据遮蔽、单值取文本、总预算裁剪。
 */

/** 来源材料的总预算(字符)。 */
export const SOURCE_BUDGET = 32_000;

/** 单个字符串值的上限 —— 一条消息里的一段文本。 */
export const VALUE_CAP = 4_000;

/** 递归聚合时每层的上限。 */
export const NODE_CAP = 6_000;

/** 递归深度上限。 */
export const MAX_DEPTH = 5;

/**
 * 已知形式的疑似凭据 → 占位符。
 *
 * ⚠️ **这不是完备的敏感信息识别**(交接文档里已经这么写了),只认两类最常见的形状:
 * PEM 私钥块、`sk-…` / `AKIA…` 这类访问密钥。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----/g, "[已隐藏私钥]")
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/g, "[已隐藏疑似密钥]");
}

/** 只取文本的有界快照;不序列化图片、思考块或任意完整工具参数。
 *
 * ⚠️ **字符串在裁到 {@link VALUE_CAP} 之前先遮蔽** —— 见 {@link clampSourceContext}
 * 的那段说明:截断会毁掉 PEM 块的结束定界符,之后再遮就永远咬不住了。 */
export function textOf(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) return "";
  if (typeof value === "string") return redactSecrets(value).slice(0, VALUE_CAP);
  if (Array.isArray(value)) return value.slice(-40).map((v) => textOf(v, depth + 1)).join("\n").slice(0, NODE_CAP);
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  if (obj.type === "image" || obj.type === "thinking") return "";
  return ["text", "content", "blocks", "summary"].map((k) => textOf(obj[k], depth + 1)).filter(Boolean).join("\n").slice(0, NODE_CAP);
}

/** 关联运行那段证据的裁剪。同样**先遮后裁**。 */
export function clampRunEvidence(json: string, cap = 2_000): string {
  return redactSecrets(json).slice(0, cap);
}

/**
 * 来源材料的**遮蔽 + 总裁剪**。
 *
 * ## 顺序是有对错的:先遮蔽,再裁剪
 *
 * 反过来(先裁后遮)有一个具体的漏法:预算切口落在 PEM 私钥块中间时,
 * `-----END … PRIVATE KEY-----` 被切掉,而遮蔽模式**需要这个结束定界符才能匹配** ——
 * 于是模式匹配不上,留在材料里的那半截私钥原样进入模型上下文。`sk-…` 同理:
 * 切口把它截成不足 24 字符的残段,`{24,}` 就咬不住了。
 *
 * 遮蔽是幂等的,所以"每一道截断之前都先遮一次"(见 {@link textOf} 与
 * {@link clampRunEvidence})不会重复替换,只会让每一处切口都切在已经安全的文本上。
 *
 * 遮蔽会让文本变短,所以先遮后裁只会更保守,不会超预算。
 */
export function clampSourceContext(text: string): string {
  return redactSecrets(text).slice(0, SOURCE_BUDGET);
}

