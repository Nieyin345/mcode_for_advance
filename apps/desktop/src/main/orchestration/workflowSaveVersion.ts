import { createHash } from "node:crypto";
import type { WorkflowDoc } from "@contracts/workflow";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort()
      .filter((key) => fields[key] !== undefined)
      .map((key) => [key, canonical(fields[key])]));
  }
  return value;
}

/** Full persisted document revision, INCLUDING canvas positions, unlike the
 *  execution-only review revision. Millisecond timestamps alone can collide. */
export function workflowSaveVersion(doc: WorkflowDoc): string {
  return createHash("sha256").update(JSON.stringify(canonical(doc))).digest("hex");
}

export function workflowSaveIsStale(current: WorkflowDoc | null, expected: string | null): boolean {
  return (current === null ? null : workflowSaveVersion(current)) !== expected;
}
