/**
 * 内嵌浏览器(WebContentsView + 元素拾取):RPC 入参、cookie 保险库与
 * 地址栏/书签的设置键。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";

/** Setting key for the directory where agent browser screenshots are saved.
 *  Empty/absent → the system Pictures directory. Screenshots are organized as
 *  `<dir>/<sessionId>/turn-<N>/<timestamp>-<toolCallId>.png`. */
export const BROWSER_SCREENSHOT_DIR_SETTING_KEY = "browser.screenshotDir";

/** Setting key for the directory where the embedded browser's session data is
 *  stored (cookies, form/autofill data, localStorage, IndexedDB, etc.). The
 *  browser views run on a dedicated persistent partition
 *  ("persist:mcode-browser"); when this is set, the partition is pointed at
 *  that directory via session.fromPartition's `path` option. Empty/absent →
 *  Electron's default partition location under userData. NOTE: Electron caches
 *  Session objects by partition string, so changing this only takes effect
 *  after an app restart. */
export const BROWSER_DATA_DIR_SETTING_KEY = "browser.dataDir";

/** Setting key for "remember browser sign-in state" (default on). When
 *  enabled, BrowserManager snapshots ALL live cookies of the embedded browser
 *  into `browser.cookieVault` on a background timer and before quit, and
 *  re-injects them into the browser session before its first navigation —
 *  sign-in state (including session cookies from sites where "remember me"
 *  was unchecked) survives app restarts. Needed because Electron ≤ 40 never
 *  commits cookies to disk for persistent partitions; from Electron 41 the
 *  native store works and the vault merely shadows it. Stored as "0" to
 *  disable; missing = enabled. */
export const BROWSER_PERSIST_LOGIN_SETTING_KEY = "browser.persistLogin";

/** Setting key holding the browser cookie vault — a JSON array of
 *  `VaultCookie` snapshots written by BrowserManager (main only) and restored
 *  when a browser view's session is first created after a restart. Legacy
 *  (plaintext) location: new writes go to `browser.cookieVault.enc` via
 *  safeStorage; this key remains only as the restore fallback for vaults
 *  written before the encrypted key existed (and when OS-level encryption is
 *  unavailable, e.g. Linux without a keyring). */
export const BROWSER_COOKIE_VAULT_SETTING_KEY = "browser.cookieVault";

/** Setting key holding the safeStorage-encrypted cookie vault (base64
 *  ciphertext of the same `VaultCookie` JSON array). Preferred over
 *  `browser.cookieVault` on both save and restore; sign-in cookies are
 *  credentials, so they must not sit in the DB in plaintext where the OS
 *  supports encryption (DPAPI on Windows, Keychain on macOS, kwallet/gnome-
 *  keyring on Linux — with automatic plaintext fallback where it doesn't). */
export const BROWSER_COOKIE_VAULT_ENC_SETTING_KEY = "browser.cookieVault.enc";

/** Setting key for the address-bar history (JSON array of
 *  `BrowserHistoryEntry`, most-recent first, capped at 50). Written only by
 *  the main process (BrowserManager on did-navigate); the renderer reads it
 *  via setting.get and removes entries via the browser.historyRemove /
 *  browser.historyClear RPCs. */
export const BROWSER_ADDRESS_HISTORY_SETTING_KEY = "browser.addressHistory";

/** Setting key for the browser panel's page bookmarks (JSON array of
 *  `BrowserBookmarkEntry`, most-recent first, capped at 100). Single writer is
 *  the main process (browser.bookmarkAdd / bookmarkRemove RPCs); the renderer
 *  reads it via setting.get — the exact pattern of the address history. */
export const BROWSER_BOOKMARKS_SETTING_KEY = "browser.bookmarks";

/** One bookmarked page in the browser panel's "More" menu. */
export interface BrowserBookmarkEntry {
  url: string;
  /** Page title at bookmark time (may be empty). */
  title: string;
  /** Epoch ms of when the bookmark was added. */
  addedAt: number;
}

/** One address-bar history entry. */
export interface BrowserHistoryEntry {
  url: string;
  /** Page title at the time of navigation (may be empty for redirects). */
  title: string;
  /** Epoch ms of the last visit. */
  at: number;
}

/* ── Embedded browser (WebContentsView + DOM element picker) ──
 *  The browser view lives in main (an OS-level WebContentsView overlaid on the
 *  main window). Renderer only sees an opaque browserId and drives it via RPC.
 *  The picker script is injected into the page's main world via executeJavaScript;
 *  picked elements come back as a push event (browser:event / pickResult). */

/** A pixel rect in window coordinates, used to position the WebContentsView
 *  over the renderer's browser-panel placeholder. Measured by the renderer via
 *  getBoundingClientRect() and forwarded on resize. */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BrowserCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional initial device-emulation preset applied once the view's renderer
   *  is ready (dom-ready). Used by the sidebar container to start in mobile
   *  mode without calling setDevice too early (which can crash the GPU
   *  process before it's initialized). Omit = desktop (no emulation). */
  initialDevice: z
    .enum([
      "desktop",
      "iphone",
      "iphone-se",
      "android",
      "galaxy-s23",
      "ipad-mini",
      "custom",
    ])
    .optional(),
});
export type BrowserCreateInput = z.infer<typeof BrowserCreateSchema>;

export const BrowserLoadUrlSchema = z.object({
  browserId: z.string().min(1),
  url: z.string().min(1),
});
export type BrowserLoadUrlInput = z.infer<typeof BrowserLoadUrlSchema>;

export const BrowserGoBackSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserGoBackInput = z.infer<typeof BrowserGoBackSchema>;

export const BrowserGoForwardSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserGoForwardInput = z.infer<typeof BrowserGoForwardSchema>;

export const BrowserReloadSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserReloadInput = z.infer<typeof BrowserReloadSchema>;

export const BrowserSetBoundsSchema = z.object({
  browserId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type BrowserSetBoundsInput = z.infer<typeof BrowserSetBoundsSchema>;

export const BrowserSetPickModeSchema = z.object({
  browserId: z.string().min(1),
  enabled: z.boolean(),
});
export type BrowserSetPickModeInput = z.infer<typeof BrowserSetPickModeSchema>;

export const BrowserShowSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserShowInput = z.infer<typeof BrowserShowSchema>;

export const BrowserHideSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserHideInput = z.infer<typeof BrowserHideSchema>;

export const BrowserCloseSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserCloseInput = z.infer<typeof BrowserCloseSchema>;

export const BrowserBookmarkAddSchema = z.object({
  url: z.string().min(1),
  title: z.string(),
});
export type BrowserBookmarkAddInput = z.infer<typeof BrowserBookmarkAddSchema>;

/** Act on a tracked browser download from the panel's download bar. The
 *  renderer passes only the downloadId — main resolves the path from its own
 *  download registry, so an arbitrary filesystem path never crosses IPC.
 *  "open" launches the file with the OS default app (only allowed once the
 *  download completed); "reveal" selects it in the containing folder. */
export const BrowserDownloadActionSchema = z.object({
  downloadId: z.string().min(1),
  action: z.enum(["open", "reveal"]),
});
export type BrowserDownloadActionInput = z.infer<typeof BrowserDownloadActionSchema>;

export const BrowserBookmarkRemoveSchema = z.object({
  url: z.string().min(1),
});
export type BrowserBookmarkRemoveInput = z.infer<typeof BrowserBookmarkRemoveSchema>;

export const BrowserCaptureFrameSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserCaptureFrameInput = z.infer<typeof BrowserCaptureFrameSchema>;

/** Result of browser.captureFrame: one PNG frame of the page for the
 *  renderer's frozen-frame placeholder (toolbar menus float over this
 *  snapshot while the real view parks offscreen). `data` is base64 PNG.
 *  ok:false = capture failed (compositor not ready, view gone) — the caller
 *  degrades to the plain hide. Purely in-memory: never persisted. */
export interface BrowserCaptureFrameResult {
  ok: boolean;
  data?: string;
  mimeType?: "image/png";
  error?: string;
}

/** Device presets for the browser panel's device emulation. "desktop" is the
 *  default (no emulation — the page viewport follows the panel's actual size,
 *  like a normal desktop browser window); the mobile presets set a viewport
 *  width/height + deviceScaleFactor + mobile screenPosition via
 *  enableDeviceEmulation. "custom" uses the width/height passed at set-device
 *  time instead of a fixed preset. */
export type BrowserDevicePreset =
  | "desktop"
  | "iphone"
  | "iphone-se"
  | "android"
  | "galaxy-s23"
  | "ipad-mini"
  | "custom";

/** Screen orientation for device emulation. "landscape" swaps the preset's
 *  width/height before applying emulation (e.g. 390×844 → 844×390). */
export type BrowserOrientation = "portrait" | "landscape";

/** One entry in the shared device preset catalog. `width`/`height` are the
 *  portrait-orientation logical (CSS) viewport dims; `scale` is the
 *  deviceScaleFactor passed to enableDeviceEmulation. Kept in contracts so
 *  main (BrowserManager.setDevice) and renderer (BrowserPanel bounds sync +
 *  BrowserToolbar labels) read the same numbers. */
export interface BrowserDeviceSpec {
  id: BrowserDevicePreset;
  label: string;
  width: number;
  height: number;
  scale: number;
}

/** Shared preset catalog — single source of truth for the device selector.
 *  "custom" is a menu entry (no fixed dims; width/height come from the input
 *  fields at set time).
 *
 *  "desktop" (no-emulation) is both the default device for new tabs and the
 *  selectable "桌面端" menu entry: the page viewport follows the panel's real
 *  size (responsive) instead of pinning a fixed emulated viewport. */
export const BROWSER_DEVICE_PRESETS: BrowserDeviceSpec[] = [
  { id: "desktop", label: "桌面端", width: 0, height: 0, scale: 1 },
  { id: "iphone", label: "iPhone 14", width: 390, height: 844, scale: 3 },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667, scale: 2 },
  { id: "android", label: "Pixel 7", width: 412, height: 915, scale: 2.625 },
  { id: "galaxy-s23", label: "Galaxy S23", width: 360, height: 740, scale: 3 },
  { id: "ipad-mini", label: "iPad mini", width: 768, height: 1024, scale: 2 },
  { id: "custom", label: "自定义", width: 0, height: 0, scale: 3 },
];

/** Resolve a preset's portrait dims/scale, falling back to the given custom
 *  width/height (or the default preset) when the id is unknown. */
export function resolveBrowserDeviceSpec(
  device: BrowserDevicePreset,
  custom?: { width?: number; height?: number },
): BrowserDeviceSpec {
  const found = BROWSER_DEVICE_PRESETS.find((p) => p.id === device);
  if (device === "custom") {
    return {
      id: "custom",
      label: found?.label ?? "自定义",
      width: custom?.width ?? 390,
      height: custom?.height ?? 844,
      scale: found?.scale ?? 3,
    };
  }
  return (
    found ?? { id: "desktop", label: "桌面端", width: 0, height: 0, scale: 1 }
  );
}

export const BrowserSetDeviceSchema = z.object({
  browserId: z.string().min(1),
  device: z.enum([
    "desktop",
    "iphone",
    "iphone-se",
    "android",
    "galaxy-s23",
    "ipad-mini",
    "custom",
  ]),
  /** Custom viewport width (required when device === "custom"). */
  width: z.number().int().min(1).optional(),
  /** Custom viewport height (required when device === "custom"). */
  height: z.number().int().min(1).optional(),
  /** Screen orientation; "landscape" swaps width/height. Defaults to
   *  "portrait" when omitted (backward compatible with old callers). */
  orientation: z.enum(["portrait", "landscape"]).optional(),
  /** Effective emulated viewport size (CSS px) to apply. When set, overrides
   *  the preset/custom dims — used by the renderer to match the view's
   *  physical bounds exactly (e.g. a narrow sidebar column), which keeps
   *  capturePage() from returning black frames and pages from being clipped.
   *  Omit to use the preset/custom dims. */
  viewportWidth: z.number().int().min(1).optional(),
  viewportHeight: z.number().int().min(1).optional(),
});
export type BrowserSetDeviceInput = z.infer<typeof BrowserSetDeviceSchema>;

/** Current viewport configuration for a browser view (mirrors what was last
 *  passed to browser.setDevice). Custom dims are present only for "custom";
 *  orientation defaults to "portrait" when the field is absent. effWidth/
 *  effHeight are the EFFECTIVE emulated viewport size (CSS px) actually
 *  applied — equals the preset/custom dims (post-orientation) unless the
 *  renderer overrode them to match the view's physical bounds. */
export interface BrowserViewport {
  device: BrowserDevicePreset;
  width?: number;
  height?: number;
  orientation: BrowserOrientation;
  effWidth?: number;
  effHeight?: number;
}

/** Structured result for browser.create - either success with the id, or
 *  ok:false + error. */
export type BrowserCreateResult =
  | { ok: true; browserId: string }
  | { ok: false; error: string };

/** Generic ok/error result for browser navigation / view ops. */
export interface BrowserOpResult {
  ok: boolean;
  error?: string;
}

/* ── Address history ──
 *  History is written by main only (on did-navigate); these RPCs let the
 *  renderer remove entries without racing main's writes. */

export const BrowserHistoryRemoveSchema = z.object({
  url: z.string().min(1),
});
export type BrowserHistoryRemoveInput = z.infer<typeof BrowserHistoryRemoveSchema>;

export const BrowserHistoryClearSchema = z.object({});
export type BrowserHistoryClearInput = z.infer<typeof BrowserHistoryClearSchema>;

/** Renderer's answer to an "authRequest" push event. */
export const BrowserAuthRespondSchema = z.object({
  requestId: z.string().min(1),
  /** Empty username+password cancels the auth prompt. */
  username: z.string(),
  password: z.string(),
});
export type BrowserAuthRespondInput = z.infer<typeof BrowserAuthRespondSchema>;

