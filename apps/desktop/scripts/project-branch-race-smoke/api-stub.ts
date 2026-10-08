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
  calls: [] as Array<{ method: string; input: Record<string, unknown> }>,
  hold: new Set<string>(),
  held: [] as Held[],
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

export function resetApi(): void {
  server.calls.length = 0;
  server.held.length = 0;
  server.repos = {};
  server.statusBranch = {};
  server.statusFiles = {};
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
          // 结果在调用那一刻算出 —— 回包后到,带的仍是当时那份数据。
          // 直接把 **result** 给出去(桌面端 preload 就是这么解包的),不是 {ok,result} 信封。
          const result = handle(method, input ?? {});
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
