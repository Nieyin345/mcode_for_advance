/**
 * IPC handlers for auto-update (electron-updater).
 *
 * Thin wrappers over the updater module (src/main/updater.ts). The updater
 * module owns all autoUpdater logic and guards dev/prod; these handlers just
 * expose it to the renderer via the typed RPC contract.
 *
 * No input validation needed - all three RPCs are parameterless.
 *
 * `APP_CHECK_FOR_UPDATES` is the About-panel button, so it passes `"manual"`
 * explicitly: the `source` tag is what tells the `update-available` push whether
 * the discovery came from the user or from the recurring background timer
 * (`updater.ts` passes `"auto"` from both timers). Relying on the parameter's
 * default would make this call site silently switch origin if that default ever
 * changed, and the symptom would be a notification card that never pops.
 */
import type { IpcMain } from "electron";
import { IPC, type CheckForUpdatesResult } from "@contracts/ipc";
import { checkForUpdates, downloadUpdate, quitAndInstall } from "@main/updater.js";

export function registerUpdaterHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.APP_CHECK_FOR_UPDATES, async (): Promise<CheckForUpdatesResult> => {
    return checkForUpdates("manual");
  });

  ipcMain.handle(IPC.APP_DOWNLOAD_UPDATE, async (): Promise<void> => {
    await downloadUpdate();
  });

  ipcMain.handle(IPC.APP_QUIT_AND_INSTALL, async (): Promise<void> => {
    await quitAndInstall();
  });
}
