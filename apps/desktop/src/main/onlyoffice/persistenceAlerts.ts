/** Native, bilingual save failure UI. No quit/teardown happens on failure. */
import { dialog } from "electron";
import { UI_LOCALE_SETTING_KEY } from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { zh } from "../../renderer/lib/i18n/zh/common.js";
import { en } from "../../renderer/lib/i18n/en/common.js";

function messages(): typeof zh | typeof en {
  try { if (SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en") return en; }
  catch { /* use the default locale if the database is not available */ }
  return zh;
}

export function onlyOfficeMigrationBlockedMessage(): string {
  return messages()["common.officeMigrationBlocked"];
}

let dialogOpen = false;
export function showOnlyOfficeSaveError(cause: unknown): void {
  if (dialogOpen) return;
  dialogOpen = true;
  const text = messages();
  void Promise.resolve().then(() => dialog.showMessageBox({
    type: "error",
    title: text["common.officeSaveFailureTitle"],
    message: text["common.officeSaveFailureMessage"],
    detail: cause instanceof Error ? cause.message : String(cause),
    buttons: [text["common.keepAppOpen"]],
    defaultId: 0, cancelId: 0, noLink: true,
  })).catch((error: unknown) => {
    log.error(`OnlyOffice persistence dialog failed: ${String(error)}`);
  }).finally(() => { dialogOpen = false; });
}
