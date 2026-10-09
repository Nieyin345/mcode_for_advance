/**
 * `@renderer/lib/api.js` 替身:一个**记事的 Proxy** —— 任何 `api.<ns>.<method>()`
 * 都被记录并回一个成功的空结果。
 *
 * 这套只关心"某个动作**有没有被触发**"(new-branch 输入框上的 Enter 会不会真的去
 * 建分支),所以判据是 `calls` 里有没有那条 `git.checkout`。
 */
export const calls: Array<{ method: string; input: unknown }> = [];
/** 按方法名覆盖回包(默认一律 `{ok:true}`)。用来制造"某个 git 动作失败"的场景。 */
export const overrides = new Map<string, unknown>();
export function setOverride(method: string, result: unknown): void {
  overrides.set(method, result);
}
export function resetCalls(): void {
  calls.length = 0;
  overrides.clear();
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
          const key = `${ns}.${prop}`;
          if (overrides.has(key)) return Promise.resolve(overrides.get(key));
          return Promise.resolve({ ok: true });
        };
      },
    },
  );
}

// 顶层命名空间用 Proxy 挂:组件 import 到的每个 `api.x` 都是一层代理。
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
