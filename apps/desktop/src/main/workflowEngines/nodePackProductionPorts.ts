/**
 * T42 production backing for Node-RED child IPC. Dispatches through the SAME
 * RuntimeManager/ModuleHost used by the native desktop UI, not a new agent loop.
 * An unbound session, absent approval UI, or missing runtime fails closed.
 */
import { randomUUID } from "node:crypto";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { getModuleHost } from "@main/modules/service.js";
import type { NodePackHostServices, NodePackAction } from "./nodePackHost.js";
import type { EngineRuntimeStatus } from "./runtimeSupervisor.js";

import type { PermissionMode, RuntimeEvent } from "@contracts/runtime";

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
  const prompt = promptOverride ?? [instruction, input === null || input === undefined ? ""
    : typeof input === "string" ? input : JSON.stringify(input)].filter(Boolean).join("\n\n");
  if (!prompt.trim()) throw Error("Mcode agent instruction/input is empty");
  if (prompt.length > 30_000) throw Error("Mcode agent prompt too large");
  // Only Host-verified tab membership can nominate the workflowId. A Node-RED
  // msg/sidecar is untrusted and cannot choose another workflow's board.
  const workflowId = resolveWorkflow?.(asString(payload.tabId)) ?? null;
  const nodeId = asString(payload.nodeId);
  const runId = asString(payload.runId) || randomUUID();
  const title = asString(payload.nodeTitle) || nodeId;
  const emitStep = (event: Record<string, unknown>): void => {
    if (workflowId && nodeId) runtimeManager.emitExternal({
      ...event, sessionId, workflowId, runId, nodeId,
    } as Parameters<typeof runtimeManager.emitExternal>[0]);
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
    const handle = await runtimeManager.sendTurn(dispatchedSession, { prompt, cwd });
    if (!handle) throw Error("Mcode session busy; native engine did not accept this turn");
    await handle.done;
    if (eventError) throw Error(eventError);
    if (terminal !== "end_turn") throw Error("Mcode native engine did not finish normally: " + (terminal ?? "no turn.done"));
    if (text.length >= MAX_TEXT) throw Error("Mcode agent response exceeded output limit");
    emitStep({ type: "workflow.node.result", nodeType, title, status: "success", summary: text });
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
): NodePackHostServices {
  return {
    async execute(operation: NodePackAction, payload: Payload): Promise<unknown> {
      if (operation === "agent.run" || operation === "conversation.run")
        return runSelectedSession(payload, undefined, resolveWorkflow,
          operation === "agent.run" ? "mcode-agent" : "mcode-conversation");
      if (operation === "branch.decide") return chooseBranch(payload);
      if (operation === "module.invoke") {
        const p = paramsOf(payload);
        const projectPath = asString(p.projectPath);
        if (!projectPath) throw Error("Module workflow requires a projectPath bound to its Host grant");
        const result = await (await getModuleHost()).invoke({
          moduleId: asString(payload.moduleId), contributionId: asString(payload.contributionId),
          resource: { path: asString(payload.path), projectPath }, requestId: randomUUID(),
        });
        return { text: JSON.stringify(result), artifacts: [], runId: randomUUID() };
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
      if (payload.triggerKind !== "event") {
        throw Error("Use Node-RED native inject/watch for manual, schedule, or file triggers");
      }
      // Old mcode.trigger stores HookEvent identifiers in `events` while `task`
      // is prose for the Agent. Hand-authored native nodes without `events`
      // retain the previous single `task` event-name fallback. A nonempty
      // native `events` field is authoritative; never silently fall back
      // to an unrelated human instruction if its entries are invalid.
      const eventFilter = params.eventFilter;
      if (eventFilter !== undefined && eventFilter !== null
        && (typeof eventFilter !== "string" || eventFilter.trim() !== "")) {
        throw Error("Legacy eventFilter is not implemented for Node-RED: migrate the filter explicitly or clear it before deploying");
      }
      const hasEvents = params.events !== undefined;
      const source = hasEvents ? params.events : params.task;
      const rawEvents = Array.isArray(source) ? source : typeof source === "string" ? source.split(/[\r\n,]+/) : [];
      const names = [...new Set(rawEvents.map(e => typeof e === "string" ? e.trim() : ""))].filter(Boolean);
      if (!names.length || names.length > 16
        || names.some(name => name.length > 100 || !/^[a-z0-9][a-z0-9._-]*$/.test(name))) {
        throw Error("Trigger event type must be specified (use the Events field, not Task)");
      }
      // Same Mcode event stream as automationRunner, but this Node-RED node
      // only emits into its *existing* flow — no second executor is started.
      const eventNames = new Set(names);
      return runtimeManager.subscribe((event) => {
        if (!eventNames.has(event.type)) return;
        // This is NOT TriggerPayload.input from the old custom-UI form.
        // Never infer trigger.input.doi from event.itemId or task prose.
        emit({ payload: { event: event.type, sessionId: event.sessionId, at: Date.now() } });
      });
    },
  };
}
