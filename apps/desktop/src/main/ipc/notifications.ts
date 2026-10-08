import type { IpcMain } from "electron";
import { IPC, NOTIFICATION_PREFS_SETTING_KEY, FocusSessionSchema, NotificationPrefsSchema, normalizeNotificationPrefs, type NotificationPrefs } from "@contracts/ipc";
import { notificationManager } from "@main/notifications/NotificationManager.js";
import { SettingRepo } from "@main/store/repositories.js";
import { sendToRenderer } from "@main/window.js";
import { errText } from "@main/lib/ipcError.js";

/** Register notification-related IPC handlers (get/set prefs + focus session). */
export function registerNotificationHandlers(ipc: IpcMain): void {
  ipc.handle(IPC.NOTIFICATION_GET_PREFS, async () => {
    return { prefs: notificationManager.getPrefs() };
  });

  ipc.handle(IPC.NOTIFICATION_SET_PREFS, async (_event, raw) => {
    let parsed;
    try {
      parsed = NotificationPrefsSchema.parse(raw);
    } catch (err) {
      // 与其它 handler 同一份出口(见 `@main/lib/ipcError`)—— 否则 zod 失败时
      // `ZodError.message`(一整段 JSON 数组文本)会原样冒到 `NotificationsPanel`
      // 的 catch,用户看到的是内部 JSON 而不是「入参不合法(字段: 原因)」。
      // `notification.setPrefs` 在 app-control 目录里,模型经 `app_api_call` 传坏形状
      // 也走这条路。
      throw new Error(errText(err));
    }
    const prefs: NotificationPrefs = normalizeNotificationPrefs(parsed);
    // Persist to the settings table as JSON.
    SettingRepo.set(NOTIFICATION_PREFS_SETTING_KEY, JSON.stringify(prefs));
    // Update the in-memory prefs so the observer picks up the change immediately.
    notificationManager.setPrefs(prefs);
    return { prefs };
  });

  // Focus a session (show + focus the window, then tell the renderer to
  // navigate). Used when the renderer wants to jump to a session - e.g. from
  // a toast click (though that path also works purely renderer-side via
  // openTab; this RPC ensures the window is brought to front first).
  ipc.handle(IPC.NOTIFICATION_FOCUS_SESSION, async (_event, raw) => {
    let input;
    try {
      input = FocusSessionSchema.parse(raw);
    } catch (err) {
      throw new Error(errText(err));
    }
    const { getMainWindow } = await import("@main/window.js");
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendToRenderer(IPC.NOTIFICATION_FOCUS_SESSION, {
      channel: IPC.NOTIFICATION_FOCUS_SESSION,
      sessionId: input.sessionId,
    });
  });
}
