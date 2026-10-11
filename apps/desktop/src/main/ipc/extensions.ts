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
  ExtensionStoreReadFileSchema,
  ExtensionStoreWriteFileSchema,
  ExtensionStoreListFilesSchema,
  EXTENSION_STORE_MAX,
} from "@contracts/ipc";
import { dataRoot } from "@main/lib/dataRoot.js";
import {
  listFilesInExtension,
  readFileInExtension,
  readValue,
  removeValue,
  writeFileInExtension,
  writeValue,
} from "@main/lib/extensionStore.js";

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

  // ── 文件通道(报告附录 P):该扩展自己目录下读 / 写 / 列任意文件 ──
  // 读 id 与相对路径都由 zod 挡过一遍(绝对路径 / `..` / 盘符在这一层就拒);lib 那层再做
  // 词法 + realpath 两道,挡符号链接逃逸。
  ipcMain.handle(IPC.EXTENSION_STORE_READ_FILE, (_evt, raw: unknown) => {
    const input = ExtensionStoreReadFileSchema.parse(raw);
    return readFileInExtension(dataRoot(), input.extensionId, input.relPath);
  });
  ipcMain.handle(IPC.EXTENSION_STORE_WRITE_FILE, (_evt, raw: unknown) => {
    const input = ExtensionStoreWriteFileSchema.parse(raw);
    return writeFileInExtension(dataRoot(), input.extensionId, input.relPath, input.content);
  });
  ipcMain.handle(IPC.EXTENSION_STORE_LIST_FILES, (_evt, raw: unknown) => {
    const input = ExtensionStoreListFilesSchema.parse(raw);
    return listFilesInExtension(dataRoot(), input.extensionId, input.relPath);
  });
}
