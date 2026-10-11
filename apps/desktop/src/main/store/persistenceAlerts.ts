/** Visible persistence failures without coupling db.ts to Electron or IPC.
 * Only the tiny common catalogs are imported; no React/store/full UI catalog. */
import { app, dialog } from "electron";
import { UI_LOCALE_SETTING_KEY } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "./repositories.js";
import { flushDb, onDbPersistenceError } from "./db.js";
import { persistenceFailureDetail } from "./persistenceDiagnosis.js";
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
  // 报告 E3:`detail` 从前只是原始错误串(`EPERM: operation not permitted, rename …`)——
  // 用户看不出是谁挡的,而弹窗正文那句「检查磁盘空间和目录权限」把最常见的一种(另一个
  // 程序开着 mcode.db)指向了错方向。`persistenceFailureDetail` 在原文后面补一句**指得着
  // 动手方向**的说明(认不出就不加,不硬套)。
  const detail = persistenceFailureDetail(cause);
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

/** initDb() rejected (unreadable/locked data file, sql.js load failure, failed
 *  migration). Every IPC awaits the same rejected promise, so without this the
 *  window just stays empty with the cause buried in main.log. The persistence
 *  dialog above does not fit: its "retry" means flushDb(), a no-op with no DB. */
export function showDbOpenError(cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause);
  log.error(`sqlite open failed at startup: ${cause instanceof Error ? cause.stack ?? detail : detail}`);
  // The DB never opened, so the saved locale is unreadable: default catalog.
  const messages = zh;
  void Promise.resolve().then(() => dialog.showMessageBox({
    type: "error",
    title: messages["common.dbOpenFailureTitle"],
    message: messages["common.dbOpenFailureMessage"],
    detail,
    buttons: [messages["common.quitApp"], messages["common.keepAppOpen"]],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })).then(({ response }) => {
    if (response === 0) app.quit();
  }).catch((error: unknown) => {
    log.error(`sqlite open-failure dialog failed: ${String(error)}`);
  });
}

/** Install before initDb; one dialog per outage, not one per backoff attempt. */
export function installDbPersistenceAlerts(): void {
  if (installed) return;
  installed = true;
  onDbPersistenceError(showDbPersistenceError);
}
