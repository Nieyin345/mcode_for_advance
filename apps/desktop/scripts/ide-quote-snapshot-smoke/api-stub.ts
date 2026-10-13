/**
 * `@renderer/lib/api.js` 替身。`EditPane` 的 warm-start / post-swap 核对会读
 * `api.file.readFile`;其余命名空间给一个"任何方法都返回成功空结果"的 Proxy,
 * 免得某条边角路径一碰就 TypeError。
 */
export const CONTENT = "AAAA first line of selection\nBBBB second line of selection\nCCCC line 3\n";

export const reads: string[] = [];

const asyncNoop = (): Promise<unknown> => Promise.resolve(undefined);

/** 顶层命名空间用 Proxy:`api.<ns>.<method>()` 一律回成功空结果。 */
function makeNs(ns: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return (...args: unknown[]): Promise<unknown> => {
          if (ns === "file" && prop === "readFile") {
            const p = (args[0] as { filePath?: string } | undefined)?.filePath ?? "";
            reads.push(p);
            return Promise.resolve({ content: CONTENT });
          }
          return asyncNoop();
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
