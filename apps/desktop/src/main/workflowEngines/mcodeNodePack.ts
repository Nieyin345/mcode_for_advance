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

import { branchContextForNode, type McodeBranchContext } from "./branchContext.js";

/** Convert the first workflow message into a stable prompt value, with a hard IPC bound. */
export function workflowUserTextOf(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 32_000);
  if (value === null || typeof value !== "object") return "";
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    // Native triggers and injected messages often use the same { text } shape
    // as Mcode's own node output. Preserve the human-readable request instead
    // of serializing the wrapper object into every downstream prompt.
    for (const key of ["text", "content", "question", "instruction"]) {
      if (typeof record[key] === "string" && (record[key] as string).trim() !== "") {
        return (record[key] as string).slice(0, 32_000);
      }
    }
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.slice(0, 32_000) : "";
  } catch {
    return "";
  }
}

/** Keep only bounded, template-relevant fields when forwarding prior node results to Host. */
export function workflowResultsForHost(incomingMcode: Record<string, unknown>): unknown[] | undefined {
  const raw = incomingMcode["results"];
  if (!Array.isArray(raw)) return undefined;
  const results: Record<string, unknown>[] = [];
  for (const item of raw.slice(-64)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const nodeId = entry["nodeId"];
    const status = entry["status"];
    const summary = entry["summary"];
    if (typeof nodeId !== "string" || nodeId.length === 0 || nodeId.length > 256
        || (status !== "success" && status !== "failed" && status !== "unselected")
        || typeof summary !== "string") continue;
    const safe: Record<string, unknown> = { nodeId, status, summary: summary.slice(0, 8_192) };
    if (status === "failed" && typeof entry["error"] === "string") safe["error"] = entry["error"].slice(0, 4_096);
    const rawOutputs = entry["outputs"];
    if (rawOutputs !== null && typeof rawOutputs === "object" && !Array.isArray(rawOutputs)) {
      try {
        const serialized = JSON.stringify(rawOutputs);
        if (typeof serialized === "string" && serialized.length <= 32_000) {
          safe["outputs"] = JSON.parse(serialized) as Record<string, unknown>;
        }
      } catch { /* invalid structured values are omitted at the IPC boundary */ }
    }
    const rawArtifacts = entry["artifacts"];
    if (Array.isArray(rawArtifacts)) {
      const artifacts = rawArtifacts.slice(0, 16).flatMap((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
        const artifact = item as Record<string, unknown>;
        if (typeof artifact["kind"] !== "string" || artifact["kind"].length > 64
            || typeof artifact["uri"] !== "string" || artifact["uri"].length === 0 || artifact["uri"].length > 4_096) return [];
        return [{
          kind: artifact["kind"], uri: artifact["uri"],
          ...(typeof artifact["name"] === "string" ? { name: artifact["name"].slice(0, 512) } : {}),
          ...(typeof artifact["mimeType"] === "string" ? { mimeType: artifact["mimeType"].slice(0, 256) } : {}),
          ...(typeof artifact["sizeBytes"] === "number" && Number.isSafeInteger(artifact["sizeBytes"]) && artifact["sizeBytes"] >= 0
            ? { sizeBytes: artifact["sizeBytes"] } : {}),
        }];
      });
      if (artifacts.length > 0) safe["artifacts"] = artifacts;
    }
    results.push(safe);
  }
  return results.length > 0 ? results : undefined;
}

/** Append a bounded failed outcome before Node-RED routes the original msg to Catch. */
export function appendWorkflowFailureResult(message: unknown, nodeId: unknown, error: unknown): void {
  if (message === null || typeof message !== "object" || Array.isArray(message)
      || typeof nodeId !== "string" || nodeId.trim() === "" || nodeId.length > 256) return;
  const msg = message as Record<string, unknown>;
  const rawMcode = msg["mcode"];
  const mcode = rawMcode !== null && typeof rawMcode === "object" && !Array.isArray(rawMcode)
    ? { ...(rawMcode as Record<string, unknown>) } : {};
  const prior = Array.isArray(mcode["results"]) ? mcode["results"] as unknown[] : [];
  const reason = error instanceof Error ? error.message : String(error);
  mcode["nodeId"] = nodeId;
  mcode["results"] = [...prior.slice(-63), {
    nodeId,
    summary: "",
    status: "failed",
    error: reason.slice(0, 4_096),
  }];
  msg["mcode"] = mcode;
}

/** 节点类型 id —— 与迁移器 `NODE_RED_TYPE_OF_RUNNER.prompt` 同一字符串。 */
export const MCODE_AGENT_NODE_TYPE = "mcode-agent";

/** 本片节点包版本（`package.json` / 报告可复核）。 */
export const MCODE_NODE_PACK_VERSION = 1;

/**
 * 【T28】**让 `x-mcode` 活过原生编辑器的导出/导入往返**。
 *
 * ## 上游规则（node-red 5.0.8，实码取证）
 *
 * `@node-red/editor-client/src/js/nodes.js` 的两条序列化路径**都只抄
 * `_def.defaults` 里声明过的键**：
 *
 *   - `convertWorkspace(n)`（tab）：`for (var d in n._def.defaults) node[d] = n[d];`
 *   - `convertNode(n)`（普通节点）：同一个循环。
 *
 * 也就是说：Mcode 挂在节点/tab 上的 `x-mcode` 只要**没在 defaults 里声明**，用户点
 * 「导出」拿到的 JSON 里就没有它；再「导入」回来，图还在、身份没了 —— T8 缺陷 2。
 * 声明之后，两条路径都会把该键原样带出/带回（`importNodes` 按 defaults 逐个
 * `node[d] = n[d]` 还原，见同文件）。
 *
 * ## tab 为什么是「就地补」，而不是 `registerType("tab", …)`
 *
 * tab 类型由 editor-client **内置**（`nodeDefinitions['tab'] = { defaults: {...} }`），
 * 且 `registerNodeType` 对任何一个不在当前 node set 里的类型直接报
 * `palette.event.unknownNodeRegistered` 并**丢弃整个定义**（实测：defaults 不变）。
 * 唯一不被拒绝的官方机制是**就地给这个内置定义对象的 defaults 加键** —— 节点 HTML 里的
 * `<script type="text/javascript">` 与页面脚本走同一条 `appendConfig` 执行路径，加载
 * 时序上节点包脚本先于 flows 导入，所以导入时 `_def.defaults` 已经带上了它。
 *
 * ## 升级鲁棒性（fail-closed，不静默丢身份）
 *
 * 补丁自带**运行时自检**：`getType("tab")` 不存在、或 `defaults` 不是对象、或补丁后
 * `defaults` 里仍读不到 `x-mcode` → 记 `console.error` 并抛错（页面上是一次显式的
 * 失败，而不是"导出的 JSON 看起来正常、身份悄悄没了"）。真实往返由
 * `x-mcode-roundtrip-smoke` 用**真上游源码**逐字节验证；上游升级改了 tab 形状时，
 * 那条回归会先红。
 */
export const MCODE_TAB_META_PROPERTY = "x-mcode";

/**
 * 每个 Mcode 节点类型 `defaults` 里都要有的一格。`value: undefined` 是刻意的：
 * 全新从 palette 拖出来的节点不该凭空带一个 `x-mcode`；但**导入时**上游会把 JSON 里
 * 的同名键原样抄进来（`applyNodeDefaults` 只在 `n[d] === undefined` 时填默认值）。
 */
export const MCODE_X_MCODE_DEFAULT_ENTRY = '"x-mcode": { value: undefined }';

/**
 * 给内置类型定义补 `x-mcode` 的浏览器脚本（`<script type="text/javascript">` 的
 * 内容）。与节点注册脚本同一条执行路径；失败是**响的**（console.error + throw）。
 *
 * ## 为什么不止 tab
 *
 * Mcode 的迁移器会把若干节点落到 **Node-RED 内置类型**（`flowMigration.ts` 的
 * `effectiveNodeRedTypeOf`）：`manual`/`schedule` trigger → `inject`、`file` trigger →
 * `watch`、condition → `switch`、command 与非 JS 的 code → `exec`、JS 的 code →
 * `function`。这些节点上的 `x-mcode`（nodeId、Mcode 私有参数、边注释）同样只在
 * `_def.defaults` 里声明过才活得过往返；不补的话，经编辑器 Import 回来的图节点身份
 * 会漂移成原生 id，库镜像会把同一份文档改写成另一套节点 id。
 *
 * 补的时机与顺序无关：定义已存在就当场补；还没注册就挂
 * `registry:node-type-added`（上游公开事件），注册时补 —— 编辑器在**全部节点集
 * 加载完之后**才导入 flows，两种顺序都赶在导入之前。
 *
 * `tab` 是唯一必须**已存在**的类型（editor-client 在加载任何节点包之前就注册了它）；
 * 缺了它说明编辑器版本与我们的假设不符 → 当场抛错，绝不静默导出没有身份的图。
 */
export const MCODE_PATCHED_NATIVE_TYPES = ["tab", "inject", "watch", "switch", "exec", "function"] as const;

export function tabMetaDefaultsScript(): string {
  const types = JSON.stringify(MCODE_PATCHED_NATIVE_TYPES);
  const property = JSON.stringify(MCODE_TAB_META_PROPERTY);
  const required = JSON.stringify("tab");
  return `(function () {
  // T28: the upstream editor serialises only _def.defaults keys. Built-in types
  // (tab, inject, watch, switch, exec, function) have editor-owned definitions,
  // so the only accepted way to make x-mcode survive export/import is to add
  // the key to those definitions' defaults. Patch now when present and on the
  // public registry:node-type-added event otherwise; both happen before any
  // flow import (the editor loads every node set first, then flows).
  var TYPES = ${types};
  var REQUIRED = ${required};
  var PROP = ${property};
  function patch(type) {
    var def = (RED.nodes && RED.nodes.getType) ? RED.nodes.getType(type) : null;
    if (!def || typeof def !== "object" || !def.defaults || typeof def.defaults !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(def.defaults, PROP)) {
      def.defaults[PROP] = { value: undefined };
    }
    return Object.prototype.hasOwnProperty.call(def.defaults, PROP);
  }
  var missing = [];
  for (var i = 0; i < TYPES.length; i++) {
    if (!patch(TYPES[i])) missing.push(TYPES[i]);
  }
  if (missing.indexOf(REQUIRED) !== -1) {
    console.error("[mcode-node-pack] built-in tab definition missing; x-mcode would be silently dropped on export/import");
    throw new Error("Mcode node pack: built-in tab definition unavailable");
  }
  if (missing.length > 0) {
    if (RED.events && typeof RED.events.on === "function") {
      RED.events.on("registry:node-type-added", function (type) {
        if (missing.indexOf(type) !== -1) patch(type);
      });
    } else {
      // 延迟补丁的唯一通道没了：这些类型若稍后才注册，x-mcode 会静默丢。
      // tab 的缺失已在上面抛错；这里对非 tab 类型记一条响亮的错误（不抛 ——
      // 某些精简编辑器可能根本不装这些核心节点集，那不是身份丢失）。
      console.error("[mcode-node-pack] " + missing.join(", ")
        + " not registered yet and registry:node-type-added is unavailable; x-mcode would be dropped for these types on export/import");
    }
  }
  var tabDef = RED.nodes.getType("tab");
  if (!Object.prototype.hasOwnProperty.call(tabDef.defaults, PROP)) {
    console.error("[mcode-node-pack] tab defaults patch did not take effect");
    throw new Error("Mcode node pack: tab defaults patch failed");
  }
})();`;
}

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
  /** Opaque Host-owned trigger context lookup; never a permission grant. */
  triggerTicket?: string;
  /** Selected-edge context for this exact node; informational only. */
  branchContext?: McodeBranchContext;
  /** Original workflow request carried across native nodes; prompt context only. */
  user?: string;
  /** Bounded prior node summaries for shared template expansion. */
  results?: unknown[];
  /** 迁移器带过来的其余参数（未知字段原样交给 port）。 */
  params: Record<string, unknown>;
}

/** port 的产出 —— 与迁移器/Mcode 侧的「这一步交什么」同形。 */
export interface McodeAgentRunResult {
  text: string;
  artifacts: Array<{ kind: string; uri: string; name?: string; mimeType?: string; sizeBytes?: number }>;
  /** Host 签发/回执的 runId（可选；缺省沿用输入 msg 上的那份）。 */
  runId?: string;
  /** Validated structured output variables, if the saved workflow declares them. */
  outputs?: Record<string, unknown>;
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
    "decider", "note", "triggerKind", "task", "events", "eventFilter", "cron",
    // 【EXT-07】扩展命令坐标。**必须在列表里** —— 用户在原厂表单里填的扩展 id /
    // 命令 id 只有经过这一步回读才会进 `effectiveParams`，而执行端只认它们。
    // 少了这两项时，用户在编辑器里填什么都跑不起来（节点会报"缺 extensionId"），
    // 而旧图里的 moduleId 又能读出来 —— 症状是"看起来配好了但不工作"。
    "extensionId", "commandId",
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
  const outputs = (result as { outputs?: unknown }).outputs;
  if (outputs !== undefined) {
    if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) {
      throw new Error("Host RPC result invalid: outputs must be an object");
    }
    try {
      const serialized = JSON.stringify(outputs);
      if (typeof serialized !== "string" || serialized.length > 64_000) {
        throw new Error("Host RPC result invalid: structured outputs exceed the limit");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("structured outputs exceed")) throw error;
      throw new Error("Host RPC result invalid: outputs are not JSON-compatible");
    }
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
  msgId?: string;
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
    ...(typeof config.z === "string" ? { tabId: config.z } : {}),
    ...(typeof messageSnapshot["_msgid"] === "string" ? { msgId: messageSnapshot["_msgid"] } : {}) };
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
  const branchContext = branchContextForNode(incomingMcode, config.id);
  const carriedUser = typeof incomingMcode["user"] === "string" && incomingMcode["user"].length > 0
    ? incomingMcode["user"].slice(0, 32_000) : workflowUserTextOf(inputSnapshot);
  const results = workflowResultsForHost(incomingMcode);
  const payload: McodeAgentRunPayload = {
    instruction: normalized.instruction,
    input: inputSnapshot,
    capability: normalized.capability,
    nodeId: normalized.nodeId,
    runId,
    ...(typeof config.z === "string" ? { tabId: config.z } : {}),
    ...(typeof incomingMcode["triggerTicket"] === "string" && incomingMcode["triggerTicket"].length <= 128
      ? { triggerTicket: incomingMcode["triggerTicket"] } : {}),
    ...(branchContext !== undefined ? { branchContext } : {}),
    ...(carriedUser ? { user: carriedUser } : {}),
    ...(results ? { results } : {}),
    params: paramsSnapshot,
  };
  // Validate and detach the Host result before exposing it downstream.
  const result = assertMcodeNodePortResult(await port.run(payload));
  // W17：与 `mcodeNodeTypes.ts` 的 `outputMsg` 同一件事 —— 每个 mcode-* 节点在输出上
  // 追加自己这条执行事实，条件求值节点据此拼旧调度器那份 outcome 表（Host 只看得见
  // 它自己那一次调用，看不见上游）。上限 64 条，理由见那边的注释。
  const priorResults = Array.isArray(incomingMcode["results"]) ? incomingMcode["results"] as unknown[] : [];
  // 产出形状与 Mcode 侧「这一步交什么」一致：text + artifacts。
  const nextMcode: Record<string, unknown> = {
    ...incomingMcode,
    ...((typeof incomingMcode["user"] === "string" && incomingMcode["user"].length > 0)
      ? { user: incomingMcode["user"].slice(0, 32_000) }
      : (workflowUserTextOf(inputSnapshot) ? { user: workflowUserTextOf(inputSnapshot) } : {})),
    nodeId: normalized.nodeId,
    runId: result.runId ?? runId,
    ...(normalized.outputVar !== null ? { outputVar: normalized.outputVar } : {}),
    results: [...priorResults.slice(-63), {
      nodeId: normalized.nodeId,
      summary: result.text,
      status: "success",
      ...(result.outputs !== undefined ? { outputs: result.outputs } : {}),
      ...(result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
    }],
  };
  // Branch context is one-hop context for this node, not a sticky prompt that
  // should leak into every later node in the message flow.
  delete nextMcode["branch"];
  const msg: Record<string, unknown> = {
    ...messageSnapshot,
    payload: { text: result.text, artifacts: result.artifacts },
    mcode: nextMcode,
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
export function createNodeInputLifecycle(node: NodeRedNodeLike, onClose?: () => void): {
  isClosed(): boolean;
  begin(done: (err?: Error) => void): ((err?: Error) => void) | null;
} {
  let closed = false;
  const pending = new Set<(err?: Error) => void>();
  node.on("close", () => {
    if (closed) return;
    closed = true;
    // 【WF-05】清画布状态行。放**这个**监听器里而不是再加一个 `on("close")`：
    // Node-RED 的 node 允许多个监听器，但本仓库的假 node（套件里的桩）只有一个
    // 槽位 —— 后注册的会顶掉先注册的，直接把"关闭时结算在途输入"这条既有保证
    // 弄没了（实测 13 条断言当场转红）。
    try {
      onClose?.();
    } catch {
      /* 清状态是展示动作，不能阻断在途输入结算 */
    }
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

/**
 * 【Q10 / WF-05】**节点状态行** —— 画布上那一行小字。
 *
 * 这是 Node-RED 原生的 `node.status({fill, shape, text})` 机制，不是我们自造的
 * 叠层（旧手写画布的"沿边框走亮线"随 T45 删除画布一并退场，见功能文档 WF-05）。
 *
 * 用户在画布上直接看到：这格在跑、跑了多久、成功还是失败。**耗时从第一次
 * `running` 起算**，由节点自己计数 —— Node-RED 不给节点提供运行时钟。
 *
 * 为什么这是一个函数而不是各处直接 `node.status(...)`：五类 Mcode 节点要显示
 * **同一种**语义（同一套文案、同一套颜色、同样从 running 起算耗时），各写一遍
 * 必然漂移成五种样子。仓库硬规矩 2「共享实现只有一份」。
 */
export type NodeStatusReporter = {
  running(label?: string): void;
  success(label?: string): void;
  failed(label: string): void;
  /** 节点关闭/重新部署时清掉状态，避免画布上留一行"执行中"的幽灵。 */
  clear(): void;
};

export function createNodeStatusReporter(node: NodeRedNodeLike): NodeStatusReporter {
  let startedAt: number | null = null;
  const put = (status: Record<string, unknown>): void => {
    try {
      node.status?.(status);
    } catch {
      // 状态行是**纯展示**：画布不可用（无头执行、编辑器未挂载）时不能让它
      // 把一个正在跑的节点变成失败。
    }
  };
  return {
    running(label) {
      if (startedAt === null) startedAt = Date.now();
      put({ fill: "blue", shape: "dot", text: withElapsed(label ?? "执行中", startedAt) });
    },
    success(label) {
      put({ fill: "green", shape: "dot", text: withElapsed(label ?? "完成", startedAt, true) });
      startedAt = null;
    },
    failed(label) {
      // 失败不显示耗时：用户此刻关心的是原因，不是它跑了多久。
      put({ fill: "red", shape: "ring", text: label });
      startedAt = null;
    },
    clear() {
      startedAt = null;
      put({});
    },
  };
}

/** 「执行中 · 12s」。`final` 时只保留一次耗时读数，不再随秒变化。 */
function withElapsed(label: string, startedAt: number | null, final = false): string {
  if (startedAt === null) return label;
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (!final && seconds === 0) return label;
  return `${label} · ${seconds}s`;
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
      ${MCODE_X_MCODE_DEFAULT_ENTRY},
    },
    inputs: 1,
    outputs: 1,
    icon: "font-awesome/fa-user",
    label: function () { return this.name || "mcode-agent"; },
    paletteLabel: "mcode-agent",
  });
</script>
<script type="text/javascript">
${tabMetaDefaultsScript()}
</script>
<script type="text/html" data-template-name="${MCODE_AGENT_NODE_TYPE}">
  <div class="form-row">
    <label for="node-input-name" data-i18n="[title]mcode.tooltip.name"><i class="fa fa-tag"></i> <span data-i18n="common.label.name">Name</span></label>
    <input type="text" id="node-input-name" placeholder="Name" data-i18n="[placeholder]common.label.name">
  </div>
  <div class="form-row">
    <label for="node-input-instruction" data-i18n="[title]mcode.tooltip.instruction"><i class="fa fa-pencil"></i> <span data-i18n="mcode.label.instruction">Instruction</span></label>
    <textarea id="node-input-instruction" rows="5" placeholder="What this step does" data-i18n="[placeholder]mcode.placeholder.instruction"></textarea>
  </div>
  <div class="form-row">
    <label for="node-input-capability" data-i18n="[title]mcode.tooltip.capability"><i class="fa fa-shield"></i> <span data-i18n="mcode.label.capability">Capability</span></label>
    <select id="node-input-capability"><option value="read" data-i18n="mcode.option.read">read</option><option value="write" data-i18n="mcode.option.write">write</option></select>
  </div>
  <div class="form-row">
    <label for="node-input-outputVar" data-i18n="[title]mcode.tooltip.outputVar"><i class="fa fa-code"></i> <span data-i18n="mcode.label.outputVar">Output variable</span></label>
    <input type="text" id="node-input-outputVar" placeholder="Output variable" data-i18n="[placeholder]mcode.placeholder.outputVar">
  </div>
  <div class="form-row">
    <label for="node-input-sessionId" data-i18n="[title]mcode.tooltip.sessionId"><i class="fa fa-comments"></i> <span data-i18n="mcode.label.sessionId">Mcode session ID</span></label>
    <input type="text" id="node-input-sessionId" placeholder="Existing visible Mcode session ID" data-i18n="[placeholder]mcode.placeholder.sessionId">
  </div>
</script>
<script type="text/html" data-help-name="${MCODE_AGENT_NODE_TYPE}">
  <p data-i18n="mcode.help.input">Input: msg.payload is combined with the instruction and sent to the selected visible Mcode session.</p>
  <p data-i18n="mcode.help.output">Output: one msg.payload with { text, artifacts }; msg.mcode carries the run ID.</p>
  <p data-i18n="mcode.help.approval">Approval: Host session permissions still apply. Tool actions may require user approval; selecting write is not authorization.</p>
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
    // 【WF-05】画布状态行：执行中带耗时，成功/失败各自可辨。
    const status = createNodeStatusReporter(node);
    const lifecycle = createNodeInputLifecycle(node, () => status.clear());
    node.on("input", (msg, send, done) => {
      const finish = lifecycle.begin(done);
      if (finish === null) return;
      status.running();
      void (async () => {
        try {
          const outcome = await runAgentNode(msg, config, getPort());
          if (!lifecycle.isClosed()) send(outcome.msg);
          status.success();
          finish();
        } catch (err) {
          if (!lifecycle.isClosed()) {
            appendWorkflowFailureResult(msg, normalizeAgentConfig(config).nodeId, err);
            status.failed(err instanceof Error ? err.message : String(err));
            node.error(err, msg);
          } else {
            status.clear();
          }
          finish(lifecycle.isClosed() ? undefined : err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
  } as unknown as new (config: McodeAgentNodeConfig) => NodeRedNodeLike);
  RED.log?.info?.(`[mcode-agent] registered (pack v${MCODE_NODE_PACK_VERSION})`);
}
