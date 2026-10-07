import { runWorkflow, type RunPorts } from "@main/orchestration/scheduler.js";
import type { NodeOutcome, NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowNode } from "@contracts/workflow";

let total = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}`, detail ?? ""); }
}
function node(id: string, type: string, params: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, title: id, params, position: { x: 0, y: 0 } };
}
const CODE: NodeTypeManifest = {
  id: "x.code", manifestVersion: 1, name: "Code", runner: { kind: "code", language: "python" }, capability: "exec",
  params: [{ key: "code", kind: "longtext", label: "代码", required: true }, { key: "language", kind: "select", label: "语言", options: [{ value: "python", label: "Python" }] }],
};
/** 岔路口 —— 决定权在用户,出路全在边上(`runner.kind === "branch"`)。 */
const BRANCH: NodeTypeManifest = {
  id: "mcode.branch", manifestVersion: 1, name: "分支", runner: { kind: "branch" }, capability: "read", params: [],
};
const doc: WorkflowDoc = {
  id: "wf_dataflow", name: "dataflow", builtin: false, updatedAt: 0,
  nodes: [
    node("A", CODE.id, { code: "pass", language: "python" }),
    node("B", CODE.id, { code: "pass", language: "python" }),
  ],
  edges: [{ id: "e_A__B", from: "A", to: "B" }],
};

/** 上游那句独一份的正文 —— 拿来钉"没走的那条路上的内容不许漏进下游提示词"。 */
const A_BODY = "A finished";

const seen: Record<string, unknown> = {};
const ports: RunPorts = {
  async manifestOf(typeId) { return typeId === CODE.id ? CODE : typeId === BRANCH.id ? BRANCH : undefined; },
  async manifestDirOf() { return undefined; },
  contextLines() { return []; },
  async choose(_node, options) { return { edgeId: options[0]?.id ?? "" }; },
  async execute(target, _manifest, input) {
    seen[target.id] = input;
    const outcome: NodeOutcome = target.id === "A"
      ? { status: "success", summary: A_BODY, outputs: { answer: 42 }, artifacts: [{ kind: "file", uri: "D:/work/result.txt", name: "result.txt" }] }
      : { status: "success", summary: `${target.id} 的结果` };
    return outcome;
  },
  report() {},
  snapshot() {},
};

const result = await runWorkflow({ doc, prompt: "run", ports, signal: new AbortController().signal });
const bInput = seen.B as any;
check("workflow succeeds", result.status === "success", result.status);
check("downstream receives structured data context", bInput?.data?.upstreamOutputs?.A?.answer === 42 && bInput?.data?.userInput === "run", bInput);
check("downstream receives upstream outputs", bInput?.data?.upstreamOutputs?.A?.answer === 42, bInput);
check("downstream receives artifact reference", bInput?.data?.upstreamArtifacts?.[0]?.uri === "D:/work/result.txt", bInput);
check("downstream keeps artifact name", bInput?.data?.upstreamArtifacts?.[0]?.name === "result.txt", bInput);
check("downstream still receives human-readable upstream summary", bInput?.data?.upstreamText?.includes("A finished") === true, bInput?.upstream);
/* ─────────── 分支:没走的那条路上的内容不许漏进下游 ───────────
 *
 *     A ──→ U(岔路口)──[整理]──→ X ──┐
 *              └──────[跳过整理]──→ D ←─┘   (U→D 是图上画着、但**没被选中**的那条边)
 *
 * 用户选了「整理」。就绪判断走的是**活跃上游**(没走的路不算上游),所以 D 的上游只剩 X
 * —— 而 U→D 那根线还在前向邻接表里,且 U 自己是 `success`(透传成功)。
 *
 * ⚠️ 按邻接表拼 `upstreamText` / `upstreamOutputs` 的话,`U` 透传的**A 的正文**会跟着
 * 进 D 的提示词 —— 模型以为那是上游交出来的东西,而那一步**这次压根没走**。一句话都
 * 不报错,是这种漏法最坏的地方。
 */
{
  const branchDoc: WorkflowDoc = {
    id: "wf_branch", name: "branch", builtin: false, updatedAt: 0,
    nodes: [
      node("A", CODE.id, { code: "pass", language: "python" }),
      { id: "U", type: BRANCH.id, title: "下一步", params: {}, position: { x: 0, y: 0 } },
      node("X", CODE.id, { code: "pass", language: "python" }),
      node("D", CODE.id, { code: "pass", language: "python" }),
    ],
    edges: [
      { id: "e_A__U", from: "A", to: "U" },
      { id: "e_U__X", from: "U", to: "X", label: "整理" },
      { id: "e_U__D", from: "U", to: "D", label: "跳过整理" },
      { id: "e_X__D", from: "X", to: "D" },
    ],
  };
  seen.A = seen.X = seen.D = undefined;
  const r = await runWorkflow({ doc: branchDoc, prompt: "run", ports, signal: new AbortController().signal });
  const xText = (seen.X as any)?.data?.upstreamText as string | undefined;
  const dText = (seen.D as any)?.data?.upstreamText as string | undefined;
  check("分支跑通了", r.status === "success", r.status);
  // 正控:X 是**被选中**那条路的下游,它拿得到 A 的正文(不然下面那条断言是空过)。
  check("选中的那条路拿到了 A 的正文", xText?.includes(A_BODY) === true, xText);
  check("★ 没走的那条路的下游拿不到 A 的正文", dText?.includes(A_BODY) === false, dText);
  check("★ 但它拿得到真正走过的上游 X 的产出", dText?.includes("X 的结果") === true, dText);
}

console.log(`\nPASS: ${total - failures}/${total} checks`);
if (failures) process.exitCode = 1;
