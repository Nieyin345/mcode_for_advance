import type { IpcMainInvokeEvent } from "electron";
import { IPC } from "@contracts/ipc";
import type { MarketProgressSink } from "./marketClone.js";

/** Only the initiating webContents receives progress. IDs correlate concurrent
 * windows/operations; they are not a broadcast channel or an authorization key. */
export function marketProgressFor(event: IpcMainInvokeEvent, requestId?: string): MarketProgressSink | undefined {
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128
    || [...requestId].some(ch => ch.charCodeAt(0) < 33 || ch.charCodeAt(0) > 126)) return undefined;
  // Bind the pending operation to the requesting document as well as its
  // window. A clone can outlive a navigation; sender.send would target the
  // next document if we retained only the WebContents reference.
  const frame = event?.senderFrame;
  const originalUrl = frame?.url;
  return progress => {
    try {
      const sender = event?.sender;
      if (!sender || sender.isDestroyed?.()) return;
      if (frame && (frame.isDestroyed?.() || frame.url !== originalUrl || sender.mainFrame !== frame)) return;
      sender.send(IPC.MARKET_PROGRESS, { channel: IPC.MARKET_PROGRESS, payload: { ...progress, requestId } });
    } catch { /* closing a settings window must not fail the catalog operation */ }
  };
}
