/**
 * 声明式条件:只能读一个上游引用,用固定的三个谓词比较字面值。
 * 这里没有表达式求值器,也不把右侧文本当模板/代码执行。
 */
import { z } from "zod";
import { readConditionRef, type NodeTemplateScope } from "./nodeTemplate.js";

export const NODE_CONDITION_EXPRESSION_KEY = "expression";

const RefSchema = z.string().min(6).max(250).regex(/^\{\{[^{}]+\}\}$/, "请填写完整的 {{上游节点.字段}} 引用");
const ExistsRule = z.object({ ref: RefSchema, op: z.literal("exists") }).strict();
const EqualRule = z.object({ ref: RefSchema, op: z.literal("equal"), value: z.string().max(1024) }).strict();
const ContainsRule = z.object({ ref: RefSchema, op: z.literal("contains"), value: z.string().max(1024) }).strict();

export const ConditionExpressionSchema = z.object({
  logic: z.enum(["and", "or"]),
  rules: z.array(z.discriminatedUnion("op", [ExistsRule, EqualRule, ContainsRule])).min(1).max(32),
}).strict();
export type ConditionExpression = z.infer<typeof ConditionExpressionSchema>;

export type ConditionCheck =
  | { ok: true; expression: ConditionExpression }
  | { ok: false; error: string };

/** 保存和执行都走这一个解析器;未知操作符/空规则不退化成 false。 */
export function parseConditionExpression(raw: unknown): ConditionCheck {
  const parsed = ConditionExpressionSchema.safeParse(raw);
  if (parsed.success) return { ok: true, expression: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `(${issue.path.join(".")})` : "";
  return { ok: false, error: `条件规则${where}不合法: ${issue?.message ?? "未知错误"}` };
}

/** 只比较原始标量;对象不会通过隐式 toString 调用任意方法。 */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export type ConditionResult = { ok: true; matched: boolean } | { ok: false; error: string };

/** 不做短路:哪怕前一条已决定真假,后面的坏引用仍必须显式报错。 */
export function evaluateConditionExpression(
  expression: ConditionExpression,
  scope: NodeTemplateScope,
): ConditionResult {
  const answers: boolean[] = [];
  for (const rule of expression.rules) {
    const read = readConditionRef(rule.ref, scope);
    if (!read.ok) return read;
    if (rule.op === "exists") {
      // false / 0 / 空串 / 空数组都确实存在;只有没有值与 null 才算缺失。
      answers.push(read.found);
    } else if (!read.found) {
      answers.push(false);
    } else if (rule.op === "equal") {
      answers.push(textOf(read.value) === rule.value);
    } else {
      const raw = read.value;
      answers.push(
        typeof raw === "string" ? raw.includes(rule.value) :
        Array.isArray(raw) ? raw.some((item) => textOf(item) === rule.value) : false,
      );
    }
  }
  return { ok: true, matched: expression.logic === "and" ? answers.every(Boolean) : answers.some(Boolean) };
}
