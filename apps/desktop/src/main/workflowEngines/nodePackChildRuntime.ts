/**
 * T42 — Node-RED child-side transport. Bundled into ONE standalone CJS asset;
 * no imports from Electron, Mcode main process, or provider SDKs.
 * The parent process exclusively owns authorization and all domain actions.
 */
import { registerMcodeNodePack, type McodeNodePorts } from "./mcodeNodeTypes.js";
import type { NodeRedRuntimeApi } from "./mcodeNodePack.js";

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const subscriptions = new Map<string, (msg: Record<string, unknown>) => void>();
let sequence = 0;
const RPC_TIMEOUT_MS = 10 * 60_000;
const MAX_INFLIGHT = 128;
const failAll = (reason: string) => {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
  subscriptions.clear();
};
process.on("disconnect", () => failAll("Mcode Host IPC disconnected"));
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const msg = message as Record<string, unknown>;
  if (msg.kind === "mcode-node-event" && typeof msg.id === "string") {
    const emit = subscriptions.get(msg.id);
    if (emit) emit(msg.payload as Record<string, unknown>);
    return;
  }
  if (msg.kind !== "mcode-node-reply" || typeof msg.id !== "string") return;
  const item = pending.get(msg.id);
  if (!item) return;
  pending.delete(msg.id);
  clearTimeout(item.timer);
  if (msg.ok === true) item.resolve(msg.result);
  else item.reject(new Error(typeof msg.reason === "string" ? msg.reason : "Mcode Host refused node request"));
});
function requireChannel(): void {
  if (typeof process.send !== "function" || !process.connected) {
    throw new Error("Mcode Host IPC unavailable; refusing node execution");
  }
}
function send(kind: string, payload: Record<string, unknown>): void {
  requireChannel();
  process.send!({ kind, ...payload });
}
function invoke(operation: string, payload: unknown): Promise<any> {
  requireChannel();
  if (pending.size >= MAX_INFLIGHT) return Promise.reject(new Error("Mcode Host IPC queue full"));
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Mcode Host node request timed out (no approval or response)"));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      send("mcode-node-request", { id, operation, payload });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
const ports: McodeNodePorts = {
  agent: { run: (payload) => invoke("agent.run", payload) },
  conversation: { run: (payload) => invoke("conversation.run", payload) },
  branch: { decide: (payload) => invoke("branch.decide", payload) },
  moduleCapability: { run: (payload) => invoke("module.invoke", payload) },
  nodeRedCall: { run: (payload) => invoke("node-red.call", payload) },
  trigger: {
    subscribe(payload, emit) {
      requireChannel();
      const id = "sub-" + (++sequence);
      subscriptions.set(id, emit);
      void invoke("trigger.subscribe", { ...payload, subscriptionId: id }).catch((err) => {
        // Trigger subscriptions have a synchronous Node-RED API. An asynchronous
        // Host denial must become a node.error via the existing event validator.
        if (subscriptions.has(id)) emit(null as unknown as Record<string, unknown>);
        void err;
      });
      return () => {
        subscriptions.delete(id);
        try { send("mcode-node-unsubscribe", { id }); } catch { /* disconnected */ }
      };
    },
  },
};
export function registerType(RED: NodeRedRuntimeApi, type: string): void {
  registerMcodeNodePack(RED, () => ports, type);
}
