/**
 * 【ARC-006】工作流节点的**扩展缝**回归网。
 *
 * ## 它守的是什么
 *
 * 用户的目标是把成熟工作流能力（Node-RED 之类）接进来，同时保留 Mcode 自己的
 * 用户交互节点（弹前端选项卡、资料库等）。要能接得进来，扩展缝必须成立，而且
 * 必需是**一条**：
 *
 *  1. **kind 三处同源**：`NodeRunnerSchema` 的 union（契约认哪些 kind）、
 *     `IMPLEMENTED_RUNNER_KINDS`（调度器认为哪些跑得起来）、以及每个
 *     `NodeTypeManifest.runner.kind`（清单实际用的）必须互相对得上。
 *     两处各写一份而漏改一处时，症状是"节点画得出来、发出去就报没有执行器"，
 *     或者反过来"契约说能跑、内置里根本没人用"。
 *  2. **执行器接缝是注册表，不是分支**：`createBuiltinExecutionEngine()` 只能
 *     通过 `.register(...)` 挂执行器；`executionEngine.ts` 里不得出现
 *     `if (kind === "...")` 形式的分派。
 *  3. **外部执行器的 fail-closed 边界**：`module-capability` 的缺失执行器必须
 *     落"失败"而不是模型兜底（P2-01-REQ-02）。
 *  4. **用户交互节点仍是 Mcode 的**：`askBeforeRun` 仍由 `conversation` 节点
 *     驱动，`choose` 端口仍由 runner 提供 —— 外部执行器不得替它回答。
 *
 * ## 为什么单独一套
 *
 * 既有 `orchestration-ipc-smoke` 已对账「清单 ↔ IMPLEMENTED_RUNNER_KINDS」，
 * 但**没有**把 `NodeRunnerSchema` 自身算进去：新 kind 只加 schema 不加常量时，
 * 那条网看不见。本套补的是这一格，且刻意用**真 schema 的 options** 而不是
 * 抄一份字面量（抄本会跟真货漂开）。
 *
 * Run: bash scripts/workflow-extension-seams-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeRunnerSchema, IMPLEMENTED_RUNNER_KINDS, isRunnerImplemented } from "@contracts/nodeType";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const root = process.cwd();

/* ══════════ 1. NodeRunnerSchema 的 kind 集合 == IMPLEMENTED_RUNNER_KINDS ══════════ */
{
  // DiscriminatedUnion 的 options 是内部结构；用公开 API 逐个探而不是读私有字段：
  // 对每个候选 kind 构造一个最小 runner 对象，看 schema 认不认。候选集来自
  // `IMPLEMENTED_RUNNER_KINDS` 本身 + 几个已知历史 kind，能覆盖"加了 schema 忘加常量"
  // 与"加了常量忘加 schema"两个方向。
  const contractKinds = [...(IMPLEMENTED_RUNNER_KINDS as readonly string[])].sort();
  // ⚠️ 必须从 **schema 自身**取 union 成员，不能拿常量当循环源 —— 拿常量当源时，
  // 常量少一项只是循环少一轮，断言**不会红**（第一版就这样，变异验证当场抓到）。
  // ZodDiscriminatedUnion 的 `.options` 是公开结构，直接读；每个 option 的
  // `shape.kind.value` 就是该分支的 literal。
  const union = NodeRunnerSchema as unknown as {
    options: Array<{ shape?: { kind?: { value?: unknown } } }>;
  };
  const schemaKinds = [...new Set(
    (union.options ?? [])
      .map((o) => o.shape?.kind?.value)
      .filter((v): v is string => typeof v === "string"),
  )].sort();
  check("前提：从 schema 里真的读到了 union 成员（防读到空集合的假绿）", schemaKinds.length >= 5, schemaKinds);

  eq("★ schema 认得的每个 kind 都在 IMPLEMENTED_RUNNER_KINDS 里（否则画得出来但跑不了）",
    schemaKinds.filter((k) => !contractKinds.includes(k)), []);
  eq("★ IMPLEMENTED_RUNNER_KINDS 里的每个 kind, NodeRunnerSchema 都认得（否则那个声明是空头支票）",
    contractKinds.filter((k) => !schemaKinds.includes(k)), []);

  // 每个 kind 的 isRunnerImplemented 必须与常量一致（防函数与常量分叉）。
  eq("★ isRunnerImplemented 与 IMPLEMENTED_RUNNER_KINDS 逐项一致",
    contractKinds.filter((k) => !isRunnerImplemented(k as never)), []);
}

/* ══════════ 2. 执行器接缝：注册表，不是 if 分支 ══════════ */
{
  const engineSrc = readFileSync(join(root, "src/main/orchestration/executionEngine.ts"), "utf8");
  const registrySrc = readFileSync(join(root, "src/main/orchestration/executorRegistry.ts"), "utf8");
  check("★ 内置执行器只经 .register(...) 挂载", /\.register\(new \w+Executor\(\)\)/.test(engineSrc));
  check("★ executionEngine 里没有按 kind 的 if/switch 分派",
    !/if\s*\(\s*kind\s*===\s*"/.test(engineSrc) && !/switch\s*\(\s*kind\s*\)/.test(engineSrc),
    (engineSrc.match(/if\s*\(\s*kind\s*===/g) ?? []).length);
  check("★ 注册表是通用的 kind→executor 映射（不含具体 kind 字面量）",
    !/"(prompt|conversation|command|code|module-capability)"/.test(registrySrc));
  check("★ module-capability 缺失执行器时不得落模型兜底",
    /MODULE_CAPABILITY_RUNNER_KIND\s*\?\s*undefined\s*:\s*this\.fallback/.test(engineSrc));
}

/* ══════════ 3. 用户交互节点仍由 Mcode 驱动 ══════════ */
{
  const nodeTypesSrc = readFileSync(join(root, "src/main/orchestration/nodeTypes.ts"), "utf8");
  const schedulerSrc = readFileSync(join(root, "src/main/orchestration/scheduler.ts"), "utf8");
  check("★ 「运行前先问我」参数仍在节点表单里", nodeTypesSrc.includes("NODE_ASK_PARAM_KEY"));
  check("★ ask 只在 conversation 节点上生效", /runner\.kind === "conversation" && askBeforeRunOf\(/.test(schedulerSrc));
  check("★ 选择端口由 runner 提供（外部执行器无法替用户回答）",
    /choose:\s*async\s*\(/.test(readFileSync(join(root, "src/main/orchestration/runner.ts"), "utf8")));
  // 用户交互的两个选择集合仍在契约里（渲染端靠它画选项卡）。
  const contractSrc = readFileSync(join(root, "../../packages/contracts/src/nodeType.ts"), "utf8");
  check("★ ASK_CHOICES 仍在契约里", /ASK_CHOICES\s*=/.test(contractSrc));
}

console.log(`\nworkflow-extension-seams-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
