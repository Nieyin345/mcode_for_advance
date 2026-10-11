/**
 * 【MC-076】`./piSdkLoader.js` 的相对替身(经 `--external:` 外置 + 铺同名文件)。
 * 无任何 import,保证单独打包可跑。
 *
 * 行为由 `globalThis.__piFake.reset(mode)` 驱动:
 *   - "ok":`createAgentSession` 立刻返回假会话。
 *   - "late":`createAgentSession` **延迟**返回(模拟初始化慢),给宿主超时 abort 留出
 *     窗口 —— provider 应在会话迟到建成时**主动 `dispose()`**(不把未归还的会话留在后台)。
 *   - "hang":`createAgentSession` 永不返回(彻底挂死),provider 拿不到会话可释放,
 *     验证"底层未 settle → 探测服务保持 cancelling、不再另起"。
 *
 * `disposeCount` 是断言「超时确实触发了资源释放」的唯一观测点。
 */
type Mode = "ok" | "late" | "hang";

interface PiFakeState {
  mode: Mode;
  createCount: number;
  disposeCount: number;
  lastSessionFile: string;
  reset(mode: Mode): void;
}

function state(): PiFakeState {
  const g = globalThis as unknown as { __piFake?: PiFakeState };
  if (!g.__piFake) {
    g.__piFake = {
      mode: "ok",
      createCount: 0,
      disposeCount: 0,
      lastSessionFile: "/tmp/mcode-fake/pi-session.jsonl",
      reset(mode: Mode) {
        this.mode = mode;
        this.createCount = 0;
        this.disposeCount = 0;
      },
    };
  }
  return g.__piFake;
}

function makeFakeSession() {
  const s = state();
  const listeners = new Set<(event: unknown) => void>();
  return {
    get sessionFile() {
      return s.lastSessionFile;
    },
    get sessionId() {
      return "pi-session-id";
    },
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    subscribe(cb: (event: unknown) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async prompt() {
      for (const l of listeners) l({ type: "agent_end", willRetry: false, messages: [] });
    },
    async abort() {},
    dispose() {
      s.disposeCount += 1;
    },
  };
}

const sdk = {
  SessionManager: {
    open(_path: string) {
      return { kind: "opened" };
    },
    create(_cwd: string) {
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
  },
  getAgentDir: () => "/tmp/mcode-fake/pi-agent",
  async createAgentSession(_opts: unknown) {
    const s = state();
    s.createCount += 1;
    if (s.mode === "hang") return new Promise<never>(() => {});
    if (s.mode === "late") await new Promise((res) => setTimeout(res, 25));
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

/* 模块加载即安装到 globalThis。 */
state();
