/**
 * `@renderer/lib/api.js` 替身:能扣住 plugins/mcp 的 `projectList` 回包。
 *
 * 判据是"切项目后,上一个项目的 projectList 迟到回包会不会画到新项目这一页",所以要能
 * 按任意顺序手动放行。其余方法一律抛(本套只碰这两个)。
 */
type Held = { method: string; input: Record<string, unknown>; release: () => void };

export const server = {
  /** projectPath → 该项目的插件行 */
  pluginRows: {} as Record<string, unknown[]>,
  /** projectPath → 该项目的 MCP 列表 */
  mcpLists: {} as Record<string, unknown>,
  calls: [] as Array<{ method: string; input: Record<string, unknown> }>,
  hold: new Set<string>(),
  held: [] as Held[],
};

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
  server.pluginRows = {};
  server.mcpLists = {};
  server.hold.clear();
}

function handle(method: string, input: Record<string, unknown>): unknown {
  switch (method) {
    case "plugins:projectList": {
      const pp = (input.projectPath as string) ?? "";
      return { plugins: server.pluginRows[pp] ?? [] };
    }
    case "mcp:projectList": {
      const pp = (input.projectPath as string) ?? "";
      return server.mcpLists[pp] ?? { file: `${pp}/.mcp.json`, exists: false, servers: [], invalid: [] };
    }
    default:
      throw new Error(`unexpected api call: ${method}`);
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
          let result: unknown;
          let error: unknown = null;
          try {
            result = handle(method, input ?? {});
          } catch (e) {
            error = e;
          }
          if (server.hold.has(method)) {
            return new Promise((res, rej) => {
              server.held.push({
                method,
                input: input ?? {},
                release: () => (error !== null ? rej(error) : res(result)),
              });
            });
          }
          return error !== null ? Promise.reject(error) : Promise.resolve(result);
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
