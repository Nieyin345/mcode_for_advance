import { WorkflowDocSchema, type WorkflowDoc } from "@contracts/workflow";
import { snapshotMcodeNodeInvocation } from "@main/workflowEngines/mcodeNodePack.js";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { flowToWorkflowDoc, migrateWorkflowDoc, roundTripMismatchPaths } from "@main/workflowEngines/flowMigration.js";
import {
  effectiveWorkflowEngine, assertWorkflowExecutor,
  assertNativeEngineSelection, checkEngineSwitch,
} from "@main/workflowEngines/workflowEngineSelection.js";
let total = 0, failed = 0;
function check(name: string, yes: boolean, details?: unknown): void {
  total++;
  if (yes) console.log("  ok   " + name);
  else { failed++; console.log("  FAIL " + name + " — " + JSON.stringify(details)); }
}
const nativeMessage = snapshotMcodeNodeInvocation(
  { _msgid: "native-run-001", payload: "input" },
  { id: "native-node", z: "tab-001", instruction: "do it" },
);
check("Node-RED 的 _msgid 按整次图运行聚合同一 runId", nativeMessage.runId === "native-run-001");
check("宿主可取得原生 tab 身份以关联工作流看板", nativeMessage.tabId === "tab-001");
const manifest: NodeTypeManifest = {
  id: "mcode.agent", manifestVersion: 1, name: "Agent", runner: { kind: "prompt" }, capability: "read", params: [],
};
const types = new Map([["mcode.agent", manifest]]);
const legacy: WorkflowDoc = {
  id: "legacy-fixture", name: "旧图", builtin: false, updatedAt: 0,
  nodes: [{ id: "step1", type: "mcode.agent", title: "Step", position: { x: 20, y: 30 }, params: { instruction: "Hello" } }],
  edges: [],
};
const native = { ...legacy, engine: "node-red" } as const;
check("旧库契约接受无 engine 的存档", WorkflowDocSchema.safeParse(legacy).success);
check("旧图按原生 runner 推断，绝不静默变 node-red", effectiveWorkflowEngine(legacy) === "mcode");
check("新图 engine=node-red 不能进入原生调度器", (() => {
  try { assertWorkflowExecutor(native, "mcode"); return false; }
  catch (e) { return e instanceof Error && e.message.includes("node-red") && e.message.includes("拒绝"); }
})());
check("旧图 engine=mcode 不能进入 Node-RED", (() => {
  try { assertWorkflowExecutor(legacy, "node-red"); return false; }
  catch (e) { return e instanceof Error && e.message.includes("mcode") && e.message.includes("拒绝"); }
})());
const serialized = migrateWorkflowDoc(legacy, {types}).flow;
const roundtrip = flowToWorkflowDoc(serialized);
check("旧图迁移与反迁移引擎仍是 mcode", effectiveWorkflowEngine(roundtrip) === "mcode",
  roundTripMismatchPaths({ ...legacy, engine: "mcode" }, roundtrip));
check("迁移后 roundTripMismatchPaths 读取 engine 差异", roundTripMismatchPaths(native, roundtrip).includes("engine"));
const switched = checkEngineSwitch(legacy,"node-red",types);
check("无丢失旧图允许显式切换 node-red", switched.ok, switched);
const lossy = { ...legacy, nodes: [{ ...legacy.nodes[0]!, type: "unknown-plugin" }] };
const deny = checkEngineSwitch(lossy,"node-red",types);
check("未知语义被拒绝且原因列出 nodes[step1]", !deny.ok && deny.paths.some(x=>x.includes("step1")) && deny.reason.includes("丢失"),deny);
const back = checkEngineSwitch(native,"mcode",types);
check("没有引擎当前 flow 的反向切换 fail-closed", !back.ok && back.paths.includes("flows.json"),back);
const realNative = migrateWorkflowDoc(native, { types }).flow;
const restored = checkEngineSwitch(native, "mcode", types, realNative);
check("取得当前 Node-RED flow 且无损时允许反向切换", restored.ok, restored);
const impossible = checkEngineSwitch(
  { ...native, nodes: [{ ...native.nodes[0]!, type: "unknown-plugin" }] }, "mcode", types,
  migrateWorkflowDoc({ ...native, nodes: [{ ...native.nodes[0]!, type: "unknown-plugin" }] }, { types }).flow,
);
check("反向切换遇到未知节点类型拒绝", !impossible.ok && impossible.reason.includes("step1"), impossible);
const tab = [{ id:"tab1",type:"tab","x-mcode":{docId:legacy.id,engine:"node-red"} }];
check("伪造 node-red 元数据无法越过宿主引擎归属", (() => {
  try { assertNativeEngineSelection(tab,()=>legacy); return false; }
  catch(e) { return e instanceof Error && e.message.includes("mcode"); }
})());
check("真实 node-red 允许 Node-RED 部署", (() => {
  try { assertNativeEngineSelection(tab,()=>native); return true; }
  catch { return false; }
})());
check("宿主找不到已标记工作流时不允许执行", (() => {
  try { assertNativeEngineSelection(tab,()=>null); return false; }
  catch(e) { return e instanceof Error && e.message.includes("不在宿主"); }
})());
console.log(`workflow-engine-selection:${total-failed}/${total} 通过`);
if (failed) process.exitCode=1;
