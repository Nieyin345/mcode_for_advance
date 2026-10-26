/** T46: one graph, one execution engine. Pure preflight reused by save and runtime gates. */
import type { NodeTypeManifest } from "@contracts/nodeType";
import type { WorkflowDoc, WorkflowEngine } from "@contracts/workflow";
import {
  migrateWorkflowDoc, flowToWorkflowDoc, roundTripMismatchPaths,
  type NodeRedFlow,
} from "./flowMigration.js";

export function effectiveWorkflowEngine(doc: Pick<WorkflowDoc, "engine">): WorkflowEngine {
  // Historical stored docs have no engine marker and must stay on the legacy runner.
  return doc.engine ?? "mcode";
}

/**
 * 【Q5 / 批次 3】执行归属判定。
 *
 * ## 两个调用方，两种含义，不能合成一个
 *
 * | 调用方 | `executor` | 语义 |
 * |---|---|---|
 * | 用户图 / 自动化 | `"mcode"` | **拒绝**：旧执行器已退场，用户图统一走 Node-RED |
 * | 内部编排（记忆助手、钩子动作、手机端） | `"mcode"` | **放行**：这些不是用户工作流，是产品功能 |
 *
 * ## ⚠️ 为什么内部编排必须放行（2026-10-27 实测回归）
 *
 * 我第一版把它写成"任何归 mcode 的图都不许进执行"，结果**记忆助手、钩子动作、手机端
 * 三条功能当场全坏** —— 它们至今仍走 `startWorkflowRun`（旧调度器）：
 *
 * - `memory/assistant.ts:79`：记忆整理跑的是 `memory-capture` / `memory-checkpoint` /
 *   `memory-health` 三张内置图（`memoryWorkflows.ts`，**没有 engine 字段** →
 *   `effectiveWorkflowEngine` 得 `mcode`）；
 * - `hooks/agentActions.ts:70`：钩子的 `workflow` 动作；
 * - `mobile/mobileRpc.ts:97`。
 *
 * 这几条本来就在"待迁移到原生"的清单上（见功能文档 WF-07 末条）。在它们迁完之前
 * 就停旧执行器，等于先拆桥再过河。**"退场"的对象是用户图，不是产品功能。**
 *
 * 判据用 `executor` 参数区分：内部编排永远传 `"mcode"`，而用户图的入口传的也是
 * `"mcode"` —— 两者从签名上看不出来。所以真正的区分在**调用点**：用户图那条路
 * （`scheduler.ts` / `automationRunner` / MCP 工具）必须先过 `isRetiredLegacyGraph`。
 */
export function assertWorkflowExecutor(doc: Pick<WorkflowDoc, "id" | "engine" | "nodes">, executor: WorkflowEngine): void {
  if (doc.nodes.length === 0) return; // prompt-only flows have no graph scheduler
  const owner = effectiveWorkflowEngine(doc);
  if (owner === executor) return;
  throw new Error(
    `工作流「${doc.id}」指定由 ${owner} 执行，拒绝由 ${executor} 重复执行。请先完成引擎迁移。`,
  );
}

/**
 * 这张图是不是**该被旧执行器拒绝**的用户图。
 *
 * 与 {@link assertWorkflowExecutor} 分开正是因为上一条注释里的理由：旧的归属判定
 * 表达不了"内部编排仍可跑"这件事。判据只有一条 —— 归 mcode 且有节点。**调用方必须
 * 是用户图的入口**（调度器、自动化、MCP 工具），内部编排不要调它。
 */
export function isRetiredLegacyGraph(doc: Pick<WorkflowDoc, "engine" | "nodes">): boolean {
  return doc.nodes.length > 0 && effectiveWorkflowEngine(doc) === "mcode";
}

/**
 * 这张图是**Mcode 自己的内部编排**（不是用户工作流）。
 *
 * 目前只有记忆助手那三条内置模板（`memoryWorkflows.ts` 的 `memory-capture` /
 * `memory-checkpoint` / `memory-health`）。它们的 id 是写死的常量，用户改不了 ——
 * 所以按 id 判是可靠的。
 *
 * 钩子的 `workflow` 动作不在这里：它跑的是**用户自己选的图**，所以该跟着退场。
 * 用户若给钩子挂了一张还归旧执行器的图，会得到与手动运行同一句迁移提示 ——
 * 那是一致的行为，不是缺陷。
 *
 * **这张表要跟着 `MEMORY_WORKFLOWS` 走**：将来加第四条记忆模板而忘了加进这里，
 * 症状是那条记醒来报"请迁移到 Node-RED"，而它根本不是用户的工作流。
 */
const INTERNAL_ORCHESTRATION_GRAPH_IDS: ReadonlySet<string> = new Set([
  "memory-capture",
  "memory-checkpoint",
  "memory-health",
]);

export function isInternalOrchestrationGraph(workflowId: string): boolean {
  return INTERNAL_ORCHESTRATION_GRAPH_IDS.has(workflowId);
}

/**
 * 用户图仍挂在旧执行器上时的那句话 —— **所有入口共用同一句**。
 *
 * 手动运行、钩子动作、自动化手动跑、自定义 UI 右键运行，四处都会撞上这条拒绝；
 * 各写一份必然漂移成四种说法，而用户看到的是同一件事。仓库硬规矩 2。
 */
export function retiredGraphError(workflowName: string): string {
  return `工作流「${workflowName}」还挂在旧执行器上。Mcode 的用户工作流已统一到 Node-RED，`
    + "请在设置 → 工作流里把它迁移过去（迁移会保留全部节点与参数）。";
}

/** Node-RED Admin and startup receive native tabs, not an authoritative engine flag.
 * Resolve each migrated docId through the Host library; a forged x-mcode.engine
 * in a network payload can NEVER grant the right to execute. */
export function assertNativeEngineSelection(
  nodes: unknown,
  lookup: (docId: string) => WorkflowDoc | null,
): void {
  if (!Array.isArray(nodes)) throw new Error("Node-RED 流必须是节点数组");
  for (const item of nodes) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const tab = item as Record<string, unknown>;
    if (tab.type !== "tab") continue;
    if (!Object.prototype.hasOwnProperty.call(tab, "x-mcode")) continue;
    const meta = tab["x-mcode"];
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Node-RED tab 的 x-mcode 元数据损坏");
    const docId = (meta as Record<string, unknown>)["docId"];
    if (typeof docId !== "string" || docId.length === 0) throw new Error("Node-RED tab 缺少可信的 docId");
    const hostDoc = lookup(docId);
    if (hostDoc === null) throw new Error(`Node-RED 工作流「${docId}」不在宿主工作流库中，拒绝部署或执行`);
    assertWorkflowExecutor(hostDoc, "node-red");
  }
}

/** Rebuild the exact live tab from Node-RED's actual flows.json rather than a
 * stale Mcode DB snapshot. Missing, duplicated, or foreign members fail closed. */
export function nativeFlowForWorkflow(nodes: unknown, docId: string): NodeRedFlow {
  if (!Array.isArray(nodes)) throw new Error("Node-RED flows.json 不是节点数组");
  const tabs = nodes.filter((n): n is Record<string, unknown> =>
    n !== null && typeof n === "object" && !Array.isArray(n) && n.type === "tab");
  const target = tabs.filter((t) => {
    const meta = t["x-mcode"];
    return meta !== null && typeof meta === "object" && !Array.isArray(meta)
      && (meta as Record<string, unknown>)["docId"] === docId;
  });
  if (target.length !== 1 || typeof target[0]?.["id"] !== "string") {
    throw new Error(`Node-RED 中找不到唯一的工作流「${docId}」tab，拒绝猜测转换`);
  }
  const tab = target[0]!;
  const members = nodes.filter((n): n is Record<string, unknown> =>
    n !== null && typeof n === "object" && !Array.isArray(n)
      && n.type !== "tab" && n.z === tab.id);
  for (const node of members) {
    if (typeof node.id !== "string" || typeof node.type !== "string")
      throw new Error("Node-RED tab 节点身份损坏，拒绝切换引擎");
  }
  // Global config nodes are not scoped to the tab: importing only this tab
  // could silently break references. Require explicit migration support.
  if (nodes.some((n) => n !== null && typeof n === "object" && !Array.isArray(n)
    && (n as Record<string, unknown>)["type"] !== "tab"
    && (!(n as Record<string, unknown>)["z"] || (n as Record<string, unknown>)["z"] === ""))) {
    throw new Error("Node-RED 包含全局配置节点，无法确定它们属于哪张图；拒绝无损声明");
  }
  return { id: tab.id as string, label: typeof tab["label"] === "string" ? tab["label"] : "",
    nodes: [tab, ...members] as NodeRedFlow["nodes"] };
}

export type EngineSwitchCheck =
  | { ok: true }
  | { ok: false; paths: string[]; reason: string; requiresConfirmation?: boolean };

/** No implicit switch: lossless serialisation alone is insufficient when an
 * unsupported native node changes semantics. Expose exact loss paths/causes. */
export function checkEngineSwitch(
  source: WorkflowDoc,
  target: WorkflowEngine,
  types: ReadonlyMap<string, NodeTypeManifest>,
  nativeFlow?: NodeRedFlow,
  confirmHumanDecisions = false,
): EngineSwitchCheck {
  if (effectiveWorkflowEngine(source) === target) return { ok: true };
  if (source.nodes.length === 0) return { ok: true };

  if (target === "mcode" && nativeFlow === undefined) return {
    ok: false,
    paths: ["flows.json"],
    reason: "Node-RED → Mcode 需要先读取编辑器当前真实 flow；未取得该版本，不允许用旧库文档冒充已迁移",
  };
  const candidate = { ...source, engine: target };
  const generated = target === "node-red"
    ? migrateWorkflowDoc(candidate, { types: new Map(types) })
    : null;
  const nativeDoc = target === "mcode" ? flowToWorkflowDoc(nativeFlow!) : null;
  const reversed = target === "node-red" ? flowToWorkflowDoc(generated!.flow)
    : { ...nativeDoc!, engine: "mcode" as const };
  const mismatches = roundTripMismatchPaths(candidate, reversed);
  // Reverse migration must also verify native node semantics against the Mcode
  // manifest: round-trip of preserved sidecars alone cannot prove executability.
  const checked = generated ?? migrateWorkflowDoc(nativeDoc!, { types: new Map(types) });
  const unmappedPaths = checked.report.unmapped.map((i) => `nodes[${i.nodeId}]: ${i.reason}`);
  const humanDecisionPaths = checked.report.needsHumanDecision.map((i) =>
    `nodes[${i.nodeId ?? "?"}]: ${i.message}`);
  const lossyPaths = checked.report.lossy.filter((i) => !/位置|坐标/.test(i.message)).map((i) =>
    `nodes[${i.nodeId ?? "?"}]: ${i.message}`);
  const hardPaths = [...mismatches, ...unmappedPaths, ...lossyPaths];
  const paths = [...hardPaths, ...humanDecisionPaths];
  // Human decisions may be acknowledged only on the explicit legacy -> Node-RED
  // migration path. Unknown node mappings, changed round-trips, and lossy
  // conversions remain non-overridable even when the caller confirms.
  const humanOnly = target === "node-red"
    && hardPaths.length === 0 && humanDecisionPaths.length > 0;
  if (humanOnly && confirmHumanDecisions) return { ok: true };
  return paths.length === 0
    ? { ok: true }
    : {
        ok: false,
        paths,
        reason: humanOnly
          ? `迁移需要人工确认以下语义差异：${paths.join("；")}`
          : `切换到 ${target} 会丢失/改变以下内容：${paths.join("；")}`,
        ...(humanOnly ? { requiresConfirmation: true } : {}),
      };
}
