/**
 * T42 production backing for Node-RED child IPC. Dispatches through the SAME
 * RuntimeManager/ModuleHost used by the native desktop UI, not a new agent loop.
 * An unbound session, absent approval UI, or missing runtime fails closed.
 */
import { randomUUID } from "node:crypto";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { extensionCommandPort } from "@main/orchestration/extensionCommandPort.js";
import type { NodePackHostServices, NodePackAction } from "./nodePackHost.js";
import type { EngineRuntimeStatus } from "./runtimeSupervisor.js";

import type { PermissionMode, RuntimeEvent } from "@contracts/runtime";
import { HOOK_EVENT_OF, HOOK_EVENTS, eventItemFactsOf, hookSubjectOf, matchesAnyGlob, type HookEvent } from "@contracts/hook";
import { createEventSubjects } from "@main/hooks/eventSubjects.js";
import { triggerEnabledOf } from "@contracts/nodeType";

/** T60: one Host emitter for Node-RED native stages and Mcode Host-backed
 * stages. Do not create a parallel event bus or a fake Agent session. */
export function emitNativeRunboardEvent(event: RuntimeEvent): void {
  runtimeManager.emitExternal(event);
}

type Payload = Record<string, unknown>;
const asString = (v: unknown): string => typeof v === "string" ? v : "";
const paramsOf = (payload: Payload): Payload => {
  const p = payload.params;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw Error("Node params missing");
  return p as Payload;
};
const MAX_TEXT = 256_000;
type Capability = "read" | "write";

/**
 * W21: the node's declared `capability` decides **how this turn is dispatched**.
 *
 * Why this exists: the native Node-RED form exposes `capability: "read" | "write"`
 * (`mcodeNodePack.ts`), and the old graph runner honored it by deriving the
 * session's `permissionMode` on every dispatch (`runner.ts` `nodeSessionOf` →
 * `permissionModeForCapability`, `runner.ts:282`). This port is the production
 * path for `mcode-agent` / `mcode-conversation`, and it used to drop the field
 * on the floor: a node the user marked read-only still ran under whatever mode
 * the session row happened to carry. "Field exists" vs "field takes effect".
 *
 * Why the mapping is repeated here instead of imported: `runner.ts` statically
 * pulls the three provider implementations (and a `?raw` asset chain) — the
 * standalone Node-RED child bundle cannot carry that graph, and the regression
 * suite for this file bundles without those loaders (see
 * `scripts/mcode-agent-capability-smoke/`, which imports the real
 * `permissionModeForCapability` and asserts this table stays identical).
 * The production app is a single electron-vite bundle where both copies are
 * compiled together; the two mode strings are pinned to the real function by
 * that cross-suite assertion, not a second source of truth in practice.
 *
 * Why `plan` means *approval*, not *denial*: the shared contract is "make
 * writes visible" — a write-class tool under `plan` prompts the user; it is not
 * silently refused (`permissionModeForCapability` doc comment, `runner.ts:275`).
 * Making `read` a hard deny here would be *stronger* than the old behavior and
 * would regress migrated graphs (see W21 card §"派活时总控追加").
 */
const CAPABILITY_PERMISSION_MODE: Record<Capability, PermissionMode> = {
  read: "plan",
  write: "acceptEdits",
};
/**
 * Only the two `mcode-agent` values exist on the native form. Anything else
 * (missing field, stale `exec` / `net` from a hand-written flow, wrong type)
 * keeps the session's own mode — never invent a permission out of a malformed
 * value. Node-RED serializes node config as plain JSON, so the union must be
 * re-established at this untrusted boundary rather than trusted from TS.
 */
function capabilityOf(payload: Payload, params: Payload): Capability | null {
  // `mcodeNodePack.ts` normalizes the native editor field into BOTH the payload
  // top level and `params.capability` (when the native form field exists). The
  // top-level one is authoritative; the params copy is the migration fallback.
  const raw = payload.capability !== undefined ? payload.capability : params.capability;
  return raw === "read" || raw === "write" ? raw : null;
}
async function runSelectedSession(
  payload: Payload, promptOverride?: string,
  resolveWorkflow?: (tabId: string) => string | null,
  nodeType = "mcode-agent",
  /**
   * 【WF-09】按 id 取那张工作流文档 —— 用于把 **工作流级框架说明**
   * （`WorkflowDoc.frameworkNote`）拼进每一步的提示词。
   *
   * 可选：无头套件 / 记忆助手那条路拿不到库时传 undefined，
   * 那种情形只是不拼那一段，不影响执行。
   */
  getDoc?: (id: string) => { frameworkNote?: string; name?: string } | null,
): Promise<{ text: string; artifacts: []; runId: string }> {
  const params = paramsOf(payload);
  const sessionId = asString(params.sessionId);
  if (!sessionId) {
    // W18: migrated main/conversation nodes have no implicit chat identity.
    // Keep the established error contract for agent/branch callers (covered
    // by mcode-node-pack-ports-smoke); give conversation users an actionable
    // message rather than an internal field name.
    throw Error(nodeType === "mcode-conversation"
      ? "此对话节点尚未绑定 Mcode 聊天会话：请在 Node-RED 节点编辑器填写现有可见的「Mcode 会话 ID」，保存后重新部署。"
      : "Mcode sessionId is required");
  }
  const session = SessionRepo.get(sessionId);
  if (!session || session.kind !== "chat") {
    throw Error(nodeType === "mcode-conversation"
      ? "所选 Mcode 会话不存在或不是可用的聊天会话；请在 Node-RED 节点编辑器检查「Mcode 会话 ID」，不要使用其他人的会话标识。"
      : "Mcode Host session missing or not user-visible");
  }
  if (!["claude-sdk", "pi-sdk", "codex-sdk"].includes(session.providerId))
    throw Error("Mcode Host session is not backed by a supported native engine");
  const project = ProjectRepo.get(session.projectId);
  if (!project) throw Error("Mcode Host project not found");
  const cwd = session.worktreePath ?? project.path;
  // W21 capability gate. Only `mcode-agent` carries the form field: the old
  // graph never applied capability to a conversation run (`showsNodeCapability`
  // → only `runner.kind === "prompt"`), and the native conversation form's
  // flag has no old-side meaning, so applying it there would be a new behavior
  // change smuggled in with a fix.
  const capability = nodeType === "mcode-agent" ? capabilityOf(payload, params) : null;
  // What this turn will run under. `permissionMode` rides two paths and they
  // must agree:
  //   1. the in-memory session we hand `sendTurn` → StartTurnRequest/provider
  //      option (the engine's own SDK-level mode);
  //   2. the ApprovalBridge's live gate (`getPermissionMode`) that every
  //      provider consults right before `shouldAutoApprove` — the host-side
  //      canUseTool check that actually turns `plan` into "prompt on writes".
  // `bindSession` seeds the bridge from the persisted row and is idempotent,
  // so a session bound earlier in the app's life still holds the row's mode.
  // The bridge is written inside the try (below) so every early `throw` leaves
  // it untouched, and the `finally` puts the session's own mode back.
  const dispatchedSession = capability === null ? session
    : { ...session, permissionMode: CAPABILITY_PERMISSION_MODE[capability] };
  const instruction = asString(payload.instruction);
  const input = payload.input;
  /* 【WF-07】先把身份取出来 —— 下面拼"你在哪里"要用（它必须在这段之前定义）。 */
  const nodeId = asString(payload.nodeId);
  const title = asString(payload.nodeTitle) || nodeId;
  const body = promptOverride ?? [instruction, input === null || input === undefined ? ""
    : typeof input === "string" ? input : JSON.stringify(input)].filter(Boolean).join("\n\n");
  /* 【WF-07】**让每一步都知道自己在哪张流程的哪一格**。
   *
   * 旧调度器会把「整条流程是什么、你现在在第几步」拼进提示词（`schedulerPrompt`），
   * 而原生路径只有 instruction + input —— 于是同一个 agent 节点单独看这段指令时
   * 不知道上下游是什么，容易写出和整条流程对不上的产出（比如综述节点去改了格式）。
   *
   * 拼的是**结构事实**，不是新的指令：图 id、这一步的 id、它的标题。
   * **不拼整条流程的节点清单** —— 那会把每一步的上下文都撑大，而模型真正需要的是
   * "我在一条多步流程里，不是在做一件孤立的事"。
   *
   * `promptOverride` 是调用方给的完整替身（记忆助手这类），那种情形**不掺**上下文
   * —— 它是故意整段替换的。
   */
  /* 【WF-09】工作流级的框架说明（`frameworkNote`）—— 用户为**整张图**写的
   * 补充约定（"所有产出都用中文" / "引用必须带页码"）。旧调度器会拼进每个节点的提示词，
   * 原生路径以前完全读不到它：用户写了框架说明，改成 Node-RED 引擎之后就不生效了。
   *
   * 取不到文档时**只是不拼这一段**，不报错 —— 框架说明是补充，不是前置条件。 */
  const frameworkNote = ((): string | undefined => {
    if (getDoc === undefined) return undefined;
    const docId = resolveWorkflow?.(asString(payload.tabId));
    if (docId === null || docId === undefined) return undefined;
    const note = getDoc(docId)?.frameworkNote?.trim();
    return note === undefined || note === "" ? undefined : note;
  })();
  const flowContext = promptOverride !== undefined
    ? ""
    : [
        "## 你在哪里",
        `你在一条多步自动化流程（${asString(payload.tabId) || "未知流程"}）的其中一步：「${asString(payload.nodeTitle) || nodeId}」。`,
        "上游的产出会作为输入给你；你的产出会交给下游。不要把这一步当成孤立任务，",
        "也不要替上下游做决定（改别的文件、发布、删除）—— 那是它们各自的步骤。",
        // 【WF-09】整张图的框架说明（用户为这张图写的补充约定）。
        ...(frameworkNote !== undefined ? ["", "## 这张流程的约定", frameworkNote] : []),
        "",
      ].join("\n");
  const prompt = [flowContext, body].filter(Boolean).join("\n");
  if (!body.trim()) throw Error("Mcode agent instruction/input is empty");
  if (prompt.length > 30_000) throw Error("Mcode agent prompt too large");
  // Only Host-verified tab membership can nominate the workflowId. A Node-RED
  // msg/sidecar is untrusted and cannot choose another workflow's board.
  const workflowId = resolveWorkflow?.(asString(payload.tabId)) ?? null;
  const runId = asString(payload.runId) || randomUUID();
  const emitStep = (event: Record<string, unknown>): void => {
    if (workflowId && nodeId) runtimeManager.emitExternal({
      ...event, sessionId, workflowId, runId, nodeId,
    } as Parameters<typeof runtimeManager.emitExternal>[0]);
  };
  /**
   * 【WF-05】这一步**花了多少**（token / 金额）。收尾时取一次。
   *
   * 为什么取快照而不是累加：这一轮可能有多次 API 调用，而 `usageOf` 给的是
   * 主进程已经算好的**那一条回合记录**（与用量页、上下文环同一份事实）——
   * 在这里自己累 token 会算出和用量页对不上的第二个数字。
   *
   * 没有历史（这一轮还没结算）时返回 undefined：卡片据此**不显示**那一行，
   * 而不是显示 0（0 会被读成"没花钱"）。
   */
  const usageSnapshot = (): { totalTokens: number; outputTokens: number; costUsd?: number } | undefined => {
    const record = runtimeManager.usageOf(sessionId);
    if (record === undefined) return undefined;
    // `TurnUsageRecord` 里就是 `totalProcessedTokens`（input+output+cache 已合并），
    // 不需要再自己加 —— 自己算会和用量页的数字对不上。
    const totalTokens = typeof record.totalProcessedTokens === "number"
      ? record.totalProcessedTokens
      : 0;
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return undefined;
    return {
      totalTokens,
      outputTokens: typeof record.outputTokens === "number" ? record.outputTokens : 0,
      ...(typeof record.costUsd === "number" ? { costUsd: record.costUsd } : {}),
    };
  };
  let text = "";
  let eventError: string | null = null;
  let terminal: string | null = null;
  // Subscribe *before* dispatch to avoid missing fast provider emissions.
  const unsubscribe = runtimeManager.subscribe((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.type === "text.delta") {
      if (text.length < MAX_TEXT) text += event.text.slice(0, MAX_TEXT - text.length);
    } else if (event.type === "error") eventError = event.message;
    else if (event.type === "turn.done") terminal = event.reason;
  });
  try {
    // Gate the FIRST tool call: write the bridge before any dispatch below.
    if (capability !== null) runtimeManager.setPermissionMode(sessionId, dispatchedSession.permissionMode);
    emitStep({ type: "workflow.node.queued" });
    emitStep({ type: "workflow.node.progress", nodeType, title, phase: "running", message: "Node-RED 节点已开始执行" });
    // 【WF-07】**发完即走**：对话节点可以只把话递进那条会话，不等它答完。
    //
    // 旧调度器用 `injectMode: "auto"` 表达这件事（"把消息递给主代理，由用户决定发不发"
    // 那条）。原生侧没有"发起会话"这个概念，但**同一个语义**仍然需要：一个节点把一段话
    // 投进某条对话，然后流程继续往下走，不卡在那条对话的回答上。
    //
    // 判据只看节点参数 `injectMode === "auto"`，与 `@contracts/nodeType` 的
    // `injectModeOf` 同一份取值；不新造字段。
    //
    // ⚠️ 代价与旧路径一致：这一步**拿不到那轮的产出**。需要产出的流程别用 auto。
    const autoInject = params["injectMode"] === "auto";
    const handle = await runtimeManager.sendTurn(dispatchedSession, { prompt, cwd });
    if (!handle) throw Error("Mcode session busy; native engine did not accept this turn");
    if (autoInject) {
      // 不 await `handle.done`：那一轮对目标对话来说是条**正常消息**，该几点收就几点收。
      // 这一步立刻记成功，并把已发出的文本作为产出交给下游。
      emitStep({
      type: "workflow.node.result", nodeType, title, status: "success", summary: text || prompt,
      /* auto 注入那条**拿不到那轮的产出**（不 await done），所以也没有用量 ——
         如实不带，而不是写一个 0。 */
    });
      return { text: text || prompt, artifacts: [], runId };
    }
    await handle.done;
    if (eventError) throw Error(eventError);
    if (terminal !== "end_turn") throw Error("Mcode native engine did not finish normally: " + (terminal ?? "no turn.done"));
    if (text.length >= MAX_TEXT) throw Error("Mcode agent response exceeded output limit");
    const usage = usageSnapshot();
    emitStep({
      type: "workflow.node.result", nodeType, title, status: "success", summary: text,
      // 【WF-05】把这一轮的用量带给卡片 —— 没有这一行，"哪一步最贵"完全看不见。
      ...(usage !== undefined ? { usage } : {}),
    });
    return { text, artifacts: [], runId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    emitStep({ type: "workflow.node.result", nodeType, title, status: "failed", summary: "", error: reason });
    throw err;
  } finally {
    unsubscribe();
    // Restore the session's own mode so the node's capability does not leak
    // into the user's next manual message: this port borrows the user's chat
    // session (the old graph used a dedicated node session whose mode *was*
    // the node's). The dispatch snapshot above is per-turn; the bridge gate is
    // session-scoped, so it must be put back explicitly. Re-read the row
    // instead of reusing `session`: the user may have changed the mode in the
    // UI while the node ran (that path persists via `SessionRepo.updateSettings`).
    // Known cost, by bridge design: each mode flip clears the session's
    // "always allow" grants (`ApprovalBridge.setPermissionMode`) — the safe
    // direction (a grant given under another policy is re-asked once).
    if (capability !== null) {
      const current = SessionRepo.get(sessionId)?.permissionMode ?? session.permissionMode;
      runtimeManager.setPermissionMode(sessionId, current);
    }
  }
}
async function chooseBranch(payload: Payload): Promise<{ port: number }> {
  const params = paramsOf(payload);
  const count = payload.portCount;
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 12)
    throw Error("Branch portCount invalid");
  const portCount = count as number;
  const decider = asString(payload.decider) || "user";
  if (decider === "model") {
    const prompt = "Choose exactly one output port (integer 0 to " + (portCount - 1)
      + "). Reply with the number ONLY. Node context: " + JSON.stringify(payload.input ?? null)
      + "\nNode note: " + asString(params.note);
    // A branch payload never carries the agent form's `capability`, but a
    // hand-built msg could. "The model picks a port" must not inherit a
    // permission switch the branch form never had, so strip both copies
    // before reusing the shared dispatch path.
    const { capability: _unusedTop, ...branchPayload } = payload;
    const branchParams = { ...params };
    delete branchParams.capability;
    const result = await runSelectedSession({ ...branchPayload, params: branchParams }, prompt);
    const choice = result.text.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(choice)) throw Error("Model branch did not return a single numeric port");
    const port = Number(choice);
    if (port >= portCount) throw Error("Model branch port out of range");
    return { port };
  }
  if (decider !== "user") throw Error("Unknown branch decider");
  const { dialog } = await import("electron");
  const { getMainWindow } = await import("@main/window.js");
  const win = getMainWindow();
  if (!win || win.isDestroyed()) throw Error("Human branch approval unavailable; refusing to choose");
  const buttons = Array.from({ length: portCount }, (_, i) => "Output " + i);
  buttons.push("Cancel");
  const response = await dialog.showMessageBox(win, {
    type: "question", message: "Mcode workflow branch needs your decision",
    detail: asString(params.note).slice(0, 1000) || "Choose the Node-RED output port to continue.",
    buttons, cancelId: portCount, defaultId: portCount, noLink: true,
  });
  if (response.response < 0 || response.response >= portCount) throw Error("Human branch cancelled");
  return { port: response.response };
}
export function productionNodePackServices(
  getStatus: () => EngineRuntimeStatus,
  adminToken: string | undefined,
  resolveWorkflow?: (tabId: string) => string | null,
  /** 【WF-09】按 id 取文档 —— 用于把工作流级框架说明拼进每一步的提示词。 */
  getDoc?: (id: string) => { frameworkNote?: string; name?: string } | null,
): NodePackHostServices {
  return {
    async execute(operation: NodePackAction, payload: Payload): Promise<unknown> {
      if (operation === "agent.run" || operation === "conversation.run")
        return runSelectedSession(payload, undefined, resolveWorkflow,
          operation === "agent.run" ? "mcode-agent" : "mcode-conversation", getDoc);
      if (operation === "branch.decide") return chooseBranch(payload);
      if (operation === "module.invoke") {
        // 【EXT-07】现在跑的是**已安装 VS Code 扩展的一条命令**，不再是 ModuleHost 的
        // 模块/贡献坐标。与 `ModuleCapabilityExecutor` 走同一个端口。
        //
        // ⚠️ `projectPath` 从 **`params`** 读，与 HEAD 的 `paramsOf(payload).projectPath` 一致：
        // 真实调用链里它是 `conditionHostPorts` 注入进 `params` 的（见那里的
        // `needsModuleContext` 分支），不是 payload 顶层 —— 从顶层读会让正常节点
        // 全部被拒成「没有工作区」。
        const p = paramsOf(payload);
        const projectPath = asString(p.projectPath);
        if (!projectPath) throw Error("扩展命令节点需要一个已登记的工作区（projectPath）");
        const extensionId = asString(payload.extensionId || p.extensionId);
        const commandId = asString(payload.commandId || p.commandId);
        if (!extensionId || !commandId) {
          throw Error("扩展命令节点需要 extensionId 与 commandId（旧的 moduleId/contributionId 已不再支持）");
        }
        const declared = asString(payload.path || p.path);
        const resolved = declared && isAbsolute(declared) ? declared : resolvePath(projectPath, declared ?? "");
        const value = await extensionCommandPort.execute({
          extensionId, commandId, path: resolved,
          signal: AbortSignal.timeout(60_000),
        });
        const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
        return { text: text.slice(0, 100_000), artifacts: [], runId: randomUUID() };
      }
      if (operation === "node-red.call") {
        const state = getStatus();
        if (state.state !== "running" || state.port === null || !adminToken)
          throw Error("Node-RED Host API unavailable");
        const method = asString(payload.engineMethod).toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
          throw Error("Node-RED Host API method invalid");
        const endpoint = asString(payload.enginePath);
        if (!endpoint.startsWith("/") || endpoint.startsWith("//") || endpoint.includes("..")
          || endpoint.includes("?") || endpoint.includes("#") || endpoint.length > 256)
          throw Error("Invalid Node-RED API path");
        // Node installation, auth/settings, and arbitrary admin changes must
        // not be exposed as an unguarded shortcut through a workflow node.
        if (method !== "GET") {
          if (!(method === "POST" && endpoint === "/flows"))
            throw Error("Node-RED mutations must use an approved Host path");
          const { dialog } = await import("electron");
          const { getMainWindow } = await import("@main/window.js");
          const win = getMainWindow();
          if (!win || win.isDestroyed()) throw Error("Host deploy approval UI unavailable");
          const approval = await dialog.showMessageBox(win, {
            type: "warning", message: "Allow this Node-RED flow to request another deployment?",
            detail: "The target deployment still passes the native executor-ownership handshake.",
            buttons: ["Deny", "Allow once"], defaultId: 0, cancelId: 0, noLink: true,
          });
          if (approval.response !== 1) throw Error("Host rejected Node-RED deployment");
        }
        const response = await fetch("http://127.0.0.1:" + state.port + endpoint, {
          method, headers: {
            Authorization: "Bearer " + adminToken,
            ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
          },
          ...(method !== "GET" ? { body: asString(payload.engineBody) } : {}),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await response.text();
        if (!response.ok) throw Error("Node-RED API HTTP " + response.status + ": " + text.slice(0, 500));
        return { text: text.slice(0, MAX_TEXT), artifacts: [], status: response.status };
      }
      throw Error("Unsupported Mcode node operation");
    },
    subscribe(payload, emit) {
      const params = paramsOf(payload);
      /* 【AUTO-01】这个触发器被单独关掉了吗？
       *
       * `enabled` 是迁移时**原样搬进 x-mcode.params** 的，但执行侧一直没读它 ——
       * 于是界面上把某个触发器关掉，原生侧照旧订阅/照旧触发。用户看到的是
       * "我关了它，它还在跑"。
       *
       * 关掉时**静默不订阅**（不是报错）：`subscribe` 的失败会被当成"这张图有问题"
       * 而整个流程起不来，而"这个触发器关着"是一个**正常状态**。
       * 返回一个空拆解函数，语义是"订阅了，但什么都不会发生"。 */
      if (triggerEnabledOf(params) === false) {
        return () => {};
      }
      if (payload.triggerKind !== "event") {
        throw Error("Use Node-RED native inject/watch for manual, schedule, or file triggers");
      }
      // Old mcode.trigger stores HookEvent identifiers in `events` while `task`
      // is prose for the Agent. Hand-authored native nodes without `events`
      // retain the previous single `task` event-name fallback. A nonempty
      // native `events` field is authoritative; never silently fall back
      // to an unrelated human instruction if its entries are invalid.
      const eventFilter = params.eventFilter;
      if (eventFilter !== undefined && eventFilter !== null && typeof eventFilter !== "string") {
        throw Error("Legacy eventFilter must be a string; never run with an unknown filter");
      }
      const matcher = typeof eventFilter === "string" ? eventFilter.trim() : "";
      const hasEvents = params.events !== undefined;
      const source = hasEvents ? params.events : params.task;
      const rawEvents = Array.isArray(source) ? source : typeof source === "string" ? source.split(/[\r\n,]+/) : [];
      const names = [...new Set(rawEvents.map(e => typeof e === "string" ? e.trim() : ""))].filter(Boolean);
      if (!names.length || names.length > 16
        || names.some(name => name.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(name))) {
        throw Error("Trigger event type must be specified (use the Events field, not Task)");
      }
      // A name must be an actual HookEvent. Accepting an arbitrary dotted
      // string here makes "successfully subscribed" mean "never fires".
      const validEvents = new Set<string>(HOOK_EVENTS);
      if (names.some(name => !validEvents.has(name))) {
        throw Error("Unknown HookEvent in Events field; select an event supported by Mcode");
      }
      // The old matcher operates on tool names or file paths, depending on
      // the event. File-path matching needs a cwd from a real Host session,
      // never from editable native node parameters. Unfilterable kinds fail
      // closed rather than receiving ALL events.
      if (matcher && names.some(name => hookSubjectOf(name as HookEvent) === null)) {
        throw Error("Legacy eventFilter is not implemented for this Node-RED event type: only tool-name and turn.files path filters are supported");
      }
      const eventNames = new Set(names);
      const subjects = createEventSubjects();
      return runtimeManager.subscribe((event) => {
        // factsOf has state (tool.use → tool.result ID lookup). It must run
        // once per event even if the event itself is not subscribed.
        const facts = subjects.factsOf(event);
        const eventName = HOOK_EVENT_OF[event.type];
        if (eventName === null || !eventNames.has(eventName)) return;
        if (matcher) {
          let cwd = "";
          if (hookSubjectOf(eventName) === "path") {
            const session = SessionRepo.get(event.sessionId);
            const project = session ? ProjectRepo.get(session.projectId) : null;
            if (!project?.path) return; // unknown/stale session has no verified cwd
            cwd = project.path;
          }
          if (!matchesAnyGlob(matcher, subjects.subjectsOf(event, cwd, facts.toolName) ?? [])) return;
        }
        // Same Mcode event stream as automationRunner. Item facts come from
        // the original RuntimeEvent through the shared contract mapping,
        // never from msg.mcode or a guessed "latest" library item.
        const items = eventItemFactsOf(event);
        emit({ payload: {
          event: eventName, sessionId: event.sessionId, at: Date.now(),
          ...(items ?? {}),
        } });
      });
    },
  };
}
