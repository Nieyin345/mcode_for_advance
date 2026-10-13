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
 *
 * ## 【MC-095】可信扩展身份绑定
 *
 * 六条都收请求者自填的 `extensionId`。这里在**每条**的入口先过
 * `extensionAccessRefusal(extensionId)`(与 `memory.*` 共用同一套宿主铸造的
 * `AsyncLocalStorage` 作用域,见 `main/memory/agentScope.ts`):
 *   - **桌面渲染端直连**(`panelBridge`,经真实 IPC 不经 `app_api_call`)无作用域 → 保留
 *     「任意 id」(桥已用 `host.item.id` 自绑,面板脚本够不到 `window.api`);
 *   - **Agent 经通用 `app_api_call`** —— `appControl/tools.ts` 装了作用域但**没有**扩展身份
 *     → **一律拒**,不起眼地 fail-closed。模型不能靠自填 `extensionId` 越到别的扩展。
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
import { extensionAccessRefusal } from "@main/memory/agentScope.js";
import {
  listFilesInExtension,
  readFileInExtension,
  readValue,
  removeValue,
  writeFileInExtension,
  writeValue,
} from "@main/lib/extensionStore.js";

/**
 * 该次 `extensionStore.*` 调用能不能访问这个扩展 —— 不能则**抛**(调用方 fail-closed)。
 * 判据是**唯一一份** `extensionAccessRefusal`(见 `main/memory/agentScope.ts`),六条 handler
 * 都调它,不各自重写。
 */
function assertExtensionAccess(extensionId: string): void {
  const refusal = extensionAccessRefusal(extensionId);
  if (refusal !== null) throw new Error(refusal);
}

export function registerExtensionStoreHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.EXTENSION_STORE_GET, (_evt, raw: unknown) => {
    const input = ExtensionStoreGetSchema.parse(raw);
    assertExtensionAccess(input.extensionId);
    return { value: readValue(dataRoot(), input.extensionId, input.key) };
  });
  ipcMain.handle(IPC.EXTENSION_STORE_SET, (_evt, raw: unknown) => {
    const input = ExtensionStoreSetSchema.parse(raw);
    assertExtensionAccess(input.extensionId);
    const ok = writeValue(dataRoot(), input.extensionId, input.key, input.value);
    return ok ? { ok: true } : { ok: false, reason: "tooLarge", limit: EXTENSION_STORE_MAX };
  });
  ipcMain.handle(IPC.EXTENSION_STORE_REMOVE, (_evt, raw: unknown) => {
    const input = ExtensionStoreRemoveSchema.parse(raw);
    assertExtensionAccess(input.extensionId);
    removeValue(dataRoot(), input.extensionId, input.key);
    return { ok: true };
  });

  // ── 文件通道(报告附录 P):该扩展自己目录下读 / 写 / 列任意文件 ──
  // 读 id 与相对路径都由 zod 挡过一遍(绝对路径 / `..` / 盘符在这一层就拒);lib 那层再做
  // 词法 + realpath 两道,挡符号链接逃逸。
  ipcMain.handle(IPC.EXTENSION_STORE_READ_FILE, (_evt, raw: unknown) => {
    const input = ExtensionStoreReadFileSchema.parse(raw);
    assertExtensionAccess(input.extensionId);
    return readFileInExtension(dataRoot(), input.extensionId, input.relPath);
  });
  ipcMain.handle(IPC.EXTENSION_STORE_WRITE_FILE, (_evt, raw: unknown) => {
    const input = ExtensionStoreWriteFileSchema.parse(raw);
    assertExtensionAccess(input.extensionId);
    return writeFileInExtension(dataRoot(), input.extensionId, input.relPath, input.content);
  });
  ipcMain.handle(IPC.EXTENSION_STORE_LIST_FILES, (_evt, raw: unknown) => {
    const input = ExtensionStoreListFilesSchema.parse(raw);
    assertExtensionAccess(input.extensionId);
    return listFilesInExtension(dataRoot(), input.extensionId, input.relPath);
  });
}
