/**
 * IPC handlers：OnlyOffice Document Server（Office 文档可视化编辑）。
 * 逻辑全在 `@main/onlyoffice/OnlyOfficeBridge.ts`，这里只做 schema 校验 + 转发。
 */
import type { IpcMain } from "electron";
import { nativeTheme } from "electron";
import {
  IPC,
  OnlyOfficeOpenSchema,
  OnlyOfficeSessionSchema,
  OnlyOfficeSetConfigSchema,
} from "@contracts/ipc";
import { uiLocale } from "@main/lib/dialogText.js";
import {
  closeSession,
  forceSave,
  getOnlyOfficeConfig,
  getOnlyOfficeSessionState,
  openOnlyOfficeSession,
  probeOnlyOffice,
  setOnlyOfficeConfig,
} from "@main/onlyoffice/OnlyOfficeBridge.js";
import { detectLocal } from "@main/onlyoffice/localInstall.js";
export function registerOnlyOfficeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.ONLYOFFICE_OPEN, async (_evt, raw) => {
    const { filePath, mode, deviceType } = OnlyOfficeOpenSchema.parse(raw);
    // 界面语言跟着 Mcode 走（DS 的 lang 用 BCP-47 前两段就够）。规则只有一份
    // (`dialogText.uiLocale`,带 DB 未就绪兜底)。
    const lang = uiLocale();
    return openOnlyOfficeSession(filePath, {
      lang,
      dark: nativeTheme.shouldUseDarkColors,
      userName: "Mcode",
      mode: mode ?? "edit",
      deviceType: deviceType ?? "desktop",
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
  // 只读探测（目录 / 服务 / 端口 / local.json 里的密钥）。设置页拿它做自动填写，
  // 判据不在渲染端重写一遍 —— 与工具链检测、安装流程同一个真相源。
  ipcMain.handle(IPC.ONLYOFFICE_DETECT_LOCAL, () => detectLocal());
}
