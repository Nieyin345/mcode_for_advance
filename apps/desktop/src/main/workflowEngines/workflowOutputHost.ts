/**
 * Host-side output contracts for native Node-RED Mcode nodes.
 *
 * The persisted Mcode workflow is the source of truth for declared outputs.
 * Node-RED sidecar fields and model text are untrusted inputs; this adapter
 * reuses the same output-variable contract as the legacy scheduler.
 */
import {
  checkOutput,
  describeOutputVars,
  outputVarsOf,
  pickOutputs,
  type OutputVar,
} from "@contracts/outputConstraint";
import type { WorkflowDoc } from "@contracts/workflow";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";

export interface PreparedWorkflowOutput {
  instruction?: string;
  vars: OutputVar[];
}

export async function workflowOutputVarsFor(doc: WorkflowDoc, nodeId: string): Promise<OutputVar[]> {
  // Match the legacy scheduler: output contracts are only useful when a
  // downstream node can reference them. Terminal nodes are not prompted for
  // JSON and are not failed for omitting variables nobody can consume.
  if (!doc.edges.some((edge) => edge.from === nodeId)) return [];
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const manifest = (await loadNodeTypes()).entries.find((candidate) => candidate.id === node.type)?.manifest;
  if (!manifest) return [];
  return outputVarsOf(manifest, node.params);
}

/** Append the shared structured-output instructions without changing saved parameters. */
export async function prepareWorkflowOutput(
  doc: WorkflowDoc,
  nodeId: string,
  instruction: unknown,
): Promise<PreparedWorkflowOutput> {
  const vars = await workflowOutputVarsFor(doc, nodeId);
  const rawInstruction = typeof instruction === "string" ? instruction : undefined;
  const contract = describeOutputVars(vars);
  if (!contract) return { ...(rawInstruction !== undefined ? { instruction: rawInstruction } : {}), vars };
  return {
    instruction: [rawInstruction, contract].filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join("\n\n"),
    vars,
  };
}

/**
 * Validate the Host result against the same hard contract used by Mcode's
 * scheduler, and attach only declared values for downstream {{node.field}}
 * references. A malformed or incomplete output is a failed step, not a soft
 * warning or a best-effort parse.
 */
export function applyWorkflowOutput(
  result: unknown,
  vars: readonly OutputVar[],
): unknown {
  if (vars.length === 0) return result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Mcode Host output contract failed: expected a result object");
  }
  const record = result as Record<string, unknown>;
  if (typeof record["text"] !== "string") {
    throw new Error("Mcode Host output contract failed: result text missing");
  }
  const rawOutputs = record["outputs"];
  const existingOutputs = rawOutputs !== null && typeof rawOutputs === "object" && !Array.isArray(rawOutputs)
    ? rawOutputs as Record<string, unknown> : undefined;
  // Some executors (notably the Node-RED HTTP executor) produce authoritative
  // structured values separately from their display summary. Match the legacy
  // checkOutputFrom contract before attempting to parse the text representation.
  if (existingOutputs && vars.every((variable) =>
    Object.prototype.hasOwnProperty.call(existingOutputs, variable.name))) return result;
  const checked = checkOutput(record["text"], vars);
  if (!checked.ok || checked.value === undefined) {
    throw new Error(checked.ok ? "Mcode output contract returned no structured value" : checked.error);
  }
  return {
    ...record,
    outputs: { ...(existingOutputs ?? {}), ...pickOutputs(checked.value, vars) },
  };
}
