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

import type { RuntimeEvent } from "@contracts/runtime";

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
async function runSelectedSession(
  payload: Payload, promptOverride?: string,
  resolveWorkflow?: (tabId: string) => string | null,
  nodeType = "mcode-agent",
): Promise<{ text: string; artifacts: []; runId: string }> {
  const params = paramsOf(payload);
  const sessionId = asString(params.sessionId);
  if (!sessionId) throw Error("Mcode sessionId is required; select an existing visible session in the node editor");
  const session = SessionRepo.get(sessionId);
  if (!session || session.kind !== "chat") throw Error("Mcode Host session missing or not user-visible");
  if (!["claude-sdk", "pi-sdk", "codex-sdk"].includes(session.providerId))
    throw Error("Mcode Host session is not backed by a supported native engine");
  const project = ProjectRepo.get(session.projectId);
  if (!project) throw Error("Mcode Host project not found");
  const cwd = session.worktreePath ?? project.path;
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
    emitStep({ type: "workflow.node.queued" });
    emitStep({ type: "workflow.node.progress", nodeType, title, phase: "running", message: "Node-RED 节点已开始执行" });
    const handle = await runtimeManager.sendTurn(session, { prompt, cwd });
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
    const result = await runSelectedSession(payload, prompt);
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
      const eventType = asString(params.task);
      if (!eventType || eventType.length > 100) throw Error("Trigger event type must be specified");
      // Same Mcode event stream as automationRunner, but this Node-RED node
      // only emits into its *existing* flow — no second executor is started.
      return runtimeManager.subscribe((event) => {
        if (event.type !== eventType) return;
        emit({ payload: { event: event.type, sessionId: event.sessionId, at: Date.now() } });
      });
    },
  };
}
