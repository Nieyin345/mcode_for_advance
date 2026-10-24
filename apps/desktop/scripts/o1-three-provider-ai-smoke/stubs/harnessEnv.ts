/**
 * O1：三家引擎各自驱动 Docs AI 的**宿主替身**（RuntimeManager / repositories /
 * window / Electron），真实被测对象是 `docsAiPorts` 与三家的适配/工具粘合层。
 *
 * ## 这层替身替的是什么，不替的是什么
 *
 * 替掉的是**每轮都一样的宿主管线**：会话/项目查询、事件订阅、回合句柄、
 * "中断时先关工具调度器再 abort"的接线（生产在 RuntimeManager.sendTurn 的
 * 1679–1729 行，那段拉 db/electron，无头跑不动）。**它不模拟任何一家 provider
 * 的原生事件** —— 那是 `shapes/claude.ts` / `shapes/pi.ts` / `shapes/codex.ts`
 * 三份互不相同的文件的事。把三家接到一份通用事件流上，这张卡就白做了。
 *
 * ## 真实保留的部分
 *
 * - `createExternalToolDispatcher` 是**生产实现**：请求级工具白名单、callId 唯一、
 *   输入 schema 校验、取消闸。替身只决定"谁是审批人"—— 这里视作已「始终允许」
 *   （文档 AI 的确认在生产里发生在 docsAiPorts.confirm 的模态框，不在工具级）。
 * - 传给 `ctx.invokeExternalTool` 的实例与 `input.externalToolHandler` 都来自
 *   真实调用链（docsAiPorts 建的桥），本文件不复制任何一条桥的判据。
 *
 * ## pathWithin 的替身边界
 *
 * 这里只做**字面**包含判定（分隔符归一 + 大小写折叠，与 Windows 上真实现一致）。
 * 真实现还会解析符号链接（`realPathWithin`），那部分由 `path-guard-smoke` 覆盖；
 * 本套件要验的是「docsAiPorts 的围栏在三家 provider 下都拦得住」，不是路径算法的本体。
 */
import { createExternalToolDispatcher } from "@main/providers/nativeToolProtocol.js";
import type {
  ExternalToolDefinition,
  ExternalToolHandler,
  ProviderContext,
  TurnHandle,
} from "@contracts/provider";
import type { RuntimeEvent } from "@contracts/runtime";

export type HarnessSession = {
  id: string;
  projectId: string;
  providerId: string;
  model: string;
  worktreePath: string | null;
};

export type HarnessTurnInput = {
  prompt: string;
  cwd: string;
  userMessage?: unknown;
  externalTools?: ExternalToolDefinition[];
  externalToolHandler?: ExternalToolHandler;
};

export type HarnessTurn = {
  session: HarnessSession;
  input: HarnessTurnInput;
  emit: (event: RuntimeEvent) => void;
  signal: AbortSignal;
  ctx: ProviderContext;
};

export type HarnessDriver = (turn: HarnessTurn) => Promise<unknown>;

export const projects = new Map<string, { id: string; path: string }>();
export const sessions: HarnessSession[] = [];
export const turnCalls: Array<{ sessionId: string; input: HarnessTurnInput }> = [];

const listeners = new Set<(event: RuntimeEvent) => void>();

export const state: {
  driver: HarnessDriver | null;
  lastDriverResult: unknown;
  /** 驱动函数真正开始执行的次数 —— 与 turnCalls 分开：turnCalls 记「请求到达」，
   *  它记「替身真的被跑起来了」。判据里要的是后者，不能拿返回值当代理
   *  （normal 流返回 undefined，「返回值非空」会把它读成「没跑」）。 */
  driverRuns: number;
  activeSubscriptions: number;
  peakSubscriptions: number;
  interruptCalls: number;
} = {
  driver: null,
  lastDriverResult: undefined,
  driverRuns: 0,
  activeSubscriptions: 0,
  peakSubscriptions: 0,
  interruptCalls: 0,
};

export function resetTurnState(): void {
  turnCalls.length = 0;
  state.lastDriverResult = undefined;
  state.driverRuns = 0;
  state.interruptCalls = 0;
}

export function setDriver(driver: HarnessDriver | null): void {
  state.driver = driver;
}

/** 生产 logger 的替身：照实打到 stderr，不静默吞掉适配层警告。 */
function harnessLog(level: string, ...args: unknown[]): void {
  process.stderr.write(`[o1:${level}] ${args.map(String).join(" ")}\n`);
}

const log = {
  info: (...args: unknown[]) => harnessLog("info", ...args),
  warn: (...args: unknown[]) => harnessLog("warn", ...args),
  error: (...args: unknown[]) => harnessLog("error", ...args),
};

/* ── repositories / registry / guards（docsAiPorts.resolveDocsAiSession 的输入） ── */

export const ProjectRepo = {
  get: (id: string) => projects.get(id) ?? null,
};

export const SessionRepo = {
  get: (id: string) => sessions.find((session) => session.id === id) ?? null,
};

export const providerRegistry = {
  get: (id: string) =>
    ["claude-sdk", "pi-sdk", "codex-sdk"].includes(id) ? { id } : undefined,
};

/** 字面包含判定（见文件头「pathWithin 的替身边界」）。 */
export function pathWithin(root: string, abs: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = norm(root);
  const a = norm(abs);
  return a === r || a.startsWith(r + "/");
}

export const getMainWindow = () => ({ isDestroyed: () => false });

/* ── Electron 的唯一用途：docsAiPorts.confirm 的模态框（本套件不走 confirm） ── */

export const dialog = {
  showMessageBox: async () => ({ response: 1 }),
};

/* ── RuntimeManager 替身 ── */

function emitToAll(event: RuntimeEvent): void {
  for (const listener of [...listeners]) listener(event);
}

export const runtimeManager = {
  subscribe(fn: (event: RuntimeEvent) => void): () => void {
    listeners.add(fn);
    state.activeSubscriptions++;
    state.peakSubscriptions = Math.max(state.peakSubscriptions, state.activeSubscriptions);
    return () => {
      if (listeners.delete(fn)) state.activeSubscriptions--;
    };
  },

  async sendTurn(session: HarnessSession, input: HarnessTurnInput): Promise<TurnHandle> {
    const driver = state.driver;
    if (!driver) throw new Error("o1 harness: no turn driver registered");
    turnCalls.push({ sessionId: session.id, input });

    const providerAbort = new AbortController();
    const externalToolAbort = new AbortController();
    // 与 RuntimeManager.sendTurn 同构：请求级调度器拿本轮的关停信号。
    const dispatcher =
      input.externalTools && input.externalTools.length > 0 && input.externalToolHandler
        ? createExternalToolDispatcher({
            sessionId: session.id,
            tools: input.externalTools,
            handler: input.externalToolHandler,
            // 文档 AI 的用户确认在 docsAiPorts.confirm（模态框）；工具级审批在本套件
            // 按「已始终允许」处理，审批语义由 t0 / approval 套件覆盖。
            isToolAlwaysAllowed: () => true,
            isDontAskMode: () => false,
            signal: externalToolAbort.signal,
          })
        : null;

    const ctx: ProviderContext = {
      emit: emitToAll,
      ...(dispatcher
        ? { invokeExternalTool: (call, signal) => dispatcher.invoke(call, signal) }
        : {}),
      log,
    };

    // 生产 RuntimeManager 对 handle.interrupt 的包装（同文件 1714–1729 行）：
    // 先关工具调度器并 abort 本轮的 externalToolAbort，再转给 provider。
    const interrupt = (): void => {
      state.interruptCalls++;
      dispatcher?.close();
      externalToolAbort.abort();
      providerAbort.abort();
    };

    const done = (async () => {
      try {
        state.driverRuns++;
        state.lastDriverResult = await driver({
          session,
          input,
          emit: emitToAll,
          signal: providerAbort.signal,
          ctx,
        });
      } finally {
        dispatcher?.close();
        externalToolAbort.abort();
      }
    })();

    return { done, interrupt, isRunning: () => !providerAbort.signal.aborted };
  },
};
