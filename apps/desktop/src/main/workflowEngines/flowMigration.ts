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
  links: NodeRedLink[];
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

/** 迁移器版本：映射规则一变就 +1（报告可追溯到规则）。 */
export const FLOW_MIGRATOR_VERSION = 1;

/* ── runner.kind → Node-RED 节点类型 ── */

/**
 * 每种执行原语在 Node-RED 侧的节点类型。`condition` 用官方 `switch`（MERGE-0：
 * 强度「官方」），其余是 Mcode 节点包（`mcode-*`，MERGE-2/3 才落地 —— 本切片只
 * 产出形状）。
 */
export const NODE_RED_TYPE_OF_RUNNER: Record<string, string> = {
  prompt: "mcode-agent",
  conversation: "mcode-conversation",
  branch: "mcode-branch",
  condition: "switch",
  trigger: "mcode-trigger",
  command: "exec",
  code: "function",
  [MODULE_CAPABILITY_RUNNER_KIND]: "mcode-module-capability",
  [NODE_RED_RUNNER_KIND]: "mcode-node-red-call",
};

/** 这个 runner 的输出端口数（`branch` = 出边数，调用方另算；`trigger` 无输入）。 */
function outputPortCountOf(kind: NodeRunnerKind | "unknown", outDegree: number): number {
  if (kind === "branch") return Math.max(1, outDegree);
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
        message: `code 节点语言为 ${language}；Node-RED function 只跑 JS，${language} 只能经 exec 子进程，沙箱面不同 —— 需人工裁决（MERGE-0 未知语义 #3）。`,
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

    const wireType = kind === "unknown" ? "mcode-unknown" : (NODE_RED_TYPE_OF_RUNNER[kind] ?? "mcode-unknown");
    if (kind === "unknown") {
      unmapped.push({
        nodeId: node.id,
        type: node.type,
        reason: `类型「${node.type}」不在节点类型清单里 —— 执行语义未知，按 mcode-unknown 迁移（原始 type 留在 x-mcode.type，可逆）`,
      });
    }
    // code 非 node 语言：Node-RED function 只跑 JS，落 mcode-code 保留语言。
    const effectiveType = kind === "code" && (node.params["language"] ?? "python") !== "node" ? "mcode-code" : wireType;

    const nrNode: NodeRedNode = {
      id: nodeRedId,
      type: effectiveType,
      name: node.title,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      wires: Array.from({ length: outPorts }, () => [] as string[]),
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
    needsHumanDecision.push(...humanDecisionIssuesOf(node, kind, node.params));

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

  // 端口分配后写 wires：每个出端口的目标 link-id 列表。
  for (const link of links) {
    const source = [...nodeRedOf.values()].find((n) => n.id === link.source);
    if (source?.wires !== undefined && source.wires[link.sourcePort] !== undefined) {
      source.wires[link.sourcePort].push(link.id);
    }
  }

  const flow: NodeRedFlow = {
    id: nodeRedIdOf("flow", doc.id, usedIds),
    label: doc.name,
    nodes: [...nodeRedOf.values()],
    links,
    "x-mcode": {
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
    },
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
  const meta = flow["x-mcode"];
  const nrToMcodeNode = new Map<string, string>();
  const nodes: WorkflowNode[] = [];
  for (const nrNode of flow.nodes) {
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

  // 边：按 link 的源端口排序还原。branch 的端口顺序 = 文档顺序，所以对每个 source
  // 按 sourcePort 排序即可；其它 kind 只有 0 号口。
  const edges: Array<WorkflowEdge & Record<string, unknown>> = [];
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
