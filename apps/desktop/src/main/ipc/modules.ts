import type { IpcMain } from "electron";
import { IPC, ModuleInstallSchema, ModuleInvokeSchema, ModuleRemoveSchema, ModuleTaskRefSchema, ModuleWorkspaceSchema } from "@contracts/ipc";
import { getModuleHost } from "@main/modules/service.js";

export function registerModuleHandlers(ipcMain:IpcMain):void {
  ipcMain.handle(IPC.MODULE_CATALOG,async()=> (await getModuleHost()).catalog());
  ipcMain.handle(IPC.MODULE_INSTALL,async(_event,raw:unknown)=>{
    const input=ModuleInstallSchema.parse(raw);return (await getModuleHost()).install(input.manifest);
  });
  ipcMain.handle(IPC.MODULE_REMOVE,async(_event,raw:unknown)=>{
    const input=ModuleRemoveSchema.parse(raw);return (await getModuleHost()).remove(input.moduleId);
  });
  ipcMain.handle(IPC.MODULE_INVOKE,async(_event,raw:unknown)=> (await getModuleHost()).invoke(ModuleInvokeSchema.parse(raw)));
  ipcMain.handle(IPC.MODULE_TASK,async(_event,raw:unknown)=> (await getModuleHost()).task(ModuleTaskRefSchema.parse(raw)));
  ipcMain.handle(IPC.MODULE_CANCEL,async(_event,raw:unknown)=> (await getModuleHost()).cancel(ModuleTaskRefSchema.parse(raw)));
  ipcMain.handle(IPC.MODULE_TASKS,async(_event,raw:unknown)=> (await getModuleHost()).tasks(ModuleWorkspaceSchema.parse(raw)));
}
