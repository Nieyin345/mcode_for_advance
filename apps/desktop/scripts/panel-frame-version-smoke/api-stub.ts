/**
 * `@renderer/lib/api.js` 替身:只有 `customUi.stagePanel` 一条,并且**能扣住回包** ——
 * 换版竞态要能手动控制"A 的 stage 先回 / B 的 stage 后回 / B 直接失败"。
 *
 * 内容寻址:同一份 html 得到同一个 `url`(真实现是主进程按文档字节算的),于是同一版
 * 内容跨渲染 key 不变、iframe 不重挂 —— 这正是竞态的舞台。
 *
 * 判据在 main.ts:换版期间旧面板的调用不能被按新配置执行。所以要能按任意顺序放行。
 */
type Held = { method: string; input: Record<string, unknown>; release: () => void };

export const server = {
  /** 已发起的 stage 调用(断言"纯 target 变化不重 stage"用它计数)。 */
  stageCalls: [] as Array<{ html: string; network?: boolean }>,
  /** 非空时,下一次 stage 调用**直接拒绝**(换版失败场景)。 */
  stageThrows: null as string | null,
  hold: new Set<string>(),
  held: [] as Held[],
  /** html → 内容寻址 url。 */
  urls: new Map<string, string>(),
  urlSeq: 0,
};

/** 放行第一条满足条件的挂起回包。 */
export function release(method: string, match?: (input: Record<string, unknown>) => boolean): boolean {
  const i = server.held.findIndex((h) => h.method === method && (!match || match(h.input)));
  if (i < 0) return false;
  const [h] = server.held.splice(i, 1);
  h.release();
  return true;
}

export function resetApi(): void {
  server.stageCalls.length = 0;
  server.held.length = 0;
  server.hold.clear();
  server.stageThrows = null;
  server.urls.clear();
  server.urlSeq = 0;
}

function handle(method: string, input: Record<string, unknown>): unknown {
  switch (method) {
    case "customUi:stagePanel": {
      const html = (input.html as string) ?? "";
      server.stageCalls.push({ html, network: input.network as boolean | undefined });
      if (server.stageThrows !== null) throw new Error(server.stageThrows);
      let url = server.urls.get(html);
      if (!url) {
        url = `mcode-panel://panel/${++server.urlSeq}`;
        server.urls.set(html, url);
      }
      return { url };
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
