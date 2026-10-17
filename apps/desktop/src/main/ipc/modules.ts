import type { IpcMain } from "electron";
import { IPC, ModuleInstallSchema, ModuleInvokeSchema, ModuleRemoveSchema, ModuleTaskRefSchema, ModuleWorkspaceSchema } from "@contracts/ipc";
import { ModuleWorkflowGrantSchema } from "@contracts/moduleCapability";
import { getModuleHost } from "@main/modules/service.js";

/** 【MC-036】授权变更的入参形状(与记录同形,不带 `grantedAt`)。宿主的 issue/revoke 会
 *  再按**现场清单**核验模块/版本/贡献/能力;IPC 层只挡形状与非对象。 */
const GrantChangeSchema = ModuleWorkflowGrantSchema.omit({ grantedAt: true });

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
  // 【MC-036】真人授权入口:签发 / 撤销都返回刷新后的目录,UI 一次往返就能重画。
  // ⚠️ 这两条**不是**给 agent 的 —— `appControl/policy.ts` 把同一对方法名钉在 blocked 档
  // (与 `hooks.issueHostHookGrant` 同一条纪律:自动运行权不能由模型自己给自己升)。
  ipcMain.handle(IPC.MODULE_ISSUE_WORKFLOW_GRANT,async(_event,raw:unknown)=>{
    const host=await getModuleHost();await host.issueWorkflowGrant(GrantChangeSchema.parse(raw));return host.catalog();
  });
  ipcMain.handle(IPC.MODULE_REVOKE_WORKFLOW_GRANT,async(_event,raw:unknown)=>{
    const host=await getModuleHost();await host.revokeWorkflowGrant(GrantChangeSchema.parse(raw));return host.catalog();
  });
}
