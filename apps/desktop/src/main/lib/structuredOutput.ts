/**
 * 结构化输出的**降级管道** —— 给没有原生 structured-output 的引擎（Codex / Pi）
 * 用的提示词注入 + 轮末校验。Claude 在默认端点走 SDK 的 `outputFormat`
 * (json_schema)，不经过这里；但自定义网关（apiConfig 存在）同样降级到本文件。
 *
 * 为什么手写校验器而不是上 ajv：pnpm 严格模式下 ajv 不是直接依赖，为一个
 * "模型输出的 JSON 大体长对了没有"的检查拉一整个校验库不值。这里覆盖 JSON
 * Schema 的常用子集 —— `type` / `properties` / `required` / `items` / `enum` /
 * `additionalProperties: false` —— 产出物（`structuredOutput`）的使用方都是
 * 本仓库自己（工作流节点收 JSON），约定 schema 不超出这个子集。校验失败会
 * 带着错误重试一次再报 `structured_invalid`，不是静默吞掉。
 */

export interface StructuredOutputSpec {
  name: string;
  schema: Record<string, unknown>;
}

/** 组进 prompt 末尾的降级指令。语气刻意硬：只许输出 JSON，不许寒暄、不许代码围栏。 */
export function buildStructuredOutputPrompt(spec: StructuredOutputSpec): string {
  return [
    "",
    "───",
    `你的最终回答必须是**一个** JSON 文档（名称：${spec.name}），与下面的 JSON Schema 完全一致。`,
    "只输出这个 JSON 文档本身：不要解释、不要前后缀文字、不要 Markdown 代码围栏。",
    "JSON Schema:",
    JSON.stringify(spec.schema, null, 2),
  ].join("\n");
}

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * 纠错轮的 prompt：把上一轮的校验错误原样喂回去，要求只重发 JSON。
 * Codex / Pi（以及 Claude 自定义网关降级路径）在轮末 parse 失败后用同一
 * 会话追这一条 —— 模型看到具体错在哪，一次修正的成功率远高于干喊"重来"。
 */
export function buildCorrectivePrompt(spec: StructuredOutputSpec, error: string): string {
  return [
    `你上一条回复不符合结构化输出要求（${spec.name}）。校验错误：`,
    error,
    "请重新输出**一个**符合上面 JSON Schema 的 JSON 文档。只输出 JSON 本身：不要解释、不要代码围栏、不要任何其他文字。",
  ].join("\n");
}

/**
 * 从模型回复的文本里抠出第一个 JSON 文档：剥 Markdown 代码围栏，从第一个
 * `{` / `[` 起做括号配平扫描（字符串字面量感知），JSON.parse。返回错误时
 * message 是给重试轮 / 用户看的中文。
 */
export function extractJsonDocument(text: string): ParseResult {
  const stripped = stripCodeFence(text);
  // 枚举每个 `{`/`[` 起点,配平后尝试 parse,**在所有能 parse 的候选里取"结束位置最靠后"
  // 的那个**(并列则取起点最靠前的,即最外层)。
  //
  // 为什么不是"第一个"(从前的做法):前置说明里出现一个配平但不合法的花括号片段
  // (模型爱写"示例 {x}")时,首个候选 parse 失败就整段判失败,白白触发一次纠错轮。
  // 为什么不是"最后一个起点":那会把嵌套文档的**内层**对象抠出来(测试
  // `{"outer":{"inner":…}}` 就是这么被抓住的)。
  // "结束最靠后"两头都对:真正的交付文档总在末尾,且外层对象比内层结束得更晚。
  const starts: number[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "{" || ch === "[") starts.push(i);
  }
  if (starts.length === 0) {
    return { ok: false, error: "回复中没有找到 JSON 文档" };
  }
  let best: { start: number; end: number; value: unknown } | null = null;
  let firstError: string | null = null;
  for (const start of starts) {
    const end = balancedEnd(stripped, start);
    if (end < 0) {
      if (firstError === null) firstError = "JSON 文档不完整（括号未配平）";
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(stripped.slice(start, end + 1));
    } catch (err) {
      if (firstError === null) firstError = `JSON 解析失败：${(err as Error).message}`;
      continue;
    }
    if (best === null || end > best.end || (end === best.end && start < best.start)) {
      best = { start, end, value };
    }
  }
  if (best === null) return { ok: false, error: firstError ?? "回复中没有找到 JSON 文档" };
  return { ok: true, value: best.value };
}

/** 校验 `value` 是否符合 schema（支持的子集见文件头）。返回错误列表，空 = 通过。 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "$",
): string[] {
  const errors: string[] = [];
  const type = schema.type as string | string[] | undefined;
  if (type !== undefined && !matchesType(value, type)) {
    return [`${path} 的类型应为 ${fmtType(type)}，实际是 ${jsonType(value)}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push(`${path} 不在枚举 ${JSON.stringify(schema.enum)} 内`);
  }
  if (jsonType(value) === "object") {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required ?? []) as string[];
    const obj = value as Record<string, unknown>;
    for (const key of required) {
      if (!(key in obj)) errors.push(`${path} 缺少必需字段 "${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path} 出现 schema 之外的字段 "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj && obj[key] !== undefined) {
        errors.push(...validateAgainstSchema(obj[key], sub ?? {}, `${path}.${key}`));
      }
    }
  }
  if (jsonType(value) === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (const [i, item] of (value as unknown[]).entries()) {
        errors.push(...validateAgainstSchema(item, items, `${path}[${i}]`));
      }
    }
  }
  return errors;
}

/** 提取 + 校验一步到位。`spec.name` 只用于错误信息。 */
export function parseStructuredOutput(text: string, spec: StructuredOutputSpec): ParseResult {
  const extracted = extractJsonDocument(text);
  if (!extracted.ok) return extracted;
  const errors = validateAgainstSchema(extracted.value, spec.schema);
  return errors.length === 0
    ? extracted
    : { ok: false, error: `输出不符合 schema ${spec.name}：\n${errors.join("\n")}` };
}

/* ────────────────────────── 内部工具 ────────────────────────── */

function stripCodeFence(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  return fence ? fence[1] : text;
}

/** 从 `start`（必是 `{` 或 `[`）起扫描到配平的闭合符，跳过字符串字面量。找不到返回 -1。 */
function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) =>
    t === "integer" ? jsonType(value) === "number" && Number.isInteger(value) : jsonType(value) === t,
  );
}

function fmtType(type: string | string[]): string {
  return Array.isArray(type) ? type.join(" | ") : type;
}
