/**
 * 【MC-060】**生产审批端口** —— 把一个 `action` 能力执行前的批准请求,落到一个**原生确认框**
 * 上,由用户本人点头/拒绝。这是 `modules/service.ts` 里那个纯 Node 注入口
 * (`configureModuleApprovalPort`)的真实现。
 *
 * ## 为什么单独一个文件
 *
 * `modules/service.ts` 被多个无头 smoke bundle;它不能 import Electron(那会把整个 electron
 * 图拉进那些套件)。所以端口**类型与空实现**留在 `service.ts`(纯 Node),真正碰 `dialog` 的
 * 这一层单独放这里,由 `main/index.ts` 在启动装配期(`assembleModuleApprovalPort`)装上。
 *
 * ## fail-closed 与"不回退"
 *
 * 装配期只在这里**真装上**一次。装之前宿主的能力调用拿到的是 `service.ts` 那句
 * `approval_unavailable` 拒绝(命令没执行)—— 与 `gateAppAction` 无审批通道同款取向。
 * 装上之后**不回退**:静默退回"没通道"会让「用户批准过」变成假象。
 *
 * ## 语义
 *
 *   - 用户点「允许」→ `resolve`(宿主继续执行 `capability.run`);
 *   - 用户点「拒绝」/ 关掉对话框 → `reject`,宿主把原因包成 `approval_denied`(命令**没执行**)。
 *
 * 文案走 `dialogText`(主进程读词典,跟界面语言走),不在这里写死中文。
 */
import { dialog } from "electron";
import { getMainWindow } from "@main/window.js";
import { dialogText } from "@main/lib/dialogText.js";
import { configureModuleApprovalPort, configureModuleAppCallPort, type ModuleApprovalPort } from "@main/modules/service.js";
import { invokeExtensionAppCall } from "@main/appControl/tools.js";

/** 把一个审批请求映射成原生确认框,拿到用户的 yes/no。**只做这一个决定**。 */
const nativeModuleApprovalPort: ModuleApprovalPort = async (request) => {
  const win = getMainWindow();
  // 【MC-035】联网与写文件是**两件事**,审批框必须说清楚在批哪一件。
  // 否则用户看到"请求执行写操作"就批了,实际批准的是"这个扩展可以出网"。
  // 【T19】`scope === "danger"`(扩展经 core.app.call 调高风险 RPC)当前按写档文案
  // 呈现:专属文案需要新的 i18n 键,而词典在 renderer/(T19 边界外)。判定本身仍在
  // ModuleHost 里 —— 每次 danger 调用都必须经过这个框,文案只是表述。
  const isNetwork = request.scope === "network";
  const options = {
    type: "question" as const,
    title: dialogText(isNetwork ? "common.moduleNetworkApprovalTitle" : "common.moduleApprovalTitle"),
    message: dialogText(isNetwork ? "common.moduleNetworkApprovalMessage" : "common.moduleApprovalMessage", {
      module: request.moduleId,
      contribution: request.contributionId,
      path: request.resource.path,
    }),
    detail: dialogText(isNetwork ? "common.moduleNetworkApprovalDetail" : "common.moduleApprovalDetail"),
    buttons: [
      dialogText(isNetwork ? "common.moduleNetworkApprovalAllow" : "common.moduleApprovalAllow"),
      dialogText("common.moduleApprovalDeny"),
    ],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  // 有主窗口就挂成它的模态子对话框;没有(纯后台)也照弹 —— 审批是"命令执行前唯一的闸",
  // 不能因为窗口一时不在就放过一个写动作(fail-closed)。
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  if (response !== 0) {
    // 命令**没执行** —— 宿主会把这个原因包成 approval_denied(REJECTED,可安全重来)。
    throw Error(dialogText(isNetwork ? "common.moduleNetworkApprovalDenied" : "common.moduleApprovalDenied"));
  }
};

/** 启动装配入口(由 `main/index.ts` 调)。装上之后不回退。 */
export function assembleModuleApprovalPort(): void {
  configureModuleApprovalPort(nativeModuleApprovalPort);
  configureModuleAppCallPort(invokeExtensionAppCall);
}
