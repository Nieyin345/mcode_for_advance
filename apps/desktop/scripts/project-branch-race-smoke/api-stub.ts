/**
 * `@renderer/lib/api.js` 替身:一个**能扣住回包**的记事 api。
 *
 * 判据是"切项目后,旧项目的 `git:status` 回包会不会把新项目的分支盖掉",所以
 * `git.status` 的回包要能按任意顺序手动放行(弱网下旧回包后到)。其余方法立刻回。
 */
type Held = { method: string; input: Record<string, unknown>; release: () => void };

export const server = {
  /** projectPath → 发现到的仓库 */
  repos: {} as Record<string, { path: string; name: string; isRepo: true }[]>,
  /** repoPath → status 里的分支名(回值在**调用那一刻**算出来) */
  statusBranch: {} as Record<string, string>,
  statusFiles: {} as Record<string, string>,
  /** worktreePath → 那棵树有没有未并回的活(true 时工具按钮出现)。 */
  worktreeDirty: {} as Record<string, boolean>,
  /** repoPath → 该仓库的工作树列表(回值在调用那一刻快照)。 */
  worktreeLists: {} as Record<string, Array<Record<string, unknown>>>,
  /** source(HEAD)→ mergePreview 回值;测切树竞态时给不同树不同的 incoming。 */
  mergePreviews: {} as Record<string, Record<string, unknown>>,
  calls: [] as Array<{ method: string; input: Record<string, unknown> }>,
  hold: new Set<string>(),
  held: [] as Held[],
  /** method → 直接返回的覆盖值(替代 handle 的默认回值)。 */
  overrides: {} as Record<string, unknown>,
  /** 这些 method 直接 **reject**(模拟 IPC 真抛:参数不过校验 / 传输断)。 */
  reject: new Set<string>(),
  rejectMsg: "mock: IPC 传输中断",
  /** 只让 `git:worktreeList` 对这些 repoPath 拒 —— 用来验"一个仓库失败不拖累别的"。 */
  worktreeListReject: new Set<string>(),
};

export function callsOf(method: string): Array<Record<string, unknown>> {
  return server.calls.filter((c) => c.method === method).map((c) => c.input);
}

/** 放行第一条满足条件的挂起回包。 */
export function release(method: string, match?: (input: Record<string, unknown>) => boolean): boolean {
  const i = server.held.findIndex((h) => h.method === method && (!match || match(h.input)));
  if (i < 0) return false;
  const [h] = server.held.splice(i, 1);
  h.release();
  return true;
}

/** 放行**最后**一条满足条件的挂起回包(输入相同、要靠发起先后区分新旧时用)。 */
export function releaseLast(method: string, match?: (input: Record<string, unknown>) => boolean): boolean {
  for (let i = server.held.length - 1; i >= 0; i--) {
    const h = server.held[i];
    if (h.method === method && (!match || match(h.input))) {
      server.held.splice(i, 1);
      h.release();
      return true;
    }
  }
  return false;
}

export function resetApi(): void {
  server.calls.length = 0;
  server.held.length = 0;
  server.repos = {};
  server.statusBranch = {};
  server.statusFiles = {};
  server.worktreeLists = {};
  server.mergePreviews = {};
  server.overrides = {};
  server.reject.clear();
  server.worktreeListReject.clear();
  server.hold.clear();
}

function handle(method: string, input: Record<string, unknown>): unknown {
  switch (method) {
    case "git:discoverRepos":
      return { repos: server.repos[input.projectPath as string] ?? [] };
    case "git:status": {
      const rp = input.repoPath as string;
      return {
        status: {
          branch: server.statusBranch[rp] ?? "",
          ahead: 0,
          behind: 0,
          files: server.statusFiles[rp] ? [{ path: server.statusFiles[rp], index: "unmodified", workingTree: "modified" }] : [],
        },
      };
    }
    case "git:listBranches":
      return { branches: { current: "", detached: false, local: [], remote: [], tags: [] } };
    case "git:worktreeStatus": {
      const wp = (input.worktreePath as string) ?? "";
      // 每棵树配一份"有没有活"的判定(由测试通过 server.worktreeDirty 指定)。
      const dirty = server.worktreeDirty[wp] ?? false;
      return { status: { dirty, merged: !dirty } };
    }
    case "git:worktreeList": {
      // 回值在**调用那一刻**快照 —— 测试先改 server.worktreeLists 再放行旧回包,
      // 旧回包带的仍是当时那份列表(竞态据此显形)。
      const rp = (input.repoPath as string) ?? "";
      return { worktrees: server.worktreeLists[rp] ?? [] };
    }
    case "git:mergePreview": {
      // 按 source(源的 HEAD)区分 —— 每棵树给不同的 incoming,切树竞态才可判。
      const src = (input.source as string) ?? "";
      return server.mergePreviews[src] ?? { ok: true, upToDate: false, fastForward: true, incomingCommits: 1 };
    }
    default:
      return {};
  }
}

function makeNs(ns: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (typeof prop !== "string") return undefined;
        return (input: Record<string, unknown>) => {
          const method = `${ns}:${prop}`;
          server.calls.push({ method, input: input ?? {} });
          // 覆盖值 / 强制 reject —— 用来驱动"IPC 真抛"那一类(删工作树失败).
          if (server.reject.has(method)) {
            return Promise.reject(new Error(server.rejectMsg));
          }
          // 逐仓库拒(只 worktreeList):验"一个仓库失败不拖累别的仓库"用。
          if (method === "git:worktreeList" && server.worktreeListReject.has(input.repoPath as string)) {
            return Promise.reject(new Error(server.rejectMsg));
          }
          const result = method in server.overrides ? server.overrides[method] : handle(method, input ?? {});
          // 结果在调用那一刻算出 —— 回包后到,带的仍是当时那份数据。
          // 直接把 **result** 给出去(桌面端 preload 就是这么解包的),不是 {ok,result} 信封。
          if (server.hold.has(method)) {
            return new Promise((res) => {
              server.held.push({ method, input: input ?? {}, release: () => res(result) });
            });
          }
          return Promise.resolve(result);
        };
      },
    },
  );
}

const namespaces = new Map<string, unknown>();
export const api = new Proxy(
  {},
  {
    get(_t, prop: string) {
      if (typeof prop !== "string") return undefined;
      if (!namespaces.has(prop)) namespaces.set(prop, makeNs(prop));
      return namespaces.get(prop);
    },
  },
) as unknown;
