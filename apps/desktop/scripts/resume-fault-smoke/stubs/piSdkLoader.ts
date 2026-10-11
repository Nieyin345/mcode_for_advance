/**
 * 假的 `piSdkLoader` 模块 —— 换掉 PiAgentSdkProvider 的**相对 import** `./piSdkLoader.js`
 * (`--alias` 不收相对名,故走 `--external:./piSdkLoader.js` + 把它 esbuild 成同名文件
 * 铺在 bundle 旁边)。本文件因此**不得有任何 import**(保持零依赖,单独打包即可跑)。
 *
 * 行为由 `globalThis.__piFake.reset(mode)` 驱动:
 *   - Pi 恢复路径:`SessionManager.open(path)` 在 "reject" 模式抛错;
 *   - 新建路径:`SessionManager.create(cwd)` 计数,`createAgentSession` 返回假 session;
 *   - 假 session 的 `prompt()` 向订阅者派发一次工具事件 + 终态 `agent_end`,让回合收尾。
 */
type Mode = "ok" | "reject" | "empty";

interface PiFakeState {
  mode: Mode;
  calls: { create: number; createAgentSession: number; toolsDispatched: number };
  reset(mode: Mode): void;
}

function state(): PiFakeState {
  const g = globalThis as unknown as { __piFake?: PiFakeState };
  if (!g.__piFake) {
    g.__piFake = {
      mode: "ok",
      calls: { create: 0, createAgentSession: 0, toolsDispatched: 0 },
      reset(mode: Mode) {
        this.mode = mode;
        this.calls = { create: 0, createAgentSession: 0, toolsDispatched: 0 };
      },
    };
  }
  return g.__piFake;
}

function makeFakeSession() {
  const listeners = new Set<(event: unknown) => void>();
  let model: { id?: string; input?: string[] } | undefined;
  return {
    get sessionFile() {
      return "/tmp/mcode-fake/pi-session.jsonl";
    },
    get sessionId() {
      return "pi-session-id";
    },
    get model() {
      return model;
    },
    set model(v: { id?: string; input?: string[] } | undefined) {
      model = v;
    },
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    subscribe(cb: (event: unknown) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async prompt() {
      // 派发一次工具执行 —— 让"**没有**派发工具"这条断言在 fresh 路径上**可判别**
      // (否则它在两条路径上都是 0,是空过的假绿)。工具事件经适配器 → ctx.emit(tool.use)。
      state().calls.toolsDispatched++;
      for (const l of listeners)
        l({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "x" } });
      for (const l of listeners) l({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: "ok" });
      // 终态 agent_end → 适配器发 turn.done,回合收尾。
      const frame = {
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      };
      for (const l of listeners) l(frame);
    },
    async sendUserMessage() {
      await this.prompt();
    },
    async abort() {},
    dispose() {},
  };
}

const sdk = {
  SessionManager: {
    open(_path: string) {
      if (state().mode === "reject") throw new Error("FAKE open boom");
      return { kind: "opened" };
    },
    create(_cwd: string) {
      state().calls.create++;
      return { kind: "created" };
    },
    inMemory() {
      return { kind: "memory" };
    },
  },
  ModelRuntime: {
    async create() {
      return { async setRuntimeApiKey() {}, getModel: () => undefined };
    },
  },
  DefaultResourceLoader: class {
    async reload() {}
    getSkills() {
      return { skills: [], diagnostics: [] };
    }
  },
  getAgentDir: () => "/tmp/mcode-fake/pi-agent",
  async createAgentSession(_opts: unknown) {
    state().calls.createAgentSession++;
    return { session: makeFakeSession() };
  },
  createReadToolDefinition: () => ({}),
  createBashToolDefinition: () => ({}),
  VERSION: "fake-0.0.0",
};

export async function loadPiSdk() {
  return sdk;
}

export function polyfillWorkerThreads() {}

/* 模块加载即安装到 globalThis,让 main.ts 在跑任何用例前就能 reset()。 */
state();
