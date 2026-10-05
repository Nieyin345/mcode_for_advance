/** Agent writes are not renderer-originated: invalidate the desktop cache only.
 * Do NOT use the mobile broadcast/allowlist for private custom UI definitions.
 * No HTML rides this notification; the receiver reads the latest stored value.
 */
import { IPC } from "@contracts/ipc";
import { CUSTOM_UI_SETTING_KEY } from "@contracts/customUi";
import { sendToRenderer } from "@main/window.js";
export function notifyAppSettingWrite(method: string, raw: unknown): void {
  if (method !== "setting.set" || !raw || typeof raw !== "object") return;
  if ((raw as { key?: unknown }).key !== CUSTOM_UI_SETTING_KEY) return;
  sendToRenderer(IPC.CLAUDE_EVENT, {
    channel: IPC.CLAUDE_EVENT, sessionId: "",
    event: { type: "setting.changed", sessionId: "", key: CUSTOM_UI_SETTING_KEY, value: "" },
  });
}
