/**
 * **扩展专用数据区**的三条 IPC(报告 E12)。
 *
 * 契约与形状见 `@contracts/extensionStore`;磁盘读写见 `main/lib/extensionStore.ts`。
 * 路径拼装(把 `dataRoot()` 注进来)在这一层 —— lib 那份是纯函数,无头 smoke 直接
 * bundle。
 *
 * ## 权限
 *
 * 三条都经 agent `app_api_call` 那条路可达(自动进 `apiCatalog`)。分级按 `policyFor`:
 * `extensionStore.get`(`get` 前缀)落只读档,`extensionStore.set` / `remove` 落**写档**
 * (兜底 write)—— 见契约头注释里为什么不升到 danger。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  ExtensionStoreGetSchema,
  ExtensionStoreSetSchema,
  ExtensionStoreRemoveSchema,
  EXTENSION_STORE_MAX,
} from "@contracts/ipc";
import { dataRoot } from "@main/lib/dataRoot.js";
import { readValue, removeValue, writeValue } from "@main/lib/extensionStore.js";

export function registerExtensionStoreHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.EXTENSION_STORE_GET, (_evt, raw: unknown) => {
    const input = ExtensionStoreGetSchema.parse(raw);
    return { value: readValue(dataRoot(), input.extensionId, input.key) };
  });
  ipcMain.handle(IPC.EXTENSION_STORE_SET, (_evt, raw: unknown) => {
    const input = ExtensionStoreSetSchema.parse(raw);
    const ok = writeValue(dataRoot(), input.extensionId, input.key, input.value);
    return ok ? { ok: true } : { ok: false, reason: "tooLarge", limit: EXTENSION_STORE_MAX };
  });
  ipcMain.handle(IPC.EXTENSION_STORE_REMOVE, (_evt, raw: unknown) => {
    const input = ExtensionStoreRemoveSchema.parse(raw);
    removeValue(dataRoot(), input.extensionId, input.key);
    return { ok: true };
  });
}
