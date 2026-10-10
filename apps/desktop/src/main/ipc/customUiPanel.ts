/**
 * 自定义面板(R41)的几条 IPC:stage 面板文档、`mcode.ask()`、`mcode.api.call()`。
 * 契约见 `@contracts/customUiPanel`。
 */
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { CustomUiPanelApiSchema, CustomUiPanelAskSchema, CustomUiStagePanelSchema } from "@contracts/customUiPanel";
import { stagePanel } from "@main/customUi/panelProtocol.js";
import { panelAsk } from "@main/customUi/panelAsk.js";
import { panelApiCall } from "@main/appControl/tools.js";

export function registerCustomUiPanelHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.CUSTOM_UI_STAGE_PANEL, async (_evt, raw) => {
    const input = CustomUiStagePanelSchema.parse(raw);
    return { url: stagePanel(input.html, input.network === true) };
  });
  ipcMain.handle(IPC.CUSTOM_UI_PANEL_ASK, async (_evt, raw) => {
    const input = CustomUiPanelAskSchema.parse(raw);
    return panelAsk(input);
  });
  // `mcode.api.call(method, input)`:调任意主进程方法,复用 agent `app_api_call` 的同一套
  // 权限分类。`approved` 只由渲染端的桥在用户点头后补上(面板脚本发不出它)。`panelLabel`
  // 只用于确认框正文(哪个面板要调什么),不参与判据。
  ipcMain.handle(IPC.CUSTOM_UI_PANEL_API_CALL, async (_evt, raw) => {
    const input = CustomUiPanelApiSchema.parse(raw);
    return panelApiCall(input.method, input.input, input.approved === true, input.panelLabel ?? "");
  });
}
