/** Only fake Mcode ports; production DocsAI module under test is real. */
export const calls: Array<{ providerId: string; prompt: string; userMessage: unknown }> = []
export const events = new Set<(e: unknown) => void>()
export const targetSession = { id: 'session-1', projectId: 'project-1', providerId: 'claude-sdk', model: 'mcode-model', worktreePath: null }
export const ProjectRepo = { get: (id: string) => id === 'project-1' ? { path: 'C:/sandbox', id } : null }
export const SessionRepo = { get: (id: string) => id === 'session-1' ? targetSession : null }
export const providerRegistry = { get: (id: string) => ['claude-sdk', 'pi-sdk', 'codex-sdk'].includes(id) ? {id} : undefined }
export const pathWithin = (root: string, file: string) => file === root || file.startsWith(root + '/')
export const runtimeManager = {
  subscribe(fn: (e: unknown) => void) { events.add(fn); return () => {events.delete(fn)} },
  async sendTurn(session: typeof targetSession, input: { prompt: string; userMessage: unknown }) {
    calls.push({ providerId: session.providerId, prompt: input.prompt, userMessage: input.userMessage })
    for (const cb of events) {
      cb({ type: 'text.delta', sessionId: session.id, text: 'native-' + session.providerId })
      cb({ type: 'turn.done', sessionId: session.id, reason: 'end_turn' })
    }
    return { done: Promise.resolve(), isRunning: () => false, interrupt: () => {}, injectMessage: () => false }
  },
}
export const getMainWindow = () => ({ isDestroyed: () => false })
export const dialog = { showMessageBox: async () => ({ response: 1 }) }

// Some transitive imports of the AI adapter reach `electron.app` (paths, versions).
// The suite never boots a real Electron main process, so expose the minimum that
// keeps those modules loadable without pretending to implement them.
export const app = {
  getPath: (_name: string) => "C:/sandbox",
  getVersion: () => "0.0.0-test",
  isPackaged: false,
  on: () => {},
  once: () => {},
  whenReady: () => Promise.resolve(),
}
