import { createHash } from "node:crypto";
import type { WorkflowDoc } from "@contracts/workflow";

/**
 * Hash what could ACTUALLY be written as JSON, rather than silently treating
 * NaN as null, a Date as {}, or a function as a missing field. Such collisions
 * would defeat stale-revision checks and can overwrite a newer workflow.
 * Ignore undefined object fields for compatibility with ordinary JSON saves.
 */
function canonical(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("工作流版本包含无效数字，拒绝计算保存修订");
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("工作流版本包含不支持的 JSON 值，拒绝计算保存修订");
  }
  if (ancestors.has(value)) throw new Error("工作流版本包含循环引用，拒绝计算保存修订");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, i) => {
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
          throw new Error("工作流版本包含空数组位置，拒绝计算保存修订");
        }
        return canonical(value[i], ancestors);
      });
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("工作流版本包含不支持的对象类型，拒绝计算保存修订");
    }
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort()
      .filter((key) => fields[key] !== undefined)
      .map((key) => [key, canonical(fields[key], ancestors)]));
  } finally {
    ancestors.delete(value);
  }
}

/** Full persisted document revision, INCLUDING canvas positions, unlike the
 *  execution-only review revision. Millisecond timestamps alone can collide. */
export function workflowSaveVersion(doc: WorkflowDoc): string {
  return createHash("sha256").update(JSON.stringify(canonical(doc))).digest("hex");
}

export function workflowSaveIsStale(current: WorkflowDoc | null, expected: string | null): boolean {
  return (current === null ? null : workflowSaveVersion(current)) !== expected;
}
