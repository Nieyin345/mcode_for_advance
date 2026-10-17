import { z } from "zod";
import { ModuleManifestSchema } from "../modules.js";
export { ModuleInvokeSchema, ModuleRemoveSchema, ModuleTaskRefSchema, ModuleWorkspaceSchema } from "../modules.js";
export const ModuleInstallSchema = z.object({
  manifest:ModuleManifestSchema,
  confirmReadAccess:z.literal(true),
  /** 【MC-035】带 `program` 的扩展包**额外**要求一次针对"会执行代码"的确认 ——
   *  与只读声明分开:同意"读我选中的文件"不等于同意"在我机器上跑一段程序"。
   *  桌面 UI 勾选框与 Agent 的 danger 审批卡(每次必弹)是两个入口的同一件事。 */
  confirmExecutableCode:z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.manifest.program !== undefined && value.confirmExecutableCode !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmExecutableCode"], message: "Executable module installs require explicit code-execution consent" });
  }
});
export type ModuleInstallInput = z.infer<typeof ModuleInstallSchema>;
