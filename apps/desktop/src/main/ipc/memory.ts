/**
 * 记忆库 IPC(MEM-01 的界面通道)。业务全在 `main/memory/store.ts`,这里只做
 * zod 校验与编排 —— 与 `templates.ts` 同一条约定。
 *
 * 渠道字符串来自 `@contracts/memory` 的 `MEMORY_*_CHANNEL`(与 preload 的 invoke
 * 字符串同一份);R 侧 runtime 契约里的 `IPC.MEMORY_*` 常量应取同样的值。
 */
import type { IpcMain } from "electron";
import {
  MEMORY_CATEGORIES_CHANNEL,
  MEMORY_DELETE_CHANNEL,
  MEMORY_LIST_CHANNEL,
  MEMORY_READ_CHANNEL,
  MEMORY_SAVE_CHANNEL,
  MemoryListSchema,
  MemoryPathSchema,
  MemorySaveSchema,
} from "@contracts/memory";
import {
  deleteMemoryFile,
  listMemoryFiles,
  memoryCategories,
  readMemoryFile,
  saveMemoryFile,
} from "@main/memory/store.js";

export function registerMemoryHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(MEMORY_LIST_CHANNEL, (_evt, raw) => {
    const input = MemoryListSchema.parse(raw ?? {});
    return listMemoryFiles(input.category ? { category: input.category } : undefined);
  });

  ipcMain.handle(MEMORY_READ_CHANNEL, (_evt, raw) => {
    const input = MemoryPathSchema.parse(raw);
    return readMemoryFile(input.path);
  });

  ipcMain.handle(MEMORY_SAVE_CHANNEL, (_evt, raw) => {
    const input = MemorySaveSchema.parse(raw);
    return saveMemoryFile(input);
  });

  ipcMain.handle(MEMORY_DELETE_CHANNEL, (_evt, raw) => {
    // delete 与 read 同形(<类目>/<文件名>.md 的相对路径),共用一份 schema
    const input = MemoryPathSchema.parse(raw);
    return deleteMemoryFile(input.path);
  });

  ipcMain.handle(MEMORY_CATEGORIES_CHANNEL, () => memoryCategories());
}
