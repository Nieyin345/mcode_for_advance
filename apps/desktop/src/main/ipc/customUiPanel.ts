/**
 * 自定义面板(R41)的两条 IPC:stage 面板文档、`mcode.ask()`。契约见 `@contracts/customUiPanel`。
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { CustomUiPanelAskSchema, CustomUiStagePanelSchema } from "@contracts/customUiPanel";
import { stagePanel } from "@main/customUi/panelProtocol.js";
import { panelAsk } from "@main/customUi/panelAsk.js";

export function registerCustomUiPanelHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CUSTOM_UI_STAGE_PANEL, async (_evt, raw) => {
    const input = CustomUiStagePanelSchema.parse(raw);
    return { url: stagePanel(input.html, input.network === true) };
  });
  ipcMain.handle(IPC.CUSTOM_UI_PANEL_ASK, async (_evt, raw) => {
    const input = CustomUiPanelAskSchema.parse(raw);
    return panelAsk(input);
  });
}
