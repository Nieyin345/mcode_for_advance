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

const globalTarget = globalThis as unknown as Record<string, unknown>;

globalTarget.fetch = async (url: string, init?: { body?: string }): Promise<unknown> => {
  if (url !== "/api/rpc") throw new Error(`unexpected fetch ${url}`);
  const { method, input } = JSON.parse(init?.body ?? "{}") as { method: string; input: Record<string, unknown> };
  server.calls.push({ method, input });
  const result = handle(method, input ?? {});
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
