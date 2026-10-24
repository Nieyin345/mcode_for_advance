/**
 * W18: an old main/conversation graph has NO stable chat identity of its own.
 * Prove migration -> real registered Node-RED node -> fake Host port.
 * The native editor's sessionId is authoritative over stale x-mcode metadata;
 * never fall back to an arbitrary foreground chat.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDoc } from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import { migrateWorkflowDoc, flowToWorkflowDoc } from "@main/workflowEngines/flowMigration.js";
import { conversationNodeHtml, registerMcodeNodePack, type McodeNodePorts } from "@main/workflowEngines/mcodeNodeTypes.js";

let total = 0;
let failed = 0;
function check(label: string, yes: boolean, detail?: unknown): void {
  total++;
  if (yes) console.log("  ok   " + label);
  else { failed++; console.error("  FAIL " + label, detail === undefined ? "" : JSON.stringify(detail)); }
}

const types: ReadonlyMap<string, NodeTypeManifest> = new Map([
  ["mcode.main", {
    id: "mcode.main", manifestVersion: 1, name: "主代理",
    runner: { kind: "conversation" }, capability: "read", params: [],
  }],
]);
function docWithSession(sessionId?: string): WorkflowDoc {
  return {
    id: "w18_flow", name: "迁移绑定会话", description: "", icon: "flow", prompt: "",
    trigger: "manual", schemaVersion: "1", builtin: false, updatedAt: 1,
    nodes: [{
      id: "main", type: "mcode.main", title: "主对话",
      params: { instruction: "把任务分给下游", ...(sessionId === undefined ? {} : { sessionId }) },
      position: { x: 10, y: 20 },
    }],
    edges: [],
  } as WorkflowDoc;
}
function migratedNode(sessionId?: string) {
  const migrated = migrateWorkflowDoc(docWithSession(sessionId), { types });
  const native = migrated.flow.nodes.find(n => n["x-mcode"]?.nodeId === "main");
  if (!native) throw Error("Missing migrated native conversation node");
  return { migrated, native };
}

const unset = migratedNode();
check("旧图无固定会话身份，迁移时不伪造 ID",
  unset.native["sessionId"] === "", unset.native);
check("未绑定会话的迁移报告显式要求人工绑定",
  unset.migrated.report.needsHumanDecision.some(
    issue => issue.nodeId === "main" && issue.message.includes("Mcode 会话 ID")
      && issue.message.includes("部署")), unset.migrated.report.needsHumanDecision);
const html = conversationNodeHtml();
check("原生编辑器将会话字段声明为 required",
  /sessionId:\s*\{\s*value:\s*""\s*,\s*required:\s*true\s*\}/.test(html),
  html.slice(html.indexOf("sessionId:") - 30, html.indexOf("sessionId:") + 105));

const { migrated, native } = migratedNode("session-original-123");
check("明确绑定的会话写入原生编辑字段",
  native["sessionId"] === "session-original-123", native["sessionId"]);
const back = flowToWorkflowDoc(migrated.flow);
check("会话字段能从原生画布 round-trip 回来",
  back.nodes.find(n => n.id === "main")?.params["sessionId"] === "session-original-123",
  back.nodes.find(n => n.id === "main")?.params);

const overriddenFlow = structuredClone(migrated.flow);
const overridden = overriddenFlow.nodes.find(n => n["x-mcode"]?.nodeId === "main")!;
overridden["sessionId"] = "session-selected-456";
check("原生编辑器显式选择覆盖旧 x-mcode 会话身份",
  flowToWorkflowDoc(overriddenFlow).nodes.find(n => n.id === "main")?.params["sessionId"] === "session-selected-456");

const clearedFlow = structuredClone(migrated.flow);
clearedFlow.nodes.find(n => n["x-mcode"]?.nodeId === "main")!["sessionId"] = "";
check("用户清空会话绑定不能从陈旧 sidecar 中复活",
  flowToWorkflowDoc(clearedFlow).nodes.find(n => n.id === "main")?.params["sessionId"] === "");

type InputHandler = (
  message: Record<string, unknown>,
  send: (message: unknown) => void,
  done: (error?: Error) => void,
) => void;
type NodeCtor = (this: unknown, config: Record<string, unknown>) => void;
let ctor: NodeCtor | undefined;
const seenIds: unknown[] = [];
const ports = {
  conversation: {
    run: async (payload: { params: Record<string, unknown> }) => {
      seenIds.push(payload.params["sessionId"]);
      return { text: "Host 执行成功", artifacts: [], runId: "w18-run" };
    },
  },
} as unknown as McodeNodePorts;
const RED = {
  nodes: {
    registerType: (type: string, registered: NodeCtor) => {
      if (type === "mcode-conversation") ctor = registered;
    },
    createNode: () => {},
  },
} as unknown as Parameters<typeof registerMcodeNodePack>[0];
registerMcodeNodePack(RED, () => ports, "mcode-conversation");
check("实际 Node-RED registerType 注册了会话执行节点", typeof ctor === "function");

async function executeNative(config: Record<string, unknown>): Promise<{ output: unknown; error?: Error }> {
  const listeners: Record<string, unknown> = {};
  const instance = {
    on(name: string, callback: unknown) { listeners[name] = callback; },
    error() {},
    send() {},
  };
  if (!ctor) throw Error("Missing Node-RED conversation registration");
  ctor.call(instance, config);
  const input = listeners["input"] as InputHandler;
  if (typeof input !== "function") throw Error("Missing registered input handler");
  return await new Promise(resolve => {
    let output: unknown = null;
    input({ payload: "请处理" }, (message) => { output = message; }, (error) => resolve({ output, error }));
  });
}

(async () => {
  const runOriginal = await executeNative(native as Record<string, unknown>);
  check("迁移原生节点经过真实 input handler 调用了 Host 假端口",
    runOriginal.error === undefined && seenIds[0] === "session-original-123"
      && (runOriginal.output as { payload?: { text?: string } } | null)?.payload?.text === "Host 执行成功",
    { seenIds, output: runOriginal });
  const runOverride = await executeNative(overridden as Record<string, unknown>);
  check("显式新会话优先于迁移 metadata，实际端口收到用户选择",
    runOverride.error === undefined && seenIds[1] === "session-selected-456",
    { seenIds, output: runOverride });
  const legacy = structuredClone(migrated.flow);
  delete legacy.nodes.find(n => n["x-mcode"]?.nodeId === "main")!["sessionId"];
  const recovered = await executeNative(legacy.nodes.find(n => n["x-mcode"]?.nodeId === "main")! as Record<string, unknown>);
  check("早期仅有 sidecar 的老档案仍能执行其明确绑定的身份",
    recovered.error === undefined && seenIds[2] === "session-original-123", seenIds);

  // The task's "3 of 7 presets contain mcode.main" was stale. Inspect the
  // actual shipped source instead of reproducing that assumption in a fixture.
  // Prompt-only presets have no graph nodes: don't call them executable flows.
  const source = JSON.parse(readFileSync(join(process.cwd(), "resources/presets/workflows.json"), "utf8")) as {
    workflows: Array<{ id: string; name: string; nodes: WorkflowDoc["nodes"]; edges: WorkflowDoc["edges"] }>;
  };
  check("预设源共有七份", source.workflows.length === 7, source.workflows.map(p => p.id));
  const presetManifest = (id: string, kind: NodeTypeManifest["runner"]): NodeTypeManifest => ({
    id, manifestVersion: 1, name: id, runner: kind, capability: "read", params: [],
  });
  const presetTypes: ReadonlyMap<string, NodeTypeManifest> = new Map([
    ["mcode.main", presetManifest("mcode.main", { kind: "conversation" })],
    ["mcode.agent", presetManifest("mcode.agent", { kind: "prompt" })],
    ["mcode.branch", presetManifest("mcode.branch", { kind: "branch" })],
    ["mcode.trigger", presetManifest("mcode.trigger", { kind: "trigger" })],
    ["mcode.code", presetManifest("mcode.code", { kind: "code", language: "python" })],
    ["mcode.condition", presetManifest("mcode.condition", { kind: "condition" })],
  ]);
  let graphCount = 0;
  let promptOnlyCount = 0;
  let mainCount = 0;
  for (const preset of source.workflows) {
    if (preset.nodes.length === 0) { promptOnlyCount++; continue; }
    graphCount++;
    const workflow: WorkflowDoc = {
      ...docWithSession(),
      id: preset.id,
      name: preset.name,
      nodes: preset.nodes,
      edges: preset.edges,
    };
    const originalMainNodes = workflow.nodes.filter(n => n.type === "mcode.main");
    // Simulate the user's explicit binding, NEVER an ambient session lookup.
    for (const node of originalMainNodes) {
      node.params = { ...node.params, sessionId: "preset-user-selected-chat" };
    }
    mainCount += originalMainNodes.length;
    const converted = migrateWorkflowDoc(workflow, { types: presetTypes });
    check("真实预设 " + preset.id + " 的 graph 迁移没有未映射节点",
      converted.report.unmapped.length === 0, converted.report.unmapped);
    for (const n of originalMainNodes) {
      const nr = converted.flow.nodes.find(entry => entry["x-mcode"]?.nodeId === n.id);
      const outcome = nr ? await executeNative(nr as Record<string, unknown>) : null;
      check("真实预设 " + preset.id + " 的显式绑定主会话能走 Node-RED input → Host",
        outcome?.error === undefined && outcome?.output !== null && nr?.["sessionId"] === "preset-user-selected-chat"
          && seenIds[seenIds.length - 1] === "preset-user-selected-chat",
        { actual: nr?.["sessionId"], error: outcome?.error?.message });
    }
  }
  check("真实预设分为四份图与三份 prompt-only（不假装空图可执行）",
    graphCount === 4 && promptOnlyCount === 3, { graphCount, promptOnlyCount });
  check("真实预设包含两份主会话节点而非旧卡误记的三份",
    mainCount === 2, { mainCount });

  console.log("W18 conversation session smoke: " + (total - failed) + "/" + total);
  if (failed) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
