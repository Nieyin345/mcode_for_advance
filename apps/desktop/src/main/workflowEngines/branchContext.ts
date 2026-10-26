/**
 * Shared, non-authoritative context for a selected workflow branch.
 *
 * The child runtime uses this module to attach a note only to the selected
 * native target. The main-process adapter uses the same normalization and
 * formatting rules before adding that context to a model prompt. This metadata
 * is descriptive only: it never grants permissions or chooses a target session.
 */

export interface McodeBranchContext {
  sourceNodeId: string;
  targetNodeId: string;
  port: number;
  by: "user" | "agent";
  label?: string;
  note?: string;
}

export interface McodeBranchOption {
  /** 0-based output port. */
  port: number;
  /** Native target identity is only used to deliver the note to the exact target. */
  targetNodeId?: string;
  /** Saved Mcode target title used when the edge has no explicit label. */
  targetTitle?: string;
  label?: string;
  note?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Read branch context only on the exact native target chosen by the branch.
 * Node-RED messages can be modified by arbitrary native nodes; a context that
 * was forwarded to some other node is stale and must not influence its prompt.
 */
export function branchContextForNode(
  incomingMcode: Record<string, unknown>,
  nodeId: unknown,
): McodeBranchContext | undefined {
  if (typeof nodeId !== "string" || nodeId.trim() === "") return undefined;
  const branch = recordOf(incomingMcode["branch"]);
  if (!branch) return undefined;
  const sourceNodeId = boundedText(branch["sourceNodeId"], 256);
  const targetNodeId = boundedText(branch["targetNodeId"], 256);
  const port = branch["port"];
  const by = branch["by"];
  if (!sourceNodeId || targetNodeId !== nodeId || !Number.isSafeInteger(port)
      || (port as number) < 0 || (port as number) > 11
      || (by !== "user" && by !== "agent")) return undefined;
  const label = boundedText(branch["label"], 500);
  const note = boundedText(branch["note"], 2_000);
  return {
    sourceNodeId,
    targetNodeId,
    port: port as number,
    by,
    ...(label ? { label } : {}),
    ...(note ? { note } : {}),
  };
}

/** Normalize branch options at the child/Host IPC seam; malformed metadata is ignored. */
export function normalizeBranchOptions(raw: unknown, portCount: number): McodeBranchOption[] {
  if (!Number.isSafeInteger(portCount) || portCount < 1 || portCount > 12) return [];
  const byPort = new Map<number, McodeBranchOption>();
  if (Array.isArray(raw) && raw.length <= 12) {
    for (const item of raw) {
      const option = recordOf(item);
      if (!option) continue;
      const port = option["port"];
      if (!Number.isSafeInteger(port) || (port as number) < 0 || (port as number) >= portCount
          || byPort.has(port as number)) continue;
      const targetNodeId = boundedText(option["targetNodeId"], 256);
      const targetTitle = boundedText(option["targetTitle"], 500);
      const label = boundedText(option["label"], 500) ?? targetTitle;
      const note = boundedText(option["note"], 2_000);
      byPort.set(port as number, {
        port: port as number,
        ...(targetNodeId ? { targetNodeId } : {}),
        ...(targetTitle ? { targetTitle } : {}),
        ...(label ? { label } : {}),
        ...(note ? { note } : {}),
      });
    }
  }
  return Array.from({ length: portCount }, (_, port) => byPort.get(port) ?? { port });
}

/** Format the prior branch decision as ordinary prompt context, never as policy. */
export function formatBranchArrivalSection(raw: unknown): string {
  const candidate = recordOf(raw);
  if (!candidate) return "";
  const targetNodeId = candidate["targetNodeId"];
  const context = branchContextForNode({ branch: candidate }, targetNodeId);
  if (!context) return "";
  const label = context.label || `输出端口 ${context.port}`;
  const lines = [
    "## 本次执行的前置选择",
    context.by === "agent"
      ? `上一处分支由模型判定走的是「${label}」。`
      : `上一处分支中，用户选择的是「${label}」。`,
  ];
  if (context.note) lines.push(context.note);
  return lines.join("\n");
}
