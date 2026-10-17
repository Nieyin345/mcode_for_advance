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
import { awaitDb } from "@main/store/db.js";

export function createDbGuardedIpc(target: IpcMain): IpcMain {
  const wrapped: Pick<IpcMain, "handle"> = {
    handle(channel, handler) {
      const guarded = async (event: Parameters<typeof handler>[0], raw: unknown) => {
        await awaitDb();
        const operationId = operationIdFromIpcInput(raw);
        if (operationId !== null) {
          const method = methodForChannel(channel);
          // 查不到方法（渲染端专用通道）/ 只读档 → 不介入。
          if (method !== null && idempotencyApplies(policyFor(method).level)) {
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
              const out = await handler(event, raw);
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
        return handler(event, raw);
      };
      target.handle(channel, guarded);
      // 同一个函数留一份给 mcode-app 的 `app_api_call`(agent 调功能 = 界面按按钮,走同一段代码)。
      recordRpcHandler(channel, guarded as (event: unknown, raw: unknown) => unknown);
    },
  };
  return wrapped as unknown as IpcMain;
}

/** 幂等键只是通道约定，不进业务入参（handler 的 zod 会 strip，但摘要也不该包含它）。 */
function stripOperationId(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const copy = { ...(raw as Record<string, unknown>) };
  delete copy[DESKTOP_OPERATION_ID_KEY];
  return copy;
}
