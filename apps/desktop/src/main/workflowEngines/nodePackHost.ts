/** T42 — authenticated child/parent message protocol for Mcode's six native nodes.
 * This runs ONLY in the Mcode main process, never in the bundled Node-RED child.
 * Requests use the already established fork IPC channel, but have disjoint
 * kinds/identifiers from mcode-deploy-* (ownership handshake).
 */
export type NodePackAction = "agent.run" | "conversation.run" | "branch.decide"
  | "trigger.subscribe" | "module.invoke" | "node-red.call";
export interface NodePackHostServices {
  execute(operation: NodePackAction, payload: Record<string, unknown>): Promise<unknown>;
  subscribe(payload: Record<string, unknown>, emit: (payload: Record<string, unknown>) => void): () => void;
}
const ACTIONS = new Set<NodePackAction>([
  "agent.run", "conversation.run", "branch.decide", "trigger.subscribe",
  "module.invoke", "node-red.call",
]);
export class NodePackHost {
  private disposed = false;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly inflight = new Set<string>();
  constructor(private readonly services: NodePackHostServices) {}
  handle(message: unknown, reply: (message: unknown) => void): boolean {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const msg = message as Record<string, unknown>;
    if (msg.kind === "mcode-node-unsubscribe") {
      if (typeof msg.id === "string") this.unsubscribe(msg.id);
      return true;
    }
    if (msg.kind !== "mcode-node-request") return false;
    const id = msg.id;
    if (typeof id !== "string" || !/^[0-9]{1,16}$/.test(id)) return true;
    const fail = (reason: string): void => {
      if (!this.disposed) reply({ kind: "mcode-node-reply", id, ok: false, reason });
    };
    if (this.disposed || this.inflight.has(id) || this.inflight.size >= 128) {
      fail("Mcode Host node channel unavailable or saturated");
      return true;
    }
    const operation = msg.operation;
    if (typeof operation !== "string" || !ACTIONS.has(operation as NodePackAction)
      || !msg.payload || typeof msg.payload !== "object" || Array.isArray(msg.payload)) {
      fail("Invalid Mcode node IPC request");
      return true;
    }
    const payload = msg.payload as Record<string, unknown>;
    if (typeof payload.nodeId !== "string" || payload.nodeId.trim() === "") {
      fail("Mcode node identity missing");
      return true;
    }
    this.inflight.add(id);
    void (async () => {
      try {
        let result: unknown;
        if (operation === "trigger.subscribe") {
          const subscriptionId = payload.subscriptionId;
          if (typeof subscriptionId !== "string" || !/^sub-[0-9]{1,16}$/.test(subscriptionId)
            || this.subscriptions.has(subscriptionId)) throw new Error("Invalid/duplicate trigger subscription");
          const buffered: Record<string, unknown>[] = [];
          let overflow = false;
          const publish = (event: Record<string, unknown>) => {
            if (this.disposed) return;
            if (this.subscriptions.has(subscriptionId)) {
              reply({ kind: "mcode-node-event", id: subscriptionId, payload: event });
            } else if (buffered.length < 256) {
              buffered.push(event);
            } else {
              overflow = true;
            }
          };
          const dispose = this.services.subscribe(payload, publish);
          if (typeof dispose !== "function") throw new Error("Host trigger has no unsubscribe handle");
          if (this.disposed || overflow) {
            dispose();
            throw new Error(overflow ? "Host trigger event buffer exceeded" : "Node-RED runtime stopped");
          }
          this.subscriptions.set(subscriptionId, dispose);
          for (const event of buffered) publish(event);
          result = { subscribed: true };
        } else {
          result = await this.services.execute(operation as NodePackAction, payload);
        }
        if (!this.disposed) reply({ kind: "mcode-node-reply", id, ok: true, result });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      } finally {
        this.inflight.delete(id);
      }
    })();
    return true;
  }
  private unsubscribe(id: string): void {
    const dispose = this.subscriptions.get(id);
    this.subscriptions.delete(id);
    if (dispose) {
      try { dispose(); } catch { /* parent is stopping; do not re-register */ }
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.subscriptions.keys()]) this.unsubscribe(id);
    this.inflight.clear();
  }
}
