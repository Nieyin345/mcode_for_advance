/**
 * 通知偏好 RPC + 通知点击后的 focusSession。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。偏好本身的键与 schema 在 ./settings.js —
 * 这里的通道只是它的类型化壳。
 */

import { z } from "zod";
import { NotificationPrefsSchema } from "./settings.js";
import type { NotificationPrefs } from "./settings.js";

/* ── Notifications ── */

/** Input for getting/setting notification preferences. The prefs are persisted
 *  under {@link NOTIFICATION_PREFS_SETTING_KEY} as JSON; these RPCs provide a
 *  typed wrapper so the renderer doesn't hand-roll the JSON parse/stringify. */
export const GetNotificationPrefsSchema = z.object({});
export type GetNotificationPrefsInput = z.infer<typeof GetNotificationPrefsSchema>;

export const SetNotificationPrefsSchema = NotificationPrefsSchema;
export type SetNotificationPrefsInput = NotificationPrefs;

/** Input for focusing a session after an OS notification click. The main
 *  process brings the window to the front (show + focus), then pushes a
 *  `notification:focusSession` event so the renderer can navigate to the
 *  session (selectSession / openTab). */
export const FocusSessionSchema = z.object({ sessionId: z.string() });
export type FocusSessionInput = z.infer<typeof FocusSessionSchema>;

