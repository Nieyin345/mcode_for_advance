/**
 * IPC handlers：OnlyOffice Document Server（Office 文档可视化编辑）。
 * 逻辑全在 `@main/onlyoffice/OnlyOfficeBridge.ts`，这里只做 schema 校验 + 转发。
 */
import type { IpcMain } from "electron";
import { nativeTheme } from "electron";
import {
  IPC,
  OnlyOfficeInstallSchema,
  OnlyOfficeOpenSchema,
  OnlyOfficeSessionSchema,
  OnlyOfficeSetConfigSchema,
  UI_LOCALE_SETTING_KEY,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import {
  closeSession,
  forceSave,
  getOnlyOfficeConfig,
  getOnlyOfficeSessionState,
  openOnlyOfficeSession,
  probeOnlyOffice,
  setOnlyOfficeConfig,
} from "@main/onlyoffice/OnlyOfficeBridge.js";
import {
  applyLocal,
  cancelInstall,
  detectLocal,
  getInstallProgress,
  startLocalConfigure,
  startLocalInstall,
} from "@main/onlyoffice/localInstall.js";

export function registerOnlyOfficeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.ONLYOFFICE_OPEN, async (_evt, raw) => {
    const { filePath } = OnlyOfficeOpenSchema.parse(raw);
    // 界面语言跟着 Mcode 走（DS 的 lang 用 BCP-47 前两段就够）
    const locale = SettingRepo.get(UI_LOCALE_SETTING_KEY);
    const lang = locale === "en" ? "en" : "zh";
    return openOnlyOfficeSession(filePath, {
      lang,
      dark: nativeTheme.shouldUseDarkColors,
      userName: "Mcode",
    });
  });
  ipcMain.handle(IPC.ONLYOFFICE_FORCE_SAVE, (_evt, raw) => {
    const { sessionKey } = OnlyOfficeSessionSchema.parse(raw);
    return forceSave(sessionKey);
  });
  ipcMain.handle(IPC.ONLYOFFICE_SESSION_STATE, (_evt, raw) => {
    const { sessionKey } = OnlyOfficeSessionSchema.parse(raw);
    return getOnlyOfficeSessionState(sessionKey);
  });
  ipcMain.handle(IPC.ONLYOFFICE_CLOSE, (_evt, raw) => {
    const { sessionKey } = OnlyOfficeSessionSchema.parse(raw);
    return { ok: closeSession(sessionKey) };
  });
  ipcMain.handle(IPC.ONLYOFFICE_STATUS, () => probeOnlyOffice());
  ipcMain.handle(IPC.ONLYOFFICE_GET_CONFIG, () => getOnlyOfficeConfig());
  ipcMain.handle(IPC.ONLYOFFICE_SET_CONFIG, (_evt, raw) => setOnlyOfficeConfig(OnlyOfficeSetConfigSchema.parse(raw)));
  // 本机安装（Windows 安装包），逻辑在 `@main/onlyoffice/localInstall.ts`
  ipcMain.handle(IPC.ONLYOFFICE_DETECT_LOCAL, () => detectLocal());
  ipcMain.handle(IPC.ONLYOFFICE_INSTALL_LOCAL, (_evt, raw) => startLocalInstall(OnlyOfficeInstallSchema.parse(raw ?? {})));
  ipcMain.handle(IPC.ONLYOFFICE_CONFIGURE_LOCAL, () => startLocalConfigure());
  ipcMain.handle(IPC.ONLYOFFICE_INSTALL_PROGRESS, () => getInstallProgress());
  ipcMain.handle(IPC.ONLYOFFICE_CANCEL_INSTALL, () => cancelInstall());
  ipcMain.handle(IPC.ONLYOFFICE_APPLY_LOCAL, () => applyLocal());
}
