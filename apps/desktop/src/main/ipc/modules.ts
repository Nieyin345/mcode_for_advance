import { readFileSync } from "node:fs";
import type { IpcMain } from "electron";
import { IPC, ModuleInstallSchema, ModuleInstallVsixSchema, ModuleInvokeSchema, ModuleRemoveSchema, ModuleTaskRefSchema, ModuleWorkspaceSchema } from "@contracts/ipc";
import { ModulePermissionUpdateSchema } from "@contracts/modulePermissions";
import { ModuleWorkflowGrantSchema } from "@contracts/moduleCapability";
import { getModuleHost } from "@main/modules/service.js";
import { getJsOnlyEgressConsent, setJsOnlyEgressConsent } from "@main/modules/egressConsent.js";
import { z } from "zod";
import { diagnoseEgressIsolation } from "@main/modules/permissionedProcessRunner.js";
import { resolveInstallDecision } from "@main/modules/installConsentPolicy.js";

/** 【MC-036】授权变更的入参形状(与记录同形,不带 `grantedAt`)。宿主的 issue/revoke 会
 *  再按**现场清单**核验模块/版本/贡献/能力;IPC 层只挡形状与非对象。 */
const GrantChangeSchema = ModuleWorkflowGrantSchema.omit({ grantedAt: true });

/** 【T18】安装卡决策的宿主侧收窄（`allow-always` 只认真实桌面发送方）。
 *  实现在 `modules/installConsentPolicy.ts`（纯函数，不 import electron）——
 *  无头套件直接 import 那一份，不必把整个 IPC 面拖进 bundle。这里原样再导出，
 *  让 `ipc/modules.ts` 的调用方继续能从同一个入口拿到它。 */
export { resolveInstallDecision };

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
  // 【T18】`installConsent` 是安装卡片的三态选择；`deny` 在宿主里**先于任何写盘**抛出。
  ipcMain.handle(IPC.MODULE_INSTALL,async(event,raw:unknown)=>{
    const input=ModuleInstallSchema.parse(raw);
    const decision=resolveInstallDecision(input,event);
    return (await getModuleHost()).install(input.manifest, input.grantedPermissions, decision);
  });
  // 【F006】从 `.vsix` 安装 —— 与 `MODULE_INSTALL` 是同一个宿主能力的两条入口。
  //
  // **顺序是安全属性，别调换**：
  //   1. 解析入参（形状）
  //   2. `resolveInstallDecision` —— `deny` 在这里就返回，**文件还没被读过**
  //   3. 读字节
  //   4. `VscodeL1Bridge.install` —— 解析 vsix、转成 manifest、交给 `host.install`
  //
  // ⚠️ `VscodeL1Bridge.install` **当前不透传 decision**（它内部调 `host.install(manifest)`
  // 用的是默认 `allow-once`）。所以「deny = 磁盘零写入」这条保证**由上面第 2 步实现**：
  // 拒绝时根本走不到读文件。若将来 bridge 加了 decision 参数，把第 2 步的结果一并传下去，
  // 那时才是两处都挡 —— **在此之前不要以为 bridge 里已经挡过了**。
  ipcMain.handle(IPC.MODULE_INSTALL_VSIX,async(event,raw:unknown)=>{
    const input=ModuleInstallVsixSchema.parse(raw);
    const decision=resolveInstallDecision(input,event);
    if (decision === "deny") throw Error("用户拒绝了这次安装，未读取任何文件");
    const bytes=new Uint8Array(readFileSync(input.path));
    const { VscodeL1Bridge }=await import("@main/modules/vscodeL1Bridge.js");
    const bridge=await VscodeL1Bridge.install(await getModuleHost(), bytes, {
      confirmReadAccess:input.confirmReadAccess,
      // vsix 里的 `extension.js` 是要在本机跑的程序 —— 与 `modules.install` 同一条规矩。
      confirmExecutableCode:input.confirmExecutableCode === true,
    });
    // 返回形状与 `modules.install` 对齐（`ModuleChangeResult`），调用方拿 catalog 重画。
    // `cancelledTasks` / `cancelFailures` 在这条通道上是 0 / 空：VSIX 安装**只新增或替换
    // 同 ID 的模块**，而 bridge 内部走的 `host.install` 已经做了它那份取消诊断 ——
    // 只是没回传。这里如实给 0，而不是编一个数。
    return { catalog:(await getModuleHost()).catalog(), cancelledTasks:0, cancelFailures:[], moduleId:bridge.moduleId };
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
