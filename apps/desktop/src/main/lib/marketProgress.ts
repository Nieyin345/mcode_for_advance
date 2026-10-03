import type { IpcMainInvokeEvent } from "electron";
import { IPC } from "@contracts/ipc";
import type { MarketProgressSink } from "./marketClone.js";

/** Only the initiating webContents receives progress. IDs correlate concurrent
 * windows/operations; they are not a broadcast channel or an authorization key. */
export function marketProgressFor(event: IpcMainInvokeEvent, requestId?: string): MarketProgressSink | undefined {
  if (!requestId) return undefined;
  return progress => {
    try {
      const sender = event?.sender;
      if (!sender || sender.isDestroyed?.()) return;
      sender.send(IPC.MARKET_PROGRESS, { channel: IPC.MARKET_PROGRESS, payload: { ...progress, requestId } });
    } catch { /* closing a settings window must not fail the catalog operation */ }
  };
}
