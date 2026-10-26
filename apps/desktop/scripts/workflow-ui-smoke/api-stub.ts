import type { Api } from "../../src/preload/index.js";
type Handler = (...args: unknown[]) => unknown;
type MockApi = Record<string, Record<string, Handler> | Handler>;
const host = window as unknown as { __apiImpl?: MockApi; __apiCalls?: string[] };
host.__apiCalls ??= [];
/** 订阅类方法的后缀 —— 它们**返回退订函数**，不是 Promise。 */
const SUBSCRIBER = /(Changed|Changed$|Subscription|Approval|on[A-Z]|^on$)/;

function invoke(namespace: string, method: string | null, args: unknown[]): unknown {
  host.__apiCalls?.push(method ? `${namespace}.${method}` : namespace);
  const space = host.__apiImpl?.[namespace];
  const handler = method === null ? (typeof space === "function" ? space : undefined)
    : typeof space === "object" ? space[method] : undefined;
  if (handler) return handler(...args);
  if (namespace === "on" || /^on[A-Z]/.test(method ?? namespace)) return () => {};
  /* ⚠️ **未打桩的订阅器必须返回退订函数，不能落到 `Promise.resolve(undefined)`。**
   *
   * 真实的 preload 里 `xxxChanged(handler)` / `on.*` 返回的是**函数**，而渲染端会把它
   * 直接当 `useEffect` 的清理函数返回。返回一个 Promise 时 React 卸载会抛
   * `TypeError: destroy_ is not a function`，**React 19 把整棵树卸载** ——
   * 套件里表现为点一下按钮整页空白，而失败信息只有那个类型错误。
   * 实测：`workflow-ui-smoke` 的 `native-editor-entry`。
   *
   * 判据按**形状**（名字以 Changed 结尾 / 带 on 前缀）而不是逐一枚举：
   * 新增订阅器时不需要同时改这里，也不会再掉回 Promise 分支。 */
  if (SUBSCRIBER.test(method ?? namespace)) return () => {};
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
