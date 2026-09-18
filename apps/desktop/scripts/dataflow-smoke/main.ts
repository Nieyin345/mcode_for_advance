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
const doc: WorkflowDoc = {
  id: "wf_dataflow", name: "dataflow", builtin: false, updatedAt: 0,
  nodes: [
    node("A", CODE.id, { code: "pass", language: "python" }),
    node("B", CODE.id, { code: "pass", language: "python" }),
  ],
  edges: [{ id: "e_A__B", from: "A", to: "B" }],
};

const seen: Record<string, unknown> = {};
const ports: RunPorts = {
  async manifestOf(typeId) { return typeId === CODE.id ? CODE : undefined; },
  contextLines() { return []; },
  async choose() { return { edgeId: "" }; },
  async execute(target, _manifest, input) {
    seen[target.id] = input;
    const outcome: NodeOutcome = target.id === "A"
      ? { status: "success", summary: "A finished", outputs: { answer: 42 }, artifacts: [{ kind: "file", uri: "D:/work/result.txt", name: "result.txt" }] }
      : { status: "success", summary: "B finished" };
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

console.log(`\nPASS: ${total - failures}/${total} checks`);
if (failures) process.exitCode = 1;
