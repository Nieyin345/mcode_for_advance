/**
 * 渲染层的通知偏好缓存 —— 给「应用内提示(Toast)」用。
 *
 * 系统通知由主进程 NotificationManager 按 prefs 决定;窗口在前台时弹的应用内
 * 提示走 sessionStore 里的 pushToast,它是同步的,不能每次都 IPC 去问,所以在
 * 这里缓存一份:第一次用到时拉一次,设置页改动时直接写进来。拉取失败就按默认
 * (老行为:照常弹)处理。
 */
import {
  DEFAULT_NOTIFICATION_PREFS,
  isInQuietHours,
  normalizeNotificationPrefs,
  type NotificationPrefs,
} from "@contracts/ipc";
import { api } from "@renderer/lib/api.js";

let cache: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;
let primed = false;
let revision = 0;

function prime(): void {
  if (primed) return;
  primed = true;
  const requestRevision = ++revision;
  try {
    void api.notification
      .getPrefs()
      .then((res) => {
        // Settings may be saved while the initial disk fetch is in flight.
        // An older response cannot roll back the new user preference.
        if (revision === requestRevision) cache = normalizeNotificationPrefs(res.prefs);
      })
      .catch(() => {
        if (revision === requestRevision) primed = false;
      });
  } catch {
    if (revision === requestRevision) primed = false;
  }
}

/** 设置页保存后调用,让提示立刻按新设置走。 */
export function setCachedNotificationPrefs(prefs: NotificationPrefs): void {
  revision++;
  cache = normalizeNotificationPrefs(prefs);
  primed = true;
}

/** 这条会话(所属项目)现在能不能弹应用内提示。 */
export function inAppToastAllowed(projectId: string | undefined): boolean {
  prime();
  if (!cache.inAppToasts) return false;
  if (projectId !== undefined && cache.mutedProjectIds.includes(projectId)) return false;
  if (isInQuietHours(cache)) return false;
  return true;
}
