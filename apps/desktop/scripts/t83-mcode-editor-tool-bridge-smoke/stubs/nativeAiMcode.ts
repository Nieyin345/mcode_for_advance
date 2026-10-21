/** Isolated fake RuntimeManager / repositories for the T83 bridge gate smoke. */
export const calls: Array<{ providerId: string; prompt: string; userMessage: unknown }> = [];
export const events = new Set<(e: unknown) => void>();
export const targetSession = {
  id: "session-1",
  projectId: "project-1",
  providerId: "claude-sdk",
  model: "mcode-model",
  worktreePath: null as string | null,
};
export const ProjectRepo = {
  get: (id: string) => id === "project-1" ? { path: "C:/sandbox", id } : null,
};
export const SessionRepo = {
  get: (id: string) => id === "session-1" ? targetSession : null,
};
export const providerRegistry = {
  get: (id: string) => ["claude-sdk", "pi-sdk", "codex-sdk"].includes(id) ? { id } : undefined,
};
export const pathWithin = (root: string, file: string) => file === root || file.startsWith(root + "/");
export const getMainWindow = () => ({ isDestroyed: () => false });
export const dialog = { showMessageBox: async () => ({ response: 1 }) };

let serial = 0;
export const runtimeManager = {
  /** Test-only observability; production RuntimeManager has no such property. */
  __t83: { calls, events, targetSession },
  subscribe(fn: (e: unknown) => void) {
    events.add(fn);
    return () => { events.delete(fn); };
  },
  async sendTurn(session: typeof targetSession, input: { prompt: string; userMessage: unknown }) {
    calls.push({ providerId: session.providerId, prompt: input.prompt, userMessage: input.userMessage });
    const messageId = "assistant-" + (++serial);
    for (const cb of [...events]) {
      cb({ type: "text.delta", sessionId: session.id, messageId, text: "native-" + session.providerId });
      cb({ type: "turn.done", sessionId: session.id, reason: "end_turn" });
    }
    return { done: Promise.resolve(), isRunning: () => false, interrupt: () => {} };
  },
};
