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
  MCODE_X_MCODE_DEFAULT_ENTRY,
  agentNodeHtml,
  assertMcodeNodePortResult,
  createNodeInputLifecycle,
  normalizeAgentConfig,
  snapshotMcodeNodeInvocation,
  registerMcodeAgentNodes,
  tabMetaDefaultsScript,
  type McodeAgentNodeConfig,
  type McodeAgentPort,
  type NodeRedNodeLike,
  type NodeRedRuntimeApi,
} from "./mcodeNodePack.js";
import {
  CONDITION_EVAL_BRIDGE_KEY,
  MCODE_CONDITION_EVAL_NODE_TYPE,
} from "@contracts/conditionBridge";

export const MCODE_CONVERSATION_NODE_TYPE = "mcode-conversation";
export const MCODE_BRANCH_NODE_TYPE = "mcode-branch";
export const MCODE_TRIGGER_NODE_TYPE = "mcode-trigger";
export const MCODE_MODULE_CAPABILITY_NODE_TYPE = "mcode-module-capability";
export const MCODE_NODE_RED_CALL_NODE_TYPE = "mcode-node-red-call";
export { MCODE_CONDITION_EVAL_NODE_TYPE };

/** **用户可放置的节点类型**（palette）。内部适配节点不在这个表里，见
 *  {@link MCODE_INTERNAL_NODE_TYPES}。 */
export const MCODE_NODE_PACK_TYPES = [
  MCODE_AGENT_NODE_TYPE,
  MCODE_CONVERSATION_NODE_TYPE,
  MCODE_BRANCH_NODE_TYPE,
  MCODE_TRIGGER_NODE_TYPE,
  MCODE_MODULE_CAPABILITY_NODE_TYPE,
  MCODE_NODE_RED_CALL_NODE_TYPE,
] as const;

/**
 * **结构性内部节点**：用户不放置、由迁移器插入、语义完全由 Host 定义。
 *
 * 它们与 palette 类型走同一条 `registerType` 与 `<type>.js` 安装路径（否则编辑器
 * 会把它们当 unknown 处理、导出时丢掉 `x-mcode`），但**不进** `MCODE_NODE_PACK_TYPES`：
 * 那张表是「用户可以拖进画布的节点」的清单，混进内部节点会让调色板、文档与
 * 覆盖断言三处都说不清「这几类到底是什么」。
 */
export const MCODE_INTERNAL_NODE_TYPES = [
  MCODE_CONDITION_EVAL_NODE_TYPE,
] as const;

/** 本节点包**实际注册**的全部类型（palette + 内部）。`package.json` 的
 *  `node-red.nodes` 与安装清单都按这一份生成。 */
export const MCODE_REGISTERED_NODE_TYPES = [
  ...MCODE_NODE_PACK_TYPES,
  ...MCODE_INTERNAL_NODE_TYPES,
] as const;

type Cfg = McodeAgentNodeConfig & { wires?: string[][] };

/** 统一 payload 基座：每类端口都收这几个，再各自带动作参数。 */
export interface McodeNodeBasePayload {
  input: unknown;
  params: Record<string, unknown>;
  nodeId: string;
  runId: string | null;
  tabId?: string;
  /** Node-RED message id：同一批消息（一次触发派生的整条流）共享它。 */
  msgId?: string;
  /** Host lookup key only, checked against native tab/document at dispatch. */
  triggerTicket?: string;
}

type Invocation = ReturnType<typeof snapshotMcodeNodeInvocation>;

function basePayload(invocation: Invocation): McodeNodeBasePayload {
  return {
    input: invocation.inputSnapshot,
    params: invocation.paramsSnapshot,
    nodeId: invocation.normalized.nodeId,
    runId: invocation.runId,
    ...(invocation.tabId !== undefined ? { tabId: invocation.tabId } : {}),
    ...(typeof invocation.incomingMcode["triggerTicket"] === "string"
      && invocation.incomingMcode["triggerTicket"].length <= 128
      ? { triggerTicket: invocation.incomingMcode["triggerTicket"] } : {}),
  };
}

/** Host return uses the *same* invocation snapshot sent to the port. */
function outputMsg(
  invocation: Invocation,
  result: { text: string; artifacts: Array<Record<string, unknown>>; runId?: string },
  extraMcode: Record<string, unknown> = {},
): Record<string, unknown> {
  const safeResult = assertMcodeNodePortResult(result);
  const { normalized, incomingMcode, messageSnapshot, runId } = invocation;
  // W17：每个 mcode-* 节点在输出上追加自己这条执行事实，条件求值节点据此拼旧调度器
  // 那份 outcome 表（Host 只看得见它自己那一次调用，看不见上游）。上限 64 条：
  // 一条消息走过几十个节点已罕见；再多说明流被手改成环了，截断比无界增长安全
  // （`conditionHost.sanitizeConditionResults` 也只取尾部）。
  const priorResults = Array.isArray(incomingMcode["results"]) ? incomingMcode["results"] as unknown[] : [];
  const mcode: Record<string, unknown> = {
    ...incomingMcode,
    nodeId: normalized.nodeId,
    runId: safeResult.runId ?? runId,
    ...(normalized.outputVar !== null ? { outputVar: normalized.outputVar } : {}),
    results: [...priorResults.slice(-63), {
      nodeId: normalized.nodeId,
      summary: safeResult.text,
      status: "success",
    }],
    ...extraMcode,
  };
  // The new native editor's empty output binding takes precedence over the
  // previous upstream message, exactly as it does for mcode-agent.
  if (normalized.outputVar === null) delete mcode["outputVar"];
  return {
    ...messageSnapshot,
    payload: { text: safeResult.text, artifacts: safeResult.artifacts },
    mcode,
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
  const invocation = snapshotMcodeNodeInvocation(inputMsg, config);
  const base = basePayload(invocation);
  const result = await port.run({ ...base, instruction: invocation.normalized.instruction });
  return { msg: outputMsg(invocation, result) };
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
  const invocation = snapshotMcodeNodeInvocation(inputMsg, config);
  const base = basePayload(invocation);
  // Flows restored from disk are untrusted runtime objects, regardless of
  // the TypeScript type of a native editor's wires array. Never authorize
  // a Host routing decision using a synthetic/invalid output shape.
  const wires = config.wires;
  if (wires !== undefined && (!Array.isArray(wires)
      || !wires.every((targets) => Array.isArray(targets)
        && targets.every((target) => typeof target === "string")))) {
    throw new Error("Node-RED branch wires invalid: expected string[][]");
  }
  const portCount = Math.max(1, wires?.length ?? 1);
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
    invocation,
    { text: "", artifacts: [] }, // branch 只负责路由，原输入从调用时快照恢复。
    { branch: { port: chosen.port, ...(chosen.label !== undefined ? { label: chosen.label } : {}) } },
  );
  msg["payload"] = invocation.inputSnapshot;
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
  const invocation = snapshotMcodeNodeInvocation({}, config);
  const normalized = invocation.normalized;
  const kind = typeof invocation.paramsSnapshot["triggerKind"] === "string"
    ? invocation.paramsSnapshot["triggerKind"] as string : "manual";
  return {
    payload: { trigger: { kind, at } },
    mcode: { nodeId: normalized.nodeId, runId: null, triggerKind: kind },
  };
}

/** trigger 订阅时交给 port 的 payload（供 port 决定触发源）。 */
export function triggerSubscribePayload(config: Cfg): McodeNodeBasePayload & { triggerKind: string } {
  const invocation = snapshotMcodeNodeInvocation({}, config);
  const kind = typeof invocation.paramsSnapshot["triggerKind"] === "string"
    ? invocation.paramsSnapshot["triggerKind"] as string : "manual";
  return { ...basePayload(invocation), triggerKind: kind };
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
  const invocation = snapshotMcodeNodeInvocation(inputMsg, config);
  const base = basePayload(invocation);
  const moduleId = typeof base.params["moduleId"] === "string" ? (base.params["moduleId"] as string) : "";
  const contributionId = typeof base.params["contributionId"] === "string" ? (base.params["contributionId"] as string) : "";
  const path = typeof base.params["path"] === "string" ? (base.params["path"] as string) : "";
  const result = await port.run({ ...base, moduleId, contributionId, path });
  return { msg: outputMsg(invocation, result) };
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

/* ── condition-eval（W17：迁移后的条件图求值） ── */

/**
 * 条件求值端口。**求值在 Host 做**（见 `@contracts/conditionBridge` 文件头）：
 * 这里只交出「我是谁、我的表达式是什么、这条消息流上已经发生过什么」。
 *
 * 返回**布尔**。抛错 = 这次求值失败（引用不存在 / 算不了 / 宿主库不一致），
 * 外壳会 `node.error` 且**不发送消息** —— 与旧调度器「条件求值失败 → 节点失败、
 * 下游不跑」一致，而不是安静地走 else。
 */
export interface McodeConditionEvalPort {
  evaluate(payload: McodeNodeBasePayload & { expression: unknown; results: unknown[]; triggerTicket?: string }): Promise<{ matched: boolean }>;
}

/** 消息流上已发生的 mcode-* 执行事实（见 `mcodeNodePack.ts` 的 `outputMsg`）。 */
function carriedResultsOf(mcode: Record<string, unknown>): unknown[] {
  const raw = mcode["results"];
  return Array.isArray(raw) ? raw : [];
}

/** 条件节点自己的「结果文本」：上游透传的那段（和旧 `carriedTextOf` 同义）。 */
function carriedTextOf(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const text = (payload as Record<string, unknown>)["text"];
    if (typeof text === "string") return text;
  }
  return "";
}

export async function runConditionEvalNode(
  inputMsg: Record<string, unknown>,
  config: Cfg,
  port: McodeConditionEvalPort,
): Promise<{ msg: Record<string, unknown> }> {
  const invocation = snapshotMcodeNodeInvocation(inputMsg, config);
  const base = basePayload(invocation);
  const expression = base.params["expression"];
  const results = carriedResultsOf(invocation.incomingMcode).slice(-64);
  // **求值与执行记录都以原条件节点的 Mcode id 为准**（`bridgesNodeId`），不是适配
  // 节点自己的 `x-mcode.nodeId` —— 旧调度器里这一步的结局挂在条件节点名下，下游
  // `{{条件.status}}` 与流程记录都按那个 id 查。适配节点的 id 只是画布上的容器。
  const meta = config["x-mcode"];
  const bridgeTarget = meta !== null && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)[CONDITION_EVAL_BRIDGE_KEY] : undefined;
  if (typeof bridgeTarget !== "string" || bridgeTarget.trim() === "") {
    throw new Error("condition 求值节点缺少 bridgesNodeId —— 不在迁移产物里的节点，拒绝执行");
  }
  const ticket = invocation.incomingMcode["triggerTicket"];
  const outcome = await port.evaluate({ ...base, nodeId: bridgeTarget, expression, results,
    ...(typeof ticket === "string" && ticket.length <= 128 ? { triggerTicket: ticket } : {}),
  });
  if (outcome === null || typeof outcome !== "object" || typeof outcome.matched !== "boolean") {
    throw new Error("Host condition.evaluate result invalid: expected { matched: boolean }");
  }
  const mcode: Record<string, unknown> = {
    ...invocation.incomingMcode,
    nodeId: bridgeTarget,
    runId: invocation.runId,
    // 上游 `switch` 的 `{t:"true", vt:"bool"}` 规则读的就是它（实测：规则比较
    // property 与 true 全等，不读规则自带的值）。
    // The switch property path is "mcode.condition" on msg, but this object
    // is ALREADY msg.mcode. A literal "mcode.condition" key here is invisible
    // to Node-RED property traversal and silently sends true to else.
    condition: outcome.matched,
    results: [...results, {
      nodeId: bridgeTarget,
      summary: carriedTextOf(invocation.inputSnapshot),
      status: "success",
    }],
  };
  return { msg: { ...invocation.messageSnapshot, mcode } };
}

export async function runNodeRedCallNode(
  inputMsg: Record<string, unknown>,
  config: Cfg,
  port: McodeNodeRedCallPort,
): Promise<{ msg: Record<string, unknown> }> {
  const invocation = snapshotMcodeNodeInvocation(inputMsg, config);
  const base = basePayload(invocation);
  const enginePath = typeof base.params["enginePath"] === "string" ? (base.params["enginePath"] as string) : "";
  // Keep a freshly-created native palette node aligned with the Mcode
  // node-type manifest and Host executor: omitted/blank method means POST.
  const nativeMethod = base.params["engineMethod"];
  const engineMethod = typeof nativeMethod === "string" && nativeMethod.trim() !== ""
    ? nativeMethod : "POST";
  const engineBody = typeof base.params["engineBody"] === "string" ? (base.params["engineBody"] as string) : null;
  const result = assertMcodeNodePortResult(await port.run({ ...base, enginePath, engineMethod, engineBody }));
  if (result.status !== undefined && (!Number.isInteger(result.status)
    || result.status < 100 || result.status > 599)) {
    throw new Error("Host node-red-call status invalid: expected an HTTP status");
  }
  const msg = outputMsg(invocation, result,
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
  conditionEval: McodeConditionEvalPort;
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
    // Share the Agent node's redeploy lifecycle: an indefinitely pending Host
    // call must not strand Node-RED's input accounting or publish into old wires.
    const lifecycle = createNodeInputLifecycle(node);
    node.on("input", (msg, send, done) => {
      const finish = lifecycle.begin(done);
      if (finish === null) return;
      void (async () => {
        try {
          const outcome = await run(msg, config);
          if (!lifecycle.isClosed()) send(outcome.msg);
          finish();
        } catch (err) {
          if (!lifecycle.isClosed()) node.error(err, msg);
          finish(lifecycle.isClosed() ? undefined : err instanceof Error ? err : new Error(String(err)));
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
export function registerMcodeNodePack(RED: NodeRedRuntimeApi, getPorts: () => McodeNodePorts, onlyType?: string): void {
  // Node-RED loads each <type>.js as its own node set. Register exactly the
  // matching type from that file; the old all-types entry remains for tests.
  if (!onlyType || onlyType === MCODE_AGENT_NODE_TYPE)
    registerMcodeAgentNodes(RED, () => getPorts().agent);
  if (!onlyType || onlyType === MCODE_CONVERSATION_NODE_TYPE)
    registerIoSugar(RED, MCODE_CONVERSATION_NODE_TYPE, (msg, config) =>
      runConversationNode(msg, config, getPorts().conversation));
  if (!onlyType || onlyType === MCODE_MODULE_CAPABILITY_NODE_TYPE)
    registerIoSugar(RED, MCODE_MODULE_CAPABILITY_NODE_TYPE, (msg, config) =>
      runModuleCapabilityNode(msg, config, getPorts().moduleCapability));
  if (!onlyType || onlyType === MCODE_NODE_RED_CALL_NODE_TYPE)
    registerIoSugar(RED, MCODE_NODE_RED_CALL_NODE_TYPE, (msg, config) =>
      runNodeRedCallNode(msg, config, getPorts().nodeRedCall));
  if (!onlyType || onlyType === MCODE_CONDITION_EVAL_NODE_TYPE)
    registerIoSugar(RED, MCODE_CONDITION_EVAL_NODE_TYPE, (msg, config) =>
      runConditionEvalNode(msg, config, getPorts().conditionEval));

  // ── branch：1 入 N 出，按端口 send ──
  if (!onlyType || onlyType === MCODE_BRANCH_NODE_TYPE) RED.nodes.registerType(MCODE_BRANCH_NODE_TYPE, function (this: NodeInstance, config: Cfg) {
    const node = this;
    RED.nodes.createNode(node, config);
    const lifecycle = createNodeInputLifecycle(node);
    node.on("input", (msg, send, done) => {
      const finish = lifecycle.begin(done);
      if (finish === null) return;
      void (async () => {
        try {
          const outcome = await runBranchNode(msg, config, getPorts().branch);
          if (!lifecycle.isClosed()) {
            const portCount = Math.max(1, node.wires?.length ?? 1);
            const ports: Array<Record<string, unknown> | null> = Array.from({ length: portCount }, () => null);
            ports[outcome.port] = outcome.msg;
            send(ports);
          }
          finish();
        } catch (err) {
          if (!lifecycle.isClosed()) node.error(err, msg);
          finish(lifecycle.isClosed() ? undefined : err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  } as unknown as new (config: Cfg) => NodeRedNodeLike);

  // ── trigger：0 入 1 出，订阅 port 并在触发时 send ──
  if (!onlyType || onlyType === MCODE_TRIGGER_NODE_TYPE) RED.nodes.registerType(MCODE_TRIGGER_NODE_TYPE, function (this: NodeInstance, config: Cfg) {
    const node = this;
    RED.nodes.createNode(node, config);
    let closed = false;
    let active = false;
    // Only synchronous subscribe() events are buffered. A port that floods
    // before it returns its disposer cannot exhaust the main-process heap.
    const maxBufferedTriggerEvents = 256;
    const buffered: Array<Record<string, unknown>> = [];
    let bufferOverflow = false;
    let dispose: (() => void) | void = undefined;
    try {
      // The same Host identity and structured-clone boundary protects a
      // trigger's subscription even though triggers have no input callback.
      const subscription = triggerSubscribePayload(config);
      // The port receives a mutable transport payload. Capture the native
      // identity before handing that object across the Host boundary.
      const trustedNodeId = subscription.nodeId;
      const trustedTriggerKind = subscription.triggerKind;
      dispose = getPorts().trigger.subscribe(subscription, (msg) => {
        if (closed) return; // A queued event can arrive after unsubscribe.
        try {
          if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
            throw new Error("Host trigger event invalid: expected a message object");
          }
          // Event sources may reuse their message objects; detach them before
          // publishing so later changes cannot alter downstream Node-RED data.
          const event = structuredClone(msg) as Record<string, unknown>;
          const rawMeta = event["mcode"];
          if (rawMeta !== undefined && (rawMeta === null
              || typeof rawMeta !== "object" || Array.isArray(rawMeta))) {
            throw new Error("Host trigger event invalid: mcode metadata must be an object");
          }
          const meta = rawMeta === undefined ? {} : rawMeta as Record<string, unknown>;
          // Trigger is a new flow root: it has no upstream signed runId,
          // output binding or branch decision. Never import these as trusted
          // mcode metadata from an event source, even when it reached the port.
          // Preserve only the documented non-authority condition flag.
          event["mcode"] = {
            nodeId: trustedNodeId,
            runId: null,
            triggerKind: trustedTriggerKind,
            ...(typeof meta["condition"] === "boolean" ? { condition: meta["condition"] } : {}),
            // A token is only a lookup key; the Host owns the actual facts.
            ...(typeof meta["triggerTicket"] === "string" && meta["triggerTicket"].length <= 128
              ? { triggerTicket: meta["triggerTicket"] } : {}),
          };
          // A Host port may synchronously emit and then reject subscribe().
          // Publish only after it returns a callable cancellation handle.
          if (active) node.send(event);
          else if (buffered.length >= maxBufferedTriggerEvents) {
            bufferOverflow = true;
            closed = true;
            buffered.length = 0;
          } else buffered.push(event);
        } catch (err) {
          if (!closed) node.error(err);
        }
      });
      if (bufferOverflow) {
        throw new Error("Host trigger synchronous event buffer exceeded");
      }
      if (typeof dispose !== "function") {
        throw new Error("Host trigger subscription missing cancellation handle");
      }
      active = true;
      for (const event of buffered.splice(0)) {
        if (closed) break;
        node.send(event);
      }
    } catch (err) {
      // Failed subscriptions must never publish buffered or later events.
      closed = true;
      buffered.length = 0;
      if (typeof dispose === "function") {
        try { dispose(); } catch { /* keep original failure */ }
        dispose = undefined;
      }
      node.error(err);
    }
    node.on("close", () => {
      if (closed) return;
      closed = true;
      if (typeof dispose === "function") {
        const release = dispose;
        dispose = undefined;
        try {
          release();
        } catch (err) {
          // Surface failed Host cancellation. The local node stays closed,
          // but the user must not be told the external source was stopped.
          try { node.error(err); } catch { /* still finish Node-RED close */ }
        }
      }
    });
  } as unknown as new (config: Cfg) => NodeRedNodeLike);

  RED.log?.info?.(`[mcode-node-pack] registered ${onlyType ?? MCODE_REGISTERED_NODE_TYPES.join(", ")} (v${MCODE_NODE_PACK_VERSION})`);
}

/* ── 编辑器 HTML（每类型最小三格参数；Node-RED 只认有同名 .html 的 .js） ── */

/** Native editor icon names verified in Node-RED's bundled Font Awesome 4 CSS. */
const nodeEditorUi: Record<string, {
  icon: string; input: string; output: string; approval: string;
}> = {
  [MCODE_CONVERSATION_NODE_TYPE]: {
    icon: "fa-comments",
    input: "Input: msg.payload and the instruction are sent to the selected visible Mcode chat session.",
    output: "Output: one msg.payload with { text, artifacts }; msg.mcode includes the run ID.",
    approval: "Approval: native model tool actions can require Mcode user approval; the capability field does not grant permission.",
  },
  [MCODE_BRANCH_NODE_TYPE]: {
    icon: "fa-random",
    input: "Input: msg.payload is preserved; decider selects a Host-backed user or model decision.",
    output: "Output: original msg.payload is sent to exactly one of the configured outputs (zero-based port index).",
    approval: "Approval: user decisions require a Host dialog and cancellation stops routing; model decisions may invoke normal tool approvals.",
  },
  [MCODE_TRIGGER_NODE_TYPE]: {
    icon: "fa-bolt",
    input: "Input: no incoming msg.payload (zero-input node); the Host subscribes to the configured event source.",
    output: "Output: the Host event's msg.payload is emitted on the single output.",
    approval: "Approval: this node never grants permission; event subscription uses Host authorization and does not itself display an approval dialog.",
  },
  [MCODE_MODULE_CAPABILITY_NODE_TYPE]: {
    icon: "fa-puzzle-piece",
    input: "Input: msg.payload and module ID, contribution ID, path and authorized project path go to the Host module invocation.",
    output: "Output: Host result becomes msg.payload with { text, artifacts }.",
    approval: "Approval: module capability permission is checked by the Mcode Host; missing or denied grants block execution.",
  },
  [MCODE_NODE_RED_CALL_NODE_TYPE]: {
    icon: "fa-retweet",
    input: "Input: msg.payload accompanies the configured Node-RED API path, method and body.",
    output: "Output: response becomes msg.payload with { text, artifacts }; HTTP status is stored in msg.mcode.engineStatus.",
    approval: "Approval: GET is Host scoped; POST /flows requires user deployment approval and ownership checks. Other mutations are rejected.",
  },
  [MCODE_CONDITION_EVAL_NODE_TYPE]: {
    icon: "fa-code-fork",
    input: "Input: the original message; the saved condition expression and the upstream results already seen on this flow go to the Host for evaluation.",
    output: "Output: the same message with msg.mcode.condition set to the boolean result. The native switch AFTER this node routes true/false; this node never routes on its own.",
    approval: "Approval: evaluation is read-only and never calls a model or a command. A reference this Host cannot resolve (trigger payload, structured output variables, native node status) fails the node instead of quietly choosing the false branch.",
  },
};
function htmlFor(type: string, params: Array<{ id: string; label: string; kind: "text" | "select" | "textarea"; options?: string[]; defaultValue?: string; required?: boolean }>, extraDefs = ""): string {
  const ui = nodeEditorUi[type];
  if (!ui) throw new Error("Unknown Mcode editor type: " + type);
  const rows = params.map((p) => {
    const label = '<label for="node-input-' + p.id + '" data-i18n="[title]mcode.tooltip.' + p.id + '"><span data-i18n="mcode.label.' + p.id + '">' + p.label + '</span></label>';
    const control = p.kind === "select"
      ? '<select id="node-input-' + p.id + '">' + (p.options ?? []).map((o) =>
        '<option value="' + o + '" data-i18n="mcode.option.' + o + '">' + o + '</option>').join("") + '</select>'
      : p.kind === "textarea"
        ? '<textarea id="node-input-' + p.id + '" rows="4" placeholder="' + p.label + '" data-i18n="[placeholder]mcode.placeholder.' + p.id + '"></textarea>'
        : '<input type="text" id="node-input-' + p.id + '" placeholder="' + p.label + '" data-i18n="[placeholder]mcode.placeholder.' + p.id + '">';
    return '<div class="form-row">' + label + control + '</div>';
  }).join("\n  ");
  return `<script type="text/javascript">
  RED.nodes.registerType("${type}", {
    category: "mcode",
    color: "#8ea6b8",
    defaults: { name: { value: "" }, ${params.map((p) => `${p.id}: { value: ${JSON.stringify(p.defaultValue ?? "")}${p.required ? ", required: true" : ""} }`).join(", ")}, ${MCODE_X_MCODE_DEFAULT_ENTRY} },
    inputs: ${type === MCODE_TRIGGER_NODE_TYPE ? 0 : 1},
    outputs: ${extraDefs === "multi" ? "function () { return Math.max(1, (this.wires && this.wires.length) || 1); }" : 1},
    icon: "font-awesome/${ui.icon}",
    label: function () { return this.name || "${type}"; },
    paletteLabel: "${type}",
  });
</script>
<script type="text/javascript">
${tabMetaDefaultsScript()}
</script>
<script type="text/html" data-template-name="${type}">
  <div class="form-row"><label for="node-input-name" data-i18n="[title]mcode.tooltip.name"><i class="fa fa-tag"></i> <span data-i18n="common.label.name">Name</span></label><input type="text" id="node-input-name" placeholder="Name" data-i18n="[placeholder]common.label.name"></div>
  ${rows}
</script>
<script type="text/html" data-help-name="${type}">
  <p data-i18n="mcode.help.input">Input: ${ui.input.slice("Input: ".length)}</p>
  <p data-i18n="mcode.help.output">Output: ${ui.output.slice("Output: ".length)}</p>
  <p data-i18n="mcode.help.approval">Approval: ${ui.approval.slice("Approval: ".length)}</p>
</script>
`;
}

export function conversationNodeHtml(): string {
  return htmlFor(MCODE_CONVERSATION_NODE_TYPE, [
    { id: "instruction", label: "Instruction", kind: "textarea" },
    { id: "capability", label: "Capability", kind: "select", options: ["read", "write"] },
    { id: "outputVar", label: "Output variable", kind: "text" },
    { id: "sessionId", label: "Mcode session ID", kind: "text", required: true },
  ]);
}
export function branchNodeHtml(): string {
  return htmlFor(MCODE_BRANCH_NODE_TYPE, [
    { id: "decider", label: "Decider (user/model)", kind: "select", options: ["user", "model"] },
    { id: "outputVar", label: "Output variable", kind: "text" },
    { id: "note", label: "Note", kind: "textarea" },
    { id: "sessionId", label: "Mcode session ID (model decision)", kind: "text" },
  ], "multi");
}
export function triggerNodeHtml(): string {
  return htmlFor(MCODE_TRIGGER_NODE_TYPE, [
    { id: "triggerKind", label: "Trigger kind", kind: "select", options: ["manual", "schedule", "file", "event"] },
    { id: "task", label: "Task instructions (not the event type)", kind: "textarea" },
    { id: "events", label: "Event types (comma-separated, e.g. library.item.imported)", kind: "text" },
    { id: "eventFilter", label: "Legacy event filter (unsupported; clear before Deploy)", kind: "text" },
    { id: "cron", label: "Cron", kind: "text" },
  ]);
}
export function moduleCapabilityNodeHtml(): string {
  return htmlFor(MCODE_MODULE_CAPABILITY_NODE_TYPE, [
    { id: "moduleId", label: "Module id", kind: "text" },
    { id: "contributionId", label: "Contribution id", kind: "text" },
    { id: "path", label: "Path", kind: "text" },
    { id: "projectPath", label: "Authorized project path", kind: "text" },
  ]);
}
export function nodeRedCallNodeHtml(): string {
  return htmlFor(MCODE_NODE_RED_CALL_NODE_TYPE, [
    { id: "enginePath", label: "Engine path", kind: "text" },
    { id: "engineMethod", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], defaultValue: "POST" },
    { id: "engineBody", label: "Body", kind: "textarea" },
  ]);
}

/**
 * 条件求值适配节点。**没有可编辑的表单**：表达式住在它的 `x-mcode.params` 里
 * （由迁移器从原条件节点抄过来），native 侧改它等于改条件语义 —— 那应该回 Mcode
 * 画布改，不是在 Node-RED 里手改一份影子。所以这个模板只显示一句说明。
 *
 * 但它**必须**有 `<script type="text/html" data-template-name=...>` 块：上游编辑器
 * 对没有注册模板的类型会把节点当 `unknown` 处理，导出时只保留 `_orig` 原样字段、
 * 丢失 `x-mcode`（`editor-client/src/js/nodes.js` 的 `convertNode`）。没有模板
 * 就等于往返一次身份就没了。
 */
export function conditionEvalNodeHtml(): string {
  return `<script type="text/javascript">
  RED.nodes.registerType("${MCODE_CONDITION_EVAL_NODE_TYPE}", {
    category: "mcode",
    color: "#b8c4d0",
    defaults: { name: { value: "" }, ${MCODE_X_MCODE_DEFAULT_ENTRY} },
    inputs: 1,
    outputs: 1,
    icon: "font-awesome/fa-code-fork",
    label: function () { return this.name || "condition"; },
    paletteLabel: "condition",
  });
</script>
<script type="text/javascript">
${tabMetaDefaultsScript()}
</script>
<script type="text/html" data-template-name="${MCODE_CONDITION_EVAL_NODE_TYPE}">
  <div class="form-row">
    <label for="node-input-name" data-i18n="[title]mcode.tooltip.name"><i class="fa fa-tag"></i> <span data-i18n="common.label.name">Name</span></label>
    <input type="text" id="node-input-name" placeholder="Name" data-i18n="[placeholder]common.label.name">
  </div>
  <div class="form-row">
    <p data-i18n="mcode.help.conditionEvalForm">The condition expression is owned by the Mcode workflow. Edit it there; this node only evaluates it at run time.</p>
  </div>
</script>
<script type="text/html" data-help-name="${MCODE_CONDITION_EVAL_NODE_TYPE}">
  <p data-i18n="mcode.help.input">Input: the original message; the saved condition expression and the upstream results already seen on this flow go to the Host for evaluation.</p>
  <p data-i18n="mcode.help.output">Output: the same message with msg.mcode.condition set to the boolean result. Wire it into a switch that reads mcode.condition (true → output 1, else → output 2).</p>
  <p data-i18n="mcode.help.approval">Approval: evaluation is read-only. A reference this Host cannot resolve fails the node instead of quietly choosing the false branch.</p>
</script>
`;
}

/** 整个节点包的 HTML（palette 六类型；`<userDir>/nodes/<name>.html` 用它。
 *  condition/command 走内置，code 走内置 function/exec —— 节点统一后不再有
 *  mcode-code）。内部求值适配节点有自己的一对 js/html（见
 *  `MCODE_INTERNAL_NODE_TYPES`），不进这一份 —— 这一份的消费者按「六个 palette
 *  类型」计数。 */
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
