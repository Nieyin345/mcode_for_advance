/**
 * W25: real shipped workflow fixture → real native migrator → Node-RED form →
 * actual production Host trigger.subscribe, with only the runtime emitter stubbed.
 * The custom-UI trigger.input.* is NOT synthesized from a RuntimeEvent.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { migrateWorkflowDoc, flowToWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { loadWorkflowIntoNative, type NativeLoadPorts } from "@main/workflowEngines/nativeLibraryLoad.js";
import { triggerNodeHtml, triggerSubscribePayload } from "@main/workflowEngines/mcodeNodeTypes.js";
import { productionNodePackServices } from "@main/workflowEngines/nodePackProductionPorts.js";
import { emitEvent, resetRuntime } from "../mcode-node-pack-ports-smoke/stubs/runtimeManager.js";

let count = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  count++;
  if (ok) console.log("  ok   " + name);
  else { failed++; console.error("  FAIL " + name, detail === undefined ? "" : JSON.stringify(detail)); }
}
const fixtures = JSON.parse(readFileSync(join(process.cwd(), "resources/presets/workflows.json"), "utf8")) as {
  workflows: Array<{ id: string; name: string; nodes: WorkflowDoc["nodes"]; edges: WorkflowDoc["edges"] }>;
};
const realPreset = fixtures.workflows.find(w => w.id === "wf_auto_download")!;
const source: WorkflowDoc = {
  id: realPreset.id, name: realPreset.name, description: "", icon: "flow", prompt: "",
  trigger: "manual", schemaVersion: "1", builtin: false, updatedAt: 1,
  nodes: realPreset.nodes, edges: realPreset.edges,
} as WorkflowDoc;
const types: ReadonlyMap<string, NodeTypeManifest> = new Map([
  ["mcode.trigger", { id: "mcode.trigger", manifestVersion: 1, name: "trigger", runner: { kind: "trigger" }, capability: "read", params: [] }],
  ["mcode.condition", { id: "mcode.condition", manifestVersion: 1, name: "condition", runner: { kind: "condition" }, capability: "read", params: [] }],
  ["mcode.agent", { id: "mcode.agent", manifestVersion: 1, name: "agent", runner: { kind: "prompt" }, capability: "read", params: [] }],
  ["mcode.code", { id: "mcode.code", manifestVersion: 1, name: "code", runner: { kind: "code", language: "python" }, capability: "read", params: [] }],
]);
const result = migrateWorkflowDoc(source, { types });
const original = source.nodes.find(n => n.type === "mcode.trigger")!;
const converted = result.flow.nodes.find(n => n["x-mcode"]?.nodeId === original.id)!;
check("真实预设触发器携带正确的事件名到 Node-RED 原生表单",
  converted?.["events"] === "library.item.imported", converted);
check("工作任务说明不能覆盖事件订阅目标",
  converted?.["task"] === original.params["task"] && converted?.["task"] !== converted?.["events"]);
check("原生触发器的 Events 和旧筛选字段可编辑", triggerNodeHtml().includes('node-input-events')
  && triggerNodeHtml().includes('node-input-eventFilter'));
check("迁移器读回表单保持实际 HookEvent 订阅", flowToWorkflowDoc(result.flow).nodes
  .find(n => n.id === original.id)?.params["events"] === "library.item.imported");
const changed = structuredClone(result.flow);
changed.nodes.find(n => n["x-mcode"]?.nodeId === original.id)!["events"] = "turn.done";
check("编辑器更改 Events 后不能复活旧 sidecar 值", flowToWorkflowDoc(changed).nodes
  .find(n => n.id === original.id)?.params["events"] === "turn.done");
const subscribePayload = triggerSubscribePayload(converted);
check("实际注册函数发给 Host 的是 events，而不是 task", subscribePayload.params["events"] === "library.item.imported"
  && subscribePayload.params["task"] === original.params["task"], subscribePayload.params);
const losses = result.report.lossy.filter(issue => issue.message.includes("trigger.input.doi"));
check("迁移预检明确告知运行前输入根本不存在，条件不能执行",
  losses.some(issue => issue.message.includes("【迁移后不能执行】") && issue.message.includes("必须先改写条件")), result.report.lossy);

const workDir = mkdtempSync(join(tmpdir(), "mcode-w25-confirm-"));
try {
  const bound = { ...source, engine: "node-red" as const };
  const runtimeState = { state: "stopped" as const, engineId: "node-red", port: null, reason: null };
  const ports: NativeLoadPorts = {
    get: id => id === bound.id ? bound : null,
    types: async () => types,
    dataDir: () => workDir,
    migrationFacts: () => ({ review: null, inFlightWorkflowIds: new Set() }),
    runtime: {
      status: () => runtimeState,
      stop: async () => runtimeState,
      start: async () => runtimeState,
    },
    beforeStart: async () => {},
    launchSpec: () => ({ command: "fixture", dataDir: workDir, args: () => [] }),
  };
  const preflight = await loadWorkflowIntoNative(bound.id, ports, false);
  check("实际工作流装载入口在确认前向 UI 传递 trigger.input 缺失警告",
    !preflight.ok && preflight.reason.includes("【迁移后不能执行】")
      && preflight.reason.includes("trigger.input.doi")
      && preflight.requiresConfirmation === true,
    preflight);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

resetRuntime();
const services = productionNodePackServices(() => ({ state: "running", engineId: "node-red", port: 8888, reason: null }), undefined);
const received: Array<Record<string, unknown>> = [];
const release = services.subscribe({ ...subscribePayload }, message => received.push(message));
check("真实生产端口成功注册事件订阅", typeof release === "function");
emitEvent({ type: "turn.done", sessionId: "s-test", reason: "end_turn" } as never);
check("不匹配事件不执行用户工作流", received.length === 0, received);
emitEvent({ type: "library.item.imported", sessionId: "s-test", itemId: "i-test", title: "Test", pdfPath: "file" } as never);
check("真实文献导入事件经生产端口触发", received.length === 1
  && (received[0]?.["payload"] as { event?: string } | undefined)?.event === "library.item.imported", received);
check("运行前输入不在 Hook 事件中，不伪造 trigger.input.doi",
  !Object.hasOwn(received[0]?.["payload"] as object, "input")
  && !Object.hasOwn(received[0]?.["payload"] as object, "doi"), received);
release();
emitEvent({ type: "library.item.imported", sessionId: "s-test", itemId: "i-test2", title: "Test", pdfPath: "file" } as never);
check("卸载订阅后不再触发", received.length === 1);

const changedReceived: Array<Record<string, unknown>> = [];
const changedPayload = triggerSubscribePayload(changed.nodes.find(n => n["x-mcode"]?.nodeId === original.id)!);
const detach = services.subscribe({ ...changedPayload }, message => changedReceived.push(message));
emitEvent({ type: "library.item.imported", sessionId: "s-test", itemId: "i-test3", title: "Test", pdfPath: "file" } as never);
emitEvent({ type: "turn.done", sessionId: "s-test", reason: "end_turn" } as never);
check("用户编辑后的订阅目标真正覆盖旧事件", changedReceived.length === 1
  && (changedReceived[0]?.["payload"] as { event?: string })?.event === "turn.done", changedReceived);
detach();
try {
  services.subscribe({ ...subscribePayload, params: { ...subscribePayload.params, events: "bad name" } }, () => {});
  check("不合法 event 名必须拒绝，不能回落到 task", false);
} catch (error) {
  check("不合法 event 名必须拒绝，不能回落到 task",
    error instanceof Error && error.message.includes("Events field"), String(error));
}
const twoEvents: Array<Record<string, unknown>> = [];
const twoPayload = { ...subscribePayload, params: { ...subscribePayload.params,
  events: "library.item.imported, turn.done" } };
const stopTwo = services.subscribe(twoPayload, message => twoEvents.push(message));
emitEvent({ type: "turn.done", sessionId: "s-test", reason: "end_turn" } as never);
emitEvent({ type: "library.item.imported", sessionId: "s-test", itemId: "i-two", title: "Test", pdfPath: "file" } as never);
check("原版数组/逗号分隔多事件可按实际两个 HookEvent 触发", twoEvents.length === 2, twoEvents);
stopTwo();
try {
  services.subscribe({ ...subscribePayload, params: { ...subscribePayload.params, events: "" } }, () => {});
  check("原生表单清空 Events 后不能回退到旧 Task", false);
} catch (err) {
  check("原生表单清空 Events 后不能回退到旧 Task",
    err instanceof Error && err.message.includes("Events field"), String(err));
}
const filteredFlow = structuredClone(result.flow);
const filteredTrigger = filteredFlow.nodes.find(n => n["x-mcode"]?.nodeId === original.id)!;
filteredTrigger["eventFilter"] = "author=someone";
check("编辑器里的筛选配置能正确回读，不丢失用户规则",
  flowToWorkflowDoc(filteredFlow).nodes.find(n => n.id === original.id)?.params["eventFilter"] === "author=someone");
const filteredPayload = triggerSubscribePayload(filteredTrigger);
try {
  services.subscribe({ ...filteredPayload }, () => {});
  check("旧事件筛选未实现时不得静默扩大触发范围", false);
} catch (error) {
  check("旧事件筛选未实现时不得静默扩大触发范围",
    error instanceof Error && error.message.includes("eventFilter is not implemented"), String(error));
}
check("迁移报告明确要求核对事件名与不兼容的筛选条件",
  result.report.needsHumanDecision.some(issue => issue.nodeId === original.id
    && issue.message.includes("eventFilter") && issue.message.includes("events")),
  result.report.needsHumanDecision);

console.log("mcode-trigger-events-smoke: " + (count - failed) + "/" + count);
if (failed) process.exitCode = 1;
