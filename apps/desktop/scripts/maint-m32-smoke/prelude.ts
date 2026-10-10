/**
 * 浏览器全局 + 一个**可以扣住回包**的假主进程。main.ts 第一个 import 它 ——
 * ES 模块按顺序求值,这些要在 `lib/api.ts` 跑 `window.api ?? createWebApi()`
 * 之前就位(不给 `window.api`,于是走真的 `createWebApi()`,和手机一样)。
 *
 * 与 mobile-sync-smoke 的 prelude 的唯一区别:`hold` 里的方法**不立刻回**,
 * 挂进 `held` 等测试按任意顺序放行 —— 这就是"弱网下旧回包后到"。
 */
import type { GitRepo, GitStatusResult } from "@contracts/ipc";
import type { Project } from "@contracts/session";

type Held = { method: string; input: Record<string, unknown>; release: () => void };

export const server = {
  projects: [] as Project[],
  /** projectPath → 发现到的仓库 */
  repos: {} as Record<string, GitRepo[]>,
  /** repoPath → 状态 */
  status: {} as Record<string, GitStatusResult>,
  calls: [] as Array<{ method: string; input: Record<string, unknown> }>,
  /** 这些方法的回包要手动放行 */
  hold: new Set<string>(),
  held: [] as Held[],
  /** 这些方法直接 **reject**(模拟 IPC 真抛:参数不过校验 / 传输断)。 */
  reject: new Set<string>(),
  rejectMsg: "mock: IPC 传输中断",
};

export function callsOf(method: string): Array<Record<string, unknown>> {
  return server.calls.filter((c) => c.method === method).map((c) => c.input);
}

/** 放行第一条满足条件的挂起回包(按 method + 入参字段匹配)。 */
export function release(method: string, match?: (input: Record<string, unknown>) => boolean): boolean {
  const i = server.held.findIndex((h) => h.method === method && (!match || match(h.input)));
  if (i < 0) return false;
  const [h] = server.held.splice(i, 1);
  h.release();
  return true;
}

function handle(method: string, input: Record<string, unknown>): unknown {
  switch (method) {
    case "project:list":
      return { projects: server.projects };
    case "project:sessions":
      return { sessions: [], hasMore: false, total: 0 };
    case "session:listPinned":
      return { sessions: [] };
    case "setting:get":
      return { value: null };
    case "setting:getMany":
      return {};
    case "git:discoverRepos":
      return { repos: server.repos[input.projectPath as string] ?? [] };
    case "git:status":
      return { status: server.status[input.repoPath as string] ?? null };
    default:
      return undefined;
  }
}

const globalTarget = globalThis as unknown as Record<string, unknown>;

globalTarget.fetch = async (url: string, init?: { body?: string }): Promise<unknown> => {
  if (url !== "/api/rpc") throw new Error(`unexpected fetch ${url}`);
  const { method, input } = JSON.parse(init?.body ?? "{}") as {
    method: string;
    input: Record<string, unknown>;
  };
  server.calls.push({ method, input: input ?? {} });
  // 强制 reject —— 用来驱动"IPC 真抛"那一类(读 diff 失败)。
  if (server.reject.has(method)) {
    return { status: 500, json: async () => ({ ok: false, error: server.rejectMsg }) };
  }
  // 结果在**调用那一刻**算出来 —— 回包后到,带的仍是当时那份数据。
  const result = handle(method, input ?? {});
  const resp = { status: 200, json: async () => ({ ok: true, result }) };
  if (server.hold.has(method)) {
    return await new Promise((res) => {
      server.held.push({ method, input: input ?? {}, release: () => res(resp) });
    });
  }
  return resp;
};

const localStorageMap = new Map<string, string>([["mcode-web-token", "tok_smoke"]]);

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
globalTarget.getComputedStyle = () => ({ lineHeight: "18" });
globalTarget.requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 16) as unknown as number;
globalTarget.cancelAnimationFrame = (h: number) => clearTimeout(h);
