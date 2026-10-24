/**
 * **桌面 IPC 的统一包装层** —— 单独成文件,因为它有两条**必须能被直接测到**的行为:
 *
 *   1. 每条 handler 执行前 `awaitDb()`(渲染端可能在 sql.js 就绪前就发 IPC);
 *   2. 【MC-014】入参带 `__operationId` 且通道属于有副作用的档位时,先过共享操作账本
 *      (`appControl/channelIdempotency.ts`,与 `app_api_call` 同一份账本)。
 *
 * 从 `ipc/index.ts` 拆出来是为了让冒烟能**导入真函数**而不是复制一份形状 ——
 * `ipc/index.ts` 顶部 import 了全部 40+ 个 register* 模块,把整棵主进程依赖图拖进
 * bundle(实测:nodeTypesSeed 的 ?raw、relay 的 .py、sherpa 的 .node 全炸)。
 * 行为不变:index.ts 仍调用本文件,并把同一份 handler 登记给 `app_api_call`。
 *
 * ## 为什么它必须实现 IpcMain 的**全部**注册面（2026-10-24, O4）
 *
 * 本函数声明返回 `IpcMain`,生产装配（`ipc/index.ts:209`）按这个声明把它当 `IpcMain`
 * 交给每一个 `register*Handlers`。曾经它只实现 `handle`（以及一个 `as unknown as
 * IpcMain` 强转）—— **类型在撒谎**。`ipc/documentView.ts:212` 的
 * `if (typeof ipc.on === 'function')` 因此在生产里恒假：docs 页面回报的
 * `close-check-result` 落在无人监听的通道上，宿主 2 秒超时后按 fail-closed 拒绝
 * 关闭 —— 用户看到的是「编辑器未响应关闭检查」，而原因是一个缺失的方法。
 * 只有 `documentView` 这一条走 `ipc.on`，所以五家原厂编辑器关闭都正常、只有 docs 恒被拒。
 *
 * 所以这里实现 `handle` / `handleOnce` / `on` / `addListener` / `once` /
 * `prependListener` / `prependOnceListener` / `off` / `removeListener` /
 * `removeAllListeners` / `removeHandler` 与 EventEmitter 的只读面（`emit` /
 * `listenerCount` / `listeners` / `rawListeners` / `eventNames` /
 * `getMaxListeners` / `setMaxListeners`），**不允许再出现只实现一半的 IpcMain**。
 *
 * `on` 与 `handle` 走**同一道 `awaitDb()` 闸**：监听器在数据库未就绪时排队，
 * 就绪后才执行、init 失败则记日志不执行 —— 与 handle 的 fail-closed 同一条取向。
 * （`close-check-result` 只更新宿主内存状态、不碰数据库，但闸的语义必须一致：
 * 同一个包装层里两种回调执行时机不同，下一条用到 `on` 的接线就会踩在差异上。）
 */
import type { IpcMain } from "electron";
import { recordRpcHandler } from "@main/appControl/registry.js";
import { policyFor } from "@main/appControl/policy.js";
import { thrownResultKind } from "@main/appControl/commandOutcome.js";
import {
  DESKTOP_OPERATION_ID_KEY,
  beginChannelOperation,
  channelOperationResult,
  idempotencyApplies,
  methodForChannel,
  operationIdFromIpcInput,
} from "@main/appControl/channelIdempotency.js";
import { errText } from "@main/lib/ipcError.js";
import { log } from "@main/lib/logger.js";
import { awaitDb } from "@main/store/db.js";

/** `IpcMain` 的监听器签名 —— 与 Electron 的 `IpcMainEvent` 结构兼容（本模块不读 event 字段）。 */
type IpcListener = (event: never, ...args: never[]) => void;

/** 四种"注册监听器"的方法名（语义差异交给底层 EventEmitter 的同名方法）。 */
type ListenerRegistration = "on" | "once" | "prependListener" | "prependOnceListener";

export function createDbGuardedIpc(target: IpcMain): IpcMain {
  /**
   * 原始 listener → 包装层换进去的 listener（按通道）。
   * `removeListener(原函数)` 必须能摘掉包装后的那个 —— 包装层为了加 `awaitDb()`
   * 换了一个函数对象，直接透传会让调用方手里的原函数**永远摘不掉**，
   * 而症状（监听器越积越多 / 摘了还在响）离原因同样很远。
   */
  const wrappedListeners = new Map<string, Map<unknown, unknown>>();

  /**
   * 监听器的统一包装：与 `handle` 同一道 `awaitDb()` 闸。
   * init 失败（reject）时记 error、不执行 —— 与 handle 抛给 IPC 错误通道同一条
   * fail-closed 取向；吞掉拒绝会让「数据库坏了」变成「回调静默不跑」。
   *
   * `sweepAfterFire`：`once` / `prependOnceListener` 的登记在触发后自动失效 ——
   * 把事件账里的那一条也删掉，否则 `removeListener` 的映射会随每次 once 累积。
   */
  const guardListener = (
    channel: string,
    listener: IpcListener,
    sweepAfterFire?: () => void,
  ): ((event: unknown, ...args: unknown[]) => void) => {
    const guarded = (event: unknown, ...args: unknown[]): void => {
      void awaitDb().then(
        () => {
          try {
            sweepAfterFire?.();
            (listener as (event: unknown, ...args: unknown[]) => void)(event, ...args);
          } catch (err) {
            // 与裸 EventEmitter 的差异：这里不再向调用栈抛（那是 uncaughtException）。
            // 记到主进程日志，保持「坏东西显式报出来」。
            log.error(`ipc.on ${channel} 监听器抛错：${errText(err)}`);
          }
        },
        (err) => {
          sweepAfterFire?.();
          log.error(`ipc.on ${channel} 监听器未执行：数据库未就绪（${errText(err)}）`);
        },
      );
    };
    return guarded;
  };

  const addGuardedListener = (method: ListenerRegistration, channel: string | symbol, listener: unknown): IpcMain => {
    // `IpcMain` 的 prepend* 重载在 typings 里带 `string | symbol`（NodeJS.EventEmitter
    // 的签名），实际通道恒为 string；事件账（wrappedListeners）按字符串记。
    const channelKey = typeof channel === "string" ? channel : String(channel);
    // 非函数按原样交给底层（错误的用法应报出 Electron/Node 自己的错，不在这里改写）。
    if (typeof listener !== "function") {
      (target[method] as (channel: string | symbol, listener: unknown) => unknown)(channel, listener);
      return wrapped;
    }
    const once = method === "once" || method === "prependOnceListener";
    let byOriginal: Map<unknown, unknown> | undefined;
    const sweep = (): void => {
      byOriginal?.delete(listener);
      if (byOriginal !== undefined && byOriginal.size === 0) wrappedListeners.delete(channelKey);
    };
    const guarded = guardListener(channelKey, listener as IpcListener, once ? sweep : undefined);
    byOriginal = wrappedListeners.get(channelKey);
    if (byOriginal === undefined) {
      byOriginal = new Map();
      wrappedListeners.set(channelKey, byOriginal);
    }
    byOriginal.set(listener, guarded);
    (target[method] as (channel: string | symbol, listener: unknown) => unknown)(channel, guarded);
    return wrapped;
  };

  const removeGuardedListener = (channel: string, listener: unknown): IpcMain => {
    const byOriginal = wrappedListeners.get(channel);
    const guarded = byOriginal?.get(listener);
    if (guarded !== undefined) {
      byOriginal!.delete(listener);
      if (byOriginal!.size === 0) wrappedListeners.delete(channel);
      (target.removeListener as (channel: string, listener: unknown) => unknown)(channel, guarded);
      return wrapped;
    }
    // 不是包装层注册的（例如别人的直接注册）：原样透传，不改变既有语义。
    (target.removeListener as (channel: string, listener: unknown) => unknown)(channel, listener);
    return wrapped;
  };

  const guardedHandler = (
    channel: string,
    handler: (event: never, raw: never) => unknown,
  ): ((event: unknown, raw: unknown) => unknown) => {
    return async (event: unknown, raw: unknown) => {
      await awaitDb();
      const operationId = operationIdFromIpcInput(raw);
      if (operationId !== null) {
        const method = methodForChannel(channel);
        // 查不到方法（渲染端专用通道）/ 无副作用 → 不介入。
        // 【MC-014】判的必须是**副作用**而不是授权档:scene.apply / scene.resume /
        // unattended.run 对 Agent 是 blocked,但桌面用户重试同一个 `__operationId`
        // 会重复执行真实写 —— `idempotencyApplies(方法名)` 走 `sideEffectClassOf`,
        // 这些通道已在 `policy.ts` 的 BLOCKED_MUTATING 里显式标出。
        if (method !== null && idempotencyApplies(method)) {
          const decision = beginChannelOperation({
            operationId,
            ownerId: "desktop-ipc",
            sessionId: "desktop-ipc",
            sceneId: "desktop-ipc",
            method,
            input: stripOperationId(raw),
            grantRevision: "desktop-ipc",
          });
          if (decision.kind === "replay") {
            // 回放已结算的结果。body 是成功时的 JSON 序列化；序列化不了（Buffer/Date 等）
            // 时退回 undefined —— 调用方带幂等键时就接受了「重放可能拿不到正文」这个约定，
            // 关键是**副作用不重复**。
            return decision.body === undefined ? undefined : JSON.parse(decision.body);
          }
          if (decision.kind !== "execute") {
            // 拒绝/在途/冲突：抛给渲染端（IPC 的错误通道），带稳定 code。
            const err = new Error(decision.reason) as Error & { code?: string };
            err.code = `operation_${decision.kind}`;
            throw err;
          }
          try {
            const out = await (handler as (event: unknown, raw: unknown) => unknown)(event, raw);
            let body: string | undefined;
            try {
              body = JSON.stringify(out);
            } catch {
              body = undefined; // 不可 JSON 化的结果：记账但不存正文
            }
            decision.settle(channelOperationResult("SUCCEEDED", method, operationId), body);
            return out;
          } catch (err) {
            // 与 app_api_call 同判据：写档抛错 → UNCERTAIN（可能已部分提交）。
            decision.settle(
              channelOperationResult(thrownResultKind(err, policyFor(method).level), method, operationId, {
                code: "rpc_failed",
                reason: errText(err),
              }),
            );
            throw err;
          }
        }
      }
      return (handler as (event: unknown, raw: unknown) => unknown)(event, raw);
    };
  };

  const wrapped: IpcMain = {
    handle(channel, handler) {
      const guarded = guardedHandler(channel, handler as (event: never, raw: never) => unknown);
      target.handle(channel, guarded as never);
      // 同一个函数留一份给 mcode-app 的 `app_api_call`(agent 调功能 = 界面按按钮,走同一段代码)。
      recordRpcHandler(channel, guarded as (event: unknown, raw: unknown) => unknown);
    },
    handleOnce(channel, handler) {
      // 单次 handler 同样过 `awaitDb()`；但不登记进 registry —— 它执行一次就从
      // Electron 消失，把一条"随时可调"的 RPC 暴露给 `app_api_call` 是假的。
      target.handleOnce(channel, guardedHandler(channel, handler as (event: never, raw: never) => unknown) as never);
    },
    on(channel, listener) {
      return addGuardedListener("on", channel, listener);
    },
    addListener(channel, listener) {
      return addGuardedListener("on", channel, listener);
    },
    once(channel, listener) {
      return addGuardedListener("once", channel, listener);
    },
    prependListener(channel, listener) {
      return addGuardedListener("prependListener", channel, listener);
    },
    prependOnceListener(channel, listener) {
      return addGuardedListener("prependOnceListener", channel, listener);
    },
    off(channel, listener) {
      return removeGuardedListener(channel, listener);
    },
    removeListener(channel, listener) {
      return removeGuardedListener(channel, listener);
    },
    removeAllListeners(channel?: string) {
      if (channel === undefined) wrappedListeners.clear();
      else wrappedListeners.delete(channel);
      target.removeAllListeners(channel as never);
      return wrapped;
    },
    removeHandler(channel) {
      target.removeHandler(channel);
    },
    // ── EventEmitter 的只读/转发面：不做二次解释，原样交给底层 ipcMain。 ──
    emit(channel, ...args) {
      return target.emit(channel as string, ...(args as never[]));
    },
    listenerCount(channel, listener) {
      return target.listenerCount(channel as string, listener as never);
    },
    listeners(channel) {
      return target.listeners(channel as string);
    },
    rawListeners(channel) {
      return target.rawListeners(channel as string);
    },
    eventNames() {
      return target.eventNames();
    },
    getMaxListeners() {
      return target.getMaxListeners();
    },
    setMaxListeners(n) {
      target.setMaxListeners(n);
      return wrapped;
    },
  };
  return wrapped;
}

/** 幂等键只是通道约定，不进业务入参（handler 的 zod 会 strip，但摘要也不该包含它）。 */
function stripOperationId(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const copy = { ...(raw as Record<string, unknown>) };
  delete copy[DESKTOP_OPERATION_ID_KEY];
  return copy;
}
