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
    // A non-enumerable own toJSON is still invoked by JSON.stringify on the
    // document passed to persistence, yet would be silently omitted by
    // Object.keys. The revision would then identify DIFFERENT stored bytes.
    // Accessor properties are also unsafe: reading once in a filter and
    // again in a map may observe two values or execute arbitrary effects.
    const serializer = Object.getOwnPropertyDescriptor(value, "toJSON");
    // A plain data field named "toJSON" is valid persisted JSON. Only a
    // callable override (or a getter that could return one) changes native
    // JSON.stringify's meaning and must fail closed.
    if (serializer && (!("value" in serializer) || typeof serializer.value === "function")) {
      throw new Error("工作流版本包含自定义 JSON 序列化，拒绝计算保存修订");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("工作流版本包含不支持的符号键，拒绝计算保存修订");
    }
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("工作流版本包含空数组位置或访问器，拒绝计算保存修订");
        }
        return canonical(descriptor.value, ancestors);
      });
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("工作流版本包含不支持的对象类型，拒绝计算保存修订");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("工作流版本包含动态访问器，拒绝计算保存修订");
      }
      if (!descriptor.enumerable || descriptor.value === undefined) continue;
      entries.push([key, canonical(descriptor.value, ancestors)]);
    }
    // No Object.prototype.toJSON inheritance during the final stringify.
    return Object.assign(Object.create(null) as Record<string, unknown>,
      Object.fromEntries(entries));
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
