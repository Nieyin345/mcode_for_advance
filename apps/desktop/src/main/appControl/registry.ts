/**
 * **RPC 处理函数登记处** —— `ipc/index.ts` 的 `createDbGuardedIpc` 每注册一条 handler
 * 就在这里留一份,`app_api_call` 由此**直接调用同一个函数**(与界面点按钮走的是同一段代码,
 * 连 `awaitDb()` 那道闸都一样)。
 *
 * 纯模块:不 import electron。没有任何 handler 读 `event.sender`(2026-10-02 查过 ipc/ 全部),
 * 所以调用时给一个空事件对象即可。
 */

export type RecordedRpcHandler = (event: unknown, raw: unknown) => unknown;

const handlers = new Map<string, RecordedRpcHandler>();

export function recordRpcHandler(channel: string, handler: RecordedRpcHandler): void {
  handlers.set(channel, handler);
}

export function rpcHandlerFor(channel: string): RecordedRpcHandler | undefined {
  return handlers.get(channel);
}

export function registeredRpcChannels(): string[] {
  return [...handlers.keys()];
}

/** 测试用。 */
export function clearRpcHandlers(): void {
  handlers.clear();
}
