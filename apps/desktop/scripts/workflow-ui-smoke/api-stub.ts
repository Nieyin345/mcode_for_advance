import type { Api } from "../../src/preload/index.js";
type Handler = (...args: unknown[]) => unknown;
type MockApi = Record<string, Record<string, Handler> | Handler>;
const host = window as unknown as { __apiImpl?: MockApi; __apiCalls?: string[] };
host.__apiCalls ??= [];
function invoke(namespace: string, method: string | null, args: unknown[]): unknown {
  host.__apiCalls?.push(method ? `${namespace}.${method}` : namespace);
  const space = host.__apiImpl?.[namespace];
  const handler = method === null ? (typeof space === "function" ? space : undefined)
    : typeof space === "object" ? space[method] : undefined;
  if (handler) return handler(...args);
  if (namespace === "on" || /^on[A-Z]/.test(method ?? namespace)) return () => {};
  return Promise.resolve(undefined);
}
// A type-only boundary to the actual preload API, not an alternative implementation.
// All effects are in-memory; unknown reads cannot reach Electron or the network.
export const api = new Proxy({}, {
  get(_target, namespace) {
    if (typeof namespace !== "string") return undefined;
    return new Proxy((...args: unknown[]) => invoke(namespace, null, args), {
      get(_space, method) {
        if (typeof method !== "string") return undefined;
        return (...args: unknown[]) => invoke(namespace, method, args);
      },
    });
  },
}) as unknown as Api;
