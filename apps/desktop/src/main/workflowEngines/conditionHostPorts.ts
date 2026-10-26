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
import { resolve as resolvePath } from "node:path";
import { HOOK_EVENTS } from "@contracts/hook";
import { NODE_OUTPUT_VARS_KEY } from "@contracts/outputConstraint";
import { MAIN_NODE_TYPE_ID } from "@contracts/nodeType";
import { buildForwardAdjacency, upstreamClosure, type WorkflowDoc } from "@contracts/workflow";
import { loadNodeTypes } from "@main/orchestration/nodeTypes.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { evaluateConditionForHost, type ConditionResultEntry } from "./conditionHost.js";
import { expandWorkflowNodeTemplates, hasWorkflowTemplateReferences } from "./workflowTemplateHost.js";
import { applyWorkflowOutput, prepareWorkflowOutput, workflowOutputVarsFor } from "./workflowOutputHost.js";
import type { NodePackAction, NodePackHostServices } from "./nodePackHost.js";

export interface ConditionEvaluationDeps {
  /** 宿主库里的文档（生产 = `getWorkflow`）。 */
  getDoc: (docId: string) => WorkflowDoc | null;
  /** native tab → Mcode docId；**只有归属经核对的 tab 才返回**，否则 null。 */
  resolveWorkflow?: (tabId: string) => string | null;
  resolveTriggerTicket?: (ticket: string, docId: string) => TriggerContext | null;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Native Node-RED has no ambient Mcode execution cwd. Bind module file access
 * to a visible session configured on an upstream Mcode prompt/conversation
 * node; never take a workspace root from msg, params, or x-mcode metadata.
 */
async function workflowProjectPathForNode(doc: WorkflowDoc, nodeId: string): Promise<string> {
  if (!doc.nodes.some((node) => node.id === nodeId)) {
    throw new Error(`模块能力调用拒绝执行：宿主工作流「${doc.id}」中没有节点「${nodeId}」`);
  }
  const manifests = new Map((await loadNodeTypes()).entries.map((entry) => [entry.id, entry.manifest]));
  const deps = buildForwardAdjacency(doc.nodes, doc.edges).deps;
  const upstreamIds = upstreamClosure(deps, nodeId);
  const pathForSessionNode = (node: WorkflowDoc["nodes"][number]): string => {
    const sessionId = node.params["sessionId"];
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new Error(`模块能力调用拒绝执行：上游节点「${node.title || node.id}」尚未绑定 Mcode 聊天会话`);
    }
    const session = SessionRepo.get(sessionId);
    if (!session || session.kind !== "chat") {
      throw new Error(`模块能力调用拒绝执行：上游节点「${node.title || node.id}」绑定的 Mcode 聊天会话不可用`);
    }
    const project = ProjectRepo.get(session.projectId);
    if (!project) throw new Error(`模块能力调用拒绝执行：会话「${sessionId}」所属项目不存在`);
    const rawPath = session.worktreePath ?? project.path;
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      throw new Error(`模块能力调用拒绝执行：会话「${sessionId}」没有可用工作区路径`);
    }
    return resolvePath(rawPath);
  };
  // The workflow's main conversation is the closest equivalent to the legacy
  // scheduler's ambient ExecutionContext.cwd. Prefer it over child agents,
  // which may intentionally be bound to other sessions for their own turns.
  const mainNode = doc.nodes.find((node) => node.type === MAIN_NODE_TYPE_ID && upstreamIds.has(node.id));
  if (mainNode) return pathForSessionNode(mainNode);

  const paths = new Map<string, string>();
  for (const node of doc.nodes) {
    if (!upstreamIds.has(node.id)) continue;
    const kind = manifests.get(node.type)?.runner.kind;
    if (kind !== "prompt" && kind !== "conversation") continue;
    const sessionId = node.params["sessionId"];
    if (typeof sessionId !== "string" || sessionId.trim() === "") continue;
    const path = pathForSessionNode(node);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    paths.set(key, path);
  }
  if (paths.size === 0) {
    throw new Error("模块能力调用拒绝执行：无法从上游 Mcode agent/对话节点确定工作区；请先绑定一个可见聊天会话");
  }
  if (paths.size > 1) {
    throw new Error("模块能力调用拒绝执行：上游节点绑定了多个不同工作区，无法安全选择模块访问范围");
  }
  return paths.values().next().value as string;
}

export interface TriggerContext {
  facts: Readonly<Record<string, unknown>>;
  source: "hook" | "custom-ui";
}

export interface ManualTicket {
  ticket: string;
  revoke(): void;
}

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
  const context = ticket ? deps.resolveTriggerTicket?.(ticket, docId) ?? null : null;
  const outcome = evaluateConditionForHost({
    ...(context === null ? {} : { trigger: context.facts, triggerSource: context.source }),
    expression: payload["expression"],
    doc,
    nodeId,
    results: Array.isArray(results) ? results as ConditionResultEntry[] : [],
    user: asString(payload["user"]),
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return { matched: outcome.matched };
}

/**
 * 给既有服务包一层：`condition.evaluate` 走本文件，其余动作**原样**交给 `base`。
 * 不复制 `base` 的任何判据，也不改变它的返回形状。
 */
export function createConditionTriggerBridge(
  base: NodePackHostServices,
  deps: ConditionEvaluationDeps,
): { services: NodePackHostServices; issueManual(docId: string, facts: Readonly<Record<string, unknown>>): ManualTicket } {
  // A bounded, process-local lookup table. Trigger facts are issued by the
  // production Host event subscription, never accepted from mutable Node-RED msg.
  const tickets = new Map<string, {
    docId: string;
    subscription: symbol;
    at: number;
    context: TriggerContext;
  }>();
  const maxAgeMs = 5 * 60_000;
  const maxTickets = 256;
  const prune = (): void => {
    const threshold = Date.now() - maxAgeMs;
    for (const [id, entry] of tickets) if (entry.at < threshold) tickets.delete(id);
    while (tickets.size > maxTickets) tickets.delete(tickets.keys().next().value!);
  };
  const allowed = new Set<string>(HOOK_EVENTS);
  const resolveTriggerTicket = (id: string, docId: string): TriggerContext | null => {
    prune();
    const entry = tickets.get(id);
    return entry?.docId === docId ? entry.context : null;
  };
  const issueManual = (docId: string, facts: Readonly<Record<string, unknown>>): ManualTicket => {
    if (!docId || docId.length > 512) throw Error("Native input requires a bound workflow");
    if (facts["kind"] !== "event" && facts["kind"] !== "file") throw Error("Unsupported manual input kind");
    if (Object.keys(facts).length > 80) throw Error("Too many native manual input facts");
    // Only the trusted caller can issue these facts. Do not copy arbitrary
    // object/constructor/prototype fields into the trigger variable namespace.
    const normalized: Record<string, unknown> = Object.create(null);
    normalized["kind"] = facts["kind"];
    for (const [key, value] of Object.entries(facts)) {
      if (key === "kind") continue;
      if (!(key === "event" || key === "collectionId" || key === "files"
          || key === "itemId" || key === "itemTitle" || key === "pdfPath" || key === "filePath"
          || /^input\.[a-z][a-z0-9_]{0,23}$/.test(key))) continue;
      if (typeof value === "string" && value.length <= 4096) normalized[key] = value;
      else if (Array.isArray(value) && value.length <= 50
        && value.every(item => typeof item === "string" && item.length <= 4096)) normalized[key] = [...value];
    }
    prune();
    const ticket = randomUUID();
    const subscription = Symbol("custom-ui-input");
    tickets.set(ticket, { docId, subscription, at: Date.now(), context: { facts: normalized, source: "custom-ui" } });
    prune();
    return { ticket, revoke: () => { tickets.delete(ticket); } };
  };

  return { issueManual, services: {
    execute(operation: NodePackAction, payload: Record<string, unknown>): Promise<unknown> {
      if (operation === "condition.evaluate") {
        return Promise.resolve().then(() => evaluateConditionPayload(payload, {
          ...deps, resolveTriggerTicket,
        }));
      }
      if (operation === "agent.run" || operation === "conversation.run" || operation === "branch.decide"
        || operation === "module.invoke" || operation === "node-red.call") {
        const rawParams = payload["params"];
        if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
          throw new Error("Mcode Host node payload invalid: params must be an object");
        }
        const params = rawParams as Record<string, unknown>;
        const rawOutputVars = params[NODE_OUTPUT_VARS_KEY];
        const hasUnverifiedOutputRules = rawOutputVars !== undefined && rawOutputVars !== null
          && !(Array.isArray(rawOutputVars) && rawOutputVars.length === 0);
        const needsTemplates = hasWorkflowTemplateReferences(params, payload["instruction"]);
        const needsPromptContract = operation === "agent.run" || operation === "conversation.run";
        const needsOutputContract = needsPromptContract || operation === "node-red.call";
        const needsModuleContext = operation === "module.invoke";
        if (!needsTemplates && !needsOutputContract && !needsModuleContext) return base.execute(operation, payload);

        // Template scope and output contracts come from the saved Mcode graph
        // selected by the already-verified native tab. Neither msg.mcode nor
        // x-mcode can nominate a different document; trigger facts are Host-owned.
        return Promise.resolve().then(async () => {
          const tabId = asString(payload["tabId"]);
          const docId = tabId ? deps.resolveWorkflow?.(tabId) ?? null : null;
          if (!docId) {
            if (needsTemplates) throw new Error("模板展开拒绝执行：无法确认这个 Node-RED tab 对应的 Mcode 工作流");
            if (needsModuleContext) throw new Error("模块能力调用拒绝执行：无法确认这个 Node-RED tab 对应的 Mcode 工作流");
            if (needsOutputContract && hasUnverifiedOutputRules) {
              throw new Error("输出变量契约拒绝执行：无法确认这个 Node-RED tab 对应的 Mcode 工作流");
            }
            return base.execute(operation, payload);
          }
          const doc = deps.getDoc(docId);
          if (!doc) {
            if (needsTemplates) throw new Error(`模板展开拒绝执行：宿主工作流库里没有「${docId}」`);
            if (needsModuleContext) throw new Error(`模块能力调用拒绝执行：宿主工作流库里没有「${docId}」`);
            if (needsOutputContract && hasUnverifiedOutputRules) {
              throw new Error(`输出变量契约拒绝执行：宿主工作流库里没有「${docId}」`);
            }
            return base.execute(operation, payload);
          }

          const nodeId = asString(payload["nodeId"]);
          if ((needsOutputContract && hasUnverifiedOutputRules || needsModuleContext)
              && !doc.nodes.some((node) => node.id === nodeId)) {
            throw new Error(`Mcode Host 节点拒绝执行：工作流「${docId}」中没有节点「${nodeId}」`);
          }
          let nextPayload: Record<string, unknown> = payload;
          if (needsTemplates) {
            const trigger = resolveTriggerTicket(asString(payload["triggerTicket"]), docId);
            const expanded = await expandWorkflowNodeTemplates({
              doc,
              nodeId: asString(payload["nodeId"]),
              params,
              instruction: payload["instruction"],
              results: payload["results"],
              user: payload["user"],
              ...(trigger ? { trigger: trigger.facts } : {}),
            });
            nextPayload = {
              ...payload,
              params: expanded.params,
              ...(expanded.instruction !== undefined ? { instruction: expanded.instruction } : {}),
            };
            // These operations consume selected fields at the Host RPC's top
            // level as well as `params`. Expand both copies or templates appear
            // to succeed but the executor still receives the literal braces.
            if (operation === "module.invoke") {
              nextPayload = {
                ...nextPayload,
                // 【EXT-07】扩展命令坐标（旧的 moduleId/contributionId 已不再支持，
                // 但这里仍原样带上 —— 老图里还有那两个字段，执行端会按键名显式拒绝）。
                extensionId: asString(expanded.params["extensionId"]),
                commandId: asString(expanded.params["commandId"]),
                moduleId: asString(expanded.params["moduleId"]),
                contributionId: asString(expanded.params["contributionId"]),
                path: asString(expanded.params["path"]),
              };
            } else if (operation === "node-red.call") {
              const method = asString(expanded.params["engineMethod"]);
              nextPayload = {
                ...nextPayload,
                enginePath: asString(expanded.params["enginePath"]),
                engineMethod: method.trim() === "" ? "POST" : method,
                engineBody: typeof expanded.params["engineBody"] === "string"
                  ? expanded.params["engineBody"] : "",
              };
            }
          }

          if (needsModuleContext) {
            const effectiveParams = nextPayload["params"] as Record<string, unknown>;
            const safeParams = { ...effectiveParams };
            // Never honor a workspace root carried by the child message or
            // sidecar. It is derived from Host-owned upstream session records.
            delete safeParams["projectPath"];
            nextPayload = {
              ...nextPayload,
              params: safeParams,
              projectPath: await workflowProjectPathForNode(doc, nodeId),
              // 【EXT-07】扩展命令的两个坐标同样要提到顶层 —— 执行端两处都会读。
              extensionId: asString(safeParams["extensionId"]),
              commandId: asString(safeParams["commandId"]),
              moduleId: asString(safeParams["moduleId"]),
              contributionId: asString(safeParams["contributionId"]),
              path: asString(safeParams["path"]),
            };
          }

          if (!needsOutputContract) return base.execute(operation, nextPayload);
          const prepared = needsPromptContract
            ? await prepareWorkflowOutput(doc, nodeId, nextPayload["instruction"])
            : { instruction: undefined, vars: await workflowOutputVarsFor(doc, nodeId) };
          if (needsPromptContract && prepared.instruction !== undefined) {
            nextPayload = { ...nextPayload, instruction: prepared.instruction };
          }
          const result = await base.execute(operation, nextPayload);
          return applyWorkflowOutput(result, prepared.vars);
        });
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
        tickets.set(ticket, { docId, subscription, at: Date.now(), context: { facts, source: "hook" } });
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
  } };
}

/** Backward-compatible wrapper for callers that need condition evaluation only. */
export function withConditionEvaluation(base: NodePackHostServices, deps: ConditionEvaluationDeps): NodePackHostServices {
  return createConditionTriggerBridge(base, deps).services;
}
