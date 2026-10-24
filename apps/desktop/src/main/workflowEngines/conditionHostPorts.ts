/**
 * **生产侧的 `condition.evaluate` 服务** —— 把 `NodePackHost` 的 `condition.evaluate`
 * 动作接到旧的条件求值器上（`conditionHost.ts` → `@contracts/condition`）。
 *
 * ## 它在哪个装配点被接上
 *
 * 单独的 port 文件而不是塞进 `nodePackProductionPorts.ts`：那个文件被另一张卡
 * （W21 的 capability 闸门）同时在改，把两个改动压在同一个函数里只会让谁的回归
 * 都说不清。本文件导出 {@link withConditionEvaluation}，由 `registry.ts` 在
 * `new NodePackHost(...)` 处**包一层**：`condition.evaluate` 走这里，其它动作原样
 * 交给原来的服务。
 *
 * ## 它为什么必须按「宿主库里的那张文档」求值
 *
 * 引擎子进程交过来的是 `x-mcode.params.expression` 与 `msg.mcode.results`，两者都
 * **不可信**（任意 Node-RED 节点都能伪造）。真正的 scope（上游闭包、标题、参数）只能
 * 来自 Host 自己库里的 `WorkflowDoc`；而「这个 tab 属于哪张文档」必须经
 * `resolveWorkflow`（执行器归属核对）—— 引擎不能自报 docId。
 */
import { randomUUID } from "node:crypto";
import { HOOK_EVENTS } from "@contracts/hook";
import type { WorkflowDoc } from "@contracts/workflow";
import { evaluateConditionForHost, type ConditionResultEntry } from "./conditionHost.js";
import type { NodePackAction, NodePackHostServices } from "./nodePackHost.js";

export interface ConditionEvaluationDeps {
  /** 宿主库里的文档（生产 = `getWorkflow`）。 */
  getDoc: (docId: string) => WorkflowDoc | null;
  /** native tab → Mcode docId；**只有归属经核对的 tab 才返回**，否则 null。 */
  resolveWorkflow?: (tabId: string) => string | null;
  resolveTriggerTicket?: (ticket: string, docId: string) => Readonly<Record<string, unknown>> | null;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * 执行一次 `condition.evaluate`。失败**抛错**（`NodePackHost` 会把错误变成
 * `mcode-node-reply ok:false`，适配节点把它变成 `node.error` 且不发消息）——
 * 与旧调度器「条件求值失败 → 这一步失败、下游不跑」一致。
 */
export function evaluateConditionPayload(
  payload: Record<string, unknown>,
  deps: ConditionEvaluationDeps,
): { matched: boolean } {
  const tabId = asString(payload["tabId"]);
  const docId = tabId === "" ? null : deps.resolveWorkflow?.(tabId) ?? null;
  if (docId === null) {
    throw new Error("条件求值拒绝执行：无法确认这个节点属于哪张 Mcode 工作流（tab 未登记或归属不是 Node-RED）");
  }
  const doc = deps.getDoc(docId);
  if (doc === null) throw new Error(`条件求值拒绝执行：宿主工作流库里没有「${docId}」`);
  const nodeId = asString(payload["nodeId"]);
  const results: unknown = payload["results"];
  const ticket = asString(payload["triggerTicket"]);
  const trigger = ticket ? deps.resolveTriggerTicket?.(ticket, docId) ?? null : null;
  const outcome = evaluateConditionForHost({
    ...(trigger === null ? {} : { trigger }),
    expression: payload["expression"],
    doc,
    nodeId,
    results: Array.isArray(results) ? results as ConditionResultEntry[] : [],
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return { matched: outcome.matched };
}

/**
 * 给既有服务包一层：`condition.evaluate` 走本文件，其余动作**原样**交给 `base`。
 * 不复制 `base` 的任何判据，也不改变它的返回形状。
 */
export function withConditionEvaluation(
  base: NodePackHostServices,
  deps: ConditionEvaluationDeps,
): NodePackHostServices {
  // A bounded, process-local lookup table. Trigger facts are issued by the
  // production Host event subscription, never accepted from mutable Node-RED msg.
  const tickets = new Map<string, {
    docId: string;
    subscription: symbol;
    at: number;
    facts: Readonly<Record<string, unknown>>;
  }>();
  const maxAgeMs = 5 * 60_000;
  const maxTickets = 256;
  const prune = (): void => {
    const threshold = Date.now() - maxAgeMs;
    for (const [id, entry] of tickets) if (entry.at < threshold) tickets.delete(id);
    while (tickets.size > maxTickets) tickets.delete(tickets.keys().next().value!);
  };
  const allowed = new Set<string>(HOOK_EVENTS);
  const resolveTriggerTicket = (id: string, docId: string): Readonly<Record<string, unknown>> | null => {
    prune();
    const entry = tickets.get(id);
    return entry?.docId === docId ? entry.facts : null;
  };

  return {
    execute(operation: NodePackAction, payload: Record<string, unknown>): Promise<unknown> {
      if (operation === "condition.evaluate") {
        return Promise.resolve().then(() => evaluateConditionPayload(payload, {
          ...deps, resolveTriggerTicket,
        }));
      }
      return base.execute(operation, payload);
    },
    subscribe(payload, emit) {
      const tabId = asString(payload["tabId"]);
      const docId = tabId ? deps.resolveWorkflow?.(tabId) ?? null : null;
      const subscription = Symbol("mcode-trigger");
      const dispose = base.subscribe(payload, (event) => {
        const raw = event["payload"];
        const content = raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown> : {};
        const eventName = content["event"];
        // No confirmed tab or recognized event means no Host-backed facts.
        if (docId === null || typeof eventName !== "string" || !allowed.has(eventName)) {
          emit(event);
          return;
        }
        prune();
        const facts: Record<string, unknown> = { kind: "event", event: eventName };
        // Item facts belong to the two library events only. A tool/turn
        // message with an unexpected itemId must not be promoted into the
        // authoritative trigger namespace.
        if (eventName === "library.item.imported" || eventName === "library.item.downloaded") {
          for (const key of ["itemId", "itemTitle", "pdfPath", "filePath"]) {
            const value = content[key];
            if (typeof value === "string" && value.length > 0 && value.length <= 16_384) facts[key] = value;
          }
        }
        const ticket = randomUUID();
        tickets.set(ticket, { docId, subscription, at: Date.now(), facts });
        prune();
        const rawMeta = event["mcode"];
        const meta = rawMeta !== null && typeof rawMeta === "object" && !Array.isArray(rawMeta)
          ? rawMeta as Record<string, unknown> : {};
        emit({ ...event, mcode: { ...meta, triggerTicket: ticket } });
      });
      return () => {
        dispose();
        for (const [id, entry] of tickets) if (entry.subscription === subscription) tickets.delete(id);
      };
    },
  };
}
