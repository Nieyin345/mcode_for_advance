import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * **宿主侧副作用的来源链**(2026-09-28)。
 *
 * 模型那一路的事件由 `withAutomationOrigin` 逐个打标,可**宿主自己干的事**没人打标:
 * code 节点报上来的「把这些文件收进库」由主进程执行(见 `adoptFromCode.applyImports`),
 * 它发出的 `library.item.imported` 走的是 `broadcast.emitItemImported` —— 那条事件此前
 * **不带任何来源**,于是自动化 A 通过入库触发 A(或 A→B→A)在自触发额度眼里是**外部
 * 事件**,完全看不见。看不见的循环没有预算可花,只能一直转。
 *
 * 用 `AsyncLocalStorage` 而不是模块级变量:节点是并发跑的,一个全局变量会把 A 的来源
 * 记到 B 的事件上。存的是**不可变快照**(同 `snapshotAutomationOrigin` 的规矩)。
 */
const ambient = new AsyncLocalStorage<AutomationEventOrigin>();

/** 在这段异步作用域里发出的宿主事件都算作 `origin` 引出的。 */
export function runWithAutomationOrigin<T>(origin: AutomationEventOrigin | undefined, fn: () => T): T {
  const captured = snapshotAutomationOrigin(origin);
  return captured === undefined ? fn() : ambient.run(captured, fn);
}

/** 当前异步作用域的来源链(不在自动化里跑 = undefined)。 */
export function currentAutomationOrigin(): AutomationEventOrigin | undefined {
  return ambient.getStore();
}

/**
 * 给一条**马上要发出去的**事件打上当前作用域的来源。返回的是**新对象**:
 * 来源表按事件对象身份记(WeakMap),而调用方手里那份可能被复用。
 */
export function withAmbientAutomationOrigin<E extends RuntimeEvent>(event: E): E {
  const origin = ambient.getStore();
  if (origin === undefined) return event;
  const copy = { ...event } as E;
  origins.set(copy, origin);
  return copy;
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
