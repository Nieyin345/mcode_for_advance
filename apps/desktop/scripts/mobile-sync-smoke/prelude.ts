/**
 * 浏览器全局 + 假主进程。main.ts **第一个** import 它 —— ES 模块按顺序求值,
 * 这些要在 `lib/api.ts` 执行 `window.api ?? createWebApi()` 之前就位。
 *
 * 与 session-store-smoke 的 prelude 相反:**不给** `window.api`、不设
 * `mcodeElectron` —— 这就是手机网页壳(`isElectron === false`)。
 */
import type { MessageRecord, Project, Session } from "@contracts/session";

/** 假主进程的状态,脚本直接改。 */
export const server = {
  projects: [] as Project[],
  sessionsByProject: {} as Record<string, Session[]>,
  messages: {} as Record<string, MessageRecord[]>,
  settings: {} as Record<string, string>,
  /** 收到的每一条 RPC(方法名 + 入参),按顺序。 */
  calls: [] as Array<{ method: string; input: unknown }>,
};

export function callsOf(method: string): unknown[] {
  return server.calls.filter((c) => c.method === method).map((c) => c.input);
}

function handle(method: string, input: Record<string, unknown>): unknown {
  switch (method) {
    case "project:list":
      return { projects: server.projects };
    case "project:sessions": {
      const pid = input.projectId as string;
      const wt = input.worktree as "only" | "exclude" | undefined;
      const all = (server.sessionsByProject[pid] ?? [])
        .filter((s) => !!s.archived === !!input.archived)
        .filter((s) => (wt === "only" ? !!s.worktreePath : wt === "exclude" ? !s.worktreePath : true));
      return { sessions: all, hasMore: false, total: all.length };
    }
    case "session:listPinned":
      return { sessions: [] };
    case "session:messages": {
      const rows = server.messages[input.sessionId as string] ?? [];
      return { messages: rows, hasMore: false };
    }
    case "session:upsertMessages":
      return { ok: true };
    case "setting:get":
      return { value: server.settings[input.key as string] ?? null };
    case "setting:getMany": {
      const out: Record<string, string | null> = {};
      for (const k of input.keys as string[]) out[k] = server.settings[k] ?? null;
      return out;
    }
    case "setting:set":
      server.settings[input.key as string] = input.value as string;
      return undefined;
    default:
      return undefined;
  }
}

/** 【UI-039】可选的 `session:messages` 响应闸门 —— 每个闸门挂住**一次**调用,直到 `releaseMessages(i)`
 *  放行。用于制造"A 旧请求挂起 → B 新请求先回 → A 迟到"的逆序竞态。 */
type MessagesGate = { released: boolean; resolve: (() => void) | null; started: boolean };
export const messagesGates: MessagesGate[] = [];
/** 让**下一个** `session:messages` 调用挂起(直到 releaseMessages 放行该次序)。 */
export function gateMessages(): void {
  messagesGates.push({ released: false, resolve: null, started: false });
}
/** 放行第 n 个(0-based)被挂住的 `session:messages`。 */
export function releaseMessages(n = 0): void {
  const g = messagesGates[n];
  if (!g) return;
  g.released = true;
  g.resolve?.();
}

const globalTarget = globalThis as unknown as Record<string, unknown>;

globalTarget.fetch = async (url: string, init?: { body?: string }): Promise<unknown> => {
  if (url !== "/api/rpc") throw new Error(`unexpected fetch ${url}`);
  const { method, input } = JSON.parse(init?.body ?? "{}") as { method: string; input: Record<string, unknown> };
  server.calls.push({ method, input });
  // 【UI-039】**先算好这次响应内容**(快照此刻的服务端状态),再等闸门 —— 否则放行时读到的是
  // 更新后的状态,"旧请求带回旧内容"就复现不出来。
  const result = handle(method, input ?? {});
  // `session:messages` 依次消费闸门:第 k 次调用等第 k 个闸门放行 —— 制造响应逆序。
  if (method === "session:messages") {
    const gate = messagesGates.find((g) => !g.started);
    if (gate) {
      gate.started = true;
      if (!gate.released) await new Promise<void>((resolve) => { gate.resolve = resolve; if (gate.released) resolve(); });
    }
  }
  return { status: 200, json: async () => ({ ok: true, result }) };
};

const localStorageMap = new Map<string, string>([["mcode-web-token", "tok_smoke"]]);
export const storage = localStorageMap;

if (typeof (globalThis as unknown as { navigator?: unknown }).navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "McodeSmoke", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
}
globalTarget.window = {};
globalTarget.document = {
  documentElement: { setAttribute: () => {}, lang: "zh" },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  visibilityState: "visible",
};
globalTarget.localStorage = {
  getItem: (k: string) => localStorageMap.get(k) ?? null,
  setItem: (k: string, v: string) => void localStorageMap.set(k, String(v)),
  removeItem: (k: string) => void localStorageMap.delete(k),
  clear: () => localStorageMap.clear(),
  key: (i: number) => [...localStorageMap.keys()][i] ?? null,
  get length() {
    return localStorageMap.size;
  },
};
globalTarget.requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 16) as unknown as number;
globalTarget.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
