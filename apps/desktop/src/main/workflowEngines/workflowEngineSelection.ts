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

export function assertWorkflowExecutor(doc: Pick<WorkflowDoc, "id" | "engine" | "nodes">, executor: WorkflowEngine): void {
  if (doc.nodes.length === 0) return; // prompt-only flows have no graph scheduler
  const owner = effectiveWorkflowEngine(doc);
  if (owner !== executor) throw new Error(
    `工作流「${doc.id}」指定由 ${owner} 执行，拒绝由 ${executor} 重复执行。请先完成引擎迁移。`,
  );
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
        reason: `切换到 ${target} 会丢失/改变以下内容：${paths.join("；")}`,
        ...(humanOnly ? { requiresConfirmation: true } : {}),
      };
}
