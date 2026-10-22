/**
 * T0: isolated fake repositories / RuntimeManager for the GenOffice native tool
 * round-trip smoke. Every session, project, document and SDK turn is fictional;
 * no Electron, network, model or user file is touched.
 *
 * `runtimeManager.sendTurn` records the exact input the production seam hands
 * to RuntimeManager (including request-scoped external tools + handler) and
 * then runs the test-supplied driver, which plays the SDK's tool loop.
 */
export type FakeSession = {
  id: string;
  projectId: string;
  providerId: string;
  model: string;
  worktreePath: string | null;
};
export type FakeTurnInput = {
  prompt: string;
  cwd: string;
  userMessage?: unknown;
  externalTools?: unknown[];
  externalToolHandler?: unknown;
};
export type FakeTurn = {
  session: FakeSession;
  input: FakeTurnInput;
  emit: (event: unknown) => void;
  signal: AbortSignal;
};

export const sessions: FakeSession[] = [
  { id: "session-a", projectId: "project-1", providerId: "claude-sdk", model: "mcode-model", worktreePath: null },
  { id: "session-b", projectId: "project-1", providerId: "pi-sdk", model: "mcode-model", worktreePath: null },
];
export const turnCalls: Array<{ sessionId: string; input: FakeTurnInput }> = [];
export const interrupts: AbortController[] = [];
export const events = new Set<(event: unknown) => void>();
export const subscriptions = { active: 0, peak: 0 };
/** Set by the test before each docsAiPorts.run call. */
export const runtimeState: { driver: ((turn: FakeTurn) => Promise<void>) | null } = { driver: null };

export const ProjectRepo = {
  get: (id: string) => (id === "project-1" ? { path: "C:/sandbox", id } : null),
};
export const SessionRepo = {
  get: (id: string) => sessions.find((session) => session.id === id) ?? null,
};
export const providerRegistry = {
  get: (id: string) => (["claude-sdk", "pi-sdk", "codex-sdk"].includes(id) ? { id } : undefined),
};
export const pathWithin = (root: string, file: string) => file === root || file.startsWith(root + "/");
export const getMainWindow = () => ({ isDestroyed: () => false });
export const dialog = { showMessageBox: async () => ({ response: 1 }) };

export const runtimeManager = {
  /** Test-only observability; production RuntimeManager has no such property. */
  __t0: { runtimeState, turnCalls, interrupts, events, subscriptions, sessions },
  subscribe(fn: (event: unknown) => void) {
    events.add(fn);
    subscriptions.active++;
    subscriptions.peak = Math.max(subscriptions.peak, subscriptions.active);
    return () => {
      events.delete(fn);
      subscriptions.active--;
    };
  },
  async sendTurn(session: FakeSession, input: FakeTurnInput) {
    turnCalls.push({ sessionId: session.id, input });
    const controller = new AbortController();
    interrupts.push(controller);
    const emit = (event: unknown) => {
      for (const listener of [...events]) listener(event);
    };
    const driver = runtimeState.driver ?? (async ({ emit: send }: FakeTurn) => {
      send({ type: "text.delta", sessionId: session.id, text: "fake sdk text" });
    });
    try {
      await driver({ session, input, emit, signal: controller.signal });
    } finally {
      emit({ type: "turn.done", sessionId: session.id, reason: "end_turn" });
    }
    return { done: Promise.resolve(), isRunning: () => false, interrupt: () => controller.abort() };
  },
};
