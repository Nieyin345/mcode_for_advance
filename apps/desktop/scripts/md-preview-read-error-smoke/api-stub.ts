/**
 * `@renderer/lib/api.js` 替身 —— 可编程的 `file.readFile`。
 *
 * 这套只关心一件事:读文件**失败**时预览面板画什么。所以 `readFile` 由测试通过
 * `__setRead()` 喂:返回内容、或抛指定错误、或永远 pending(验加载态)。
 * 其余命名空间仍走 Proxy(传递依赖可能顺手读一个),不在判据内。
 */
type ReadPlan =
  | { kind: "ok"; content: string }
  | { kind: "error"; message: string };
let plan: ReadPlan = { kind: "ok", content: "" };
export function __setRead(next: ReadPlan): void {
  plan = next;
}
export const readCalls: string[] = [];

function makeNs(ns: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return (...args: unknown[]): Promise<unknown> => {
          if (ns === "file" && prop === "readFile") {
            const p = (args[0] as { filePath?: string } | undefined)?.filePath ?? "";
            readCalls.push(p);
            if (plan.kind === "error") return Promise.reject(new Error(plan.message));
            return Promise.resolve({ content: plan.content });
          }
          return Promise.resolve(undefined);
        };
      },
    },
  );
}

const namespaces = new Map<string, unknown>();
export const api = new Proxy(
  {},
  {
    get(_t, ns: string) {
      if (typeof ns !== "string") return undefined;
      let v = namespaces.get(ns);
      if (!v) {
        v = makeNs(ns);
        namespaces.set(ns, v);
      }
      return v;
    },
  },
);
