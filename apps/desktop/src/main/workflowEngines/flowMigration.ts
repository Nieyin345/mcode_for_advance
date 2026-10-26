/**
 * 【ARC-006 Gate C 第一个安全切片】**WorkflowDoc → Node-RED flow 的纯函数迁移器**。
 *
 * ## 它做什么(以及刻意不做什么)
 *
 * 把 Mcode 的 `WorkflowDoc`（`nodes` / `edges` / `schemaVersion`）映射成 Node-RED
 * flows.json 的 `nodes` / `wires` 形状（Mcode 边注释另存 `links` sidecar），并产出**可复核的迁移报告**；反向
 * {@link flowToWorkflowDoc} 至少能把本模块生成的 flow 读回来做往返对比。
 *
 * **本切片不接存储、不改运行时**：不读盘、不写库、不 spawn 引擎、不碰 `runtimeSupervisor`
 * / `registry`。它只回答「换内核以后这份图长什么样、哪些东西过不去、哪些必须人裁决」。
 * 备份与落盘由 `flowMigrationBackup.ts` 单独负责（同样是纯 IO，可注入数据根）。
 *
 * ## 无损的两条纪律
 *
 * 1. **未知字段原样保留**：节点/边/文档上契约不认识的键不丢、不改名，装进 Node-RED
 *    节点的 `x-mcode` 里原样带走（Node-RED 对未知属性默认透传，这与
 *    `mergeUnknownWorkflowFields` 的方向相反 —— 那边是从 raw 贴回 WorkflowDoc，这边
 *    是把 WorkflowDoc 里**已经在内存里**的未知键再带出去）。识别未知键复用
 *    `unknownWorkflowFieldPaths` 的同一套判据（键集合来自 schema），不写第二张手抄表。
 * 2. **会丢的语义显式报告**：MERGE-0 登记的未知语义（`conversation` 的主对话身份、
 *    `branch` 的人工选择挂起、`code` 的语言面、`command` 的非零退出仍是 success）
 *    遇到就进 `needsHumanDecision`，**不猜、不静默降级**。报告条目带稳定的 `code`，
 *    与校验报告同一种用法（Agent/界面按 code 定位）。
 *
 * ## 映射表（与 docs/planning/arc-006-merge0-baseline.md 第一节同源）
 *
 * | runner.kind | Node-RED 节点 type | 端口语义 |
 * |---|---|---|
 * | `prompt` | `mcode-agent` | 单输出 |
 * | `conversation` | `mcode-conversation` | 单输出（**身份需人裁决**） |
 * | `branch` | `mcode-branch` | 每条出边一个输出口（`decider: user` 需人裁决） |
 * | `condition` | `switch` | 输出 1 = `true` 边，输出 2 = `false` 边 |
 * | `trigger` | `mcode-trigger` | 无输入，单输出 |
 * | `command` | `exec` | Node-RED 内置 3 输出口；Mcode 普通边先接 stdout |
 * | `code` | `function`（node）/ `exec`（其它语言） | function 单输出；exec 3 输出 |
 * | `module-capability` | `mcode-module-capability` | 单输出 |
 * | `node-red` | `mcode-node-red-call` | 单输出 |
 *
 * 类型 → runner.kind 来自调用方注入的节点类型清单（`types: Map<id, manifest>`；
 * 主进程装配时给 `loadNodeTypes()`，冒烟给夹具）。**清单里没有的类型不猜**：节点
 * 照样迁移（type 改为 `mcode-unknown` 并保留原始 type），但报告里逐条点名
 * `unmapped-node`。这与契约里「type 认不出来不算错误、只是跑不了」同一条方向。
 *
 * ## 边的表示
 *
 * 原版 Node-RED 的真实连接事实源是 `node.wires[port][]`（同一输出口可扇出多目标）；
 * 本模块内部 `links` 只用于保存 Mcode 边 ID/label/note 等原生 wires 无法表达的字段。
 * 真实 Admin API 仅提交节点数组，反向恢复时以 wires 为准，旧边注释通过源节点的
 * `x-mcode.edgeMeta` 按完整 native 连接身份匹配；未匹配的副本与改线不得复用旧授权。
 *
 * ## 往返的已知边界
 *
 * - `position` 换成 Node-RED 的 `x`/`y`，四舍五入到整数（Node-RED 编辑器的画布单位）；
 *   往返后可能差 <1px —— 报告里 `lossy.details` 会点名（不静默）。
 * - Mcode 的边在 Node-RED 侧是"端口上的连接"，边自己的 `label` / `note` 在
 *   迁移 sidecar 的 `x-mcode-edge` 与源节点的 `x-mcode.edgeMeta` 中保留；
 *   `branch` 的选项顺序 = 端口顺序（`outgoingEdgesOf` 的文档顺序）。
 * - Native type 改变须明确重新映射；原生复制后的新 native ID 不继承老节点的写权限，
 *   即使用户已经把老原件删除。真实 Editor UI 权限审计仍须另做 U1。
 */
import {
  edgeOptionNameOf,
  buildForwardAdjacency,
  upstreamClosure,
  unknownWorkflowFieldPaths,
  workflowNodeRefName,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowNode,
} from "@contracts/workflow";
import {
  MAIN_NODE_TYPE_ID,
  NODE_TRIGGER_ENABLED_PARAM_KEY,
  type NodeTypeManifest,
  type NodeRunnerKind,
} from "@contracts/nodeType";
import { MODULE_CAPABILITY_RUNNER_KIND } from "@contracts/moduleCapability";
import {
  CONDITION_EVAL_BRIDGE_KEY,
  MCODE_CONDITION_EVAL_NODE_TYPE,
  CONDITION_HOST_TRIGGER_FIELDS,
  conditionEvalTargetOf,
  conditionSwitchShape,
} from "@contracts/conditionBridge";
import { parseConditionExpression } from "@contracts/condition";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const NODE_RED_RUNNER_KIND = "node-red" as const;

/* ── 报告形状 ── */

/** 报告条目的稳定代码 —— 与 `WorkflowValidationIssue.code` 同一种用法。 */
export type FlowMigrationIssueCode =
  | "unmapped-node"
  | "unknown-field"
  | "needs-human-decision"
  | "lossy"
  | "round-trip-mismatch";

export interface FlowMigrationIssue {
  code: FlowMigrationIssueCode;
  /** 涉及的节点 id（文档级问题为 undefined）。 */
  nodeId?: string;
  /** 涉及的边 id。 */
  edgeId?: string;
  /** 人话原因（可直接展示给用户 / Agent）。 */
  message: string;
  /** `unknown-field` 的契约外字段路径（与 `unknownWorkflowFieldPaths` 同形）。 */
  path?: string;
  /** `needs-human-decision` 的 MERGE-0 条目号（1–4），便于对台账。 */
  merge0Item?: number;
}

export interface FlowMigrationReport {
  /** 迁移器版本（报告可复核；换映射规则时 +1）。 */
  migratorVersion: number;
  /** 文档 id / 名称，报告中用于对上原文。 */
  docId: string;
  docName: string;
  /** 成功映射的节点（Node-RED 节点 id → Mcode 节点 id）。 */
  mapped: Array<{ nodeRedId: string; nodeId: string; type: string; runnerKind: NodeRunnerKind | "unknown" }>;
  /** 无法映射的节点与原因。 */
  unmapped: Array<{ nodeId: string; type: string; reason: string }>;
  /** 契约外字段路径（节点/边/文档三级）。 */
  unknownFieldPaths: string[];
  /** 需人工裁决的语义（MERGE-0 未知语义清单，遇到即列）。 */
  needsHumanDecision: FlowMigrationIssue[];
  /** 已知的损失/近似（位置舍入、边标签存储位置等）。 */
  lossy: FlowMigrationIssue[];
  /** 边映射结果（便于核对端口分配）。 */
  edges: Array<{ edgeId: string; source: string; sourcePort: number; target: string; label?: string }>;
}

export interface FlowMigrationResult {
  /** Node-RED flows.json 形状（nodes + links）。 */
  flow: NodeRedFlow;
  report: FlowMigrationReport;
}

/* ── Node-RED 形状（只覆盖本迁移器用到的字段） ── */

export interface NodeRedNode {
  id: string;
  type: string;
  z?: string;
  name?: string;
  x?: number;
  y?: number;
  wires?: string[][];
  /** 契约外字段与 Mcode 身份：原样带走。 */
  "x-mcode"?: {
    nodeId?: string;
    /** Original Node-RED native identity. Copy/paste preserves unknown metadata
     * but regenerates node.id; this allows us to rekey orphaned copies. */
    nativeId?: string;
    type?: string;
    /** Type emitted by the original palette adapter (not the Mcode runner).
     * A changed native type with stale x-mcode metadata is an unsafe edit. */
    nativeType?: string;
    title?: string;
    params?: Record<string, unknown>;
    capability?: string;
    position?: { x: number; y: number };
    unknown?: Record<string, unknown>;
    unknownPosition?: Record<string, unknown>;
    /** W17：条件求值适配节点指向的原 Mcode 条件节点（反向迁移据此折回，
     *  适配节点不进 `WorkflowDoc.nodes`）。 */
    bridgesNodeId?: string;
    /** Edge notes are not native wires properties. Keep them on the source
     * node, which survives upstream GET /flows, tied to exact native IDs. */
    edgeMeta?: Array<{
      sourceNativeId: string;
      targetNativeId: string;
      sourcePort: number;
      edgeId: string;
      label?: string;
      note?: string;
      unknown?: Record<string, unknown>;
    }>;
  };
  [key: string]: unknown;
}

export interface NodeRedLink {
  id: string;
  source: string;
  sourcePort: number;
  target: string;
  targetPort: number;
  /** 边自己的 label / note 与未知字段。 */
  "x-mcode-edge"?: {
    edgeId: string;
    label?: string;
    note?: string;
    unknown?: Record<string, unknown>;
  };
}

export interface NodeRedFlow {
  id: string;
  label: string;
  nodes: NodeRedNode[];
  /**
   * Mcode 侧的边元数据 sidecar（label/note/未知字段）。**不是 Node-RED 的格式**：
   * 真实 flows.json / GET /flows 里没有 `links`，连接全在节点的 `wires`（目标节点 id）。
   * 部署给 Node-RED 时只发 `nodes`；本字段留在这里供往返与将来的 StorageAdapter。
   * 从真引擎读回的对象没有它 —— 所以是可选的。
   */
  links?: NodeRedLink[];
  /** 文档级未知字段与 Mcode 元数据。 */
  "x-mcode"?: {
    docId: string;
    name: string;
    engine?: WorkflowDoc["engine"];
    description?: string;
    icon?: string;
    prompt?: string;
    frameworkNote?: string;
    trigger?: string;
    schemaVersion?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    builtin?: boolean;
    updatedAt?: number;
    unknown?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

/**
 * 迁移器版本：映射规则一变就 +1（报告可追溯到规则）。
 *
 * v2（2026-10-19 节点统一）：`trigger` 按 triggerKind 分流到内置 `inject`/`watch`
 * （仅应用事件保留 `mcode-trigger`）；`code` 删除 `mcode-code`，非 JS 语言走
 * `exec` + 解释器前缀。
 * v3（2026-10-20 原生双向回读）：从 Node-RED 原生顶层字段按当前
 * editor/runtime 配置恢复 params（明确清空不得被 x-mcode 旧字段覆盖），
 * x-mcode.edgeMeta 在真正的 nodes[]/wires[] 保存形状下按连线身份回收。
 * 旧 v2 flow 没有新增元数据也可按存量 fallback 读回；版本号区分映射规则。
 * v4（2026-10-20 克隆身份防护）：原版 Node-RED 编辑器复制节点时，
 * x-mcode.nativeId/nativeType 与真实 native id/type 绑定；克隆不能复用
 * 原 Mcode 节点身份、旧审批或特权，变更原生类型的旧 sidecar 不可复活。
 * 旧 v2/v3 没有 nativeId/nativeType 时仍按遗留兼容规则读取。
 */
export const FLOW_MIGRATOR_VERSION = 5;

/* ── runner.kind → Node-RED 节点类型 ── */

/**
 * 每种执行原语在 Node-RED 侧的节点类型（**默认值**；`trigger`/`code` 另有按参数分流，
 * 见 {@link effectiveNodeRedTypeOf}）。
 *
 * 节点统一审计（`docs/planning/arc-006-node-unification.md`，2026-10-19）：
 *   - `condition` / `command` / `code(node)` 直接用内置 `switch` / `exec` / `function`；
 *   - `trigger` 的手动/定时 → 内置 `inject`（含 `crontab`），文件变化 → 内置 `watch`；
 *     只有「Mcode 应用事件」内置没有，保留 `mcode-trigger`；
 *   - `code` 的 python/shell/powershell 本质是起进程 → 内置 `exec` + 解释器前缀，
 *     `mcode-code` 删除；
 *   - 其余（agent/conversation/branch/module-capability/node-red-call）保留自定义，
 *     理由见审计文档（Host RPC / 主对话 / 人工挂起 / 宿主能力面 / 回环围栏）。
 */
export const NODE_RED_TYPE_OF_RUNNER: Record<string, string> = {
  prompt: "mcode-agent",
  conversation: "mcode-conversation",
  branch: "mcode-branch",
  condition: "switch",
  // trigger 的默认（event / 未知 kind）；manual/schedule/file 由 effectiveNodeRedTypeOf 分流。
  trigger: "mcode-trigger",
  command: "exec",
  code: "function",
  [MODULE_CAPABILITY_RUNNER_KIND]: "mcode-module-capability",
  [NODE_RED_RUNNER_KIND]: "mcode-node-red-call",
};

/** Mcode 触发器参数键（与 `@contracts/nodeType` 的 `NODE_TRIGGER_*` 同值；此处不 import
 *  是为了让迁移器保持纯函数、不拖进 nodeType 的整包依赖）。 */
const TRIGGER_KIND_KEY = "triggerKind";
const TRIGGER_CRON_KEY = "cron";
const TRIGGER_PATHS_KEY = "paths";

/** 非 JS 语言的 exec 前缀（command 为空时也不留半个解释器）。 */
const EXEC_LANGUAGE_PREFIX: Record<string, string> = {
  python: "python -c",
  shell: "sh -c",
  powershell: "powershell -Command",
};

/**
 * 一个节点**实际**落到哪个 Node-RED 类型（在默认表之上按参数分流）。
 *
 * - `trigger`：`manual` → `inject`（once）、`schedule` → `inject`（crontab）、
 *   `file` → `watch`、`event`/未知 → `mcode-trigger`；
 * - `code`：`language === "node"` → `function`，其余 → `exec`（前缀见
 *   {@link EXEC_LANGUAGE_PREFIX}；未列出的语言按 `python` 处理并在报告里点名）；
 * - 其它 kind 原样查表。
 */
export function effectiveNodeRedTypeOf(
  kind: NodeRunnerKind | "unknown",
  params: Record<string, unknown>,
): string {
  if (kind === "trigger") {
    const triggerKind = typeof params[TRIGGER_KIND_KEY] === "string" ? (params[TRIGGER_KIND_KEY] as string) : "manual";
    if (triggerKind === "manual" || triggerKind === "schedule") return "inject";
    if (triggerKind === "file") return "watch";
    return "mcode-trigger";
  }
  if (kind === "code") {
    const language = typeof params["language"] === "string" ? (params["language"] as string) : "python";
    return language === "node" ? "function" : "exec";
  }
  return NODE_RED_TYPE_OF_RUNNER[kind] ?? "mcode-unknown";
}

/** `code` 节点的 exec 命令（解释器前缀 + 脚本文本）；`node` 语言返回 null。 */
export function execCommandForCode(params: Record<string, unknown>): string | null {
  const language = typeof params["language"] === "string" ? (params["language"] as string) : "python";
  if (language === "node") return null;
  const code = typeof params["code"] === "string" ? (params["code"] as string) : "";
  const prefix = EXEC_LANGUAGE_PREFIX[language] ?? EXEC_LANGUAGE_PREFIX["python"];
  return code.trim() === "" ? prefix : `${prefix} ${code}`;
}

/**
 * Populate only fields that the original Node-RED node form actually edits.
 * Mcode-only values stay in x-mcode.params; native form values must be present
 * at top level or the upstream editor will load blanks and overwrite them.
 */
function nativeNodeConfigOf(
  kind: NodeRunnerKind | "unknown",
  effectiveType: string,
  node: WorkflowNode,
): Record<string, unknown> {
  const params = node.params;
  const stringOf = (key: string, fallback = ""): string =>
    typeof params[key] === "string" ? params[key] as string : fallback;
  const timeoutMs = typeof params["timeoutMs"] === "number"
    && Number.isSafeInteger(params["timeoutMs"]) && (params["timeoutMs"] as number) > 0
    ? params["timeoutMs"] as number : 0;
  // Node-RED 5.0.8 exec.timer and function.timeout are in seconds; Mcode
  // timeoutMs is milliseconds. Convert units here, not in the host runtime.
  const timeout = timeoutMs > 0 ? String(timeoutMs / 1000) : "";
  const config: Record<string, unknown> = {};

  if (kind === "prompt" || kind === "conversation") {
    config.instruction = stringOf("instruction");
    config.capability = node.capability === "write" ? "write"
      : node.capability === "read" ? "read"
      : params["capability"] === "write" ? "write" : "read";
    config.outputVar = stringOf("outputVar");
    // A native Node-RED editor owns this field. Keep an explicitly selected
    // session visible/editable instead of hiding it in x-mcode.params.
    // An old mcode.main has NO inherent persisted chat identity: empty means
    // the user must bind an existing visible session, never "current chat".
    config.sessionId = stringOf("sessionId");
  } else if (kind === "branch") {
    config.decider = params["decider"] === "model" ? "model" : "user";
    config.outputVar = stringOf("outputVar");
    config.note = stringOf("note");
  } else if (kind === "trigger" && effectiveType === "mcode-trigger") {
    config.triggerKind = stringOf(TRIGGER_KIND_KEY, "event");
    config.task = stringOf("task");
    // Task is a human-readable instruction, NOT the HookEvent subscription.
    // Preserve the legacy events field in an editable native form.
    const eventSpec = params["events"];
    config.events = Array.isArray(eventSpec) ? eventSpec.filter((e): e is string => typeof e === "string").join(", ") : stringOf("events");
    config.eventFilter = stringOf("eventFilter");
    config.cron = stringOf(TRIGGER_CRON_KEY);
  } else if (kind === MODULE_CAPABILITY_RUNNER_KIND) {
    config.moduleId = stringOf("moduleId");
    config.contributionId = stringOf("contributionId");
    config.path = stringOf("path");
  } else if (kind === NODE_RED_RUNNER_KIND) {
    config.enginePath = stringOf("enginePath");
    config.engineMethod = stringOf("engineMethod", "POST");
    config.engineBody = stringOf("engineBody");
  } else if (kind === "command" && effectiveType === "exec") {
    config.command = stringOf("command");
    config.timer = timeout;
    config.addpay = false;
    config.append = "";
    config.useSpawn = false;
  } else if (kind === "code" && effectiveType === "function") {
    config.func = stringOf("code");
    config.outputs = 1;
    config.timeout = timeout === "" ? 0 : Number(timeout);
    config.initialize = "";
    config.finalize = "";
    config.libs = [];
  } else if (kind === "code" && effectiveType === "exec") {
    config.command = execCommandForCode(params) ?? "";
    config.timer = timeout;
    config.addpay = false;
    config.append = "";
    config.useSpawn = false;
  }
  return config;
}

function hasOwnField(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mutableRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** External flows.json can carry arbitrary x-mcode.unknown dictionaries.
 * Preserve actual extensions without letting a copied/forged unknown value
 * replace canonical fields derived from the editor and Host-owned metadata. */
function safeUnknownFields(value: unknown, reserved: readonly string[]): Record<string, unknown> {
  const fields = mutableRecord(value);
  const excluded = new Set(reserved);
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(fields)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || excluded.has(key)) continue;
    result[key] = entry;
  }
  return result;
}

function nativeStringField(node: NodeRedNode, field: string): string | undefined {
  if (!hasOwnField(node, field)) return undefined;
  const value = node[field];
  return typeof value === "string" ? value : value === null ? "" : undefined;
}

function applyNativeTimeout(params: Record<string, unknown>, node: NodeRedNode, field: "timer" | "timeout"): void {
  if (!hasOwnField(node, field)) return;
  const raw = node[field];
  if (raw === "" || raw === null || raw === undefined || raw === 0 || raw === "0") {
    // Empty native timer means unlimited. Preserve an explicit zero, but
    // remove a stale positive timeout that the user cleared in the editor.
    if (params["timeoutMs"] !== 0) delete params["timeoutMs"];
    return;
  }
  const seconds = typeof raw === "number" ? raw
    : typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const milliseconds = Math.round(seconds * 1000);
  if (Number.isSafeInteger(milliseconds) && milliseconds > 0) params["timeoutMs"] = milliseconds;
}

/** Read back editable fields owned by original Node-RED forms. A present empty
 * string is an intentional clear and must override stale migration metadata. */
function paramsFromNativeNode(node: NodeRedNode, savedParams: unknown): Record<string, unknown> {
  const params = { ...mutableRecord(savedParams) };
  const assign = (field: string, key = field, defaultValue = "", required = false): void => {
    const value = nativeStringField(node, field);
    if (value === undefined) return;
    // Optional native form fields are materialized as empty strings by the
    // editor even when Mcode never had that parameter. Avoid inventing empty
    // params on an untouched round-trip, while still honoring explicit clears.
    if (required || hasOwnField(params, key) || value !== defaultValue) params[key] = value;
  };

  switch (node.type) {
    case "mcode-agent":
    case "mcode-conversation":
      assign("instruction", "instruction", "", true);
      assign("outputVar");
      // A native editor clear must supersede a stale imported x-mcode value;
      // an explicit ID round-trips without silently retargeting the session.
      assign("sessionId");
      // The native capability form is a *different* authority from stale
      // x-mcode.params: if the old doc stored a capability param, update that
      // copy as well or a later Host path may resurrect write permission.
      if (hasOwnField(params, "capability")) {
        params["capability"] = node["capability"] === "write" ? "write" : "read";
      }
      break;
    case "mcode-branch":
      assign("decider", "decider", "user");
      assign("outputVar");
      assign("note");
      break;
    case "mcode-trigger":
      assign("triggerKind", "triggerKind", "event");
      assign("task", "task", "", true);
      // Keep legacy array encoding when the editor has not changed its values.
      const nativeEvents = nativeStringField(node, "events");
      if (nativeEvents !== undefined) {
        const savedEvents = params["events"];
        if (Array.isArray(savedEvents)) {
          const prior = savedEvents.filter((entry): entry is string => typeof entry === "string");
          const current = nativeEvents.split(/[\r\n,]+/).map(entry => entry.trim()).filter(Boolean);
          params["events"] = JSON.stringify(current) === JSON.stringify(prior) ? savedEvents : current;
        } else assign("events");
      }
      assign("eventFilter");
      assign("cron");
      break;
    case "mcode-module-capability":
      assign("moduleId", "moduleId", "", true);
      assign("contributionId", "contributionId", "", true);
      assign("path", "path", "", true);
      break;
    case "mcode-node-red-call":
      assign("enginePath", "enginePath", "", true);
      assign("engineMethod", "engineMethod", "POST");
      assign("engineBody");
      break;
    default:
      break;
  }

  // The native command node and code nodes share Node-RED's exec config,
  // but represent different Mcode contracts. Discriminate by saved Mcode
  // params, then translate only the representation we know how to invert.
  if (node.type === "exec") {
    const rawCommand = nativeStringField(node, "command");
    if (rawCommand !== undefined) {
      if (hasOwnField(params, "code") || typeof params["language"] === "string") {
        const languagePrefixes = Object.entries(EXEC_LANGUAGE_PREFIX)
          .sort((a, b) => b[1].length - a[1].length);
        const matched = languagePrefixes.find(([, prefix]) =>
          rawCommand === prefix || rawCommand.startsWith(prefix + " "));
        if (matched) {
          const originalLanguage = typeof params["language"] === "string" ? params["language"] as string : undefined;
          const knownLanguages = new Set(["python", "shell", "powershell"]);
          // Unknown Mcode languages are emitted with a documented Python
          // fallback. On an untouched round-trip, that fallback prefix must
          // not silently rewrite the original language declaration.
          if (originalLanguage === undefined || knownLanguages.has(originalLanguage) || matched[0] !== "python") {
            params["language"] = matched[0];
          }
          params["code"] = rawCommand === matched[1] ? "" : rawCommand.slice(matched[1].length + 1);
        } else {
          // Keep the native edit visible as code text. It remains within the
          // existing Mcode code runner contract, never an arbitrary command node.
          params["code"] = rawCommand;
        }
      } else if (hasOwnField(params, "command")) {
        params["command"] = rawCommand;
      }
    }
    applyNativeTimeout(params, node, "timer");
  } else if (node.type === "function"
    && (hasOwnField(params, "code") || typeof params["language"] === "string")) {
    assign("func", "code");
    applyNativeTimeout(params, node, "timeout");
  }

  if (node.type === "inject" && (hasOwnField(params, TRIGGER_KIND_KEY) || hasOwnField(params, TRIGGER_CRON_KEY))) {
    const crontab = nativeStringField(node, "crontab");
    if (crontab !== undefined) {
      if (hasOwnField(params, TRIGGER_CRON_KEY) || crontab.trim() !== "") params[TRIGGER_CRON_KEY] = crontab;
      if (crontab.trim() !== "") params[TRIGGER_KIND_KEY] = "schedule";
      else if (params[TRIGGER_KIND_KEY] !== "schedule") params[TRIGGER_KIND_KEY] = "manual";
    }
  } else if (node.type === "watch" && (hasOwnField(params, TRIGGER_KIND_KEY) || hasOwnField(params, TRIGGER_PATHS_KEY))) {
    assign("files", TRIGGER_PATHS_KEY);
    params[TRIGGER_KIND_KEY] = "file";
  }
  return params;
}

function capabilityFromNativeNode(
  node: NodeRedNode,
  savedCapability: WorkflowNode["capability"] | undefined,
): WorkflowNode["capability"] | undefined {
  if ((node.type === "mcode-agent" || node.type === "mcode-conversation")
    && hasOwnField(node, "capability")) {
    const nativeCapability = node["capability"] === "write" ? "write" : "read";
    // "read" is the native editor default. If the original Mcode node had no
    // explicit capability, don't manufacture a new field on an untouched flow.
    if (savedCapability === undefined && nativeCapability === "read") return undefined;
    return nativeCapability;
  }
  return savedCapability;
}

/** 这个 runner 的输出端口数（`branch` = 出边数，调用方另算；`trigger` 无输入）。 */
function outputPortCountOf(kind: NodeRunnerKind | "unknown", outDegree: number, effectiveType: string): number {
  if (kind === "branch") return Math.max(1, outDegree);
  // condition → 原生 switch 固定两个输出口（true / false）。
  if (kind === "condition") return 2;
  // Node-RED 5.0.8's built-in exec has three fixed outputs: stdout, stderr,
  // and return code. Keep all three wire slots even when the Mcode graph only
  // attaches a downstream edge to stdout (port 0).
  if (effectiveType === "exec") return 3;
  return 1;
}

/** 端口数是否随出边变化（往返时按它决定怎么重建边）。 */
function portsFollowEdges(kind: NodeRunnerKind | "unknown"): boolean {
  return kind === "branch";
}

/* ── 未知字段（复用 unknownWorkflowFieldPaths 的判据） ── */

/**
 * 从 `unknownWorkflowFieldPaths` 的结果里取**某个节点**的未知键名。
 *
 * 路径形状：`x-custom`（文档级）、`nodes[i].x-custom`、`nodes[i].position.z`、
 * `edges[i].x-custom`。只在这一层做字符串解析 —— 键集合仍来自 schema，不复制。
 */
function unknownKeysForNode(paths: readonly string[], nodeIndex: number): { node: string[]; position: string[] } {
  const node: string[] = [];
  const position: string[] = [];
  const prefix = `nodes[${nodeIndex}].`;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.startsWith("position.")) position.push(rest.slice("position.".length));
    else node.push(rest);
  }
  return { node, position };
}

function unknownKeysForEdge(paths: readonly string[], edgeIndex: number): string[] {
  const prefix = `edges[${edgeIndex}].`;
  return paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
}

function pickKeys(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key !== "__proto__" && value[key] !== undefined) out[key] = value[key];
  return out;
}

/* ── 需人工裁决的语义（MERGE-0 §一 未知语义清单） ── */

/**
 * 判断一个节点是否触到 MERGE-0 的未知语义。**遇到就列，不判断"能不能凑合"** ——
 * 台账要求实施前由人裁决；迁移器只负责不让它静默消失。
 */
function humanDecisionIssuesOf(
  node: WorkflowNode,
  kind: NodeRunnerKind | "unknown",
  params: Record<string, unknown>,
): FlowMigrationIssue[] {
  const issues: FlowMigrationIssue[] = [];
  if (kind === "conversation") {
    // MERGE-0 未知语义 #1：主对话身份。`mcode.main` 是入口、其余对话节点默认 self。
    const isMain = node.type === MAIN_NODE_TYPE_ID;
    issues.push({
      code: "needs-human-decision",
      nodeId: node.id,
      merge0Item: 1,
      message: isMain
        ? "主代理（mcode.main）原本跑在发起工作流的聊天会话里，旧图并不持久绑定一个会话。迁入 Node-RED 后必须在 mcode-conversation 节点的「Mcode 会话 ID」填写现有可见聊天会话，并经用户确认，才能部署运行；不得自动使用当前活动会话（MERGE-0 未知语义 #1）。"
        : "对话节点原本使用发起流程的主会话；Node-RED 没有「当前聊天会话」。必须在节点的「Mcode 会话 ID」显式填写现有可见会话，并核对分享/导入后的归属，才能部署运行（MERGE-0 未知语义 #1）。",
    });
  }
  if (kind === "branch" && params["decider"] !== "model") {
    // MERGE-0 未知语义 #2：人工选择挂起。decider=model 是模型即时选，不挂起；user 才要挂起。
    issues.push({
      code: "needs-human-decision",
      nodeId: node.id,
      merge0Item: 2,
      message: "分支节点把决定权交给用户时会挂起等真人点选（长任务存档 + 恢复）；Node-RED 消息流默认不持久化「等待中」。需要 mcode-approval + 宿主 durable journal 才能等价 —— 需人工裁决（MERGE-0 未知语义 #2）。",
    });
  }
  if (kind === "code") {
    const language = typeof params["language"] === "string" ? params["language"] : "python";
    if (language !== "node") {
      // MERGE-0 未知语义 #3：语言面不等价。
      issues.push({
        code: "needs-human-decision",
        nodeId: node.id,
        merge0Item: 3,
        message: `code 节点语言为 ${language}；节点统一后它映射到内置 exec（解释器前缀 ${EXEC_LANGUAGE_PREFIX[language] ?? EXEC_LANGUAGE_PREFIX["python"]}），与 Mcode code 节点的沙箱面不同、非零退出的成败判定也不同 —— 需人工裁决（MERGE-0 未知语义 #3 与 #4）。`,
      });
    }
  }
  if (kind === "trigger") {
    const triggerKind = typeof params[TRIGGER_KIND_KEY] === "string" ? (params[TRIGGER_KIND_KEY] as string) : "manual";
    if (triggerKind === "manual" || triggerKind === "schedule") {
      issues.push({
        code: "lossy",
        nodeId: node.id,
        message:
          `trigger 迁移到内置 inject（${triggerKind === "schedule" ? "crontab 由 Mcode 5 段 cron 原样写入" : "手动触发：once=false，仅明确点击后运行"}）；`
          + "Mcode 的合并窗口 debounceMs、项目 id、task 文本保留在 x-mcode.params，内置 inject 不表达 —— 执行侧由 Host 承担。",
      });
    } else if (triggerKind === "file") {
      issues.push({
        code: "lossy",
        nodeId: node.id,
        message:
          "trigger 迁移到内置 watch（files 取 paths）；Mcode 的 excludePaths / debounceMs / 项目 id 保留在 x-mcode.params，"
          + "内置 watch 不表达（它的 change 事件没有合并窗口）—— 执行侧由 Host 承担。",
      });
    } else {
      // event / 未知：内置没有应用事件订阅，保留自定义 mcode-trigger。
      issues.push({
        code: "needs-human-decision",
        nodeId: node.id,
        message:
          `trigger 的触发方式是 ${triggerKind}（应用事件）—— Node-RED 内置没有对应节点，保留 mcode-trigger；`
          + "订阅的 HookEvent 事件名从 events 原生字段读取（task 仅为说明）；旧 eventFilter 的工具名、turn.files 项目路径匹配复用 Mcode 的旧 matcher；其他无法等价匹配的事件仍拒绝订阅，不扩大触发范围。触发源不提供旧自定义 UI 的 trigger.input 数据，需人工调整条件与输入来源。",
      });
    }
  }
  if (kind === "command") {
    // MERGE-0 未知语义 #4：非零退出仍是 success。只要节点存在就得提醒 —— 是否真的
    // 依赖这条语义只有运行时知道，迁移器不猜"它看起来没用"。
    issues.push({
      code: "needs-human-decision",
      nodeId: node.id,
      merge0Item: 4,
      message: "command 节点在 Mcode 里「进程跑完即 success，退出码进产物」；Node-RED exec 默认把非零退出当错误。迁移时必须显式翻转（或确认该节点不依赖此语义）—— 需人工裁决（MERGE-0 未知语义 #4）。",
    });
  }
  return issues;
}

/* ── 正向：WorkflowDoc → Node-RED flow ── */

export interface MigrateOptions {
  /** 节点类型清单（主进程给 `loadNodeTypes()` 的 entries → Map，冒烟给夹具）。 */
  types?: ReadonlyMap<string, NodeTypeManifest>;
}

/** Existing unambiguous IDs keep their legacy name. When multiple distinct
 * Mcode identities fold to the same Node-RED basename, use an identity-derived
 * suffix for *all* members, rather than assigning _2 by iteration order.
 * Hash UTF-16 code units so even malformed surrogate identities stay distinct.
 */
function foldedNodeRedId(prefix: string, id: string): string {
  return `${prefix}_${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
function collidingBases(ids: readonly string[], prefix: string): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const base = foldedNodeRedId(prefix, id);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([base]) => base));
}
function nodeRedIdOf(prefix: string, id: string, used: Set<string>, collisions?: ReadonlySet<string>): string {
  const folded = foldedNodeRedId(prefix, id);
  const base = collisions?.has(folded)
    ? `${folded}_${createHash("sha256").update(id, "utf16le").digest("hex").slice(0, 16)}`
    : folded;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}_${n++}`;
  used.add(candidate);
  return candidate;
}

/**
 * 迁移一份 WorkflowDoc。**纯函数**：不读盘、不抛（错误进报告）。
 *
 * 未知字段：`unknownWorkflowFieldPaths(doc)` 给路径，按身份（节点/边在数组里的位置）
 * 把对应键原样装进每个 Node-RED 节点的 `x-mcode.unknown` / 边的 `x-mcode-edge.unknown`。
 */
export function migrateWorkflowDoc(doc: WorkflowDoc, options: MigrateOptions = {}): FlowMigrationResult {
  // Migration emits an archived flow which may be saved asynchronously. Do not
  // reuse mutable params, schemas, or unknown-field objects owned by the caller:
  // changing the original document must never mutate the migrated artifact.
  doc = structuredClone(doc);
  const types = options.types;
  const unknownPaths = unknownWorkflowFieldPaths(doc);
  const usedIds = new Set<string>();
  const nodeCollisions = collidingBases(doc.nodes.map((node) => node.id), "n");
  const edgeCollisions = collidingBases(doc.edges.map((edge) => edge.id), "l");
  // Preallocate IDs in stable identity order. A hashed collision suffix can
  // itself match another literal folded ID; allocating in visual node order
  // changes runtime IDs when the user merely reorders the document.
  const nodeIds = new Map<string, string>();
  for (const id of [...new Set(doc.nodes.map((n) => n.id))].sort()) {
    nodeIds.set(id, nodeRedIdOf("n", id, usedIds, nodeCollisions));
  }
  const edgeIds = new Map<string, string>();
  for (const id of [...new Set(doc.edges.map((e) => e.id))].sort()) {
    edgeIds.set(id, nodeRedIdOf("l", id, usedIds, edgeCollisions));
  }
  const mapped: FlowMigrationReport["mapped"] = [];
  const unmapped: FlowMigrationReport["unmapped"] = [];
  const needsHumanDecision: FlowMigrationIssue[] = [];
  const lossy: FlowMigrationIssue[] = [];

  // 文档级未知字段（不含节点/边前缀的路径）。
  const docUnknown = pickKeys(
    doc as unknown as Record<string, unknown>,
    unknownPaths.filter((p) => !p.startsWith("nodes[") && !p.startsWith("edges[")),
  );

  const nodeRedOf = new Map<string, NodeRedNode>();
  const kindOf = new Map<string, NodeRunnerKind | "unknown">();
  // W17：表达式能解析的条件节点各配一个求值适配节点（见 `@contracts/conditionBridge`）。
  // 键 = Mcode 节点 id，值 = 适配节点的 native id。**解析在这里做一次**，下面插节点、
  // 改写 wire、报告都读这一份，不各判一次。
  const conditionEvaluators = new Map<string, string>();

  for (const [index, node] of doc.nodes.entries()) {
    const manifest = types?.get(node.type);
    const kind: NodeRunnerKind | "unknown" = manifest?.runner.kind ?? "unknown";
    kindOf.set(node.id, kind);
    const nodeRedId = nodeIds.get(node.id)!;
    const outDegree = doc.edges.filter((e) => e.from === node.id).length;
    const nodeUnknown = unknownKeysForNode(unknownPaths, index);
    const effectiveType = kind === "unknown" ? "mcode-unknown" : effectiveNodeRedTypeOf(kind, node.params);
    const outPorts = outputPortCountOf(kind, outDegree, effectiveType);
    if (kind === "unknown") {
      unmapped.push({
        nodeId: node.id,
        type: node.type,
        reason: `类型「${node.type}」不在节点类型清单里 —— 执行语义未知，按 mcode-unknown 迁移（原始 type 留在 x-mcode.type，可逆）`,
      });
    }
    // 内置 inject / watch / exec 的**最小可执行参数**（节点统一：不再造 mcode-code）。
    const builtinConfig: Record<string, unknown> = {};
    /* 【AUTO-01】**关掉的触发器在部署时就不装调度**。
     *
     * `enabled: false` 以前只是留在 `x-mcode.params` 里给人看，引擎侧照样按 crontab 跑 ——
     * 于是界面上关掉一个定时任务，它还会按时触发。用户看到的正是"我关了它，它还在跑"。
     *
     * 关掉的做法是**把调度清空**（`crontab` / `repeat` 置空），不是加一个运行期判断 ——
     * Node-RED 的 inject 由引擎自己调度，宿主没有"注入前拦一下"的钩子；而一个空的
     * `crontab` 就是"永不自动触发"的原生表达。
     *
     * **手动运行照旧**：手动走的是 Host 签发的一次性票据（`runNativeManual`），
     * 不经过 crontab，所以关掉它不影响用户点「立刻运行一次」—— 这正是规格的要求。 */
    const triggerDisabled = kind === "trigger" && node.params[NODE_TRIGGER_ENABLED_PARAM_KEY] === false;
    if (kind === "trigger" && effectiveType === "inject") {
      const triggerKind = typeof node.params[TRIGGER_KIND_KEY] === "string" ? (node.params[TRIGGER_KIND_KEY] as string) : "manual";
      if (triggerDisabled) {
        builtinConfig.once = false;
        builtinConfig.repeat = "";
        builtinConfig.crontab = "";
      } else if (triggerKind === "schedule") {
        builtinConfig.crontab = typeof node.params[TRIGGER_CRON_KEY] === "string" ? node.params[TRIGGER_CRON_KEY] : "";
        builtinConfig.repeat = "";
        builtinConfig.once = false;
      } else {
        // Manual means *only* an explicit editor/Host inject action.
        // once=true fires on Deploy and on trusted restart, silently changing
        // a user gesture into unattended execution of potentially write nodes.
        builtinConfig.once = false;
        builtinConfig.repeat = "";
        builtinConfig.crontab = "";
      }
      builtinConfig.props = [{ p: "payload" }];
      builtinConfig.topic = "";
    }
    if (kind === "trigger" && effectiveType === "watch") {
      /* 关掉的 watch 不装监听：`files` 清空就是原生表达（watch 没有单独的开关字段）。 */
      builtinConfig.files = triggerDisabled
        ? ""
        : (typeof node.params[TRIGGER_PATHS_KEY] === "string" ? node.params[TRIGGER_PATHS_KEY] : "");
      builtinConfig.recursive = false;
    }
    if (kind === "code" && effectiveType === "exec") {
      const command = execCommandForCode(node.params);
      builtinConfig.command = command ?? "";
      /* 【WF-04】**上游数据经 JSON stdin 交给脚本** —— 这是规格对"命令正文禁止插值"
       * 那条的配套：命令固定，变化的东西走 stdin。
       *
       * `addpay: true` = 把进来的 `msg.payload` 追加到子进程的 stdin；
       * `append: "json"` = 用 JSON 序列化（另一个选项是 `string`，那样上游给个对象
       * 会变成 `[object Object]`）。
       *
       * 以前这里是 `addpay: false` + `append: ""` —— 等于**根本不传**，脚本只能读
       * 自己写死的常量，多步流程在上游→脚本这一环断掉。迁移报告当时也自认
       * 「input JSON 不会生效」。
       *
       * 非零退出仍然是结果而不是失败（退出码经 exec 的第 3 口交出去，
       * 由 `registry.ts` 的 node-status 只认 red 来保证）。 */
      builtinConfig.addpay = true;
      builtinConfig.append = "json";
      builtinConfig.useSpawn = false;
      builtinConfig.timer = "";
      // Node-RED 5.0.8 exec 固定三口（stdout→口0、stderr→口1、退出码→口2），上面
      // outputPortCountOf 已保留三组 wires 槽位；Mcode 边仍只有通用出边，不会自动绑定
      // stderr/退出码输出，剩余差异由迁移报告点名，后续 Host 执行器再统一结果契约。
    }

    const nrNode: NodeRedNode = {
      id: nodeRedId,
      type: effectiveType,
      name: node.title,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      wires: Array.from({ length: outPorts }, () => [] as string[]),
      ...builtinConfig,
      ...nativeNodeConfigOf(kind, effectiveType, node),
      // condition → 原生 switch 的**最小可执行形状**。规则、属性名与 checkall 的
      // 唯一来源是 `@contracts/conditionBridge` 的 `conditionSwitchShape()` —— 从前
      // 这里是三处字面量，而写 `msg.mcode.condition` 的生产者不存在：
      // 迁移后的条件图**永远走 else 口**（见 conditionBridge.ts 文件头）。
      // 现在求值由紧随其前的 `mcode-condition-eval` 适配节点 + Host 完成（见下面
      // 的 `conditionEvaluators`），switch 只负责按布尔分流。
      ...(kind === "condition" ? conditionSwitchShape() : {}),
      "x-mcode": {
        nodeId: node.id,
        nativeId: nodeRedId,
        type: node.type,
        nativeType: effectiveType,
        title: node.title,
        params: node.params,
        ...(node.capability !== undefined ? { capability: node.capability } : {}),
        position: { x: node.position.x, y: node.position.y },
        ...(Object.keys(nodeUnknown.node).length > 0 ? { unknown: pickKeys(node as unknown as Record<string, unknown>, nodeUnknown.node) } : {}),
        ...(Object.keys(nodeUnknown.position).length > 0
          ? { unknownPosition: pickKeys(node.position as unknown as Record<string, unknown>, nodeUnknown.position) }
          : {}),
      },
    };
    // 位置舍入是已知损失（<1px）；只在真的发生时报，不刷屏。
    if (node.position.x !== nrNode.x || node.position.y !== nrNode.y) {
      lossy.push({
        code: "lossy",
        nodeId: node.id,
        message: `画布坐标 ${node.position.x},${node.position.y} 舍入为 ${nrNode.x},${nrNode.y}（Node-RED 画布整数单位；原值保留在 x-mcode.position）`,
      });
    }
    nodeRedOf.set(node.id, nrNode);
    if (kind === "condition") {
      // W17：表达式能解析 → 插一个 `mcode-condition-eval` 适配节点，由 Host 用旧的
      // `evaluateConditionExpression` 求值并写 `msg.mcode.condition`；switch 仍只负责
      // 按布尔分流。表达式**不能**解析（旧档案 / 空规则）→ 不插，且报告明确说
      // 「这张图此后仍永远走 else 口」—— 静默走错分支正是本卡要修的那种坏法。
      const parsed = parseConditionExpression(node.params["expression"]);
      if (parsed.ok) {
        const evalRedId = nodeRedIdOf("n", `${node.id}__condition_eval`, usedIds, nodeCollisions);
        conditionEvaluators.set(node.id, evalRedId);
        const evalNode: NodeRedNode = {
          id: evalRedId,
          type: MCODE_CONDITION_EVAL_NODE_TYPE,
          name: `${node.title || node.id} · 求值`,
          x: Math.round(node.position.x) - 180,
          y: Math.round(node.position.y),
          wires: [[nodeRedId]],
          "x-mcode": {
            // 适配节点**不是** Mcode 文档里的节点：它的 nodeId 留空，靠
            // `bridgesNodeId` 指回原条件节点。反向迁移会把它折回去（见
            // `conditionEvalTargetOf` 与 `flowToWorkflowDoc`）。
            nodeId: `${node.id}__condition_eval`,
            type: node.type,
            nativeId: evalRedId,
            nativeType: MCODE_CONDITION_EVAL_NODE_TYPE,
            [CONDITION_EVAL_BRIDGE_KEY]: node.id,
            title: `${node.title || node.id} · 求值`,
            params: { expression: node.params["expression"] },
            position: { x: Math.round(node.position.x) - 180, y: Math.round(node.position.y) },
          },
        };
        nodeRedOf.set(`${node.id}__condition_eval`, evalNode);
      } else {
        lossy.push({
          code: "lossy",
          nodeId: node.id,
          message:
            `条件表达式无法解析（${parsed.error}）—— 迁到 Node-RED 后**没有求值节点**，`
            + "这条条件此后永远走 false 口。请在 Mcode 画布上修正表达式后重新迁移。",
        });
      }
    }
    if (kind === "condition") {
      // Old custom-UI runtime inputs are not an event's HookEvent payload.
      // Report this as an execution blocker in the confirmation dialog, not
      // as a generic "some metadata stays in x-mcode" representation caveat.
      const expression = parseConditionExpression(node.params["expression"]);
      const upstream = upstreamClosure(buildForwardAdjacency(doc.nodes, doc.edges).deps, node.id);
      const hasHostEvent = doc.nodes.some(candidate =>
        upstream.has(candidate.id) && candidate.type === "mcode.trigger"
        && candidate.params["triggerKind"] === "event");
      const hasNativeManual = doc.nodes.some(candidate =>
        upstream.has(candidate.id) && candidate.type === "mcode.trigger"
        && candidate.params["triggerKind"] === "manual");
      const supported = new Set<string>(CONDITION_HOST_TRIGGER_FIELDS);
      const unsupportedTrigger = expression.ok ? expression.expression.rules.find(rule => {
        if (typeof rule.ref !== "string" || !rule.ref.startsWith("{{trigger.")) return false;
        const key = rule.ref.endsWith("}}") ? rule.ref.slice("{{trigger.".length, -2) : "";
        return !((hasHostEvent && supported.has(key))
          || (hasNativeManual && (supported.has(key) || key === "collectionId"
            || key === "files" || /^input\.[a-z][a-z0-9_]{0,23}$/.test(key))));
      }) : undefined;
      const manualInputRule = expression.ok ? expression.expression.rules.find(rule =>
        typeof rule.ref === "string" && rule.ref.startsWith("{{trigger.input.")) : undefined;
      if (hasNativeManual && manualInputRule !== undefined) {
        needsHumanDecision.push({ code: "needs-human-decision", nodeId: node.id,
          message: "【需从 Mcode 自定义 UI 运行】这张手动工作流的 " + manualInputRule.ref + " 来自运行前表单。"
            + "只有由 Mcode 自定义 UI 确认并使用 Host 原生 /inject/:id 的一次性凭据运行时才可读取；"
            + "直接点击 Node-RED 编辑器 Inject 不携带输入，会明确失败。",
        });
      }
      if (unsupportedTrigger !== undefined) {
        lossy.push({
          code: "lossy",
          nodeId: node.id,
          message: "【迁移后不能执行】此条件引用 " + unsupportedTrigger.ref
            + "：Host 的真实事件订阅只提供 kind/event/条目字段，手动自定义 UI 输入必须经过受归属校验的原生 Inject 才可读取 input.*。"
            + "普通事件和原生编辑器直接点击 Inject 不携带运行前输入；不能靠 msg.payload 冒充。"
            + "即使确认装载并 Deploy，该引用仍会显式失败。必须先改写条件及输入来源，不可直接启用。",
        });
      }
      lossy.push({
        code: "lossy",
        nodeId: node.id,
        message:
          "condition 迁为原生 switch + mcode-condition-eval 求值节点：switch 读 "
          + "`msg.mcode.condition` 分真/假两路，求值由 Host 用旧的表达式求值器完成。"
          + "边界：Host 事件凭据可恢复 kind/event/条目字段，Mcode 自定义 UI 的手动运行可经一次性 Inject 凭据恢复 input.*；"
          + "原生编辑器直接 Inject、原生 watch、结构化产出变量及原生节点结局仍无相同数据源，"
          + "引用它们会显式失败（而不是安静地走 false）。",
      });
    }
    if ((kind === "code" || kind === "command")
      && (effectiveType === "exec" || effectiveType === "function")) {
      lossy.push({
        code: "lossy",
        nodeId: node.id,
        message: "Mcode code/command 的产出契约（exitCode/stdout/stderr 及变量绑定）与原版 Node-RED function/exec 的 msg.payload、三路 stdout/stderr/return-code 消息不同；Mcode 普通出边目前只连原生输出口 0，完整产出映射须由 Host 适配器处理。",
      });
    }
    if (kind === "code" && node.params["input"] !== undefined
      && node.params["input"] !== null
      && !(typeof node.params["input"] === "string" && node.params["input"].trim() === "")) {
      lossy.push({
        code: "lossy",
        nodeId: node.id,
        message: "code 的 input JSON 参数保留在 x-mcode.params，但原版 Node-RED function/exec 没有等价的 Mcode input-template/stdin 接口；原生运行不会自动应用该参数，须由 Host 执行器接管或在迁移确认中显式处理。",
      });
    }
    for (const issue of humanDecisionIssuesOf(node, kind, node.params)) {
      // 该函数同时产出两类条目：需人工裁决（needsHumanDecision）与已知损失
      // （lossy —— 例如 trigger 迁到内置 inject 后 debounce/项目字段无处安放）。
      // 按 code 分流，不让 lossy 混进"裁决"清单（那会误导复审者）。
      (issue.code === "lossy" ? lossy : needsHumanDecision).push(issue);
    }

    mapped.push({ nodeRedId, nodeId: node.id, type: node.type, runnerKind: kind });
  }

  // 边：每条 Mcode 边 → 一条 Node-RED link。sourcePort 规则：
  //  - branch：出边在文档里的顺序 = 端口号（与 `outgoingEdgesOf` 的选项顺序一致）；
  //  - condition：label true → 0，false → 1（与调度器 conditionOutcome 一致）；
  //  - 其余：0。
  const branchPortSeen = new Map<string, number>();
  const links: NodeRedLink[] = [];
  const edgeReport: FlowMigrationReport["edges"] = [];
  for (const [index, edge] of doc.edges.entries()) {
    const sourceNr = nodeRedOf.get(edge.from);
    const targetNr = nodeRedOf.get(edge.to);
    if (sourceNr === undefined || targetNr === undefined) {
      unmapped.push({
        nodeId: edge.from,
        type: "(edge)",
        reason: `边 ${edge.id} 的端点不在文档 nodes 里（from=${edge.from} to=${edge.to}）—— 未生成 link`,
      });
      continue;
    }
    const kind = kindOf.get(edge.from) ?? "unknown";
    let sourcePort = 0;
    if (kind === "branch") {
      sourcePort = branchPortSeen.get(edge.from) ?? 0;
      branchPortSeen.set(edge.from, sourcePort + 1);
    } else if (kind === "condition") {
      sourcePort = edge.label?.trim() === "false" ? 1 : 0;
    }
    const edgeUnknownKeys = unknownKeysForEdge(unknownPaths, index);
    const edgeUnknown = pickKeys(edge as unknown as Record<string, unknown>, edgeUnknownKeys);
    const linkId = edgeIds.get(edge.id)!;
    // W17：这条边若指向一个带求值适配节点的条件，native 侧的**连接**改成
    // 「上游 → 适配节点 → switch」；而 links sidecar 仍记「上游 → 条件节点」——
    // 它描述的是 **Mcode 的图**，不描述插入的适配节点。反向迁移按适配节点折回。
    const evalRedId = conditionEvaluators.get(edge.to);
    const link: NodeRedLink = {
      id: linkId,
      source: sourceNr.id,
      sourcePort,
      target: evalRedId ?? targetNr.id,
      targetPort: 0,
      "x-mcode-edge": {
        edgeId: edge.id,
        ...(edge.label !== undefined ? { label: edge.label } : {}),
        ...(edge.note !== undefined ? { note: edge.note } : {}),
        ...(Object.keys(edgeUnknown).length > 0 ? { unknown: edgeUnknown } : {}),
      },
    };
    links.push(link);
    edgeReport.push({
      edgeId: edge.id,
      source: sourceNr.id,
      sourcePort,
      target: targetNr.id,
      ...(edge.label !== undefined ? { label: edge.label } : {}),
    });
    // 分支的选项名没填 label 时由目标标题兜底 —— 这个"名字从哪来"的规则只存在于
    // Mcode 侧；Node-RED 侧看到的是端口。往返时按文档顺序还原，但报告里点名这条
    // 依赖，避免有人以为 label 是必需的。
    if (kind === "branch") {
      const optionName = edgeOptionNameOf(edge, doc, workflowNodeRefName);
      if ((edge.label ?? "").trim() === "") {
        lossy.push({
          code: "lossy",
          edgeId: edge.id,
          message: `分支选项「${optionName}」的 label 为空 —— 选项名由目标节点标题兜底（Mcode 规则）；Node-RED 侧只看到端口号`,
        });
      }
    }
  }

  // 端口分配后写 wires：每个出端口的目标 **节点 id** 列表。
  //
  // ⚠️ Node-RED 的 `wires` 装的是**目标节点的 id**，不是 link 的 id —— 这条是
  // 2026-10-19 用真 node-red 5.0.8 源码确认的（`@node-red/runtime/lib/flows/util.js`
  // 只认 wires / link in-out 的 `links` 目标 id；flows.json 格式里**没有**顶层
  // `links` 数组，Node-RED 的存储层以 wires 为真相）。本文件的 `links` 是
  // **Mcode 侧的边元数据 sidecar**（label/note/未知字段只能住在这里，Node-RED 的
  // 节点形上没有边对象的家）——部署给 Node-RED 时只发 `flow.nodes`，link 元数据留在
  // 迁移器这边，供往返与将来的 StorageAdapter 使用。
  const linkTargets = new Map<string, string[]>(); // sourceNrId + "#" + port → target nr ids
  for (const [index, edge] of doc.edges.entries()) {
    const sourceNr = nodeRedOf.get(edge.from);
    const targetNr = nodeRedOf.get(edge.to);
    if (sourceNr === undefined || targetNr === undefined) continue;
    const kind = kindOf.get(edge.from) ?? "unknown";
    let sourcePort = 0;
    if (kind === "branch") {
      // branch 的端口号按文档顺序分配（与上面 links 循环同一顺序）。
      sourcePort = doc.edges.slice(0, index).filter((e) => e.from === edge.from).length;
    } else if (kind === "condition") {
      sourcePort = edge.label?.trim() === "false" ? 1 : 0;
    }
    // W17：指向带求值节点的条件时，真实连接是「上游 → 适配节点」。
    const targetRedId = conditionEvaluators.get(edge.to) ?? targetNr.id;
    const key = `${sourceNr.id}#${sourcePort}`;
    const list = linkTargets.get(key) ?? [];
    list.push(targetRedId);
    linkTargets.set(key, list);
  }
  for (const [key, targets] of linkTargets) {
    const [sourceId, portText] = key.split("#");
    const source = [...nodeRedOf.values()].find((n) => n.id === sourceId);
    const port = Number(portText);
    if (source?.wires !== undefined && source.wires[port] !== undefined) {
      source.wires[port].push(...targets);
    }
  }

  // The upstream Node-RED flows.json stores only nodes[]/wires[], never
  // our top-level links sidecar. Attach unchanged edge annotations to each
  // source native node so an actual editor GET /flows can round-trip them.
  // A copied node inherits the metadata but NOT its original native id; the
  // inverse adapter rejects that stale sourceNativeId instead of silently
  // assigning an old approval/label to an unrelated new connection.
  const nativeNodes = new Map([...nodeRedOf.values()].map((node) => [node.id, node]));
  for (const link of links) {
    const source = nativeNodes.get(link.source)?.["x-mcode"];
    if (!source) continue;
    const annotation = link["x-mcode-edge"];
    (source.edgeMeta ??= []).push({
      sourceNativeId: link.source,
      targetNativeId: link.target,
      sourcePort: link.sourcePort,
      edgeId: annotation?.edgeId ?? link.id,
      ...(annotation?.label !== undefined ? { label: annotation.label } : {}),
      ...(annotation?.note !== undefined ? { note: annotation.note } : {}),
      ...(annotation?.unknown !== undefined ? { unknown: annotation.unknown } : {}),
    });
  }

  const flowId = nodeRedIdOf("flow", doc.id, usedIds);
  // 【真引擎硬事实，2026-10-19 node-red 5.0.8 实测】节点**必须**有 `z`（所属 tab 的 id）
  // 且 tab 必须在同一个 flows 数组里，否则编辑器里它们不挂任何 flow（部署 200、读回也在，
  // 但画布上无处显示）。迁移器为每份文档生成一个 tab 并给所有节点挂 z。
  //
  // 文档级 `x-mcode` 元数据同时挂在 tab 上：真引擎 GET /flows 读回的是节点数组，
  // 没有"flow 级"对象，tab 是唯一能让元数据活过往返的容器。
  const tab: NodeRedNode = {
    id: nodeRedIdOf("tab", doc.id, usedIds),
    type: "tab",
    label: doc.name,
    disabled: false,
    info: "",
    env: [],
  };
  for (const nr of nodeRedOf.values()) nr.z = tab.id;

  const docMeta: NonNullable<NodeRedFlow["x-mcode"]> = {
    docId: doc.id,
    name: doc.name,
    ...(doc.engine !== undefined ? { engine: doc.engine } : {}),
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    ...(doc.icon !== undefined ? { icon: doc.icon } : {}),
    ...(doc.prompt !== undefined ? { prompt: doc.prompt } : {}),
    ...(doc.frameworkNote !== undefined ? { frameworkNote: doc.frameworkNote } : {}),
    ...(doc.trigger !== undefined ? { trigger: doc.trigger } : {}),
    ...(doc.schemaVersion !== undefined ? { schemaVersion: doc.schemaVersion } : {}),
    ...(doc.inputSchema !== undefined ? { inputSchema: doc.inputSchema } : {}),
    ...(doc.outputSchema !== undefined ? { outputSchema: doc.outputSchema } : {}),
    builtin: doc.builtin,
    updatedAt: doc.updatedAt,
    ...(Object.keys(docUnknown).length > 0 ? { unknown: docUnknown } : {}),
  };
  // The tab survives an actual Node-RED GET /flows round-trip; the top-level
  // x-mcode is only a Mcode sidecar. They must never share mutable metadata.
  (tab as Record<string, unknown>)["x-mcode"] = structuredClone(docMeta);

  const flow: NodeRedFlow = {
    id: flowId,
    label: doc.name,
    nodes: [tab, ...nodeRedOf.values()],
    links,
    "x-mcode": docMeta,
  };

  const report: FlowMigrationReport = {
    migratorVersion: FLOW_MIGRATOR_VERSION,
    docId: doc.id,
    docName: doc.name,
    mapped,
    unmapped,
    unknownFieldPaths: unknownPaths,
    needsHumanDecision,
    lossy,
    edges: edgeReport,
  };
  return { flow, report };
}

/* ── 反向：Node-RED flow → WorkflowDoc（以原生画布为事实源） ── */

/** A migrated flow can retain the old Mcode link metadata after the user
 * edits wires inside the actual Node-RED editor. Compare connection MULTISETS
 * before accepting that sidecar: equal endpoints/ports (including duplicates)
 * means annotations are still applicable; otherwise live wires win. */
function sidecarMatchesNativeWires(nodes: readonly NodeRedNode[], links: readonly NodeRedLink[]): boolean {
  const ids = new Set(nodes.map((n) => n.id));
  const counts = new Map<string, number>();
  const key = (source: string, port: number, target: string): string =>
    JSON.stringify([source, port, target]);
  for (const node of nodes) {
    for (const [port, targets] of (node.wires ?? []).entries()) {
      for (const target of targets) {
        if (!ids.has(target)) return false;
        const k = key(node.id, port, target);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  for (const link of links) {
    if (!ids.has(link.source) || !ids.has(link.target)) return false;
    const k = key(link.source, link.sourcePort, link.target);
    const remaining = counts.get(k) ?? 0;
    if (remaining === 0) return false;
    counts.set(k, remaining - 1);
  }
  return [...counts.values()].every((remaining) => remaining === 0);
}

/** 反向映射：Node-RED 节点 type → runner.kind（只覆盖 `NODE_RED_TYPE_OF_RUNNER` 的值）。 */
const RUNNER_OF_NODE_RED_TYPE: ReadonlyMap<string, NodeRunnerKind> = new Map(
  (Object.entries(NODE_RED_TYPE_OF_RUNNER) as Array<[NodeRunnerKind, string]>).map(([kind, type]) => [type, kind]),
);

/**
 * 把本模块生成的 flow 读回 WorkflowDoc。
 *
 * 对**本迁移器产出的 flow** 是精确反向；对外部手写的 flow 只做尽力而为（缺 `x-mcode`
 * 时用节点 id 当 Mcode id、边按 link 顺序还原）。不认识的节点 type 保留原始 type，
 * 由调用方/报告点名 —— 不在这里抛。
 */
export function flowToWorkflowDoc(flow: NodeRedFlow): WorkflowDoc {
  // The returned editor document is mutable. Detach all nested values from
  // the source flow so editing a restored doc cannot alter the archive bytes.
  flow = structuredClone(flow);
  // ── W17：先把条件求值适配节点**折回**原条件节点 ──
  //
  // 适配节点是迁移器插进去的容器（用户不可见、不在 WorkflowDoc.nodes 里）。不折的
  // 话，一次往返就多出一个节点：`roundTripMismatchPaths` 会把每张含条件的图报成
  // `nodes.length(N→N+1)`，迁移预检据此 REJECT —— 而那是本卡要修的同一张图。
  //
  // 折叠规则（与正向插入严格对称）：
  //   1. 适配节点自身不进 nodes；
  //   2. 指向适配节点的边，目标改回原条件节点；
  //   3. 适配节点 → switch 的那条边是**插进去的连接**，不是用户的边，丢弃；
  //   4. 原条件节点的 native id 不变（它就是那个 switch）。
  //
  // `conditionEvalTargetOf` 对「类型对但 bridgesNodeId 坏掉」抛错 —— 被复制或手改的
  // 适配节点绝不能悄悄退化成一条普通节点，更不能折到错的条件下。
  const evalBridgeToTarget = new Map<string, string>(); // 适配 native id → Mcode 条件 id
  for (const nrNode of flow.nodes) {
    const target = conditionEvalTargetOf(nrNode as { type?: unknown; "x-mcode"?: unknown });
    if (target === null) continue;
    if (!flow.nodes.some((candidate) => candidate["x-mcode"]?.nodeId === target)) {
      throw new Error(`condition 求值适配节点 ${nrNode.id} 指向的 Mcode 节点「${target}」不在这张 flow 里 —— 拒绝折叠，须重新迁移`);
    }
    evalBridgeToTarget.set(nrNode.id, target);
  }
  if (evalBridgeToTarget.size > 0) {
    flow = {
      ...flow,
      nodes: flow.nodes
        .filter((nrNode) => !evalBridgeToTarget.has(nrNode.id))
        .map((nrNode) => {
          // edgeMeta 的 targetNativeId 记的是**真实 native 连接**（正向迁移时即适配
          // 节点）；折回后要指向条件 switch，否则真实编辑器读回的那条路径
          // （没有 links sidecar，靠 edgeMeta 恢复注释）会丢掉这条边的 label/note。
          const edgeMeta = nrNode["x-mcode"]?.edgeMeta?.map((annotation) => ({
            ...annotation,
            targetNativeId: evalBridgeToTarget.get(annotation.targetNativeId) ?? annotation.targetNativeId,
          }));
          const metaNext = nrNode["x-mcode"] === undefined ? undefined
            : { ...nrNode["x-mcode"], ...(edgeMeta !== undefined ? { edgeMeta } : {}) };
          // 指向适配节点的 wire **改回**条件 switch（不是删掉）：那条 wire 就是
          // 用户原来的「上游 → 条件」那条边，删掉等于把边丢了。适配节点 → switch
          // 的那条插入连接随适配节点一起消失（源节点被过滤掉）。
          const wires = nrNode.wires === undefined ? undefined
            : nrNode.wires.map((targets) => targets.map((target) => evalBridgeToTarget.get(target) ?? target));
          if (wires === undefined && metaNext === undefined) return nrNode;
          return { ...nrNode, ...(wires !== undefined ? { wires } : {}), ...(metaNext !== undefined ? { "x-mcode": metaNext } : {}) };
        }),
      // sidecar 里的 link target 同样是适配节点（正向迁移时 `link.target` 指向它）。
      ...(flow.links !== undefined
        ? { links: flow.links.map((link) => ({
            ...link,
            target: evalBridgeToTarget.get(link.target) ?? link.target,
          })) }
        : {}),
    };
  }
  // 文档级元数据优先取 flow 顶层；从真引擎读回的数组没有顶层元数据 —— 它挂在 tab 上
  // （见正向迁移里 `(tab as ...)["x-mcode"] = docMeta`）。
  const tab = flow.nodes.find((n) => n.type === "tab");
  const tabMeta = tab?.["x-mcode"] as NodeRedFlow["x-mcode"] | undefined;
  const meta = flow["x-mcode"] ?? tabMeta;
  // The real Node-RED tab label is the editable document title. Treat the
  // x-mcode metadata as an original baseline, not an unchangeable override.
  const liveName = tab?.label !== undefined && tab.label !== meta?.name
    ? tab.label : (meta?.name ?? tab?.label ?? flow.label);
  const nrToMcodeNode = new Map<string, string>();
  // The upstream Node-RED editor allocates a fresh native id on duplicate,
  // but carries unknown fields such as x-mcode.nodeId across unchanged.
  // Without healing that identity, duplicate/paste creates two WorkflowDoc
  // nodes with the SAME Mcode ID, breaking edges, CAS and later deployments.
  // Prefer the migrated native ID (the original) as keeper, then choose a
  // deterministic lexical keeper if this flow came from another editor.
  const claimedGroups = new Map<string, NodeRedNode[]>();
  for (const nrNode of flow.nodes) {
    if (nrNode.type === "tab") continue;
    const claimed = nrNode["x-mcode"]?.nodeId ?? nrNode.id;
    const group = claimedGroups.get(claimed) ?? [];
    group.push(nrNode);
    claimedGroups.set(claimed, group);
  }
  const reservedNodeIds = new Set(claimedGroups.keys());
  const assignCopyIdentity = (node: NodeRedNode): void => {
    const base = "mcode_copy_" + createHash("sha256").update(node.id).digest("hex").slice(0, 20);
    let candidate = base;
    let ordinal = 2;
    while (reservedNodeIds.has(candidate)) candidate = `${base}_${ordinal++}`;
    reservedNodeIds.add(candidate);
    nrToMcodeNode.set(node.id, candidate);
  };
  for (const [claimed, group] of [...claimedGroups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const sorted = [...group].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    // Native duplication copies x-mcode.nodeId AND x-mcode.nativeId. If the
    // original node is deleted, even a *single* surviving copy must receive
    // a new Mcode identity; otherwise it inherits the deleted approval.
    const originalsWithNativeMarker = sorted.filter(n =>
      typeof n["x-mcode"]?.nativeId === "string" && n["x-mcode"]?.nativeId === n.id);
    const hasNativeMarker = sorted.some(n => typeof n["x-mcode"]?.nativeId === "string");
    const original = originalsWithNativeMarker[0]
      ?? (hasNativeMarker ? undefined :
        sorted.find(n => n.id === foldedNodeRedId("n", claimed)) ?? sorted[0]);
    if (original !== undefined) nrToMcodeNode.set(original.id, claimed);
    for (const clone of sorted) {
      if (clone !== original) assignCopyIdentity(clone);
    }
  }
/**
 * Native palette replacement is NOT a metadata edit. A Node-RED node changed
 * from exec to function but still carrying x-mcode.type=mcode.command cannot
 * safely be translated back as the old Mcode command runner. Preserve
 * backward compatibility for legacy (no nativeType) files by inferring only
 * canonical built-in Mcode types; other third-party node types stay opaque.
 */
function expectedNativeType(meta: NonNullable<NodeRedNode["x-mcode"]>): string | undefined {
  if (typeof meta.nativeType === "string" && meta.nativeType.length > 0) return meta.nativeType;
  switch (meta.type) {
    case "mcode.agent": return "mcode-agent";
    case "mcode.main":
    case "mcode.conversation": return "mcode-conversation";
    case "mcode.branch": return "mcode-branch";
    case "mcode.command": return "exec";
    case "mcode.condition": return "switch";
    case "mcode.node-red": return "mcode-node-red-call";
    case "mcode.module-capability": return "mcode-module-capability";
    case "mcode.code": return meta.params?.["language"] === "node" ? "function" : "exec";
    case "mcode.trigger": {
      const kind = meta.params?.["triggerKind"];
      if (kind === "schedule" || kind === "manual") return "inject";
      if (kind === "file") return "watch";
      return "mcode-trigger";
    }
    default: return undefined;
  }
}

  const nodes: WorkflowNode[] = [];
  for (const nrNode of flow.nodes) {
    // tab 是迁移器生成的容器（文档级元数据挂在它身上），不是 Mcode 节点 —— 读回时跳过。
    // Mcode 的类型 id 形如 `作者.名字`，不可能叫 `tab`，所以这个跳过不吞用户节点。
    if (nrNode.type === "tab") continue;
    const x = nrNode["x-mcode"];
    const nodeId = nrToMcodeNode.get(nrNode.id) ?? x?.nodeId ?? nrNode.id;
    // A native palette node type can be replaced while Node-RED preserves
    // unknown x-mcode sidecar properties. Do not allow an edited Function
    // node to be re-imported as an old command/agent type with stale params.
    const expected = x !== undefined ? expectedNativeType(x) : undefined;
    if (expected !== undefined && expected !== nrNode.type
      // Older snapshots without a type marker legitimately used a
      // mcode-unknown placeholder when their node-pack was missing. Keep
      // that non-executable archive readable, not silently executable.
      && !(x?.nativeType === undefined && nrNode.type === "mcode-unknown")) {
      throw new Error(`Node-RED native type 不一致：节点 ${nrNode.id}（Mcode ${nodeId}），原为 ${expected}，现为 ${nrNode.type}；拒绝套用旧 x-mcode 参数，须明确重新映射`);
    }
    nrToMcodeNode.set(nrNode.id, nodeId);
    const originalPosition = x?.position;
    const moved = originalPosition !== undefined &&
      (nrNode.x !== undefined && nrNode.x !== Math.round(originalPosition.x) ||
       nrNode.y !== undefined && nrNode.y !== Math.round(originalPosition.y));
    const position = moved
      ? { x: nrNode.x ?? originalPosition!.x, y: nrNode.y ?? originalPosition!.y }
      : (originalPosition ?? { x: nrNode.x ?? 0, y: nrNode.y ?? 0 });
    const nativeParams = paramsFromNativeNode(nrNode, x?.params);
    const capability = capabilityFromNativeNode(
      nrNode,
      x?.capability as WorkflowNode["capability"] | undefined,
    );
    const node: WorkflowNode = {
      id: nodeId,
      type: x?.type ?? nrNode.type,
      title: nrNode.name ?? x?.title ?? "",
      params: nativeParams,
      position: {
        x: position.x,
        y: position.y,
        ...safeUnknownFields(x?.unknownPosition, ["x", "y"]),
      } as WorkflowNode["position"],
      ...(capability !== undefined ? { capability } : {}),
      ...safeUnknownFields(x?.unknown, ["id", "type", "title", "params", "position", "capability"]),
    };
    // Native "Duplicate" assigns a new native ID but copies x-mcode and
    // its prior write privilege verbatim. A new Mcode node identity must not
    // silently inherit the original node's approval/security declaration.
    if (x?.nodeId !== undefined && nodeId !== x.nodeId) {
      if (node.capability === "write") node.capability = "read";
      if ((nrNode.type === "mcode-agent" || nrNode.type === "mcode-conversation")
        && node.params["capability"] === "write") {
        node.params["capability"] = "read";
      }
    }
    nodes.push(node);
  }

  // 边：优先用 `links` sidecar（迁移器原样往返，含边级未知字段）；若 flow 来自真
  // Node-RED 的读回（没有 links），就从节点的 `wires` 重建 —— 真引擎的真相就是它。
  const edges: Array<WorkflowEdge & Record<string, unknown>> = [];
  if (flow.links !== undefined && sidecarMatchesNativeWires(flow.nodes, flow.links)) {
    const links = [...flow.links].sort((a, b) => (a.source === b.source ? a.sourcePort - b.sourcePort : 0));
    const linkIdCounts = new Map<string, number>();
    for (const link of links) {
      const id = link["x-mcode-edge"]?.edgeId ?? link.id;
      linkIdCounts.set(id, (linkIdCounts.get(id) ?? 0) + 1);
    }
    const occupied = new Set(
      [...linkIdCounts].filter(([, n]) => n === 1).map(([id]) => id),
    );
    for (const link of links) {
      const x = link["x-mcode-edge"];
      const savedId = x?.edgeId ?? link.id;
      let edgeId = savedId;
      if ((linkIdCounts.get(savedId) ?? 0) > 1) {
        // Imported/duplicated sidecar metadata may carry the same edgeId on
        // two distinct native links. Native identities, not copied x-mcode
        // labels, decide which links must receive unique recovered IDs.
        const base = "e_" + createHash("sha256")
          .update(JSON.stringify([link.source, link.sourcePort, link.target, link.id]))
          .digest("hex").slice(0, 24);
        edgeId = base;
        let ordinal = 2;
        while (occupied.has(edgeId)) edgeId = `${base}_${ordinal++}`;
        occupied.add(edgeId);
      }
      const edge: WorkflowEdge & Record<string, unknown> = {
        id: edgeId,
        from: nrToMcodeNode.get(link.source) ?? link.source,
        to: nrToMcodeNode.get(link.target) ?? link.target,
        ...(x?.label !== undefined ? { label: x.label } : {}),
        ...(x?.note !== undefined ? { note: x.note } : {}),
        ...safeUnknownFields(x?.unknown, ["id", "from", "to", "label", "note"]),
      };
      edges.push(edge);
    }
  } else {
    // The real editor's wires are canonical; however an edit to ONE wire
    // must not discard annotations/unknown fields of all OTHER unchanged
    // edges. Match old metadata by actual (source, outputPort, target) with a
    // consumed queue so duplicate parallel connections never reuse one ID.
    const oldByConnection = new Map<string, NodeRedLink[]>();
    const connectionKey = (source: string, port: number, target: string): string =>
      JSON.stringify([source, port, target]);
    for (const old of flow.links ?? []) {
      const key = connectionKey(old.source, old.sourcePort, old.target);
      const queue = oldByConnection.get(key) ?? [];
      queue.push(old);
      oldByConnection.set(key, queue);
    }
    // Actual native GET /flows has no top-level links. Restore annotations
    // only for the exact source-native-id + port + target-native-id of a
    // still-connected wire; edited/new wires remain canonical.
    if (flow.links === undefined) {
      for (const sourceNode of flow.nodes) {
        const annotations = sourceNode["x-mcode"]?.edgeMeta;
        if (!Array.isArray(annotations)) continue;
        for (const annotation of annotations) {
          if (!annotation || typeof annotation !== "object"
            || annotation.sourceNativeId !== sourceNode.id
            || typeof annotation.targetNativeId !== "string"
            || typeof annotation.edgeId !== "string"
            || !Number.isInteger(annotation.sourcePort)
            || annotation.sourcePort < 0) continue;
          const key = connectionKey(sourceNode.id, annotation.sourcePort, annotation.targetNativeId);
          const queue = oldByConnection.get(key) ?? [];
          queue.push({
            id: annotation.edgeId,
            source: sourceNode.id,
            sourcePort: annotation.sourcePort,
            target: annotation.targetNativeId,
            targetPort: 0,
            "x-mcode-edge": {
              edgeId: annotation.edgeId,
              ...(typeof annotation.label === "string" ? { label: annotation.label } : {}),
              ...(typeof annotation.note === "string" ? { note: annotation.note } : {}),
              ...(annotation.unknown && typeof annotation.unknown === "object"
                && !Array.isArray(annotation.unknown) ? { unknown: annotation.unknown } : {}),
            },
          });
          oldByConnection.set(key, queue);
        }
      }
    }
    // The native editor does not persist Mcode edge IDs. Keep the historic
    // readable fallback for ordinary links, but two distinct pairs such as
    // (a_b,c) and (a,b_c) both fold into e_a_b_c. Precompute all candidate
    // IDs before assigning any, so a change in Node-RED array order cannot
    // arbitrarily decide which connection keeps the ambiguous ID.
    const pending: Array<{
      edge: WorkflowEdge & Record<string, unknown>;
      identity: string;
    }> = [];
    const repeats = new Map<string, number>();
    for (const nrNode of flow.nodes) {
      if (nrNode.wires === undefined) continue;
      const from = nrToMcodeNode.get(nrNode.id) ?? nrNode.id;
      let n = 0;
      nrNode.wires.forEach((targets, port) => {
        for (const targetNrId of targets) {
          const to = nrToMcodeNode.get(targetNrId) ?? targetNrId;
          n += 1;
          const key = connectionKey(nrNode.id, port, targetNrId);
          const occurrence = (repeats.get(key) ?? 0) + 1;
          repeats.set(key, occurrence);
          const saved = oldByConnection.get(key)?.shift();
          const metadata = saved?.["x-mcode-edge"];
          const edgeId = metadata?.edgeId ?? `e_${from}_${to}${n > 1 ? `_${n}` : ""}`;
          const label = metadata?.label ?? (nrNode.type === "switch"
            ? (port === 1 ? "false" : port === 0 ? "true" : undefined)
            : undefined);
          pending.push({
            identity: JSON.stringify([nrNode.id, port, targetNrId, occurrence]),
            edge: {
              id: edgeId, from, to,
              ...(label !== undefined ? { label } : {}),
              ...(metadata?.note !== undefined ? { note: metadata.note } : {}),
              ...safeUnknownFields(metadata?.unknown, ["id", "from", "to", "label", "note"]),
            } as WorkflowEdge,
          });
        }
      });
    }
    const candidateCounts = new Map<string, number>();
    for (const { edge } of pending) {
      candidateCounts.set(edge.id, (candidateCounts.get(edge.id) ?? 0) + 1);
    }
    const usedEdgeIds = new Set(
      pending.filter(({ edge }) => candidateCounts.get(edge.id) === 1).map(({ edge }) => edge.id),
    );
    for (const { edge, identity } of pending) {
      if ((candidateCounts.get(edge.id) ?? 0) > 1) {
        // JSON tuple boundaries, original native node IDs and per-connection
        // occurrence make collision repair stable even when editor reorders
        // nodes or names contain arbitrary separators.
        const base = "e_" + createHash("sha256").update(identity).digest("hex").slice(0, 24);
        let candidate = base;
        let counter = 2;
        while (usedEdgeIds.has(candidate)) candidate = `${base}_${counter++}`;
        edge.id = candidate;
        usedEdgeIds.add(candidate);
      }
      edges.push(edge);
    }
  }

  return {
    id: meta?.docId ?? flow.id,
    name: liveName,
    ...(meta ? (meta.engine !== undefined ? { engine: meta.engine } : {}) : { engine: "node-red" }),
    ...(meta?.description !== undefined ? { description: meta.description } : {}),
    ...(meta?.icon !== undefined ? { icon: meta.icon } : {}),
    ...(meta?.prompt !== undefined ? { prompt: meta.prompt } : {}),
    ...(meta?.frameworkNote !== undefined ? { frameworkNote: meta.frameworkNote } : {}),
    ...(meta?.trigger !== undefined ? { trigger: meta.trigger as WorkflowDoc["trigger"] } : {}),
    ...(meta?.schemaVersion !== undefined ? { schemaVersion: meta.schemaVersion } : {}),
    ...(meta?.inputSchema !== undefined ? { inputSchema: meta.inputSchema } : {}),
    ...(meta?.outputSchema !== undefined ? { outputSchema: meta.outputSchema } : {}),
    nodes,
    edges,
    builtin: meta?.builtin ?? false,
    updatedAt: meta?.updatedAt ?? 0,
    ...safeUnknownFields(meta?.unknown, [
      "id", "name", "engine", "description", "icon", "prompt", "frameworkNote",
      "trigger", "schemaVersion", "inputSchema", "outputSchema",
      "nodes", "edges", "builtin", "updatedAt",
    ]),
  } as WorkflowDoc;
}

/**
 * 往返对比：把 `doc → flow → doc` 的**已知字段**逐个比对，返回差异路径。
 * 空数组 = 已知字段完全一致（未知字段另由 `unknownWorkflowFieldPaths` 验）。
 */
export function roundTripMismatchPaths(doc: WorkflowDoc, roundTripped: WorkflowDoc): string[] {
  const paths: string[] = [];
  const compare = (path: string, a: unknown, b: unknown): void => {
    // JSON key order does not change workflow semantics. A textual stringify
    // comparison reports false data loss after a harmless object reordering.
    if (isDeepStrictEqual(a, b)) return;
    // 位置允许 <1px 的整数化差异（迁移器显式在 report.lossy 里点名）。
    if (path.endsWith(".position") || path.endsWith("position")) {
      const pa = a as { x?: number; y?: number } | undefined;
      const pb = b as { x?: number; y?: number } | undefined;
      if (pa !== undefined && pb !== undefined && Math.abs((pa.x ?? 0) - (pb.x ?? 0)) < 1 && Math.abs((pa.y ?? 0) - (pb.y ?? 0)) < 1) return;
    }
    paths.push(path);
  };
  const knownDocKeys = [
    "id", "name", "engine", "description", "icon", "prompt", "frameworkNote", "trigger", "schemaVersion",
    "inputSchema", "outputSchema", "builtin", "updatedAt",
  ] as const;
  for (const key of knownDocKeys) {
    compare(key, (doc as unknown as Record<string, unknown>)[key], (roundTripped as unknown as Record<string, unknown>)[key]);
  }
  if (doc.nodes.length !== roundTripped.nodes.length) {
    paths.push(`nodes.length(${doc.nodes.length}→${roundTripped.nodes.length})`);
  }
  const rtNodeById = new Map(roundTripped.nodes.map((n) => [n.id, n]));
  for (const node of doc.nodes) {
    const other = rtNodeById.get(node.id);
    if (other === undefined) {
      paths.push(`nodes[${node.id}]`);
      continue;
    }
    for (const key of ["type", "title", "params", "capability"] as const) {
      compare(`nodes[${node.id}].${key}`, node[key], other[key]);
    }
    compare(`nodes[${node.id}].position`, node.position, other.position);
  }
  if (doc.edges.length !== roundTripped.edges.length) {
    paths.push(`edges.length(${doc.edges.length}→${roundTripped.edges.length})`);
  }
  const rtEdgeById = new Map(roundTripped.edges.map((e) => [e.id, e]));
  for (const edge of doc.edges) {
    const other = rtEdgeById.get(edge.id);
    if (other === undefined) {
      paths.push(`edges[${edge.id}]`);
      continue;
    }
    for (const key of ["from", "to", "label", "note"] as const) {
      compare(`edges[${edge.id}].${key}`, edge[key], other[key]);
    }
  }
  return paths;
}
