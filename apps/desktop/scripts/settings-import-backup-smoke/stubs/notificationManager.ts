/**
 * `@main/notifications/NotificationManager.js` 的替身 —— 只留 `reloadPrefs`。
 *
 * 真那个顶层 `import { Notification } from "electron"`,还 `join(__dirname, ...)` 取图标,
 * 又 `import { runtimeManager }`(一路拖到三个引擎的 SDK)。本套验的是设置的
 * **导入** 那条路,导入完顺手 `notificationManager.reloadPrefs()` —— 所以这里只要能记
 * "被重读过没有"。
 */
let reloads = 0;
export function reset(): void {
  reloads = 0;
}
export function reloadCount(): number {
  return reloads;
}

export const notificationManager = {
  reloadPrefs(): void {
    reloads += 1;
  },
  start(): void {
    throw new Error("settings-import-backup-smoke 不该走到 notificationManager.start");
  },
};
