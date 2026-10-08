/**
 * Relay IPC handlers (PC renderer → main).
 *
 * Bridges the renderer's "remote access" panel to the singleton
 * {@link relayManager}: save/read VPS config, connect/disconnect, and read
 * status. State changes are pushed proactively via `relay:event`.
 */
import type { IpcMain } from "electron";
import { IPC, RelayVpsConfigSchema } from "@contracts/ipc";
import { relayManager } from "@main/relay/RelayManager.js";
import { log } from "@main/lib/logger.js";
import { errText } from "@main/lib/ipcError.js";

export function registerRelayHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.RELAY_SAVE_CONFIG, async (_evt, raw) => {
    try {
      const config = RelayVpsConfigSchema.parse(raw);
      relayManager.saveConfig(config);
      return { ok: true as const };
    } catch (err) {
      // zod 失败时用共享的 `errText` 翻成「入参不合法(字段: 原因)」—— 这句经
      // `RemoteConnectPanel` 的 `saved.error` 原样画在面板上,裸 `ZodError.message`
      // 是一整段 JSON 数组文本(同 `lsp.ts` / `notifications.ts` 那一类)。
      const msg = errText(err);
      log.error(`relay.saveConfig failed: ${msg}`);
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(IPC.RELAY_GET_CONFIG, async () => {
    return { config: relayManager.getConfig() };
  });

  ipcMain.handle(IPC.RELAY_CONNECT, async () => {
    try {
      return await relayManager.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`relay.connect failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(IPC.RELAY_DISCONNECT, async () => {
    try {
      await relayManager.disconnect();
      return { ok: true as const };
    } catch {
      return { ok: true as const };
    }
  });

  ipcMain.handle(IPC.RELAY_STATUS, async () => {
    return relayManager.getStatus();
  });

  log.info("relay: IPC handlers registered");
}
