/** Visible persistence failures without coupling db.ts to Electron or IPC.
 * Only the tiny common catalogs are imported; no React/store/full UI catalog. */
import { dialog } from "electron";
import { UI_LOCALE_SETTING_KEY } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "./repositories.js";
import { flushDb, onDbPersistenceError } from "./db.js";
import { zh } from "../../renderer/lib/i18n/zh/common.js";
import { en } from "../../renderer/lib/i18n/en/common.js";

let installed = false;
let dialogOpen = false;

export function showDbPersistenceError(cause: unknown): void {
  if (dialogOpen) return;
  dialogOpen = true;
  let messages: typeof zh | typeof en = zh;
  try { if (SettingRepo.get(UI_LOCALE_SETTING_KEY) === "en") messages = en; }
  catch { /* startup failure: use the default locale */ }
  const detail = cause instanceof Error ? cause.message : String(cause);
  // Native APIs can throw before returning a Promise; handle both forms.
  void Promise.resolve().then(() => dialog.showMessageBox({
    type: "error",
    title: messages["common.persistenceFailureTitle"],
    message: messages["common.persistenceFailureMessage"],
    detail,
    buttons: [messages["common.retry"], messages["common.keepAppOpen"]],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })).then(({ response }) => {
    dialogOpen = false;
    if (response !== 0) return;
    try { flushDb(); }
    catch (error) { showDbPersistenceError(error); }
  }).catch((error: unknown) => {
    dialogOpen = false;
    log.error(`sqlite persistence dialog failed: ${String(error)}`);
  });
}

/** Install before initDb; one dialog per outage, not one per backoff attempt. */
export function installDbPersistenceAlerts(): void {
  if (installed) return;
  installed = true;
  onDbPersistenceError(showDbPersistenceError);
}
