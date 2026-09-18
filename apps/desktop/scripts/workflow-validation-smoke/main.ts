import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowEdge, WorkflowNode } from "@contracts/workflow";
import {
  exportWorkflowDoc,
  importWorkflowDoc,
  validateWorkflowDoc,
  WORKFLOW_SCHEMA_VERSION,
} from "@main/orchestration/workflowValidation.js";

/* ── 断言骨架 ── */

let total = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? "");
  }
}
function hasCode(report: { errors: { code: string; nodeId?: string }[] }, code: string, nodeId?: string): boolean {
  return report.errors.some((e) => e.code === code && (nodeId === undefined || e.nodeId === nodeId));
}

/* ── 夹具:一份最小的类型清单(纯数据,不读盘) ── */

function agentManifest(id: string): NodeTypeManifest {
  return {
    id,
    manifestVersion: 1,
    name: id,
    runner: { kind: "prompt" },
    capability: "read",
    params: [
      { key: "instruction", kind: "longtext", label: "指令", required: true },
      { key: "outputVars", kind: "variables", label: "产出变量" },
    ],
    outputs: [{ key: "summary", label: "结果文本" }],
  };
}
const TYPES = new Map<string, NodeTypeManifest>([
  ["mcode.main", agentManifest("mcode.main")],
  ["mcode.agent", agentManifest("mcode.agent")],
  ["mcode.branch", { id: "mcode.branch", manifestVersion: 1, name: "分支", runner: { kind: "branch" }, capability: "read", params: [] }],
  ["mcode.trigger", { id: "mcode.trigger", manifestVersion: 1, name: "触发器", runner: { kind: "trigger" }, capability: "read", params: [] }],
]);

/* ── 夹具:文档构造 ── */

function node(id: string, type: string, params: Record<string, unknown>, title = id): WorkflowNode {
  return { id, type, title, params, position: { x: 0, y: 0 } };
}
function edge(id: string, from: string, to: string): WorkflowEdge {
  return { id, from, to };
}
function doc(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDoc {
  return { id: "wf_smoke", name: "冒烟", builtin: false, updatedAt: 0, nodes, edges };
}
const SAY = { instruction: "做这一步" };
const OPTS = { types: TYPES };

/* ── 1. 合法文档:全绿,零错误零警告 ── */

const validDoc = doc(
  [
    node("A", "mcode.main", { instruction: "先看 {{user}} 说了什么再拆;字面写法 \\{{not-a-ref}} 不是引用" }),
    node("B", "mcode.agent", { instruction: "算出年份", outputVars: [{ name: "年份", example: "2024" }] }),
    node("C", "mcode.agent", { instruction: "把 {{B.年份}} 写进结论,依据 {{A}} 的拆解" }),
  ],
  [edge("e1", "A", "B"), edge("e2", "B", "C")],
);
const good = validateWorkflowDoc(validDoc, OPTS);
check("合法文档通过", good.ok, good);
check("合法文档零错误零警告", good.errors.length === 0 && good.warnings.length === 0, good);
check("转义与 {{user}} 不算坏引用", good.ok, good.errors);

/* ── 2. 图错误 ── */

const cycle = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", SAY), node("C", "mcode.agent", SAY)], [edge("e1", "A", "B"), edge("e2", "B", "C"), edge("e3", "C", "A")]),
  OPTS,
);
check("无闸门的环被拒", hasCode(cycle, "graph.cycle"), cycle.errors);

const orphan = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", SAY), node("D", "mcode.agent", SAY, "孤步骤")], [edge("e1", "A", "B")]),
  OPTS,
);
check(
  "断链(无入边且非起点)只提醒不拦 —— 旧语义允许多入口图",
  orphan.ok === true && orphan.warnings.some((w) => w.code === "graph.orphan-node" && w.nodeId === "D"),
  { ok: orphan.ok, warnings: orphan.warnings },
);

const dangling = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY)], [edge("e1", "A", "ghost")]),
  OPTS,
);
check("悬空边被报出", hasCode(dangling, "graph.dangling-edge"), dangling.errors);

const selfLoop = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY)], [edge("e1", "A", "A")]),
  OPTS,
);
check("自环被报出", hasCode(selfLoop, "graph.self-loop", "A"), selfLoop.errors);

const dup = validateWorkflowDoc(
  doc([node("dup", "mcode.agent", SAY), node("dup", "mcode.agent", SAY)], []),
  OPTS,
);
check("节点 id 重复被报出", hasCode(dup, "graph.duplicate-node-id", "dup"), dup.errors);

const gatedCycle = validateWorkflowDoc(
  doc(
    [node("A", "mcode.main", SAY), node("BR", "mcode.branch", { decider: "user" }), node("B", "mcode.agent", SAY)],
    [edge("e1", "A", "BR"), edge("e2", "BR", "B"), edge("e3", "B", "BR")],
  ),
  OPTS,
);
check("环上有用户分支闸门 → 放行", gatedCycle.ok, gatedCycle.errors);

const modelCycle = validateWorkflowDoc(
  doc(
    [node("A", "mcode.main", SAY), node("BR", "mcode.branch", { decider: "model" }), node("B", "mcode.agent", SAY)],
    [edge("e1", "A", "BR"), edge("e2", "BR", "B"), edge("e3", "B", "BR")],
  ),
  OPTS,
);
check("模型选的分支当闸门 → 环仍被拒", hasCode(modelCycle, "graph.cycle"), modelCycle.errors);

const bareBranch = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("BR", "mcode.branch", {})], [edge("e1", "A", "BR")]),
  OPTS,
);
check("分支没有出边 → branch.no-options", hasCode(bareBranch, "branch.no-options", "BR"), bareBranch.errors);

/* ── 3. 节点类型与参数 ── */

const unknownStrict = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("G", "mcode.ghost", {})], [edge("e1", "A", "G")]),
  OPTS,
);
check("未知类型默认报 error", hasCode(unknownStrict, "node.unknown-kind", "G") && !unknownStrict.ok, unknownStrict.errors);

const unknownLenient = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("G", "mcode.ghost", {})], [edge("e1", "A", "G")]),
  { types: TYPES, unknownTypeSeverity: "warning" },
);
check("存盘档位:未知类型降为 warning 且放行", !hasCode(unknownLenient, "node.unknown-kind") && unknownLenient.ok && unknownLenient.warnings.some((w) => w.code === "node.unknown-kind"), { errors: unknownLenient.errors, warnings: unknownLenient.warnings });

const missing = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", {})], [edge("e1", "A", "B")]),
  OPTS,
);
check("必填参数缺失 → param.missing", hasCode(missing, "param.missing", "B"), missing.errors);

const badShape = validateWorkflowDoc(
  doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", { instruction: "x", outputVars: "不是表" })], [edge("e1", "A", "B")]),
  OPTS,
);
check("参数形状不符 → param.invalid", hasCode(badShape, "param.invalid", "B"), badShape.errors);

/* ── 4. `{{...}}` 引用存在性 ── */

const refs = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", SAY),
      node("B", "mcode.agent", { instruction: "算年份", outputVars: [{ name: "年份", example: "2024" }] }),
      node("C", "mcode.agent", { instruction: "整理 {{}} 与 {{幽灵.东西}} 与 {{B.标题}}" }),
      node("D", "mcode.agent", { instruction: "看 {{B.年份}}" }),
    ],
    [edge("e1", "A", "B"), edge("e2", "B", "C"), edge("e3", "A", "D")],
  ),
  OPTS,
);
check("空引用 → ref.empty", hasCode(refs, "ref.empty", "C"), refs.errors);
check("引用不存在的节点 → ref.unknown-node", hasCode(refs, "ref.unknown-node", "C"), refs.errors);
check("上游未声明的变量 → ref.unknown-output", hasCode(refs, "ref.unknown-output", "C"), refs.errors);
check("引用旁支 → ref.not-upstream", hasCode(refs, "ref.not-upstream", "D"), refs.errors);

const dupTitle = validateWorkflowDoc(
  doc(
    [
      node("A", "mcode.main", { instruction: "拆" }),
      node("B1", "mcode.agent", { ...SAY, outputVars: [{ name: "年份", example: "2024" }] }, "同名"),
      node("B2", "mcode.agent", { ...SAY, outputVars: [{ name: "年份", example: "2024" }] }, "同名"),
      node("C", "mcode.agent", { instruction: "取 {{同名.年份}}" }),
    ],
    [edge("e1", "A", "B1"), edge("e2", "A", "B2"), edge("e3", "B1", "C"), edge("e4", "B2", "C")],
  ),
  OPTS,
);
check("标题重名 → ref.ambiguous-title", hasCode(dupTitle, "ref.ambiguous-title", "C"), dupTitle.errors);

/* ── 5. 导入 / 导出(WF-08) ── */

const badJson = importWorkflowDoc("{oops", OPTS);
check("非法 JSON 被拒", !badJson.ok && badJson.report.errors[0]?.code === "schema.invalid-json", badJson.ok ? badJson : badJson.report.errors);

const badShapeDoc = importWorkflowDoc(JSON.stringify({ id: "x" }), OPTS);
check("形状不符契约被拒", !badShapeDoc.ok && badShapeDoc.report.errors[0]?.code === "schema.invalid", badShapeDoc.ok ? badShapeDoc : badShapeDoc.report.errors);

const futureVersion = importWorkflowDoc(JSON.stringify({ ...validDoc, schemaVersion: "9" }), OPTS);
check("不支持的 schemaVersion 被拒", !futureVersion.ok && futureVersion.report.errors[0]?.code === "schema.version-unsupported", futureVersion.ok ? futureVersion : futureVersion.report.errors);

const failingDoc = importWorkflowDoc(JSON.stringify(doc([node("A", "mcode.main", SAY), node("B", "mcode.agent", {})], [edge("e1", "A", "B")])), OPTS);
check("校验失败的文档被拒并带回 report", !failingDoc.ok && hasCode(failingDoc.ok ? { errors: [] } : failingDoc.report, "param.missing"), failingDoc.ok ? "ok?!" : failingDoc.report.errors);

const unknownDoc = JSON.stringify({ ...doc([node("A", "mcode.main", SAY), node("G", "mcode.ghost", {})], [edge("e1", "A", "G")]) });
// 默认档 = 注入类型清单、unknownTypeSeverity 走默认 error;宽松档显式降级。
const importStrict = importWorkflowDoc(unknownDoc, OPTS);
const importLenient = importWorkflowDoc(unknownDoc, { types: TYPES, unknownTypeSeverity: "warning" });
check("导入默认档:未知类型 = error", !importStrict.ok && importStrict.report.errors.some((e) => e.code === "node.unknown-kind"), importStrict.ok ? importStrict : importStrict.report.errors);
check("导入宽松档:未知类型 = warning 放行", importLenient.ok && importLenient.doc.schemaVersion === WORKFLOW_SCHEMA_VERSION, importLenient.ok ? importLenient.doc : importLenient.report);

const roundtrip = importWorkflowDoc(exportWorkflowDoc(validDoc), OPTS);
check("export→import 往返无损", roundtrip.ok, roundtrip.ok ? roundtrip.doc : roundtrip.report.errors);
check(
  "往返内容逐字段一致",
  roundtrip.ok && JSON.stringify(JSON.parse(exportWorkflowDoc(validDoc))) === JSON.stringify({ ...validDoc, schemaVersion: WORKFLOW_SCHEMA_VERSION }),
  roundtrip.ok ? undefined : roundtrip.report,
);
check("导入成功时补上 schemaVersion", roundtrip.ok && roundtrip.doc.schemaVersion === WORKFLOW_SCHEMA_VERSION, roundtrip.ok ? roundtrip.doc.schemaVersion : roundtrip.report);

console.log(`\nPASS: ${total - failures}/${total} checks`);
if (failures > 0) process.exitCode = 1;
