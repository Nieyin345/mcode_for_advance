import { z } from "zod";
import { ModuleManifestSchema } from "../modules.js";
import { ModuleGrantedPermissionsSchema } from "../modulePermissions.js";
export { ModuleInvokeSchema, ModuleRemoveSchema, ModuleTaskRefSchema, ModuleWorkspaceSchema } from "../modules.js";
/** 【T18】安装卡片的**三态** —— 与手机装软件同一语义。
 *
 *  - `allow-once`   —— 本次安装 + 本次运行有效；重启后重新询问。
 *  - `allow-always` —— 写入持久决策；仍绑定「扩展身份 + 权限集指纹」，
 *    清单/权限/程序任一变化都会强制重新询问。
 *  - `deny`         —— 安装中止，**磁盘无任何写入**（不是"先装了再禁用"）。
 *
 * 信任模型与既有的 `confirmReadAccess` / `confirmExecutableCode` 一致：这一层
 * 记录的是**渲染端用户在卡片上的选择**。主进程**不采信**非桌面窗口发来的
 * `allow-always`（Agent / 扩展委托 / 面板桥都没有真实渲染端发送方）——
 * 那些入口一律按 `allow-once` 落盘，见 `ipc/modules.ts`。这样"永远允许"只能
 * 由坐在电脑前的用户亲自给出，任何自动化通道都无法铸造跨重启授权。
 */
export const MODULE_INSTALL_CONSENT_DECISIONS = ["allow-once", "allow-always", "deny"] as const;
export const ModuleInstallConsentSchema = z.enum(MODULE_INSTALL_CONSENT_DECISIONS);
export type ModuleInstallConsentDecision = z.infer<typeof ModuleInstallConsentSchema>;
export const ModuleInstallSchema = z.object({
  manifest:ModuleManifestSchema,
  confirmReadAccess:z.literal(true),
  /** Explicit user-chosen subset of the manifest, including an empty grant. */
  grantedPermissions:ModuleGrantedPermissionsSchema.optional(),
  /** 【MC-035】带 `program` 的扩展包**额外**要求一次针对"会执行代码"的确认 ——
   *  与只读声明分开:同意"读我选中的文件"不等于同意"在我机器上跑一段程序"。
   *  桌面 UI 勾选框与 Agent 的 danger 审批卡(每次必弹)是两个入口的同一件事。 */
  confirmExecutableCode:z.literal(true).optional(),
  /** 【T18】安装卡片的选择（见 {@link MODULE_INSTALL_CONSENT_DECISIONS}）。
   *  缺省 = `allow-once`：不携带持久授权，重启后重新询问。 */
  installConsent:ModuleInstallConsentSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.grantedPermissions !== undefined) {
    for (const grant of value.grantedPermissions) {
      if (!value.manifest.permissions.includes(grant)) context.addIssue({
        code:z.ZodIssueCode.custom, path:["grantedPermissions"], message:`Not declared in manifest: ${grant}`,
      });
    }
  }
  if (value.manifest.program !== undefined && value.confirmExecutableCode !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmExecutableCode"], message: "Executable module installs require explicit code-execution consent" });
  }
});
export type ModuleInstallInput = z.infer<typeof ModuleInstallSchema>;

/** 【F006】从 `.vsix` 安装的输入。
 *
 *  与 {@link ModuleInstallSchema} 的**关键区别**：这里没有 `manifest` —— 清单是从
 *  vsix 包里读出来的，渲染端提供的只是一份路径与用户的同意。**渲染端不能借这条
 *  通道塞一个自己拼的清单**（那等于绕过 `modules.install` 的 manifest 校验）。
 *
 *  `installConsent` 的三态语义与 `ModuleInstallSchema` 完全一致，见
 *  {@link MODULE_INSTALL_CONSENT_DECISIONS}。`deny` 时主进程在**解析 vsix 之前**
 *  就中止，磁盘零写入。
 */
export const ModuleInstallVsixSchema = z.object({
  /** 用户从文件选择器里选中的 `.vsix` 路径（绝对路径）。 */
  path: z.string().min(1).max(4096),
  confirmReadAccess: z.literal(true),
  /** 【MC-035】vsix 里带的 `extension.js` 是要在本机跑的程序 —— 与 `modules.install`
   *  同一条规矩：同意"读我选中的文件"不等于同意"在我机器上跑一段程序"。 */
  confirmExecutableCode: z.literal(true).optional(),
  installConsent: ModuleInstallConsentSchema.optional(),
}).strict();
export type ModuleInstallVsixInput = z.infer<typeof ModuleInstallVsixSchema>;

/** 【F006】从 vsix 安装的回包。在 `ModuleChangeResult` 之上多一个 `moduleId` ——
 *  渲染端要拿它做提示（「已安装：user.publisher.name」），而这个 ID 是主进程从
 *  vsix 里解析出来的，渲染端自己拼不出来（publisher/name 在包里）。 */
export interface ModuleInstallVsixResult {
  catalog: import("../modules.js").ModuleCatalog;
  cancelledTasks: number;
  cancelFailures: Array<{ taskId: string; reason: string }>;
  moduleId: string;
}
