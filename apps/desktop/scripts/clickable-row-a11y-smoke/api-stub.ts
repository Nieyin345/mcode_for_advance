/**
 * `@renderer/lib/api.js` 替身:一个**记事的 Proxy** —— 任何 `api.<ns>.<method>()`
 * 都被记录并回一个成功的空结果。
 *
 * 这套只关心"某个动作**有没有被触发**"(输入框上的 Enter 会不会真的去提交),
 * 所以判据是 `calls` 里有没有那条调用。
 */
export const calls: Array<{ method: string; input: unknown }> = [];
export function resetCalls(): void {
  calls.length = 0;
}
export function callsOf(method: string): unknown[] {
  return calls.filter((c) => c.method === method).map((c) => c.input);
}

function makeNs(ns: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: `${ns}.${prop}`, input: args[0] });
          return Promise.resolve({ ok: true, sessions: [], requests: [] });
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
