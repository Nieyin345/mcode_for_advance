/**
 * Headless smoke for the structured-output degradation pipeline
 * (main/lib/structuredOutput.ts).
 *
 * 这套管道是 Codex / Pi（以及走自定义网关的 Claude）产出结构化结果的唯一
 * 通路：提示词注入 → 轮末抽取 → schema 校验 → 纠错轮。每一环都是纯函数,
 * 写错的方式都是"安静地放行坏 JSON"或"安静地拒掉好 JSON" —— 两种都必须
 * 在这里钉死。没有覆盖的:三个 provider 里的接线(重试一轮、turn.notice
 * 的发出时机)——那些要活的引擎,靠手测。
 *
 * Run: scripts/structured-output-smoke/run.sh
 */
import {
  buildCorrectivePrompt,
  buildStructuredOutputPrompt,
  extractJsonDocument,
  parseStructuredOutput,
  validateAgainstSchema,
} from "@main/lib/structuredOutput.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    score: { type: "integer" },
  },
  required: ["title"],
} as Record<string, unknown>;

/* ────────────────────── 1. 提示词 ────────────────────── */

console.log("\nbuildStructuredOutputPrompt / buildCorrectivePrompt");

const prompt = buildStructuredOutputPrompt({ name: "result", schema: SCHEMA });
check("指令里带 schema 名", prompt.includes("result"), prompt.slice(0, 80));
check("指令里带 schema 全文", prompt.includes('"required"'));
check("明确禁止代码围栏", prompt.includes("代码围栏"));

const corrective = buildCorrectivePrompt({ name: "result", schema: SCHEMA }, "第 1 行错了");
check("纠错轮带上一轮的错误原文", corrective.includes("第 1 行错了"));
check("纠错轮仍然禁止围栏", corrective.includes("代码围栏"));

/* ────────────────────── 2. 抽取 ────────────────────── */

console.log("\nextractJsonDocument(从回复文本里抠 JSON)");

const obj = { title: "你好", score: 3 };
const arr = [1, 2, 3];

const bare = extractJsonDocument(JSON.stringify(obj));
check("裸对象解析成功", bare.ok, bare);
check("裸对象的值原样", bare.ok && (bare.value as typeof obj).title === "你好");

check("裸数组也认", (extractJsonDocument(JSON.stringify(arr)) as { ok: boolean }).ok);
check("空对象也算一个文档", (extractJsonDocument("{}") as { ok: boolean }).ok);

check(
  "json 围栏剥掉",
  (extractJsonDocument("```json\n" + JSON.stringify(obj) + "\n```") as { ok: boolean }).ok,
);
check(
  "无语言标注的围栏也剥",
  (extractJsonDocument("```\n" + JSON.stringify(obj) + "\n```") as { ok: boolean }).ok,
);
check(
  "围栏内的大写 JSON 标注不挑食",
  (extractJsonDocument("```JSON\n" + JSON.stringify(obj) + "\n```") as { ok: boolean }).ok,
);
check(
  "前后有寒暄也能抠出来",
  (() => {
    const r = extractJsonDocument(`好的,结果如下:\n${JSON.stringify(obj)}\n请查收。`);
    return r.ok && (r.value as typeof obj).score === 3;
  })(),
);

// 前置说明里出现一个**配平但不合法**的花括号片段(模型爱写"示例 {x}"),真正的文档在末尾。
// 只取第一个 `{` 会挑中示例、parse 失败,白白触发一次纠错轮。应当取最后一个能 parse 的。
check(
  "前置说明里的花括号示例不抢走真正的 JSON 文档",
  (() => {
    const r = extractJsonDocument(`可选的 shape 是 {key: value}(示意),正式结果:\n${JSON.stringify(obj)}`);
    return r.ok && (r.value as typeof obj).score === 3;
  })(),
);

// 字符串字面量里的花括号 / 引号不该骗过配平扫描 —— 模型最爱在值里写 JSON 示例。
check(
  "字符串里的花括号不破坏配平",
  (() => {
    const r = extractJsonDocument(`{"a": "这里有 { 和 } 还有 \\" 引号", "b": 1}`);
    return r.ok && (r.value as { b: number }).b === 1;
  })(),
);
check(
  "嵌套结构整体抽出",
  (() => {
    const r = extractJsonDocument(`{"outer": {"inner": [1, {"x": 2}]}}`);
    return r.ok && (r.value as { outer: { inner: unknown[] } }).outer.inner.length === 2;
  })(),
);
check(
  "JSON 后面的垃圾不带进来",
  (() => {
    const r = extractJsonDocument(`{"a": 1} 这后面全是废话`);
    return r.ok && Object.keys(r.value as object).length === 1;
  })(),
);

check("没有 JSON → 明确报错", !extractJsonDocument("抱歉,我做不到").ok);
check("括号没配平 → 明确报错", !extractJsonDocument('{"a": [1, 2').ok);
check("假 JSON(语法坏) → 明确报错", !extractJsonDocument('{"a": ??}').ok);
check("空文本 → 明确报错", !extractJsonDocument("").ok);

/* ────────────────────── 3. 校验 ────────────────────── */

console.log("\nvalidateAgainstSchema(常用子集)");

eq("符合 schema → 无错误", validateAgainstSchema({ title: "a", score: 2 }, SCHEMA).length, 0);
check(
  "缺 required 字段要报",
  validateAgainstSchema({ score: 2 }, SCHEMA).some((e) => e.includes("title")),
);
check(
  "类型不对要报(integer 收到 string)",
  validateAgainstSchema({ title: "a", score: "2" }, SCHEMA).some((e) => e.includes("score")),
);
eq(
  "integer 收到 3.0 也是整数(JSON 里没有真正的整数)",
  validateAgainstSchema({ title: "a", score: 3.0 }, SCHEMA).length,
  0,
);
check(
  "integer 收到 3.5 要报",
  validateAgainstSchema({ title: "a", score: 3.5 }, SCHEMA).length > 0,
);

check(
  "联合类型任一命中就行",
  validateAgainstSchema("txt", { type: ["string", "number"] }).length === 0,
);
check("联合类型全不中要报", validateAgainstSchema(true, { type: ["string", "number"] }).length > 0);

check(
  "enum 命中",
  validateAgainstSchema("b", { type: "string", enum: ["a", "b"] }).length === 0,
);
check(
  "enum 不命中要报",
  validateAgainstSchema("c", { type: "string", enum: ["a", "b"] }).length > 0,
);

const STRICT = {
  type: "object",
  properties: { a: { type: "number" } },
  additionalProperties: false,
  required: ["a"],
} as Record<string, unknown>;
eq("additionalProperties: false + 没多字段 → 过", validateAgainstSchema({ a: 1 }, STRICT).length, 0);
check(
  "多出来的字段要报",
  validateAgainstSchema({ a: 1, extra: true }, STRICT).some((e) => e.includes("extra")),
);

const NESTED = {
  type: "object",
  properties: {
    rows: { type: "array", items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  },
  required: ["rows"],
} as Record<string, unknown>;
eq("嵌套数组全对 → 过", validateAgainstSchema({ rows: [{ id: 1 }, { id: 2 }] }, NESTED).length, 0);
check(
  "嵌套里的错误带路径",
  validateAgainstSchema({ rows: [{ id: 1 }, { nope: 2 }] }, NESTED).some((e) => e.includes("rows[1]")),
);

// null 和 undefined 是 JSON 里不存在的值 —— 传进来不能崩,要当类型错误报。
check("null 值报类型错误不崩", validateAgainstSchema(null, { type: "object" }).length > 0);
eq("可选字段缺着不算错", validateAgainstSchema({}, SCHEMA).length, 1); // 只有 required 那一条

/* ────────────────────── 4. 组合入口 ────────────────────── */

console.log("\nparseStructuredOutput(抽取 + 校验一步)");

const good = parseStructuredOutput(`结果:\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``, {
  name: "result",
  schema: SCHEMA,
});
check("围栏 + 寒暄的组合输入解析成功", good.ok, good);
check("值穿透出来", good.ok && (good.value as typeof obj).title === "你好");

const badSchema = parseStructuredOutput(JSON.stringify({ nope: 1 }), { name: "result", schema: SCHEMA });
check("schema 不符 → 报错带名字", !badSchema.ok && badSchema.error.includes("result"), badSchema);

check("提取不到 → 报的是提取错误", !parseStructuredOutput("没得说", { name: "r", schema: SCHEMA }).ok);

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
