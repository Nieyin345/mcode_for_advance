/**
 * 长期任务的 IPC —— 三个读/控口,见 `contracts/src/longTask.ts` 与
 * `main/longtask/taskRunner.ts`(循环本身是事件驱动的,不走 IPC)。
 *
 * 校验走 zod schema(和别的通道一样,这是安全边界);start 失败不抛 ——
 * 把 `ok:false + error` 原样带回给渲染端提示(比如"已有进行中的任务")。
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import {
  LongTaskStartSchema,
  LongTaskStopSchema,
  LongTaskGetSchema,
} from "@contracts/longTask";
import { longTaskRunner } from "@main/longtask/taskRunner.js";

export function registerLongTaskHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.LONGTASK_START, (_evt, raw) => {
    const input = LongTaskStartSchema.parse(raw);
    return longTaskRunner.attach(input);
  });

  ipc.handle(IPC.LONGTASK_STOP, (_evt, raw) => {
    const input = LongTaskStopSchema.parse(raw);
    return longTaskRunner.stop(input.sessionId);
  });

  ipc.handle(IPC.LONGTASK_GET, (_evt, raw) => {
    const input = LongTaskGetSchema.parse(raw);
    return { task: longTaskRunner.currentOf(input.sessionId) };
  });
}
