/**
 * 【ARC-006 Gate C 第一个安全切片】**WorkflowDoc → Node-RED flow 的纯函数迁移器**。
 *
 * ## 它做什么(以及刻意不做什么)
 *
 * 把 Mcode 的 `WorkflowDoc`（`nodes` / `edges` / `schemaVersion`）映射成 Node-RED
 * flows.json 的 `nodes` / `links` 形状，并产出一份**可复核的迁移报告**；反向
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
 * | `command` | `exec` | 单输出；entry 形态走 `mcode-command-entry` |
 * | `code` | `function`（node）/ `mcode-code`（其它语言） | 单输出 |
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
 * Node-RED 的 link 是 `{ id, source, sourcePort, target, targetPort }`；一条输出口
 * 只能连一条 link，所以 **1→N 的出边由 Node-RED 的 link-out/link-in 中转**（端口
 * 上放一个 `link out` 节点，目标侧放 `link in`）。本模块生成的是**语义等价形状**：
 * 节点 ports 数按 kind 定，`links` 按 `(sourceNode, sourcePort)` 分组 —— 一组多条时
 * 生成中转节点。`flowToWorkflowDoc` 走同一条规则的反向，保证往返。
 *
 * ## 往返的已知边界
 *
 * - `position` 换成 Node-RED 的 `x`/`y`，四舍五入到整数（Node-RED 编辑器的画布单位）；
 *   往返后可能差 <1px —— 报告里 `lossy.details` 会点名（不静默）。
 * - Mcode 的边在 Node-RED 侧是"端口上的连接"，边自己的 `label` / `note` 存在 link 的
 *   `x-mcode-edge` 里；`branch` 的选项顺序 = 端口顺序（`outgoingEdgesOf` 的文档顺序）。
 */
import {
  edgeOptionNameOf,
  unknownWorkflowFieldPaths,
  workflowNodeRefName,
  type WorkflowDoc,
  type WorkflowEdge,
  type WorkflowNode,
} from "@contracts/workflow";
import {
  MAIN_NODE_TYPE_ID,
  type NodeTypeManifest,
  type NodeRunnerKind,
} from "@contracts/nodeType";
import { MODULE_CAPABILITY_RUNNER_KIND } from "@contracts/moduleCapability";

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
    type?: string;
    title?: string;
    params?: Record<string, unknown>;
    capability?: string;
    position?: { x: number; y: number };
    unknown?: Record<string, unknown>;
    unknownPosition?: Record<string, unknown>;
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
 */
export const FLOW_MIGRATOR_VERSION = 2;

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

/** 这个 runner 的输出端口数（`branch` = 出边数，调用方另算；`trigger` 无输入）。 */
function outputPortCountOf(kind: NodeRunnerKind | "unknown", outDegree: number): number {
  if (kind === "branch") return Math.max(1, outDegree);
  // condition → 原生 switch **固定两个输出口**（true / false）。2026-10-19 真引擎
  // 实测：只给 1 个口时，switch 的 else 分支（口 1）消息被直接丢弃 —— 下游静默不动。
  if (kind === "condition") return 2;
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
        ? "主代理（mcode.main）跑在「用户此刻正在看的那个对话」里；Node-RED 由事件触发时不存在这条对话。是每次运行绑定会话 id，还是禁止后台触发入口节点 —— 需人工裁决（MERGE-0 未知语义 #1）。"
        : "对话节点跑在主对话里；Node-RED 消息流没有「用户正在看的那个对话」概念。注入目标（self / origin）如何解析需人工裁决（MERGE-0 未知语义 #1）。",
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
          `trigger 迁移到内置 inject（${triggerKind === "schedule" ? "crontab 由 Mcode 5 段 cron 原样写入" : "once = 手动/立即运行一次"}）；`
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
          + "订阅源（HookEvent / 事件筛选）由 Host RPC 承担，需人工确认事件名与载荷映射。",
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

/** Node-RED 节点 id 规则：只允许 `[A-Za-z0-9_-]`，且不能与边 id 冲突。 */
function nodeRedIdOf(prefix: string, id: string, used: Set<string>): string {
  const base = `${prefix}_${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
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
  const types = options.types;
  const unknownPaths = unknownWorkflowFieldPaths(doc);
  const usedIds = new Set<string>();
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

  for (const [index, node] of doc.nodes.entries()) {
    const manifest = types?.get(node.type);
    const kind: NodeRunnerKind | "unknown" = manifest?.runner.kind ?? "unknown";
    kindOf.set(node.id, kind);
    const nodeRedId = nodeRedIdOf("n", node.id, usedIds);
    const outDegree = doc.edges.filter((e) => e.from === node.id).length;
    const nodeUnknown = unknownKeysForNode(unknownPaths, index);
    const outPorts = outputPortCountOf(kind, outDegree);

    const effectiveType = kind === "unknown" ? "mcode-unknown" : effectiveNodeRedTypeOf(kind, node.params);
    if (kind === "unknown") {
      unmapped.push({
        nodeId: node.id,
        type: node.type,
        reason: `类型「${node.type}」不在节点类型清单里 —— 执行语义未知，按 mcode-unknown 迁移（原始 type 留在 x-mcode.type，可逆）`,
      });
    }
    // 内置 inject / watch / exec 的**最小可执行参数**（节点统一：不再造 mcode-code）。
    const builtinConfig: Record<string, unknown> = {};
    if (kind === "trigger" && effectiveType === "inject") {
      const triggerKind = typeof node.params[TRIGGER_KIND_KEY] === "string" ? (node.params[TRIGGER_KIND_KEY] as string) : "manual";
      if (triggerKind === "schedule") {
        builtinConfig.crontab = typeof node.params[TRIGGER_CRON_KEY] === "string" ? node.params[TRIGGER_CRON_KEY] : "";
        builtinConfig.repeat = "";
        builtinConfig.once = false;
      } else {
        builtinConfig.once = true;
        builtinConfig.onceDelay = 0.1;
        builtinConfig.repeat = "";
      }
      builtinConfig.props = [{ p: "payload" }];
      builtinConfig.topic = "";
    }
    if (kind === "trigger" && effectiveType === "watch") {
      builtinConfig.files = typeof node.params[TRIGGER_PATHS_KEY] === "string" ? node.params[TRIGGER_PATHS_KEY] : "";
      builtinConfig.recursive = false;
    }
    if (kind === "code" && effectiveType === "exec") {
      const command = execCommandForCode(node.params);
      builtinConfig.command = command ?? "";
      // 非零退出在 Mcode 是 success（退出码进产物）；exec 默认当错误 —— MERGE-0 #4。
      builtinConfig.addpay = false;
      builtinConfig.append = "";
      builtinConfig.useSpawn = false;
      builtinConfig.timer = "";
      // 注意：exec 的 stdio 消息按口分（stdout→口0、stderr→口1、退出码→口2）。迁移器
      // 只给 code 节点 1 个输出口 —— stdout 正常到口 0；stderr/退出码落到不存在的口会
      // 被 Node-RED 丢弃（本片的最小语义，报告 lossy 点名；MERGE-3 接 Host 执行器时替换）。
    }

    const nrNode: NodeRedNode = {
      id: nodeRedId,
      type: effectiveType,
      name: node.title,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      wires: Array.from({ length: outPorts }, () => [] as string[]),
      ...builtinConfig,
      // condition → 原生 switch 的**最小可执行形状**（2026-10-19 真引擎实测：
      // 只写 type:"switch" 不给 rules/property 时，switch 没有任何规则、消息不会
      // 转发到任何一个口 —— 整条下游静默不动）。按 `msg.mcode.condition`（布尔）
      // 分两路：true → 口 0，否则（含 else 规则）→ 口 1。Mcode 的完整表达式求值
      // （{{上游.字段}} / logic and-or / 多种 op）属于 Host 侧，MERGE-3 接
      // `mcode-condition` 时替换本规则；此前它是"可启动的最小语义"，报告里点名。
      ...(kind === "condition"
        ? {
            rules: [
              { t: "true", v: "", vt: "bool" },
              { t: "else" },
            ],
            property: "mcode.condition",
            propertyType: "msg",
            checkall: "false",
            repair: false,
          }
        : {}),
      "x-mcode": {
        nodeId: node.id,
        type: node.type,
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
      lossy.push({
        code: "lossy",
        nodeId: node.id,
        message:
          "condition 迁为原生 switch，规则暂为「msg.mcode.condition 为 true → 口 0，否则口 1」；"
          + "Mcode 的完整表达式求值（{{上游.字段}} / and-or / op）由 Host 侧承担（MERGE-3 接 mcode-condition），"
          + "此前该节点只保证整组能启动、消息按布尔分流。",
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
    const linkId = nodeRedIdOf("l", edge.id, usedIds);
    const link: NodeRedLink = {
      id: linkId,
      source: sourceNr.id,
      sourcePort,
      target: targetNr.id,
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
    const key = `${sourceNr.id}#${sourcePort}`;
    const list = linkTargets.get(key) ?? [];
    list.push(targetNr.id);
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
  (tab as Record<string, unknown>)["x-mcode"] = docMeta;

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

/* ── 反向：Node-RED flow → WorkflowDoc（只保证本迁移器的往返） ── */

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
  // 文档级元数据优先取 flow 顶层；从真引擎读回的数组没有顶层元数据 —— 它挂在 tab 上
  // （见正向迁移里 `(tab as ...)["x-mcode"] = docMeta`）。
  const tabMeta = flow.nodes.find((n) => n.type === "tab")?.["x-mcode"] as NodeRedFlow["x-mcode"] | undefined;
  const meta = flow["x-mcode"] ?? tabMeta;
  const nrToMcodeNode = new Map<string, string>();
  const nodes: WorkflowNode[] = [];
  for (const nrNode of flow.nodes) {
    // tab 是迁移器生成的容器（文档级元数据挂在它身上），不是 Mcode 节点 —— 读回时跳过。
    // Mcode 的类型 id 形如 `作者.名字`，不可能叫 `tab`，所以这个跳过不吞用户节点。
    if (nrNode.type === "tab") continue;
    const x = nrNode["x-mcode"];
    const nodeId = x?.nodeId ?? nrNode.id;
    nrToMcodeNode.set(nrNode.id, nodeId);
    const position = x?.position ?? { x: nrNode.x ?? 0, y: nrNode.y ?? 0 };
    const node: WorkflowNode = {
      id: nodeId,
      type: x?.type ?? nrNode.type,
      title: x?.title ?? nrNode.name ?? "",
      params: x?.params ?? {},
      position: {
        x: position.x,
        y: position.y,
        ...(x?.unknownPosition ?? {}),
      } as WorkflowNode["position"],
      ...(x?.capability !== undefined ? { capability: x.capability as WorkflowNode["capability"] } : {}),
      ...(x?.unknown ?? {}),
    };
    nodes.push(node);
  }

  // 边：优先用 `links` sidecar（迁移器原样往返，含边级未知字段）；若 flow 来自真
  // Node-RED 的读回（没有 links），就从节点的 `wires` 重建 —— 真引擎的真相就是它。
  const edges: Array<WorkflowEdge & Record<string, unknown>> = [];
  if (flow.links !== undefined) {
    const links = [...flow.links].sort((a, b) => (a.source === b.source ? a.sourcePort - b.sourcePort : 0));
    for (const link of links) {
      const x = link["x-mcode-edge"];
      const edge: WorkflowEdge & Record<string, unknown> = {
        id: x?.edgeId ?? link.id,
        from: nrToMcodeNode.get(link.source) ?? link.source,
        to: nrToMcodeNode.get(link.target) ?? link.target,
        ...(x?.label !== undefined ? { label: x.label } : {}),
        ...(x?.note !== undefined ? { note: x.note } : {}),
        ...(x?.unknown ?? {}),
      };
      edges.push(edge);
    }
  } else {
    // 从 wires 重建：按节点文档顺序 + 端口顺序，node id 用 `e_<from>_<to>[_N]` 稳定生成。
    for (const nrNode of flow.nodes) {
      if (nrNode.wires === undefined) continue;
      const from = nrToMcodeNode.get(nrNode.id) ?? nrNode.id;
      let n = 0;
      nrNode.wires.forEach((targets, port) => {
        for (const targetNrId of targets) {
          const to = nrToMcodeNode.get(targetNrId) ?? targetNrId;
          n += 1;
          const edgeId = `e_${from}_${to}${n > 1 ? `_${n}` : ""}`;
          const label = nrNode.type === "switch" ? (port === 1 ? "false" : port === 0 ? "true" : undefined) : undefined;
          edges.push({ id: edgeId, from, to, ...(label !== undefined ? { label } : {}) } as WorkflowEdge);
        }
      });
    }
  }

  return {
    id: meta?.docId ?? flow.id,
    name: meta?.name ?? flow.label,
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
    ...(meta?.unknown ?? {}),
  } as WorkflowDoc;
}

/**
 * 往返对比：把 `doc → flow → doc` 的**已知字段**逐个比对，返回差异路径。
 * 空数组 = 已知字段完全一致（未知字段另由 `unknownWorkflowFieldPaths` 验）。
 */
export function roundTripMismatchPaths(doc: WorkflowDoc, roundTripped: WorkflowDoc): string[] {
  const paths: string[] = [];
  const compare = (path: string, a: unknown, b: unknown): void => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    // 位置允许 <1px 的整数化差异（迁移器显式在 report.lossy 里点名）。
    if (path.endsWith(".position") || path.endsWith("position")) {
      const pa = a as { x?: number; y?: number } | undefined;
      const pb = b as { x?: number; y?: number } | undefined;
      if (pa !== undefined && pb !== undefined && Math.abs((pa.x ?? 0) - (pb.x ?? 0)) < 1 && Math.abs((pa.y ?? 0) - (pb.y ?? 0)) < 1) return;
    }
    paths.push(path);
  };
  const knownDocKeys = [
    "id", "name", "description", "icon", "prompt", "frameworkNote", "trigger", "schemaVersion",
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
