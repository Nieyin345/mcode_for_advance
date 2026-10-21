import type { IpcMain } from "electron";
import { IPC, ModuleInstallSchema, ModuleInvokeSchema, ModuleRemoveSchema, ModuleTaskRefSchema, ModuleWorkspaceSchema } from "@contracts/ipc";
import { ModulePermissionUpdateSchema } from "@contracts/modulePermissions";
import { ModuleWorkflowGrantSchema } from "@contracts/moduleCapability";
import { getModuleHost } from "@main/modules/service.js";
import { getJsOnlyEgressConsent, setJsOnlyEgressConsent } from "@main/modules/egressConsent.js";
import { z } from "zod";
import { diagnoseEgressIsolation } from "@main/modules/permissionedProcessRunner.js";

/** 【MC-036】授权变更的入参形状(与记录同形,不带 `grantedAt`)。宿主的 issue/revoke 会
 *  再按**现场清单**核验模块/版本/贡献/能力;IPC 层只挡形状与非对象。 */
const GrantChangeSchema = ModuleWorkflowGrantSchema.omit({ grantedAt: true });

export function registerModuleHandlers(ipcMain:IpcMain):void {
  // Only the desktop module settings UI exposes this consent; app_api_call is blocked.
  // Every invocation re-reads the saved preference: disabling takes effect immediately.
  ipcMain.handle(IPC.MODULE_EGRESS_CONSENT_GET,async()=>{
    await getModuleHost(); // configure managed storage in the real dataRoot first
    return {enabled:getJsOnlyEgressConsent(),osIsolation:(await diagnoseEgressIsolation()).supported};
  });
  ipcMain.handle(IPC.MODULE_EGRESS_CONSENT_SET,async(_event,raw:unknown)=>{
    const input=z.object({enabled:z.boolean(),acknowledgeRisk:z.literal(true)}).strict().parse(raw);
    // Never write consent on other OSes just to bypass a failed OS probe.
    if(process.platform!=="win32")throw Error("该开关仅用于 Windows 无 OS 网络沙箱的平台");
    await getModuleHost();
    await setJsOnlyEgressConsent(input.enabled);
    return {enabled:getJsOnlyEgressConsent(),osIsolation:false};
  });
  ipcMain.handle(IPC.MODULE_CATALOG,async()=> (await getModuleHost()).catalog());
  // 【ARC-006 Gate E】安装/卸载的回包带**变更诊断**（`cancelledTasks` / `cancelFailures`）：
  // 升级换执行体或卸载时运行中的旧任务会被协作式取消，UI 据此提示"已取消 N 个运行中
  // 任务"；取消失败原因原样带回（不静默）。`ModuleHost` 返回的就是这个形状，这一层
  // 只透传，不再包第二份。
  ipcMain.handle(IPC.MODULE_INSTALL,async(_event,raw:unknown)=>{
    const input=ModuleInstallSchema.parse(raw);return (await getModuleHost()).install(input.manifest, input.grantedPermissions);
  });
  // User-only edit path. appControl.policy blocks this method for agents/panels.
  ipcMain.handle(IPC.MODULE_SET_PERMISSIONS,async(_event,raw:unknown)=>
    (await getModuleHost()).setPermissions(ModulePermissionUpdateSchema.parse(raw)));
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
