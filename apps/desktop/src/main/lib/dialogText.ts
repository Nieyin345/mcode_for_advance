/**
 * 主进程里**系统对话框**(保存/打开)用的本地化文案。
 *
 * ## 为什么要有这一个薄层
 *
 * 这些字符串画在 OS 的原生模态上 —— 但语言该跟界面走。早先它们在三处**各自写死中文**
 * (`ipc/dialog.ts`、`ipc/orchestration.ts`、`ipc/settingsTransfer.ts`),于是英文界面的
 * 用户点「导出工作流」时,弹出来的是「导出工作流」+ 文件类型「工作流 JSON」—— 满屏中文。
 *
 * 主进程读词典要走 `@renderer/lib/i18n/core.js` 的 `translate`(与
 * `notifications/NotificationManager.ts` 同一条路:它也是主进程,也按 `UI_LOCALE_SETTING_KEY`
 * 挑语言)。这里把那一步收成一个函数,免得三处各写一遍"读设置 → 判 en/zh → 调 translate"。
 *
 * ⚠️ **词典口径**:`zh` 是 `MessageId` 的源,`en` 必须一一覆盖 —— 缺 key 直接 typecheck 失败。
 * 这些键住在 `@renderer/lib/i18n/{zh,en}/common.ts` 的 `common.dialog.*` 段。
 */
import { UI_LOCALE_SETTING_KEY } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";

/** 当前界面语言。读不到(启动早期 DB 未就绪)就退回 `zh`(与 NotificationManager 同款兜底)。 */
function uiLocale(): "zh" | "en" {
  try {
    return SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

/** 取一条系统对话框文案。**每次现读设置**,所以界面切语言后下一次弹框就跟着换。 */
export function dialogText(key: MessageId): string {
  return translate(uiLocale(), key);
}
