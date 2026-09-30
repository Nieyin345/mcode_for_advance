import { pathToFileURL } from "node:url";
import { installMainWindowNavigation } from "@main/lib/windowNavigation.js";
import { BrowserWindow, shell, session, type WebContents } from "electron";
import { join } from "node:path";
import { is } from "@main/utils.js";
import { getEffectiveTheme, getThemeStylePreference } from "@main/lib/theme.js";
import { log } from "@main/lib/logger.js";
import { logStartup } from "@main/lib/startupTimer.js";
import { IPC } from "@contracts/ipc";

let mainWindow: BrowserWindow | null = null;

/** 关窗前的落盘：见 `mainWindow.on("close", ...)` 那段。 */
let quitFlushDone = false;
let quitFlushPending = false;
let quitFlushTimer: NodeJS.Timeout | null = null;

/**
 * **渲染端说"我存完了"** —— 真的关。
 *
 * 由 `ipc` 层在收到 `APP_FLUSH_BEFORE_QUIT_DONE` 时调。
 *
 * ⚠️ **幂等**：超时兜底和渲染端回执可能都到（谁先谁后不定），所以第一件事就是
 * 看 `quitFlushPending`；已经走过了就直接返回，别关两次。
 */
export function finishQuitFlush(): void {
  if (!quitFlushPending) return;
  quitFlushPending = false;
  quitFlushDone = true;
  if (quitFlushTimer) {
    clearTimeout(quitFlushTimer);
    quitFlushTimer = null;
  }
  const win = mainWindow;
  if (win && !win.isDestroyed()) win.close();
}

/** Background color matching the effective theme, so the first frame (before
 *  React mounts) doesn't flash the wrong color. Mirrors --surface in CSS
 *  (styles.css): light = #ffffff (sketch paper #fcfaf3), dark = #1a1d24
 *  (sketch kraft #3b3126) — the pre-DB fallback below is an imperceptible
 *  delta. */
function bgColor(): string {
  const sketch = getThemeStylePreference() === "sketch";
  if (getEffectiveTheme() === "dark") return sketch ? "#3b3126" : "#1a1d24";
  return sketch ? "#fcfaf3" : "#ffffff";
}

/** Title-bar overlay colour scheme that matches the app theme. The overlay sits
 *  behind the native min/max/close buttons when `titleBarStyle: 'hidden'` is
 *  active, so it must visually blend with the custom titlebar in the renderer.
 *
 *  `color` mirrors --surface-muted (the toolbar's background — it matches the
 *  full-height sidebar so they read as one frame); `symbolColor` mirrors
 *  --content-subtle so the button glyphs match the dim UI text tone. Values
 *  must stay in sync with styles.css (.dark block + the sketch section's
 *  paper palette: #f6f2e7 / #8d8371, and kraft palette: #332a20 / #aca089).
 *
 *  `height` must match the renderer titlebar's height (h-10 = 40px): Electron
 *  draws the overlay aligned to the top of the window, and the buttons are
 *  centered within `height`. If this is smaller than the bar (e.g. 32), the
 *  buttons sit too high instead of being vertically centered. */
function overlayColors() {
  const dark = getEffectiveTheme() === "dark";
  const sketch = getThemeStylePreference() === "sketch";
  return {
    color: dark ? (sketch ? "#332a20" : "#2c313c") : sketch ? "#f6f2e7" : "#f4f4f5",
    symbolColor: dark ? (sketch ? "#aca089" : "#9ea2ab") : sketch ? "#8d8371" : "#71717a",
    height: 40,
  };
}

/** Update the title-bar overlay colors (called when the theme switches).
 *
 *  `setTitleBarOverlay` only exists on Windows and Linux, where
 *  `titleBarOverlay` paints the area behind the native min/max/close buttons.
 *  macOS uses the traffic-light buttons (see `trafficLightPosition`) and has no
 *  overlay, so the call is a no-op there - without this guard it throws
 *  "setTitleBarOverlay is not a function" on macOS. */
export function updateTitleBarOverlay(): void {
  if (process.platform === "darwin") return;
  mainWindow?.setTitleBarOverlay(overlayColors());
}

/** Grant the renderer access to the microphone (voice input).
 *
 *  Electron defaults to denying mic permission for a sandboxed renderer, so
 *  the composer's voice button (which calls `navigator.mediaDevices.
 *  getUserMedia({ audio })`) would fail without this. This app's only mic
 *  consumer is the voice-input feature, so we allow `media` requests on the
 *  default session outright. Runs once, before any window loads a page.
 *  Uses Electron's `media` permission type (the umbrella covering mic/camera);
 *  we only ever request the mic, so granting media is sufficient.
 */
let sessionPermissionsReady = false;
function setupSessionPermissions(): void {
  if (sessionPermissionsReady) return;
  sessionPermissionsReady = true;
  const ses = session.defaultSession;

  // A custom check handler REPLACES Electron's default allow-all, so every
  // permission the renderer's own code relies on must be listed here or it
  // silently regresses app-wide. `navigator.clipboard.writeText()` performs a
  // `clipboard-sanitized-write` CHECK (no prompt) and `readText()` needs
  // `clipboard-read` — denying these broke every copy affordance (chat code
  // blocks, file-tree path copy, the mobile-connect dialog) and terminal
  // paste. Clipboard grants are scoped to the main window's webContents so
  // arbitrary pages can never touch the OS clipboard; the embedded browser
  // views use a separate persistent partition and are unaffected either way.
  const isAllowed = (wc: WebContents | null, permission: string, rawDetails?: unknown): boolean => {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || wc?.id !== main.webContents.id) return false;
    const details = (rawDetails ?? {}) as {
      isMainFrame?: boolean; mediaType?: string; mediaTypes?: string[];
    };
    if (details.isMainFrame === false) return false;
    if (permission === "media") {
      return details.mediaType !== "video" && !details.mediaTypes?.includes("video");
    }
    return permission === "mediaKeySystem" || permission === "clipboard-sanitized-write"
      || permission === "clipboard-read";
  };

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(isAllowed(wc, permission, details));
  });
  ses.setPermissionCheckHandler((wc, permission, _requestingOrigin, details) => {
    return isAllowed(wc, permission, details);
  });
}

/** Create the primary three-pane window. */
export function createMainWindow(): BrowserWindow {
  setupSessionPermissions();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "Mcode",
    // Window/taskbar icon. In dev the build/ tree sits two levels up from
    // out/main; in packaged builds electron-builder injects the icon from
    // build/icon.ico/.icns into the executable itself, so this is mainly for
    // the dev experience (otherwise the default Electron icon shows up).
    icon: join(__dirname, "../../build/icon.png"),
    backgroundColor: bgColor(),
    // Hidden title-bar + overlay lets us render custom content (the toggle
    // button plus a draggable handle) in the title-bar row alongside the
    // native window-control buttons (min / max / close).  The overlay colours
    // are set once here and kept in sync by updateTitleBarOverlay().
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(),
    // macOS only: pin the traffic-light buttons (close/min/zoom) so they sit
    // vertically centered in our 40px (h-10) custom titlebar. Without this,
    // macOS uses its default Y (~14px from the top), which is tuned for the
    // standard ~28px titlebar and leaves the buttons sitting too high in our
    // taller bar. The 12px-diameter circles are vertically centered when the
    // group origin is at y = (40 - 14) / 2 ≈ 13. Ignored on Windows/Linux.
    trafficLightPosition: { x: 20, y: 13 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    logStartup("ready-to-show");
    mainWindow?.show();
  });

  // Forward window focus/blur to the renderer so it can make notification
  // decisions (OS notification vs in-app toast vs silent badge). The renderer
  // also tracks document.visibilityState for tab-hide, but the Electron-level
  // focus event is the authoritative "is our app frontmost?" signal.
  // `blur`/`focus` fire on app switch, dock click, minimize, and restore.
  const pushFocus = (focused: boolean) => sendToRenderer(IPC.WINDOW_FOCUS_CHANGED, { focused });
  mainWindow.on("focus", () => pushFocus(true));
  mainWindow.on("blur", () => pushFocus(false));
  // On macOS, minimize doesn't trigger blur reliably in all versions, so also
  // hook the minimize/restore pair for a deterministic signal.
  mainWindow.on("minimize", () => pushFocus(false));
  mainWindow.on("restore", () => pushFocus(true));
  // Null out the reference once the window is gone so the optional chains in
  // sendToRenderer / updateTitleBarOverlay / getMainWindow short-circuit
  // instead of operating on a destroyed BrowserWindow. Without this, async
  // callbacks (node-pty onExit/onData, approval bridges) that fire during quit
  // would dereference a stale, already-destroyed window.
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Forward renderer console messages to stderr so we can debug blank screens
  // without watching DevTools, AND persist them to main.log so they survive
  // even when launched from the Start Menu (no stderr sink). The renderer's
  // own errors never go through the main-process `log`, so without this a
  // blank-screen bug leaves no trace on disk after the app quits.
  // Electron ≥35 passes the details on the event object (positional args are
  // deprecated). The old numeric level was 0=verbose 1=info 2=warning 3=error,
  // so the former `["LOG","WARN","ERROR"][level]` mapping logged console.log
  // as WARN and dropped console.error to LOG — never persisted to main.log.
  mainWindow.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
    const tag = level === "error" ? "ERROR" : level === "warning" ? "WARN" : "LOG";
    const line2 = `[renderer:${tag}] ${message} (${sourceId}:${lineNumber})`;
    process.stderr.write(`${line2}\n`);
    if (tag === "ERROR") log.error(line2);
    else if (tag === "WARN") log.warn(line2);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    const line = `[renderer:GONE] ${JSON.stringify(details)}`;
    process.stderr.write(`${line}\n`);
    log.error(line);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    const line = `[renderer:FAIL_LOAD] ${code} ${desc} ${url}`;
    process.stderr.write(`${line}\n`);
    log.error(line);
  });

  // Never allow an untrusted page to inherit the main window's IPC preload.
  const rendererEntry = is.dev && process.env["ELECTRON_RENDERER_URL"]
    ? process.env["ELECTRON_RENDERER_URL"]!
    : pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  installMainWindowNavigation(
    mainWindow.webContents, rendererEntry,
    url => shell.openExternal(url), message => log.warn(message),
  );

  // Load the renderer.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    // 加载失败另有 did-fail-load 在报,但那条 promise 本身不能丢:它 reject 的时候
    // (dev server 还没起来)是一条无人接管的 rejection。
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]).catch((err: unknown) => {
      log.error(`loadURL failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // DevTools is intentionally NOT auto-opened. The detached DevTools
    // front-end emits harmless-but-noisy Chromium console errors on every
    // startup (e.g. "Autofill.enable wasn't found", "Unknown VE context:
    // language-mismatch") because Electron's bundled Chromium doesn't
    // implement every CDP domain the DevTools UI probes. Those errors come
    // from Chromium's own logging, not the console-message listener above,
    // so they can't be filtered in app code. Renderer errors are already
    // surfaced via the listener above -> [renderer:ERROR] on stderr, so a
    // blank screen is debuggable without DevTools. Press Ctrl+Shift+I
    // (Cmd+Option+I on macOS) to open DevTools manually when needed.
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html")).catch((err: unknown) => {
      log.error(`loadFile failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Safety net: if ready-to-show never fires within 3s (e.g. the renderer's
  // first paint is stuck because a script was blocked by CSP, or a native
  // module failed to load and stalled page load), force the window visible.
  // The whole "app runs in the background but shows no UI" class of bugs on
  // packaged Windows builds comes from show:false + a ready-to-show that
  // never arrives — this guarantee ensures the user at least sees the window
  // (and, if it's blank, can open DevTools to find out why) instead of a
  // phantom background process. Once the real ready-to-show fires it simply
  // calls show() again, which is a no-op on an already-visible window.
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log.warn("ready-to-show timed out after 3s — forcing window visible");
      mainWindow.show();
    }
  }, 3000);
  mainWindow.once("closed", () => clearTimeout(showFallback));

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Send a push event to the renderer (main -> renderer).
 *
 *  Defensive against a closed/destroyed window: node-pty's onExit/onData and
 *  the approval bridges fire asynchronously, so they can run after the window
 *  has torn down during quit. Calling webContents.send() on a destroyed window
 *  throws "Object has been destroyed" (an uncaught main-process exception).
 *  Drop silently in that case - the renderer is gone and nobody can receive
 *  the message anyway. */
/** 桌面渲染端此刻能不能收事件(窗口在、没销毁、没崩)。手机 SSE 连上时带给它
 *  (`session.runningSnapshot.desktopAttached`):桌面在 = 回合消息由桌面唯一
 *  落库,手机不写;桌面不在(macOS 关窗后主进程还活着)= 手机自己写。 */
export function hasLiveRendererWindow(): boolean {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  return !wc.isDestroyed() && !wc.isCrashed();
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isDestroyed()) return;
  wc.send(channel, ...args);
}
