import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { listProjectInitializers, getProjectInitializer, saveProjectInitializer, deleteProjectInitializer, previewProjectInitializer, applyProjectInitializer } from "@main/projectInit/service.js";
/** Every mutation/input is validated in the service; no shell or agent involved. */
export function registerProjectInitHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.PROJECT_INIT_LIST, () => listProjectInitializers());
  ipc.handle(IPC.PROJECT_INIT_GET, (_event, input: Parameters<typeof getProjectInitializer>[0]) => getProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_SAVE, (_event, input: Parameters<typeof saveProjectInitializer>[0]) => saveProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_DELETE, (_event, input: Parameters<typeof deleteProjectInitializer>[0]) => deleteProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_PREVIEW, (_event, input: Parameters<typeof previewProjectInitializer>[0]) => previewProjectInitializer(input));
  ipc.handle(IPC.PROJECT_INIT_APPLY, (_event, input: Parameters<typeof applyProjectInitializer>[0]) => applyProjectInitializer(input));
}
