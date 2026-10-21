/**
 * 【ARC-006 MERGE-2 第一片】**`mcode-agent` 节点包的最小可用实现**。
 *
 * ## 它是什么（以及刻意不是什么）
 *
 * Node-RED 的自定义节点包：一个 `.js` + 同名 `.html`，放进引擎数据目录的
 * `<userDir>/nodes/` 后由 Node-RED 自己在启动时 require（`@node-red/registry` 的
 * `getNodeFiles` 扫 `<userDir>/nodes/`，要求 `.js` 有同名 `.html` 才认作节点）。
 *
 * **这一片不接三引擎**：节点执行体只调用一个可注入的 {@link McodeAgentPort}：
 *
 *   port.run(payload) → { text, artifacts }
 *
 * 生产装配将来把 port 接到 Host RPC（三 SDK + 审批 + runStore）；测试注入假实现。
 * 节点自己**不**知道模型、会话、权限 —— 它只负责 Node-RED 侧的连接语义：
 *
 *   - 读 `msg.payload` 作为这次运行的输入文本（可选；没有就用参数里的 instruction）；
 *   - 调 port.run，把结果写成 `msg.payload = { text, artifacts }`；
 *   - 透传 `msg.mcode = { nodeId, runId }`（nodeId 来自 `x-mcode.nodeId`，runId 由
 *     port 返回或由宿主注入 —— 没有就保留调用方给的那份）。
 *
 * ## 为什么拆成「纯逻辑」+「Node-RED 外壳」
 *
 * Node-RED 的节点构造函数是 `function (RED) { RED.nodes.registerType(...) }`，只能
 * 在引擎进程里跑。为了让输入/输出形状能在无头套件里**直接单测**（不进真引擎），
 * 把「一次执行」收成一个纯函数 {@link runAgentNode}；外层注册函数只做三件事：
 * 读参数、订阅 input、调纯函数、send/error/done。
 *
 * ## 参数（与迁移器产出、Mcode 侧清单一致）
 *
 * | 键 | 类型 | 语义 |
 * |---|---|---|
 * | `instruction` | string | 这一步要做什么（迁移自 `mcode.agent` 的 `params.instruction`）|
 * | `capability` | "read" \| "write" | 声明这一步的能力；**本片只透传给 port**，不据此拦 |
 * | `outputVar` | string | 产出变量名；本片用于在 `msg.mcode.outputVar` 上标注，供下游引用 |
 *
 * 未知参数不丢：Node-RED 节点配置对象上的其它键由节点自己保留在 `node.xmcodeParams`，
 * 执行时经 `payload.params` 原样交给 port —— 与迁移器「未知字段原样带走」同一条纪律。
 *
 * ## 错误语义
 *
 * port 抛错 → `node.error(err, msg)`（Node-RED 的 Catch 节点能接住）+ `node.done()`；
 * 不吞、不把失败伪装成空产出。port 缺失（装配错误）→ 同样显式报错，不静默成功。
 */

/** 节点类型 id —— 与迁移器 `NODE_RED_TYPE_OF_RUNNER.prompt` 同一字符串。 */
export const MCODE_AGENT_NODE_TYPE = "mcode-agent";

/** 本片节点包版本（`package.json` / 报告可复核）。 */
export const MCODE_NODE_PACK_VERSION = 1;

/** 一次 agent 运行的输入 —— 与 Host RPC 将来的请求形状同形（多一层包装即可）。 */
export interface McodeAgentRunPayload {
  /** 这一步要做什么。 */
  instruction: string;
  /** 本次输入（上游节点给的 `msg.payload`；字符串或任意 JSON）。 */
  input: unknown;
  /** 能力声明（read/write）——本片不据此拦截，只透传。 */
  capability: "read" | "write";
  /** Mcode 节点身份（迁移器写在 Node-RED 节点的 `x-mcode.nodeId`）。 */
  nodeId: string;
  /** 本次运行的 id（Host 注入；没有就是 null）。 */
  runId: string | null;
  /** Native tab membership, verified independently against Host-owned flow metadata. */
  tabId?: string;
  /** 迁移器带过来的其余参数（未知字段原样交给 port）。 */
  params: Record<string, unknown>;
}

/** port 的产出 —— 与迁移器/Mcode 侧的「这一步交什么」同形。 */
export interface McodeAgentRunResult {
  text: string;
  artifacts: Array<{ kind: string; uri: string; name?: string; mimeType?: string; sizeBytes?: number }>;
  /** Host 签发/回执的 runId（可选；缺省沿用输入 msg 上的那份）。 */
  runId?: string;
}

/** 可注入的执行端口。生产将来接 Host RPC；测试给假实现。 */
export interface McodeAgentPort {
  run(payload: McodeAgentRunPayload): Promise<McodeAgentRunResult>;
}

/** 节点构造时从 Node-RED 配置对象读到的参数形状（宽松：未知键保留）。 */
export interface McodeAgentNodeConfig {
  id?: string;
  name?: string;
  instruction?: unknown;
  capability?: unknown;
  outputVar?: unknown;
  /** 迁移器写在 Node-RED 节点上的 Mcode 元数据。 */
  "x-mcode"?: { nodeId?: unknown; type?: unknown; params?: unknown; title?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

/** 规范化配置：参数缺失/类型不对时给安全默认（不抛 —— 节点构造不能因配置崩引擎）。 */
export function normalizeAgentConfig(config: McodeAgentNodeConfig): {
  instruction: string;
  capability: "read" | "write";
  outputVar: string | null;
  nodeId: string;
  params: Record<string, unknown>;
} {
  // This node can be restored from untrusted/old flows.json; a TS interface
  // does not guarantee runtime shape. Never let one invalid node crash load.
  const safeConfig = config !== null && typeof config === "object" && !Array.isArray(config)
    ? config : {} as McodeAgentNodeConfig;
  const meta = safeConfig["x-mcode"];
  const xmcode = meta !== null && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  const params = "params" in xmcode ? xmcode.params : undefined;
  const rawParams = params !== null && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown> : {};
  // The upstream Node-RED editor owns instruction/capability/outputVar once a
  // property exists on the native node. x-mcode.params is a migration fallback,
  // NOT a second editable source of truth. Using sidecar-first semantics
  // silently resurrects old instructions/write permissions after a user edits
  // them in the real editor, including when a field is intentionally cleared.
  const hasNative = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(safeConfig, key);
  const instruction = hasNative("instruction")
    ? (typeof safeConfig.instruction === "string" ? safeConfig.instruction : "")
    : (typeof rawParams["instruction"] === "string" ? rawParams["instruction"] : "");
  const capability: "read" | "write" = hasNative("capability")
    ? (safeConfig.capability === "write" ? "write" : "read")
    : (rawParams["capability"] === "write" ? "write" : "read");
  const nativeOutputVar = hasNative("outputVar");
  const rawOutputVar = nativeOutputVar ? safeConfig.outputVar : rawParams["outputVar"];
  const outputVar = typeof rawOutputVar === "string" && rawOutputVar.trim() !== ""
    ? rawOutputVar.trim() : null;
  // Host consumers also receive params; do not pass stale privileged values
  // there after normalizing top-level native-editor properties.
  const effectiveParams: Record<string, unknown> = { ...rawParams };
  if (hasNative("instruction")) effectiveParams["instruction"] = instruction;
  if (hasNative("capability")) effectiveParams["capability"] = capability;
  if (nativeOutputVar) {
    if (outputVar === null) delete effectiveParams["outputVar"];
    else effectiveParams["outputVar"] = outputVar;
  }
  // The other native Node-RED palette forms are equally authoritative:
  // branch, trigger, module-capability and node-red-call must not execute
  // stale x-mcode.params after a user edits their real editor fields.
  // Preserve unknown migration metadata; overwrite only fields actually
  // exposed by the upstream Node-RED node form and present in the native node.
  for (const key of [
    "decider", "note", "triggerKind", "task", "cron",
    "moduleId", "contributionId", "path",
    "enginePath", "engineMethod", "engineBody", "sessionId", "projectPath",
  ]) {
    if (hasNative(key)) {
      effectiveParams[key] = typeof safeConfig[key] === "string" ? safeConfig[key] : "";
    }
  }
  const nodeId = typeof xmcode.nodeId === "string" && xmcode.nodeId !== ""
    ? xmcode.nodeId
    : typeof safeConfig.id === "string" ? safeConfig.id : "";
  return { instruction, capability, outputVar, nodeId, params: effectiveParams };
}

/** Host RPC boundary validator shared by agent, conversation, module and
 * node-red-call. TypeScript signatures do not validate dynamic IPC payloads.
 * A malformed response must reach Node-RED Catch, not emit a success message.
 */
export function assertMcodeNodePortResult<T>(result: T): T {
  if (result === null || typeof result !== "object"
    || typeof (result as { text?: unknown }).text !== "string"
    || !Array.isArray((result as { artifacts?: unknown }).artifacts)
    || !(result as unknown as { artifacts: unknown[] }).artifacts.every(
      (item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
        const artifact = item as {
          kind?: unknown; uri?: unknown; name?: unknown;
          mimeType?: unknown; sizeBytes?: unknown;
        };
        return typeof artifact.kind === "string" && artifact.kind.trim() !== ""
          && typeof artifact.uri === "string" && artifact.uri.trim() !== ""
          && (artifact.name === undefined || typeof artifact.name === "string")
          && (artifact.mimeType === undefined || typeof artifact.mimeType === "string")
          && (artifact.sizeBytes === undefined
            || (typeof artifact.sizeBytes === "number"
              && Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0));
      })
    || ((result as { runId?: unknown }).runId !== undefined
      && (typeof (result as { runId?: unknown }).runId !== "string"
        || (result as unknown as { runId: string }).runId.trim() === ""))) {
    throw new Error("Host RPC result invalid: expected { text, artifacts, runId? }");
  }
  // The Host transport can return mutable objects or extra custom metadata.
  // A function/symbol hidden in an artifact cannot pass Node-RED IPC. Make a
  // detached result at the same trust boundary instead of leaking references.
  try {
    return structuredClone(result);
  } catch {
    throw new Error("Host RPC result invalid: non-cloneable output");
  }
}

/** 一次节点执行的结果 —— 纯数据，供 Node-RED 外壳与单测共用。 */
export interface McodeAgentNodeOutcome {
  /** 发往下游的 msg（`payload = { text, artifacts }`，`mcode = { nodeId, runId }`）。 */
  msg: Record<string, unknown>;
  /** port 的原始结果（外壳不用，单测/诊断用）。 */
  result: McodeAgentRunResult;
}

/**
 * One trust boundary for every native Mcode Host-backed Node-RED type.
 * Captures the invocation-time identity, native editor params, provenance and
 * payload BEFORE an async Host RPC. Do not trust mutable upstream messages
 * or let one node type bypass the Agent identity/clone checks.
 */
export function snapshotMcodeNodeInvocation(
  inputMsg: Record<string, unknown>,
  config: McodeAgentNodeConfig,
): {
  normalized: ReturnType<typeof normalizeAgentConfig>;
  messageSnapshot: Record<string, unknown>;
  incomingMcode: Record<string, unknown>;
  paramsSnapshot: Record<string, unknown>;
  inputSnapshot: unknown;
  runId: string | null;
  tabId?: string;
} {
  const normalized = normalizeAgentConfig(config);
  if (normalized.nodeId.trim() === "") {
    throw new Error("Host Agent node identity missing; refusing execution");
  }
  const messageSnapshot = { ...inputMsg };
  const rawMcode = messageSnapshot["mcode"];
  let incomingMcode: Record<string, unknown>;
  let paramsSnapshot: Record<string, unknown>;
  let inputSnapshot: unknown;
  try {
    incomingMcode = rawMcode !== null && typeof rawMcode === "object" && !Array.isArray(rawMcode)
      ? structuredClone(rawMcode as Record<string, unknown>) : {};
    paramsSnapshot = structuredClone(normalized.params);
    inputSnapshot = structuredClone(messageSnapshot["payload"] ?? null);
  } catch {
    throw new Error("Host Agent invocation data is not cloneable");
  }
  // Node-RED assigns _msgid at injection and preserves it across wires.
  // Use it when no Mcode runId exists so all steps share one board run.
  const runId = typeof incomingMcode["runId"] === "string" ? incomingMcode["runId"]
    : typeof messageSnapshot["_msgid"] === "string" ? messageSnapshot["_msgid"] : null;
  return { normalized, messageSnapshot, incomingMcode, paramsSnapshot, inputSnapshot, runId,
    ...(typeof config.z === "string" ? { tabId: config.z } : {}) };
}

/**
 * **一次 `mcode-agent` 执行**（纯函数，不碰 Node-RED）。
 *
 * @param inputMsg 上游的 msg（只读 `payload` / `mcode.runId`）
 * @param config 节点配置（Node-RED 里存的那份）
 * @param port 注入的执行端口
 */
export async function runAgentNode(
  inputMsg: Record<string, unknown>,
  config: McodeAgentNodeConfig,
  port: McodeAgentPort,
): Promise<McodeAgentNodeOutcome> {
  const { normalized, messageSnapshot, incomingMcode,
    paramsSnapshot, inputSnapshot, runId } = snapshotMcodeNodeInvocation(inputMsg, config);
  const payload: McodeAgentRunPayload = {
    instruction: normalized.instruction,
    input: inputSnapshot,
    capability: normalized.capability,
    nodeId: normalized.nodeId,
    runId,
    ...(typeof config.z === "string" ? { tabId: config.z } : {}),
    params: paramsSnapshot,
  };
  // Validate and detach the Host result before exposing it downstream.
  const result = assertMcodeNodePortResult(await port.run(payload));
  // 产出形状与 Mcode 侧「这一步交什么」一致：text + artifacts。
  const msg: Record<string, unknown> = {
    ...messageSnapshot,
    payload: { text: result.text, artifacts: result.artifacts },
    mcode: {
      ...incomingMcode,
      nodeId: normalized.nodeId,
      runId: result.runId ?? runId,
      ...(normalized.outputVar !== null ? { outputVar: normalized.outputVar } : {}),
    },
  };
  // An upstream node's outputVar is not this node's output binding. Clearing
  // the native editor field must remove it instead of inheriting stale metadata.
  if (normalized.outputVar === null) {
    delete (msg["mcode"] as Record<string, unknown>)["outputVar"];
  }
  return { msg, result };
}

/** `runAgentNode` 需要 port 能回带 runId（Host 签发时）；本片允许缺省。 */

/** 供 Node-RED 外壳使用的 RED 面（只取用到的成员；测试可注入假 RED）。 */
export interface NodeRedRuntimeApi {
  nodes: {
    registerType(
      type: string,
      constructor: new (config: McodeAgentNodeConfig) => NodeRedNodeLike,
      opts?: Record<string, unknown>,
    ): void;
    /** **必须**在构造函数里调用（Node-RED 核心节点同一约定）：调用 Node 基类构造，
     *  拿到 id/wires/_flow，否则 `send()` 会抛 "Node object is not a node-red Node"。 */
    createNode(node: unknown, config: unknown): void;
  };
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

/** Node-RED 节点实例的最小面（注册函数里用到的部分）。 */
export interface NodeRedNodeLike {
  on(event: "close", listener: () => void): void;
  on(event: "input", listener: (msg: Record<string, unknown>, send: (m: unknown) => void, done: (err?: Error) => void) => void): void;
  error(err: unknown, msg?: Record<string, unknown>): void;
  status?(status: Record<string, unknown>): void;
  warn?(msg: string): void;
  id?: string;
}

/**
 * Shared lifecycle for Mcode thin Host RPC nodes. Node-RED owns the executor;
 * this adapter only closes its input accounting on redeploy. A Host RPC may
 * never settle (e.g. lost approval or connection), so close must synchronously
 * release every pending done() exactly once without publishing a stale result.
 * Physical Host cancellation is a separate, still unimplemented contract.
 */
export function createNodeInputLifecycle(node: NodeRedNodeLike): {
  isClosed(): boolean;
  begin(done: (err?: Error) => void): ((err?: Error) => void) | null;
} {
  let closed = false;
  const pending = new Set<(err?: Error) => void>();
  node.on("close", () => {
    if (closed) return;
    closed = true;
    for (const finish of [...pending]) {
      try {
        finish();
      } catch (err) {
        // A broken Node-RED done() callback must not strand the other
        // inputs or abort redeploy. Report it, but keep closing siblings.
        try { node.error(err); } catch { /* close must still continue */ }
      }
    }
  });
  return {
    isClosed: () => closed,
    begin(done) {
      if (closed) {
        done(new Error("Node-RED 节点已关闭"));
        return null;
      }
      const finish = (err?: Error): void => {
        if (!pending.delete(finish)) return;
        done(err);
      };
      pending.add(finish);
      return finish;
    },
  };
}

/** Node-RED 节点 HTML（编辑器 palette 里的外观；不含执行逻辑）。 */
export function agentNodeHtml(): string {
  return `<script type="text/javascript">
  RED.nodes.registerType("${MCODE_AGENT_NODE_TYPE}", {
    category: "mcode",
    color: "#8ea6b8",
    defaults: {
      name: { value: "" },
      instruction: { value: "" },
      capability: { value: "read" },
      outputVar: { value: "" },
      sessionId: { value: "" },
    },
    inputs: 1,
    outputs: 1,
    icon: "font-awesome/fa-user",
    label: function () { return this.name || "mcode-agent"; },
    paletteLabel: "mcode-agent",
  });
</script>
<script type="text/html" data-template-name="${MCODE_AGENT_NODE_TYPE}">
  <div class="form-row">
    <label for="node-input-name"><i class="fa fa-tag"></i> <span data-i18n="common.label.name">Name</span></label>
    <input type="text" id="node-input-name" placeholder="Name">
  </div>
  <div class="form-row">
    <label for="node-input-instruction"><i class="fa fa-pencil"></i> <span data-i18n="mcode.label.instruction">Instruction</span></label>
    <textarea id="node-input-instruction" rows="5" placeholder="What this step does"></textarea>
  </div>
  <div class="form-row">
    <label for="node-input-capability"><i class="fa fa-shield"></i> <span data-i18n="mcode.label.capability">Capability</span></label>
    <select id="node-input-capability"><option value="read">read</option><option value="write">write</option></select>
  </div>
  <div class="form-row">
    <label for="node-input-outputVar"><i class="fa fa-code"></i> <span data-i18n="mcode.label.outputVar">Output variable</span></label>
    <input type="text" id="node-input-outputVar" placeholder="outputVar">
  </div>
  <div class="form-row">
    <label for="node-input-sessionId"><i class="fa fa-comments"></i> <span data-i18n="mcode.label.sessionId">Mcode session ID</span></label>
    <input type="text" id="node-input-sessionId" placeholder="Existing visible Mcode session ID">
  </div>
</script>
<script type="text/html" data-help-name="${MCODE_AGENT_NODE_TYPE}">
  <p>Runs one Mcode agent step through the host-issued port. Outputs <code>msg.payload = { text, artifacts }</code>.</p>
</script>
`;
}

/**
 * **Node-RED 注册入口**：`module.exports = registerMcodeAgentNodes`，由 Node-RED 以
 * `registerMcodeAgentNodes(RED)` 调用（见 Node-RED 5.0.8 的 loader：模块导出函数时
 * 传入 RED 并 await 其返回的 promise）。
 *
 * `getPort` 是宿主注入点：生产在引擎进程里给它一个经 Host RPC 的 port；测试给假实现。
 * 本片**没有**把 port 接到三引擎 —— 这是刻意的最小切片。
 */
export function registerMcodeAgentNodes(RED: NodeRedRuntimeApi, getPort: () => McodeAgentPort): void {
  RED.nodes.registerType(MCODE_AGENT_NODE_TYPE, function (this: NodeRedNodeLike, config: McodeAgentNodeConfig) {
    const node = this;
    // Node-RED 约定（核心节点同形）：先建基类节点 —— 否则这个实例没有 wires/_flow，
    // send() 会抛 "Node object is not a node-red Node"（真引擎实测抓到）。
    RED.nodes.createNode(node, config);
    const lifecycle = createNodeInputLifecycle(node);
    node.on("input", (msg, send, done) => {
      const finish = lifecycle.begin(done);
      if (finish === null) return;
      void (async () => {
        try {
          const outcome = await runAgentNode(msg, config, getPort());
          if (!lifecycle.isClosed()) send(outcome.msg);
          finish();
        } catch (err) {
          if (!lifecycle.isClosed()) node.error(err, msg);
          finish(lifecycle.isClosed() ? undefined : err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  } as unknown as new (config: McodeAgentNodeConfig) => NodeRedNodeLike);
  RED.log?.info?.(`[mcode-agent] registered (pack v${MCODE_NODE_PACK_VERSION})`);
}
