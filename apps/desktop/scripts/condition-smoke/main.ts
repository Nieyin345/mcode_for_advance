import { builtinManifestById } from "@main/orchestration/nodeTypes.js";
import { runWorkflow, type RunPorts } from "@main/orchestration/scheduler.js";
import { validateWorkflowDoc } from "@main/orchestration/workflowValidation.js";
import { connect } from "@renderer/components/settings/workflows/workflowEdit.js";
import { defaultParamsOf } from "@contracts/nodeType";
import type { NodeOutcome, NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowNode, WorkflowEdge } from "@contracts/workflow";

let passed = 0, failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}
const AGENT: NodeTypeManifest = {
  id: "mcode.main", manifestVersion: 1, name: "入口",
  runner: { kind: "prompt" }, capability: "read",
  params: [{ key: "instruction", kind: "longtext", label: "指令", required: true }],
  outputs: [
    { key: "summary", label: "摘要" }, { key: "flag", label: "标记" },
    { key: "count", label: "计数" }, { key: "tags", label: "标签" },
    { key: "missing", label: "可选值" },
  ],
};
const CHILD: NodeTypeManifest = { ...AGENT, id: "mcode.agent", name: "后续" };
// Shape-cast deliberately: this smoke must compile BEFORE the new runner kind exists.
// It proves the old scheduler/validator behavior is red, not merely that an import is missing.
const CONDITION = {
  id: "mcode.condition", manifestVersion: 1, name: "条件",
  runner: { kind: "condition" }, capability: "read",
  params: [{ key: "expression", kind: "conditions", label: "条件", required: true }],
  outputs: [{ key: "result", label: "判定" }, { key: "branch", label: "出路" }],
} as unknown as NodeTypeManifest;
const types = new Map([AGENT, CHILD, CONDITION].map((m) => [m.id, m]));
function node(id: string, type: string, params: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, title: id, params, position: { x: 0, y: 0 } };
}
function edge(id: string, from: string, to: string, label?: string): WorkflowEdge {
  return { id, from, to, ...(label === undefined ? {} : { label }) };
}
const rule = (ref: string, op: "exists" | "equal" | "contains", value?: string) =>
  ({ ref, op, ...(value === undefined ? {} : { value }) });
const expression = (logic: "and" | "or", rules: unknown[]) => ({ logic, rules });
function graph(expr: unknown, labels: [string, string] = ["true", "false"]): WorkflowDoc {
  return {
    id: "wf_condition_smoke", name: "声明式条件回归", builtin: false, updatedAt: 0,
    nodes: [node("M", AGENT.id, { instruction: "读入这次的资料" }),
      node("C", CONDITION.id, { expression: expr }),
      node("YES", CHILD.id, { instruction: "走真路" }),
      node("NO", CHILD.id, { instruction: "走假路" }),
      node("JOIN", CHILD.id, { instruction: "汇总" })],
    edges: [edge("in", "M", "C"), edge("yes", "C", "YES", labels[0]),
      edge("no", "C", "NO", labels[1]), edge("yjoin", "YES", "JOIN"),
      edge("njoin", "NO", "JOIN")],
  };
}
const valid = graph(expression("and", [rule("{{M.summary}}", "contains", "ok")]));
const real = builtinManifestById("mcode.condition");
check("真内置节点可列出，且不会在模型或命令中执行", real?.runner.kind === "condition", real?.runner);
check("真清单允许 AND/OR 和三种谓词", real?.params.some((p) => p.key === "expression") === true);
const starter = real ? defaultParamsOf(real).expression : undefined;
check("添加内置条件节点时有可编辑的默认规则",
  typeof starter === "object" && starter !== null &&
  Array.isArray((starter as { rules?: unknown }).rules) &&
  (starter as { rules: unknown[] }).rules.length === 1);
const unconnected = { ...valid, edges: valid.edges.filter((e) => e.from !== "C") };
const first = connect(unconnected, "C", "YES");
const second = connect(first, "C", "NO");
check("画布连接时自动标 true / false",
  second.edges.find((e) => e.from === "C" && e.to === "YES")?.label === "true" &&
  second.edges.find((e) => e.from === "C" && e.to === "NO")?.label === "false");
check("画布不允许条件节点拉第三条出边", connect(second, "C", "JOIN") === second);
check("合法的两路条件图能保存", validateWorkflowDoc(valid, { types }).ok,
  validateWorkflowDoc(valid, { types }).errors);
const badLabels = graph(expression("and", [rule("{{M.summary}}", "exists")]), ["true", "true"]);
check("缺少 false 路且真假标签重复会拒绝保存",
  validateWorkflowDoc(badLabels, { types }).errors.some((e) => e.code === "condition.edges"));
const noRules = graph(expression("and", []));
check("空谓词禁止静默判定", validateWorkflowDoc(noRules, { types }).errors.some((e) => e.code === "param.invalid"));
const badLogic = graph({ logic: "xor", rules: [rule("{{M.summary}}", "exists")] });
check("拒绝未声明的逻辑运算符", validateWorkflowDoc(badLogic, { types }).errors.some((e) => e.code === "param.invalid"));
const badRef = graph(expression("and", [rule("{{ghost.summary}}", "exists")]));
check("条件里的引用也检查是不是上游", validateWorkflowDoc(badRef, { types }).errors.some((e) => e.code === "ref.unknown-node"));
const cycle: WorkflowDoc = { ...valid, edges: [...valid.edges, edge("cycle", "YES", "C")] };
check("自动条件不是人工环闸门", validateWorkflowDoc(cycle, { types }).errors.some((e) => e.code === "graph.cycle"));

async function run(doc: WorkflowDoc, root: NodeOutcome, resume?: Parameters<typeof runWorkflow>[0]["resume"]) {
  const executed: string[] = [], choices: string[] = [], snapshots: unknown[] = [];
  const ports: RunPorts = {
    async manifestOf(id) { return types.get(id); },
    async manifestDirOf() { return undefined; },
    contextLines() { return []; },
    async execute(n, _manifest, input) {
      executed.push(n.id);
      if (n.id === "M") return root;
      return { status: "success", summary: `${n.id}: ${input.prompt}` };
    },
    async choose(n) { choices.push(n.id); return { edgeId: "yes" }; },
    report() {}, snapshot(s) { snapshots.push(s); },
  };
  const result = await runWorkflow({ doc, prompt: "研究任务", ports, signal: new AbortController().signal,
    ...(resume ? { resume } : {}) });
  return { result, executed, choices, snapshots };
}
const payload: NodeOutcome = { status: "success", summary: "ok: test", outputs: {
  flag: false, count: 0, tags: ["A", "B"],
} };
const all = expression("and", [rule("{{M.flag}}", "exists"),
  rule("{{M.count}}", "equal", "0"), rule("{{M.tags}}", "contains", "B"),
  rule("{{M.summary}}", "contains", "ok")]);
{
  const { result, executed, choices } = await run(graph(all), payload);
  check("条件自动选真路，不调用选择框", choices.length === 0, choices);
  check("纯条件不派发模型/命令", !executed.includes("C"), executed);
  check("布尔 false / 数值 0 属于存在且能比较", result.outcomes.get("C")?.status === "success" &&
    result.outcomes.get("C")?.outputs?.result === true, result.outcomes.get("C"));
  check("只运行真路，假路标 unselected", executed.includes("YES") && !executed.includes("NO") &&
    result.outcomes.get("NO")?.status === "unselected", executed);
  check("真假汇合点仍执行，透传上游结果", executed.includes("JOIN") &&
    result.outcomes.get("C")?.summary.includes("ok: test") === true, result.outcomes.get("C"));
  check("真假选择写入可续跑的 picks", result.state.picks.some(([id, choice]) =>
    id === "C" && choice.edgeId === "yes"), result.state.picks);
  const resumed = await run(graph(all), payload, {
    record: result.state.record, rounds: result.state.rounds, picks: result.state.picks,
    settled: [["M", payload], ["C", result.outcomes.get("C") as NodeOutcome]],
  });
  check("续跑读取真假选择，不重算已经定案的条件", resumed.executed.includes("YES") &&
    !resumed.executed.includes("NO") && !resumed.executed.includes("C") &&
    resumed.choices.length === 0, resumed.executed);
}
{
  const expr = expression("or", [rule("{{M.missing}}", "exists"), rule("{{M.summary}}", "equal", "ok: test")]);
  const { result, executed } = await run(graph(expr), payload);
  check("缺失值 exists=false，OR 仍可走另一条真条件", result.outcomes.get("C")?.outputs?.result === true &&
    executed.includes("YES"), result.outcomes.get("C"));
}
{
  const { result, executed } = await run(graph(expression("and", [rule("{{M.summary}}", "contains", "not-here")])), payload);
  check("假条件只运行假路", executed.includes("NO") && !executed.includes("YES") &&
    result.outcomes.get("YES")?.status === "unselected" &&
    result.state.picks.some(([id, p]) => id === "C" && p.edgeId === "no"), result.state.picks);
}
{
  const { result, executed } = await run(badLogic, payload);
  check("绕过存盘校验也不会盲选未知表达式", result.outcomes.get("C")?.status === "failed" &&
    !executed.includes("YES") && !executed.includes("NO"), result.outcomes.get("C"));
}
{
  const { result, executed } = await run(badRef, payload);
  check("非法引用不被当作 exists=false 悄悄放行", result.outcomes.get("C")?.status === "failed" &&
    !executed.includes("YES") && !executed.includes("NO"), result.outcomes.get("C"));
}
{
  // A literal RHS must never be executed as JavaScript.
  const expr = expression("and", [rule("{{M.summary}}", "equal", "globalThis.conditionInjected = true")]);
  const { result } = await run(graph(expr), payload);
  check("比较值永远是数据而不是 eval", (globalThis as { conditionInjected?: boolean }).conditionInjected !== true &&
    result.outcomes.get("C")?.outputs?.result === false);
}
{
  // 比较值的花括号也只是数据,不能被展开成另一个上游值。
  const { result } = await run(graph(expression("and", [rule("{{M.summary}}", "equal", "{{M.summary}}")])) , payload);
  check("右侧比较文本即使有 {{ }} 也不插值",
    result.outcomes.get("C")?.outputs?.result === false, result.outcomes.get("C"));
}
console.log(`condition-smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
