/**
 * Native trigger → real Node-RED registered trigger handler → Host-owned event
 * ticket → real condition-eval adapter → Host's existing condition evaluator.
 * The only fake is RuntimeManager's event emitter. No persistent DB/Electron.
 */
import { registerMcodeNodePack, runConditionEvalNode, type McodeNodePorts } from "@main/workflowEngines/mcodeNodeTypes.js";
import { withConditionEvaluation } from "@main/workflowEngines/conditionHostPorts.js";
import type { NodePackHostServices } from "@main/workflowEngines/nodePackHost.js";
import type { WorkflowDoc } from "@contracts/workflow";

let count = 0, failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  count++;
  if (condition) console.log("  ok   " + label);
  else { failures++; console.error("  FAIL " + label, detail === undefined ? "" : JSON.stringify(detail)); }
}
const expression = { logic: "and", rules: [{ ref: "{{trigger.itemId}}", op: "contains", value: "paper-" }] };
const doc = (id: string): WorkflowDoc => ({
  id, name: id, builtin: false, updatedAt: 1, engine: "node-red",
  nodes: [
    { id: "source", type: "mcode.trigger", title: "入库", params: { triggerKind: "event", events: "library.item.imported" }, position: { x: 0, y: 0 } },
    { id: "cond", type: "mcode.condition", title: "筛选", params: { expression }, position: { x: 10, y: 20 } },
  ],
  edges: [{ id: "edge", from: "source", to: "cond" }],
}) as WorkflowDoc;
const docs = new Map([["workflow-A", doc("workflow-A")], ["workflow-B", doc("workflow-B")]]);
let hostEmit: ((msg: Record<string, unknown>) => void) | undefined;
let unsubscribed = false;
const base: NodePackHostServices = {
  execute: async () => { throw Error("Only the real condition adapter must execute"); },
  subscribe: (_payload, emit) => {
    hostEmit = emit;
    return () => { unsubscribed = true; hostEmit = undefined; };
  },
};
const wrapped = withConditionEvaluation(base, {
  resolveWorkflow: (tabId) => tabId === "tab-A" ? "workflow-A"
    : tabId === "tab-B" ? "workflow-B" : null,
  getDoc: id => docs.get(id) ?? null,
});
type NativeCtor = (this: unknown, config: Record<string, unknown>) => void;
const ctors = new Map<string, NativeCtor>();
const RED = {
  nodes: {
    registerType: (name: string, ctor: NativeCtor) => { ctors.set(name, ctor); },
    createNode() {},
  },
} as unknown as Parameters<typeof registerMcodeNodePack>[0];
const published: Array<Record<string, unknown>> = [];
const problems: unknown[] = [];
const listeners = new Map<string, Function>();
const native = {
  on(name: string, fn: Function) { listeners.set(name, fn); },
  send(message: Record<string, unknown>) { published.push(message); },
  error(error: unknown) { problems.push(String(error)); },
};
const ports = {
  trigger: { subscribe: (input: Record<string, unknown>, emit: (message: Record<string, unknown>) => void) =>
    wrapped.subscribe(input, emit) },
} as unknown as McodeNodePorts;
registerMcodeNodePack(RED, () => ports, "mcode-trigger");
const ctor = ctors.get("mcode-trigger");
check("注册的真 Node-RED trigger constructor 存在", typeof ctor === "function");
ctor?.call(native, {
  id: "native-trigger", z: "tab-A",
  "x-mcode": { nodeId: "source", type: "mcode.trigger", params: { triggerKind: "event", events: "library.item.imported" } },
});
check("真实注册路径成功建立 Host 事件订阅", typeof hostEmit === "function" && problems.length === 0, problems);

function publish(itemId: string): Record<string, unknown> {
  hostEmit?.({ payload: { event: "library.item.imported", itemId, itemTitle: "Title" } });
  return published[published.length - 1]!;
}
function inputOf(message: Record<string, unknown>, exp: unknown = expression): Record<string, unknown> {
  return {
    id: "native-eval", z: "tab-A",
    "x-mcode": { nodeId: "cond__condition_eval", bridgesNodeId: "cond", params: { expression: exp } },
  };
}
const adapter = {
  evaluate: (p: Record<string, unknown>) =>
    wrapped.execute("condition.evaluate", { ...p, tabId: "tab-A" }) as Promise<{ matched: boolean }>,
} as unknown as Parameters<typeof runConditionEvalNode>[2];

const present = publish("paper-123");
const meta = present["mcode"] as Record<string, unknown>;
check("Host-generated event context survives registered Node-RED trigger's sanitizer",
  typeof meta?.["triggerTicket"] === "string" && meta?.["nodeId"] === "source", meta);
const actual = await runConditionEvalNode(present, inputOf(present), adapter);
check("真实条件适配节点基于 Host-attested itemId 得 true",
  (actual.msg["mcode"] as Record<string, unknown>)["condition"] === true,
  actual.msg["mcode"]);
const kindExp = { logic: "and", rules: [{ ref: "{{trigger.kind}}", op: "equal", value: "event" }] };
const eventExp = { logic: "and", rules: [{ ref: "{{trigger.event}}", op: "equal", value: "library.item.imported" }] };
const kindResult = await runConditionEvalNode(present, inputOf(present, kindExp), adapter);
const eventResult = await runConditionEvalNode(present, inputOf(present, eventExp), adapter);
check("真实 Host 事件凭据让 trigger.kind 可用",
  (kindResult.msg["mcode"] as Record<string, unknown>)["condition"] === true);
check("真实 Host 事件凭据让 trigger.event 可用",
  (eventResult.msg["mcode"] as Record<string, unknown>)["condition"] === true);
const other = await runConditionEvalNode(publish("not-related"), inputOf(present), adapter);
check("同样的工作流条件依据真实其他条目得 false（不是恒 true）",
  (other.msg["mcode"] as Record<string, unknown>)["condition"] === false, other.msg["mcode"]);

// A child can claim arbitrary values in mutable msg but cannot invent a
// parent-side event ticket. It must not influence condition resolution.
let forgedRejected = false;
try {
  await runConditionEvalNode({
    payload: { event: "library.item.imported", itemId: "paper-fake" },
    mcode: { triggerTicket: "forged-ticket", nodeId: "source" },
  }, inputOf(present), adapter);
} catch (error) { forgedRejected = error instanceof Error && error.message.includes("trigger.itemId"); }
check("伪造 msg.payload + 不存在的凭据不能把条件算成 true", forgedRejected);

let crossRejected = false;
try {
  const crossAdapter = { evaluate: (p: Record<string, unknown>) =>
    wrapped.execute("condition.evaluate", { ...p, tabId: "tab-B" }) as Promise<{ matched: boolean }> } as
    unknown as Parameters<typeof runConditionEvalNode>[2];
  await runConditionEvalNode(present, inputOf(present), crossAdapter);
} catch (error) { crossRejected = error instanceof Error && error.message.includes("trigger.itemId"); }
check("其他工作流即便拿到同一个 ticket 也不能读取", crossRejected);

let inputRejected = false;
try {
  await runConditionEvalNode(present, inputOf(present, { logic: "and", rules: [
    { ref: "{{trigger.input.doi}}", op: "exists" },
  ] }), adapter);
} catch (error) { inputRejected = error instanceof Error && error.message.includes("trigger.input.doi"); }
check("Host 事件不伪造自定义 UI 的 trigger.input.doi", inputRejected);

const activeTicket = meta["triggerTicket"];
listeners.get("close")?.();
check("关闭 Node-RED 节点解除 Host 订阅", unsubscribed);
let staleRejected = false;
try {
  await wrapped.execute("condition.evaluate", {
    tabId: "tab-A", nodeId: "cond", expression, results: [],
    triggerTicket: activeTicket,
  });
} catch (error) { staleRejected = error instanceof Error && error.message.includes("trigger.itemId"); }
check("取消订阅同时使尚在消息流中的 token 失效", staleRejected);

// A tool event cannot smuggle arbitrary itemId into library-item facts.
let toolMessage: Record<string, unknown> | null = null;
const stopTool = wrapped.subscribe({ tabId: "tab-A", nodeId: "source" }, message => { toolMessage = message; });
hostEmit?.({ payload: { event: "tool.use", itemId: "paper-forged" } });
const toolTicket = (toolMessage as Record<string, unknown> | null)?.["mcode"] as Record<string, unknown> | undefined;
const toolResult = await wrapped.execute("condition.evaluate", {
  tabId: "tab-A", nodeId: "cond", expression: { logic: "and", rules: [
    { ref: "{{trigger.itemId}}", op: "exists" },
  ] }, results: [], triggerTicket: toolTicket?.["triggerTicket"],
}) as { matched: boolean };
check("工具事件不能夹带文献条目事实", toolResult.matched === false, toolResult);
stopTool();

// Bounded TTL: do not retain an old event's ticket as an evergreen claim.
// The clock is injected by changing Date.now locally, no timeouts/background.
let emitted: Record<string, unknown> | null = null;
const cleanup = wrapped.subscribe({ tabId: "tab-A", nodeId: "source" }, message => { emitted = message; });
hostEmit?.({ payload: { event: "library.item.imported", itemId: "paper-expiring" } });
const expiring = (emitted?.["mcode"] as Record<string, unknown> | undefined)?.["triggerTicket"];
check("新 subscription 能产生可观察但无凭据事实内容的 ticket", typeof expiring === "string");
const clock = Date.now;
let expiredRejected = false;
try {
  Date.now = () => clock() + 6 * 60_000;
  await wrapped.execute("condition.evaluate", {
    tabId: "tab-A", nodeId: "cond", expression, results: [],
    triggerTicket: expiring,
  });
} catch (error) {
  expiredRejected = error instanceof Error && error.message.includes("trigger.itemId");
} finally {
  Date.now = clock;
  cleanup();
}
check("超过五分钟的上下文票据不再能作为条件事实", expiredRejected);

console.log("mcode-trigger-condition-context-smoke: " + (count - failures) + "/" + count);
if (failures) process.exitCode = 1;
