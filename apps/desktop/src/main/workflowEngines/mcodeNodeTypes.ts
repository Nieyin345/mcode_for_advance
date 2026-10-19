/**
 * 【ARC-006 MERGE-2 第二片】**其余 6 种执行原语的节点包**（`mcode-agent` 之外的）。
 *
 * ## 每个类型只做「最小可执行语义」
 *
 * 与 `mcodeNodePack.ts` 的 agent 同一个形状：**纯逻辑函数**（`runXNode`）+ **注册外壳**
 * + **编辑器 HTML**，执行体全部经可注入端口。本文件不接三引擎、不接宿主存储、不做
 * 审批 —— 生产装配将来把端口接到 Host RPC，测试注入假实现。
 *
 * | Mcode runner.kind | Node-RED 类型 | 最小语义 | 端口 |
 * |---|---|---|---|
 * | `conversation` | `mcode-conversation` | 一轮主对话；经 port 跑，产出 `{text,artifacts}` | 1 入 1 出 |
 * | `branch` | `mcode-branch` | **端口 = 出边顺序**（与迁移器 sourcePort 同一规则）；由 `msg.mcode.branchPort`（人工点选/上游指定）或 port 决定 | 1 入 N 出 |
 * | `trigger` | `mcode-trigger` | **无输入**；只保留「Mcode 应用事件订阅」——手动/定时已并入内置 `inject`、文件变化并入内置 `watch`（节点统一，见 `docs/planning/arc-006-node-unification.md`） | 0 入 1 出 |
 * | `module-capability` | `mcode-module-capability` | 把 moduleId/contributionId/path 交给 port | 1 入 1 出 |
 * | `node-red-call` | `mcode-node-red-call` | 把 enginePath/engineMethod/engineBody 交给 port | 1 入 1 出 |
 *
 * **不注册**（迁移器映射到原生节点，由 Node-RED 自己提供）：
 *   - `condition` → `switch`（官方语义）；
 *   - `command` → `exec`（官方语义）；
 *   - `code`：`node` → `function`，`python`/`shell`/`powershell` → `exec` + 解释器前缀
 *     （节点统一：`mcode-code` 已删除，不再有第二个"跑代码"的自定义节点）。
 *
 * ## branch 的「决定权」边界
 *
 * Mcode 的 branch 可以 `decider: "model"`（模型即时选）或 `"user"`（挂起等真人）。
 * Node-RED 的消息流**没有持久挂起通道**（MERGE-0 未知语义 #2，需人工裁决）。本片的最小
 * 语义是：**决定由 port 或消息给出，节点只负责把消息送到对应端口** —— 人工挂起/恢复
 * 将来由 Host 的 port（durable journal + 审批）实现，节点语义不变。
 *
 * ## trigger 的「无输入仍产出」
 *
 * 触发源（cron/文件/事件/手动）在 Host 侧；节点只订阅 port。port 每次触发调
 * `emit(msg)`，节点即 `send(msg)`。本片的假 port 在订阅后异步 emit 一次，对应
 * 「手动/立刻运行一次」。`close` 事件时调用 port 返回的 disposer（不留监听器）。
 */
import {
  MCODE_AGENT_NODE_TYPE,
  MCODE_NODE_PACK_VERSION,
  agentNodeHtml,
  assertMcodeNodePortResult,
  normalizeAgentConfig,
  registerMcodeAgentNodes,
  type McodeAgentNodeConfig,
  type McodeAgentPort,
  type NodeRedNodeLike,
  type NodeRedRuntimeApi,
} from "./mcodeNodePack.js";

export const MCODE_CONVERSATION_NODE_TYPE = "mcode-conversation";
export const MCODE_BRANCH_NODE_TYPE = "mcode-branch";
export const MCODE_TRIGGER_NODE_TYPE = "mcode-trigger";
export const MCODE_MODULE_CAPABILITY_NODE_TYPE = "mcode-module-capability";
export const MCODE_NODE_RED_CALL_NODE_TYPE = "mcode-node-red-call";

/** 所有经本节点包注册的类型（GET /nodes 的断言基准）。 */
export const MCODE_NODE_PACK_TYPES = [
  MCODE_AGENT_NODE_TYPE,
  MCODE_CONVERSATION_NODE_TYPE,
  MCODE_BRANCH_NODE_TYPE,
  MCODE_TRIGGER_NODE_TYPE,
  MCODE_MODULE_CAPABILITY_NODE_TYPE,
  MCODE_NODE_RED_CALL_NODE_TYPE,
] as const;

type Cfg = McodeAgentNodeConfig & { wires?: string[][] };

/** 统一 payload 基座：每类端口都收这几个，再各自带动作参数。 */
export interface McodeNodeBasePayload {
  input: unknown;
  params: Record<string, unknown>;
  nodeId: string;
  runId: string | null;
}

function basePayload(inputMsg: Record<string, unknown>, config: Cfg): McodeNodeBasePayload {
  const normalized = normalizeAgentConfig(config);
  const incoming = (inputMsg["mcode"] !== null && typeof inputMsg["mcode"] === "object"
    ? inputMsg["mcode"]
    : {}) as Record<string, unknown>;
  return {
    input: inputMsg["payload"] ?? null,
    params: normalized.params,
    nodeId: normalized.nodeId,
    runId: typeof incoming["runId"] === "string" ? incoming["runId"] : null,
  };
}

/** 通用产出：`msg.payload = { text, artifacts }`，`msg.mcode` 透传 + 合并。 */
function outputMsg(
  inputMsg: Record<string, unknown>,
  config: Cfg,
  result: { text: string; artifacts: Array<Record<string, unknown>>; runId?: string },
  extraMcode: Record<string, unknown> = {},
): Record<string, unknown> {
  // Validate every custom node against the same Host RPC result contract.
  assertMcodeNodePortResult(result);
  const normalized = normalizeAgentConfig(config);
  const incoming = (inputMsg["mcode"] !== null && typeof inputMsg["mcode"] === "object"
    ? inputMsg["mcode"]
    : {}) as Record<string, unknown>;
  const runId = typeof incoming["runId"] === "string" ? incoming["runId"] : null;
  return {
    ...inputMsg,
    payload: { text: result.text, artifacts: result.artifacts },
    mcode: {
      ...incoming,
      nodeId: normalized.nodeId,
      runId: result.runId ?? runId,
      ...(normalized.outputVar !== null ? { outputVar: normalized.outputVar } : {}),
      ...extraMcode,
    },
  };
}

/* ── conversation ── */

export interface McodeConversationPort {
  run(payload: McodeNodeBasePayload & { instruction: string }): Promise<{
    text: string;
    artifacts: Array<Record<string, unknown>>;
    runId?: string;
  }>;
}

/** 一次对话节点执行（跑在主对话里的那一轮）。 */
export async function runConversationNode(
  inputMsg: Record<string, unknown>,
  config: Cfg,
  port: McodeConversationPort,
): Promise<{ msg: Record<string, unknown> }> {
  const base = basePayload(inputMsg, config);
  const instruction = normalizeAgentConfig(config).instruction;
  const result = await port.run({ ...base, instruction });
  return { msg: outputMsg(inputMsg, config, result) };
}

/* ── branch ── */

export interface McodeBranchPort {
  /** 选哪条出边（0-based 端口，与出边文档顺序一致）。 */
  decide(payload: McodeNodeBasePayload & { portCount: number; decider: string }): Promise<{ port: number; label?: string }>;
}

/**
 * 一次分支执行：返回**目标端口号**与要发往下游的 msg。
 *
 * 只能经受信 Host 的 `port.decide` 选择目标出口。上游的 `msg.mcode.branchPort`
 * 可由任意 Node-RED 节点构造，**不是**用户批准，不能跳过 Host 判定。
 * 无效结果必须失败并交 Node-RED Catch，禁止静默转入第 0 出口。
 */
export async function runBranchNode(
  inputMsg: Record<string, unknown>,
  config: Cfg,
  port: McodeBranchPort,
): Promise<{ msg: Record<string, unknown>; port: number; label?: string }> {
  const base = basePayload(inputMsg, config);
  const portCount = Math.max(1, config.wires?.length ?? 1);
  const chosen = await port.decide({
    ...base,
    portCount,
    decider: typeof base.params["decider"] === "string" ? (base.params["decider"] as string) : "user",
  });
  if (!chosen || typeof chosen !== "object" || !Number.isInteger(chosen.port) || chosen.port < 0 || chosen.port >= portCount) {
    throw new Error("分支端口无效，拒绝执行");
  }
  if (chosen.label !== undefined && typeof chosen.label !== "string") {
    throw new Error("Host branch label invalid: expected a string");
  }
  const msg = outputMsg(
    inputMsg,
    config,
    { text: "", artifacts: [] }, // branch 不产生产出，只选路；保留上游 payload 由 outputMsg 覆盖 —— 见下。
    { branch: { port: chosen.port, ...(chosen.label !== undefined ? { label: chosen.label } : {}) } },
  );
  // branch 不该把上游 payload 清成空产出：把上游 payload 原样放回。
  msg["payload"] = inputMsg["payload"] ?? null;
  delete (msg["mcode"] as Record<string, unknown>)["branchPort"];
  delete (msg["mcode"] as Record<string, unknown>)["branchLabel"];
  return { msg, port: chosen.port, ...(chosen.label !== undefined ? { label: chosen.label } : {}) };
}

/* ── trigger ── */

export interface McodeTriggerPort {
  /** 订阅触发：port 每次触发调 `emit(msg)`；返回 disposer（close 时调用）。 */
  subscribe(
    payload: McodeNodeBasePayload & { triggerKind: string },
    emit: (msg: Record<string, unknown>) => void,
  ): (() => void) | void;
}

/**
 * trigger 的初始消息（纯函数）。真正「什么时候发」由 port 决定 —— 调用方把
 * {@link triggerMessage} 的产出交给 `emit`。
 */
export function triggerMessage(config: Cfg, at: number = Date.now()): Record<string, unknown> {
  const normalized = normalizeAgentConfig(config);
  const kind = typeof normalized.params["triggerKind"] === "string" ? (normalized.params["triggerKind"] as string) : "manual";
  return {
    payload: { trigger: { kind, at } },
    mcode: { nodeId: normalized.nodeId, runId: null, triggerKind: kind },
  };
}

/** trigger 订阅时交给 port 的 payload（供 port 决定触发源）。 */
export function triggerSubscribePayload(config: Cfg): McodeNodeBasePayload & { triggerKind: string } {
  const normalized = normalizeAgentConfig(config);
  const kind = typeof normalized.params["triggerKind"] === "string" ? (normalized.params["triggerKind"] as string) : "manual";
  return {
    input: null,
    params: normalized.params,
    nodeId: normalized.nodeId,
    runId: null,
    triggerKind: kind,
  };
}

/* ── module-capability ── */

export interface McodeModuleCapabilityPort {
  run(payload: McodeNodeBasePayload & { moduleId: string; contributionId: string; path: string }): Promise<{
    text: string;
    artifacts: Array<Record<string, unknown>>;
    runId?: string;
  }>;
}

export async function runModuleCapabilityNode(
  inputMsg: Record<string, unknown>,
  config: Cfg,
  port: McodeModuleCapabilityPort,
): Promise<{ msg: Record<string, unknown> }> {
  const base = basePayload(inputMsg, config);
  const moduleId = typeof base.params["moduleId"] === "string" ? (base.params["moduleId"] as string) : "";
  const contributionId = typeof base.params["contributionId"] === "string" ? (base.params["contributionId"] as string) : "";
  const path = typeof base.params["path"] === "string" ? (base.params["path"] as string) : "";
  const result = await port.run({ ...base, moduleId, contributionId, path });
  return { msg: outputMsg(inputMsg, config, result) };
}

/* ── node-red-call ── */

export interface McodeNodeRedCallPort {
  run(payload: McodeNodeBasePayload & { enginePath: string; engineMethod: string; engineBody: string | null }): Promise<{
    text: string;
    artifacts: Array<Record<string, unknown>>;
    runId?: string;
    status?: number;
  }>;
}

export async function runNodeRedCallNode(
  inputMsg: Record<string, unknown>,
  config: Cfg,
  port: McodeNodeRedCallPort,
): Promise<{ msg: Record<string, unknown> }> {
  const base = basePayload(inputMsg, config);
  const enginePath = typeof base.params["enginePath"] === "string" ? (base.params["enginePath"] as string) : "";
  const engineMethod = typeof base.params["engineMethod"] === "string" ? (base.params["engineMethod"] as string) : "GET";
  const engineBody = typeof base.params["engineBody"] === "string" ? (base.params["engineBody"] as string) : null;
  const result = await port.run({ ...base, enginePath, engineMethod, engineBody });
  assertMcodeNodePortResult(result);
  if (result.status !== undefined && (!Number.isInteger(result.status)
    || result.status < 100 || result.status > 599)) {
    throw new Error("Host node-red-call status invalid: expected an HTTP status");
  }
  const msg = outputMsg(inputMsg, config, result,
    result.status !== undefined ? { engineStatus: result.status } : {});
  // Upstream Node-RED nodes can forge arbitrary msg.mcode properties. HTTP
  // status is authoritative only when the Host actually returned one.
  if (result.status === undefined) {
    delete (msg["mcode"] as Record<string, unknown>)["engineStatus"];
  }
  return { msg };
}

/* ── 端口聚合 ── */

export interface McodeNodePorts {
  agent: McodeAgentPort;
  conversation: McodeConversationPort;
  branch: McodeBranchPort;
  trigger: McodeTriggerPort;
  moduleCapability: McodeModuleCapabilityPort;
  nodeRedCall: McodeNodeRedCallPort;
}

/* ── 注册外壳（统一形状：createNode → on input → run → send / error+done） ── */

type NodeInstance = NodeRedNodeLike & {
  on(event: "input", listener: (msg: Record<string, unknown>, send: (m: unknown) => void, done: (e?: Error) => void) => void): void;
  on(event: "close", listener: () => void): void;
  /** createNode 之后由 Node 基类挂上（wires 空时是 NO-OP）。 */
  send(msg: unknown): void;
  wires?: string[][];
};

/** 统一注册一个单输入单输出节点。 */
function registerIoSugar(
  RED: NodeRedRuntimeApi,
  type: string,
  run: (msg: Record<string, unknown>, config: Cfg) => Promise<{ msg: Record<string, unknown> }>,
): void {
  RED.nodes.registerType(type, function (this: NodeInstance, config: Cfg) {
    const node = this;
    RED.nodes.createNode(node, config);
    node.on("input", (msg, send, done) => {
      void (async () => {
        try {
          const outcome = await run(msg, config);
          send(outcome.msg);
          done();
        } catch (err) {
          node.error(err, msg);
          done(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  } as unknown as new (config: Cfg) => NodeRedNodeLike);
}

/**
 * **节点包总注册入口**：`module.exports = registerMcodeNodePack`，Node-RED 以
 * `registerMcodeNodePack(RED)` 调用。`getPorts` 是宿主注入点（生产 = Host RPC，
 * 测试 = 假实现）。
 */
export function registerMcodeNodePack(RED: NodeRedRuntimeApi, getPorts: () => McodeNodePorts): void {
  registerMcodeAgentNodes(RED, () => getPorts().agent);

  registerIoSugar(RED, MCODE_CONVERSATION_NODE_TYPE, (msg, config) =>
    runConversationNode(msg, config, getPorts().conversation));
  registerIoSugar(RED, MCODE_MODULE_CAPABILITY_NODE_TYPE, (msg, config) =>
    runModuleCapabilityNode(msg, config, getPorts().moduleCapability));
  registerIoSugar(RED, MCODE_NODE_RED_CALL_NODE_TYPE, (msg, config) =>
    runNodeRedCallNode(msg, config, getPorts().nodeRedCall));

  // ── branch：1 入 N 出，按端口 send ──
  RED.nodes.registerType(MCODE_BRANCH_NODE_TYPE, function (this: NodeInstance, config: Cfg) {
    const node = this;
    RED.nodes.createNode(node, config);
    node.on("input", (msg, send, done) => {
      void (async () => {
        try {
          const outcome = await runBranchNode(msg, config, getPorts().branch);
          const portCount = Math.max(1, node.wires?.length ?? 1);
          const ports: Array<Record<string, unknown> | null> = Array.from({ length: portCount }, () => null);
          ports[outcome.port] = outcome.msg;
          send(ports);
          done();
        } catch (err) {
          node.error(err, msg);
          done(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  } as unknown as new (config: Cfg) => NodeRedNodeLike);

  // ── trigger：0 入 1 出，订阅 port 并在触发时 send ──
  RED.nodes.registerType(MCODE_TRIGGER_NODE_TYPE, function (this: NodeInstance, config: Cfg) {
    const node = this;
    RED.nodes.createNode(node, config);
    let dispose: (() => void) | void;
    try {
      dispose = getPorts().trigger.subscribe(triggerSubscribePayload(config), (msg) => {
        node.send(msg);
      });
    } catch (err) {
      node.error(err);
    }
    node.on("close", () => {
      if (typeof dispose === "function") {
        try {
          dispose();
        } catch {
          /* 清理失败不影响关停 */
        }
      }
    });
  } as unknown as new (config: Cfg) => NodeRedNodeLike);

  RED.log?.info?.(`[mcode-node-pack] registered ${MCODE_NODE_PACK_TYPES.length} types (v${MCODE_NODE_PACK_VERSION})`);
}

/* ── 编辑器 HTML（每类型最小三格参数；Node-RED 只认有同名 .html 的 .js） ── */

function htmlFor(type: string, params: Array<{ id: string; label: string; kind: "text" | "select"; options?: string[] }>, extraDefs = ""): string {
  const rows = params.map((p) => p.kind === "select"
    ? `<div class="form-row"><label for="node-input-${p.id}">${p.label}</label><select id="node-input-${p.id}">${(p.options ?? []).map((o) => `<option value="${o}">${o}</option>`).join("")}</select></div>`
    : `<div class="form-row"><label for="node-input-${p.id}">${p.label}</label><input type="text" id="node-input-${p.id}" placeholder="${p.label}"></div>`).join("\n  ");
  return `<script type="text/javascript">
  RED.nodes.registerType("${type}", {
    category: "mcode",
    color: "#8ea6b8",
    defaults: { name: { value: "" }, ${params.map((p) => `${p.id}: { value: "" }`).join(", ")} },
    inputs: ${type === MCODE_TRIGGER_NODE_TYPE ? 0 : 1},
    outputs: ${extraDefs === "multi" ? "function () { return Math.max(1, (this.wires && this.wires.length) || 1); }" : 1},
    icon: "font-awesome/fa-cube",
    label: function () { return this.name || "${type}"; },
    paletteLabel: "${type}",
  });
</script>
<script type="text/html" data-template-name="${type}">
  <div class="form-row"><label for="node-input-name"><i class="fa fa-tag"></i> Name</label><input type="text" id="node-input-name" placeholder="Name"></div>
  ${rows}
</script>
<script type="text/html" data-help-name="${type}">
  <p>Mcode ${type} node (minimal: delegates execution to the host-issued port).</p>
</script>
`;
}

export function conversationNodeHtml(): string {
  return htmlFor(MCODE_CONVERSATION_NODE_TYPE, [
    { id: "instruction", label: "Instruction", kind: "text" },
    { id: "capability", label: "Capability", kind: "select", options: ["read", "write"] },
    { id: "outputVar", label: "Output variable", kind: "text" },
  ]);
}
export function branchNodeHtml(): string {
  return htmlFor(MCODE_BRANCH_NODE_TYPE, [
    { id: "decider", label: "Decider (user/model)", kind: "select", options: ["user", "model"] },
    { id: "outputVar", label: "Output variable", kind: "text" },
    { id: "note", label: "Note", kind: "text" },
  ], "multi");
}
export function triggerNodeHtml(): string {
  return htmlFor(MCODE_TRIGGER_NODE_TYPE, [
    { id: "triggerKind", label: "Trigger kind", kind: "select", options: ["manual", "schedule", "file", "event"] },
    { id: "task", label: "Task", kind: "text" },
    { id: "cron", label: "Cron", kind: "text" },
  ]);
}
export function moduleCapabilityNodeHtml(): string {
  return htmlFor(MCODE_MODULE_CAPABILITY_NODE_TYPE, [
    { id: "moduleId", label: "Module id", kind: "text" },
    { id: "contributionId", label: "Contribution id", kind: "text" },
    { id: "path", label: "Path", kind: "text" },
  ]);
}
export function nodeRedCallNodeHtml(): string {
  return htmlFor(MCODE_NODE_RED_CALL_NODE_TYPE, [
    { id: "enginePath", label: "Engine path", kind: "text" },
    { id: "engineMethod", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "DELETE"] },
    { id: "engineBody", label: "Body", kind: "text" },
  ]);
}

/** 整个节点包的 HTML（agent + conversation/branch/trigger/module-capability/node-red-call
 *  共 6 类型；`<userDir>/nodes/<name>.html` 用它。condition/command 走内置，
 *  code 走内置 function/exec —— 节点统一后不再有 mcode-code）。 */
export function allNodeHtml(): string {
  return [
    agentNodeHtml(),
    conversationNodeHtml(),
    branchNodeHtml(),
    triggerNodeHtml(),
    moduleCapabilityNodeHtml(),
    nodeRedCallNodeHtml(),
  ].join("\n");
}
