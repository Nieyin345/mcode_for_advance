/**
 * `@renderer/lib/api.js` 替身:能扣住 `file.readFile` 回包的记事 api,外加一个
 * "调了就抛"的所有其它方法 —— 本套只碰 readFile,别的不该被调到。
 *
 * 判据是"切到另一个自定义页签后,上一个文件的旧回包会不会画到新标题底下",所以要能
 * 按任意顺序手动放行两次 readFile。
 */
type Held = { method: string; input: Record<string, unknown>; release: () => void };

export const server = {
  /** filePath → 读到的内容 */
  files: {} as Record<string, string>,
  calls: [] as Array<{ method: string; input: Record<string, unknown> }>,
  hold: new Set<string>(),
  held: [] as Held[],
};

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
  server.files = {};
  server.hold.clear();
}

function handle(method: string, input: Record<string, unknown>): unknown {
  switch (method) {
    case "file:readFile": {
      const fp = (input.filePath as string) ?? "";
      const content = server.files[fp];
      if (content === undefined) throw new Error(`ENOENT: ${fp}`);
      return { content };
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
          // 结果在调用那一刻算出 —— 回包后到,带的仍是当时那份数据。
          // 直接把 **result** 给出去(桌面端 preload 就是这么解包的)。
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
