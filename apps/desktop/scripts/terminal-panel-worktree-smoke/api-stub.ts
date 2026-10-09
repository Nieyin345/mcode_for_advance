/**
 * `@renderer/lib/api.js` 替身:记事 Proxy —— 任何 `api.<ns>.<method>()` 都被记录并回成功。
 *
 * 本套盯的是 TerminalPanel 的**桶清理 effect**(它按"项目根"判桶活不活),判据立在
 * "工作树会话的终端标签还在不在",不依赖任何真实 IPC 回包。桩只是为了 import 能解析。
 */
export const calls: Array<{ method: string; input: unknown }> = [];

function makeNs(ns: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: `${ns}.${prop}`, input: args[0] });
          return Promise.resolve({ ok: true });
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
);
