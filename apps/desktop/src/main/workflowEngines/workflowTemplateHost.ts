/**
 * Host-side expansion of native Node-RED Mcode node parameters.
 *
 * The legacy graph scheduler resolves every string parameter through the
 * shared @contracts/nodeTemplate renderer before dispatch. Native nodes must
 * use that same renderer and the workflow document bound to the editor tab;
 * neither the mutable Node-RED message nor its sidecar can nominate a graph.
 */
import {
  buildForwardAdjacency,
  upstreamClosure,
  type WorkflowDoc,
  type WorkflowNode,
} from "@contracts/workflow";
import {
  hasNodeTemplateReferences,
  renderTemplate,
  type NodeTemplateNode,
  type NodeTemplateScope,
} from "@contracts/nodeTemplate";
import type { NodeOutcome, NodeTypeManifest } from "@contracts/nodeType";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { sanitizeConditionResults, type ConditionResultEntry } from "./conditionHost.js";

export interface WorkflowTemplateExpansionInput {
  doc: WorkflowDoc;
  nodeId: string;
  params: Record<string, unknown>;
  instruction?: unknown;
  results?: unknown;
  user?: unknown;
  trigger?: Readonly<Record<string, unknown>>;
}

export interface WorkflowTemplateExpansionResult {
  params: Record<string, unknown>;
  instruction?: string;
}

const asText = (value: unknown, limit = 32_000): string => {
  if (typeof value !== "string") return "";
  return value.slice(0, limit);
};

// These fields bind execution identity or Host grants; interpolating them
// would let ordinary prompt data alter which session/project/permission runs.
const TEMPLATE_EXCLUDED_PARAM_KEYS = new Set([
  "sessionId", "projectPath", "triggerTicket", "capability", "tabId", "nodeId", "runId",
]);

export function hasWorkflowTemplateReferences(
  params: Record<string, unknown>,
  instruction?: unknown,
): boolean {
  if (Object.values(params).some((value) =>
    typeof value === "string" && hasNodeTemplateReferences(value))) return true;
  return typeof instruction === "string" && hasNodeTemplateReferences(instruction);
}

function manifestMap(catalog: { entries: ReadonlyArray<{ id: string; manifest: NodeTypeManifest }> }): Map<string, NodeTypeManifest> {
  return new Map(catalog.entries.map((entry) => [entry.id, entry.manifest]));
}

function hostBackedNode(node: WorkflowNode, manifest: NodeTypeManifest | undefined): boolean {
  if (!manifest) return false;
  const kind = manifest.runner.kind;
  // These legacy kinds execute in Node-RED's native exec/function/inject/watch
  // nodes. Their completion state is not attested by the Mcode Host message.
  if (kind === "command" || kind === "code") return false;
  if (kind === "trigger") return node.params.kind === "event";
  // Prompt, conversation, branch, condition, and module actions are all
  // acknowledged by the Mcode Host adapter. Only native process/code nodes
  // lack a Host-attested result in the Node-RED message path.
  return true;
}

function resultOutcome(result: ConditionResultEntry): NodeOutcome {
  return {
    status: result.status === "failed" ? "failed" : result.status === "unselected" ? "unselected" : "success",
    summary: result.summary,
    outputs: result.outputs ?? { summary: result.summary },
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function scopeFor(input: WorkflowTemplateExpansionInput): Promise<{
  node: WorkflowNode;
  scope: NodeTemplateScope;
  manifests: Map<string, NodeTypeManifest>;
}> {
  const node = input.doc.nodes.find((candidate) => candidate.id === input.nodeId);
  if (!node) {
    throw new Error(`模板展开拒绝执行：宿主工作流「${input.doc.id}」中没有节点「${input.nodeId}」`);
  }

  const manifests = manifestMap(await loadNodeTypes());
  const deps = buildForwardAdjacency(input.doc.nodes, input.doc.edges).deps;
  const upstreamIds = upstreamClosure(deps, node.id);
  const upstream = new Set<string>();
  for (const candidate of input.doc.nodes) {
    if (!upstreamIds.has(candidate.id)) continue;
    upstream.add(candidate.id);
    const title = (candidate.title ?? "").trim();
    if (title) upstream.add(title);
  }

  const results = sanitizeConditionResults(input.results, input.doc);
  const resultOf = new Map(results.map((entry) => [entry.nodeId, entry]));
  const nodes: NodeTemplateNode[] = input.doc.nodes.map((candidate) => {
    const result = resultOf.get(candidate.id);
    const manifest = manifests.get(candidate.type);
    let outcome: NodeOutcome | undefined;
    if (result) {
      outcome = resultOutcome(result);
    } else if (hostBackedNode(candidate, manifest)) {
      // A Host-backed upstream node absent from this message path was not
      // selected. The shared renderer will report that its value is unavailable.
      outcome = { status: "unselected", summary: "" };
    }
    return {
      id: candidate.id,
      title: candidate.title ?? "",
      params: candidate.params,
      ...(outcome ? { outcome } : {}),
    };
  });

  return {
    node,
    manifests,
    scope: {
      user: asText(input.user),
      upstream,
      nodes,
      ...(input.trigger ? { trigger: input.trigger } : {}),
    },
  };
}

function rejectUnavailableNativeStatusRefs(
  text: string,
  where: string,
  doc: WorkflowDoc,
  scope: NodeTemplateScope,
  manifests: Map<string, NodeTypeManifest>,
): void {
  // Match the contract's escaped-opening-brace rule. Let renderTemplate handle
  // every other lexical/graph error so there remains one source of truth.
  const guarded = text.split("\\{{").join("\u0000mcode-lbrace\u0000");
  const refs = /\{\{([^{}]*)\}\}/g;
  for (const match of guarded.matchAll(refs)) {
    const spec = (match[1] ?? "").trim();
    const dot = spec.indexOf(".");
    if (dot < 0) continue;
    const name = spec.slice(0, dot).trim();
    const field = spec.slice(dot + 1).trim();
    if (field !== "status" && field !== "error") continue;
    const matches = doc.nodes.filter((candidate) =>
      candidate.id === name || (candidate.title ?? "").trim() === name);
    if (matches.length !== 1) continue;
    const target = matches[0]!;
    if (!scope.upstream.has(name)) continue;
    if (!hostBackedNode(target, manifests.get(target.type))) {
      throw new Error(
        `${where}:引用「{{${spec}}}」无法读取：目标是由 Node-RED 原生节点执行的步骤，其状态/错误没有通过 Mcode Host 回传`,
      );
    }
  }
}

/**
 * Expand only saved node parameters (plus the normalized instruction mirror).
 * Runtime identity fields such as sessionId are intentionally not templated:
 * a workflow expression must never select a different chat session.
 */
export async function expandWorkflowNodeTemplates(
  input: WorkflowTemplateExpansionInput,
): Promise<WorkflowTemplateExpansionResult> {
  const rawInstruction = typeof input.instruction === "string" ? input.instruction : undefined;
  const forbidden = Object.entries(input.params).find(([key, value]) =>
    TEMPLATE_EXCLUDED_PARAM_KEYS.has(key) && typeof value === "string" && hasNodeTemplateReferences(value));
  if (forbidden) {
    throw new Error(`模板展开拒绝执行：身份/授权参数「${forbidden[0]}」不支持模板引用`);
  }
  const strings = Object.entries(input.params).filter(([key, value]) =>
    !TEMPLATE_EXCLUDED_PARAM_KEYS.has(key) && typeof value === "string");
  const hasRefs = hasWorkflowTemplateReferences(input.params, rawInstruction);

  let scope: NodeTemplateScope = {
    user: asText(input.user),
    upstream: new Set<string>(),
    nodes: [],
    ...(input.trigger ? { trigger: input.trigger } : {}),
  };
  let manifests = new Map<string, NodeTypeManifest>();
  if (hasRefs) {
    const resolved = await scopeFor(input);
    scope = resolved.scope;
    manifests = resolved.manifests;
  }

  const params: Record<string, unknown> = { ...input.params };
  for (const [key, value] of strings) {
    const spec = manifests.size > 0
      ? manifests.get(scopeForNodeType(input.doc, input.nodeId)?.type ?? "")?.params.find((param) => param.key === key)
      : undefined;
    const where = spec ? `参数「${spec.label}」` : `参数 ${key}`;
    if (hasRefs) rejectUnavailableNativeStatusRefs(value as string, where, input.doc, scope, manifests);
    const result = renderTemplate(value as string, scope, where);
    if (!result.ok) throw new Error(result.error);
    params[key] = result.text;
  }

  let instruction = rawInstruction;
  if (rawInstruction !== undefined) {
    const rawParamInstruction = input.params["instruction"];
    if (typeof rawParamInstruction === "string" && rawInstruction === rawParamInstruction) {
      instruction = typeof params["instruction"] === "string" ? params["instruction"] as string : rawInstruction;
    } else {
      if (hasRefs) rejectUnavailableNativeStatusRefs(rawInstruction, "指令", input.doc, scope, manifests);
      const result = renderTemplate(rawInstruction, scope, "指令");
      if (!result.ok) throw new Error(result.error);
      instruction = result.text;
    }
  }

  return { params, ...(instruction !== undefined ? { instruction } : {}) };
}

function scopeForNodeType(doc: WorkflowDoc, nodeId: string): WorkflowNode | undefined {
  return doc.nodes.find((node) => node.id === nodeId);
}
