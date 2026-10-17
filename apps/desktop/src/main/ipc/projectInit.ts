import type { IpcMain } from "electron";
import { IPC, ProjectInitImportPresetSchema } from "@contracts/ipc";
import { listProjectInitializers, getProjectInitializer, saveProjectInitializer, deleteProjectInitializer, previewProjectInitializer, applyProjectInitializer, setDefaultProjectInitializer } from "@main/projectInit/service.js";
import { importProjectInitPreset, readProjectInitPresets } from "@main/projectInit/presets.js";
/** Every mutation/input is validated in the service; no shell or agent involved. */
export function registerProjectInitHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.PROJECT_INIT_LIST, () => listProjectInitializers());
  ipc.handle(IPC.PROJECT_INIT_GET, (_event, input: Parameters<typeof getProjectInitializer>[0]) => getProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_SAVE, (_event, input: Parameters<typeof saveProjectInitializer>[0]) => saveProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_DELETE, (_event, input: Parameters<typeof deleteProjectInitializer>[0]) => deleteProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_PREVIEW, (_event, input: Parameters<typeof previewProjectInitializer>[0]) => previewProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_APPLY, (_event, input: Parameters<typeof applyProjectInitializer>[0]) => applyProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_SET_DEFAULT, (_event, input: Parameters<typeof setDefaultProjectInitializer>[0]) => setDefaultProjectInitializer(input));
  // 【MC-006】出厂初始化预设:列出(只读)+ 按 id 导入(永远新建,重名自动加后缀)。
  // 导入执行走 `saveProjectInitializer` 那同一条闸门 —— 这里不另写校验/落库。
  ipc.handle(IPC.PROJECT_INIT_LIST_PRESETS, () => { const { catalog } = readProjectInitPresets(); return catalog; });
  ipc.handle(IPC.PROJECT_INIT_IMPORT_PRESET, (_event, raw: unknown) => importProjectInitPreset(ProjectInitImportPresetSchema.parse(raw).id));
}
