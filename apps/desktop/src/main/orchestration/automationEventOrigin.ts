import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import { SettingRepo } from "@main/store/repositories.js";

export const EVENT_CHAIN_PREFIX = "automation.eventChain.";
export const EVENT_CHAIN_LIMIT = 64;
export interface AutomationEventOrigin { readonly workflowIds: readonly string[]; }

/** Host-only metadata, not a field the renderer/model can forge or receive. */
const origins = new WeakMap<RuntimeEvent, AutomationEventOrigin>();

export function snapshotAutomationOrigin(origin: AutomationEventOrigin | undefined): AutomationEventOrigin | undefined {
  if (origin === undefined) return undefined;
  const ids = origin.workflowIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > EVENT_CHAIN_LIMIT ||
      !ids.every((id: unknown) => typeof id === "string" && id.length > 0) || new Set(ids).size !== ids.length) {
    throw new Error("自动化事件来源链损坏，拒绝启动注入轮次");
  }
  return Object.freeze({ workflowIds: Object.freeze([...ids]) });
}

export function automationOriginOf(event: RuntimeEvent): AutomationEventOrigin | undefined {
  return origins.get(event);
}

/** Preserve trusted metadata through host timestamping/interactive retargeting. */
export function inheritAutomationOrigin(from: RuntimeEvent, to: RuntimeEvent): void {
  const origin = origins.get(from);
  if (origin !== undefined) origins.set(to, origin);
}

/** One immutable snapshot per provider turn, never a mutable session-level tag.
 * Late events keep their own turn's origin even after a user starts another turn.
 * Always clone: SDKs may reuse an event object across calls/contexts. */
export function withAutomationOrigin(
  emit: (event: RuntimeEvent) => void,
  origin: AutomationEventOrigin | undefined,
): (event: RuntimeEvent) => void {
  const captured = snapshotAutomationOrigin(origin);
  return (event) => {
    const copy = { ...event } as RuntimeEvent;
    if (captured !== undefined) origins.set(copy, captured);
    emit(copy);
  };
}

/** Compatibility fallback for automation-owned sessions without a per-event tag. */
export function readAutomationEventChain(source: Pick<Session, "id" | "workflowId">): string[] {
  const raw = SettingRepo.get(EVENT_CHAIN_PREFIX + source.id);
  if (raw === null) return [source.workflowId];
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("自动化事件来源链损坏；请手动运行来源工作流重建");
  }
  const record = value as { version?: unknown; workflowIds?: unknown };
  const ids = record.workflowIds;
  if (record.version !== 1 || !Array.isArray(ids) || ids.length === 0 || ids.length > EVENT_CHAIN_LIMIT ||
      !ids.every((id: unknown) => typeof id === "string" && id.length > 0) ||
      !ids.includes(source.workflowId) || new Set(ids).size !== ids.length) {
    throw new Error("自动化事件来源链损坏；请手动运行来源工作流重建");
  }
  return [...ids] as string[];
}
