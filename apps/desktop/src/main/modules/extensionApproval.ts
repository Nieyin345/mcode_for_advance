/**
 * 扩展 → Mcode 能力的**生产审批端口**。
 *
 * `mcodeBridge` 的契约是「写/danger 档必须先拿到用户本人的批准」。本文件把那件事
 * 落成一个**原生确认框** —— 与 `moduleApproval.ts`（已随 ModuleHost 删除）同一套纪律：
 * 有主窗口就挂成模态子框，没有也照弹、fail-closed。
 *
 * ## 为什么单独一个文件
 *
 * `installedRegistry.ts` 与 `mcodeBridge.ts` 被多个无头 smoke bundle，**不能 import
 * electron**（那会把整个 electron 图拉进那些套件）。所以碰 `dialog` 的这一层单独放这里，
 * 由 `main/index.ts` 在启动装配期注入。
 */
import { dialog } from "electron";
import { getMainWindow } from "@main/window.js";
import { dialogText } from "@main/lib/dialogText.js";
import type { McodeApprovalPort } from "@main/modules/theiaHost/mcodeBridge.js";

/** 一次扩展能力审批 → 原生确认框。**只做「批不批」这一个决定**。 */
export const nativeExtensionApprovalPort: McodeApprovalPort = async (request) => {
  const win = getMainWindow();
  const danger = request.level === "danger";
  const scope = danger ? "extensionDangerApproval" : "extensionApproval";
  const options = {
    type: "question" as const,
    title: dialogText(`common.${scope}Title`),
    message: dialogText(`common.${scope}Message`, {
      extension: request.extensionId,
      method: request.method,
      description: request.description,
    }),
    detail: dialogText(`common.${scope}Detail`),
    buttons: [dialogText(`common.${scope}Allow`), dialogText("common.extensionApprovalDeny")],
    // 默认焦点在「拒绝」—— 误按回车不该放行一个写动作。
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  // true = 批准，false = 拒绝（**不抛** —— 桥按返回值决定）。
  return response === 0;
};
