/**
 * 假的 `@earendil-works/pi-coding-agent` —— 只给 `skill-delivery-smoke` 用
 * (`--alias:` 认包名)。
 *
 * ## 它按 Pi 真实语义扫 `additionalSkillPaths`
 *
 * `DefaultResourceLoader` 对每个 root 真按 `<root>/<name>/SKILL.md` 扫一遍,并原样套用
 * provider 传进来的 `skillsOverride`。这样 `PiAgentSdkProvider.startTurn` 里**真的**
 * `buildPiSkillLoader`(allowSet 构造 / 项目根并入 / 同名优先级 override)被完整驱动,
 * 而交付结果经 `createAgentSession` 收到的那个真实 loader 暴露给本套件
 * (`globalThis.__piDelivery`)—— 断言立在「Pi 引擎**最终**看到的技能集合 + baseDir」上。
 *
 * 其余导出(SessionManager / ModelRuntime / createAgentSession / 工具构造 / getAgentDir)
 * 复刻 provider 用到的形状;假 session 在 `prompt()` 时派发一次 `agent_end`,让回合收尾。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Skill = { name: string; baseDir?: string };
export type ResourceDiagnostic = { message: string };

export function getAgentDir(): string {
  return join(process.env["MCODE_SMOKE_AGENT_DIR"] ?? "/nonexistent-pi-agent", "agent");
}

interface FakeLoaderOptions {
  additionalSkillPaths?: string[];
  skillsOverride?: (base: {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  }) => { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
}

function scanRoot(root: string): Skill[] {
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      if (!statSync(join(dir, "SKILL.md")).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ name: entry, baseDir: dir });
  }
  return out;
}

export class DefaultResourceLoader {
  private opts: FakeLoaderOptions;
  private resolved: Skill[] = [];
  constructor(opts: FakeLoaderOptions) {
    this.opts = opts;
  }
  async reload(): Promise<void> {
    const found: Skill[] = [];
    for (const root of this.opts.additionalSkillPaths ?? []) {
      found.push(...scanRoot(root));
    }
    const out = this.opts.skillsOverride
      ? this.opts.skillsOverride({ skills: found, diagnostics: [] })
      : { skills: found, diagnostics: [] };
    this.resolved = out.skills;
  }
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return { skills: this.resolved, diagnostics: [] };
  }
}

function makeFakeSession() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    sessionFile: "/tmp/mcode-fake/pi-session.jsonl",
    sessionId: "pi-session-id",
    model: undefined as { id?: string; input?: string[] } | undefined,
    getSessionStats: () => ({ tokens: { total: 0 }, cost: 0 }),
    getContextUsage: () => undefined,
    subscribe(cb: (event: unknown) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async prompt() {
      for (const l of listeners) {
        l({
          type: "agent_end",
          willRetry: false,
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        });
      }
    },
    async sendUserMessage() {
      await this.prompt();
    },
    async abort() {},
    dispose() {},
  };
}

/** 本套件观察 Pi 交付的窗口:最近一次 createAgentSession 收到的 resourceLoader、
 *  以及【MC-100/101】模型可见工具白名单(`tools`)与内置禁用(`excludeTools`)。 */
interface PiDelivery {
  loader: DefaultResourceLoader | null;
  /** createAgentSession 收到的 `tools`(undefined = 引擎「启用全部」)。 */
  tools: unknown;
  /** createAgentSession 收到的 `excludeTools`。 */
  excludeTools: unknown;
  calls: number;
}
function delivery(): PiDelivery {
  const g = globalThis as unknown as { __piDelivery?: PiDelivery };
  if (!g.__piDelivery) g.__piDelivery = { loader: null, tools: undefined, excludeTools: undefined, calls: 0 };
  return g.__piDelivery;
}

const sdk = {
  SessionManager: {
    open: (_path: string) => ({ kind: "opened" }),
    create: (_cwd: string) => ({ kind: "created" }),
    inMemory: () => ({ kind: "memory" }),
  },
  ModelRuntime: {
    async create() {
      return {
        async setRuntimeApiKey() {},
        getModel: () => ({ id: "m1", input: ["text"] }),
      };
    },
  },
  DefaultResourceLoader,
  getAgentDir,
  async createAgentSession(opts: { resourceLoader?: DefaultResourceLoader; tools?: unknown; excludeTools?: unknown }) {
    const d = delivery();
    d.calls += 1;
    d.loader = opts.resourceLoader ?? null;
    d.tools = opts.tools;
    d.excludeTools = opts.excludeTools;
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

delivery();
