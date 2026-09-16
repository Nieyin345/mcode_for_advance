/**
 * 主题 / 关于面板 / 自动更新(electron-updater)。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";
import { ThemeNameSchema } from "./settings.js";
import type { ThemeName, EffectiveTheme } from "../theme.js";

/* ── Theme / color scheme ── */

export const SetThemeSchema = z.object({ theme: ThemeNameSchema });
export type SetThemeInput = z.infer<typeof SetThemeSchema>;
export type GetThemeResult = { theme: ThemeName; effective: EffectiveTheme };

/* ── App / runtime info (About panel) ── */

/** Runtime info surfaced to the About panel. `appVersion` comes from
 *  Electron's `app.getVersion()` (reads the root package.json in dev, the
 *  built app's version in production); the rest come from `process.versions`
 *  and `process.platform` on the main side. No input - it's a parameterless
 *  RPC. */
export interface AppInfoResult {
  /** App version string (e.g. "0.0.0" in dev, the release version in prod). */
  appVersion: string;
  /** Electron version. */
  electron: string;
  /** Bundled Node.js version. */
  node: string;
  /** Bundled Chromium version. */
  chromium: string;
  /** OS platform: "win32" | "darwin" | "linux". */
  platform: string;
  /** CPU architecture (e.g. "x64", "arm64"). */
  arch: string;
}

/* ── Auto-update (electron-updater, GitHub Releases channel) ── */

/** Result of a manual/auto update check. */
export type CheckForUpdatesResult =
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string; manualInstallRequired: boolean }
  | { status: "error"; error: string };

/** Pushed when the updater finds a newer version on the release channel.
 *  Sent right after `update-available` fires in main; the renderer shows a
 *  download prompt. autoDownload is off, so the user opts in. */
export interface UpdateAvailableMessage {
  channel: "update:available";
  /** Version string of the pending update (e.g. "0.2.0"). */
  version: string;
  /** Release notes (markdown or plain) from the release, if any. */
  releaseNotes?: string;
  /** ISO date string of the release, if available. */
  releaseDate?: string;
  /** Where the check that discovered this update came from: "auto" = the
   *  boot/interval check initiated by main, "manual" = the user clicked
   *  "check for updates" in the About panel. The global update notification
   *  card only auto-shows for "auto" so a manual check never pops a redundant
   *  card over the panel the user is already looking at. */
  source?: "auto" | "manual";
  /** True when Squirrel.Mac can't auto-install updates (macOS ad-hoc
   *  signature). Surfaced at discovery time — before any bytes are downloaded
   *  — so the renderer can guide the user to the releases page immediately
   *  instead of wasting a ~100MB in-app download that ends in "manual install
   *  required". Always false on Windows. */
  manualInstallRequired?: boolean;
}

/** Pushed when a downloaded update is ready to install. The renderer offers a
 *  "restart & install" button that calls `app.quitAndInstall`.
 *
 *  On macOS with an ad-hoc signed app (no Apple Developer ID), Squirrel.Mac
 *  silently fails to apply the update — the button appears to do nothing.
 *  When `manualInstallRequired` is true the renderer should instead guide the
 *  user to manually download from the releases page. */
export interface UpdateDownloadedMessage {
  channel: "update:downloaded";
  /** Version string of the downloaded update. */
  version: string;
  /** Release notes (markdown or plain) from the release, if any. */
  releaseNotes?: string;
  /** True when Squirrel.Mac can't auto-install the update (e.g. macOS ad-hoc
   *  signature). The renderer should offer a "go to download" action instead
   *  of "restart & install". Always false on Windows. */
  manualInstallRequired?: boolean;
}

/** Pushed repeatedly while an update downloads, carrying live progress so the
 *  About panel can render a percentage + byte counter instead of a static
 *  spinner. `percent` is 0-100. */
export interface UpdateDownloadProgressMessage {
  channel: "update:downloadProgress";
  /** Version string of the update being downloaded. */
  version: string;
  /** Download progress, 0-100. */
  percent: number;
  /** Bytes transferred so far. */
  transferred: number;
  /** Total bytes to download (0 if unknown). */
  total: number;
  /** Current download speed in bytes/second. */
  bytesPerSecond: number;
}

/** Persisted snapshot of the update flow, stored under
 *  {@link UPDATE_STATE_SETTING_KEY} so the About panel can restore the banner
 *  after being unmounted/remounted or after an app restart. Only the states
 *  worth restoring are persisted - transient checks/errors stay in memory. */
export interface PersistedUpdateState {
  /** "downloading" = an update is mid-download (autoUpdater resumes on boot);
   *  "downloaded" = an update is ready to install on next restart. */
  status: "downloading" | "downloaded";
  /** Version string of the update. */
  version: string;
  /** Last seen download percent (0-100). Only meaningful for "downloading". */
  percent: number;
  /** Bytes transferred so far. Only meaningful for "downloading". */
  transferred: number;
  /** Total bytes (0 if unknown). Only meaningful for "downloading". */
  total: number;
  /** ISO timestamp of when this snapshot was written. */
  updatedAt: string;
  /** Mirrors {@link UpdateDownloadedMessage.manualInstallRequired} so the
   *  banner restores the correct action (manual download vs restart & install)
   *  after app restart. Only meaningful for "downloaded". */
  manualInstallRequired?: boolean;
}

/**
 * **统一数据根**。聊天记录(数据库)、文献库、模版库都放在它下面:
 *
 * ```
 * <数据根>/mcode.db  ·  <数据根>/library/  ·  <数据根>/templates/
 * ```
 *
 * 缺失 → 默认 `<用户主目录>/Mcode`。改它会触发**整体搬迁 + 重启应用** —— 数据库在
 * 运行期一直被主进程持有(sql.js 在内存里),没法原地换地基。
 */
export const DATA_ROOT_SETTING_KEY = "app.dataRoot";

