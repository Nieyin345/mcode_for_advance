/**
 * Auto-update module (electron-updater, GitHub Releases channel).
 *
 * electron-updater only works inside a packaged app (it reads app-update.yml
 * from the asar/resources dir, which doesn't exist in dev). So in dev every
 * entry point short-circuits to a no-op / "up-to-date" result - the updater
 * simply isn't active during `pnpm dev`.
 *
 * Flow:
 *  - On boot (prod), `initUpdater()` wires autoUpdater listeners and schedules
 *    a delayed first check (10s) plus a recurring check (every 4h).
 *  - `update-available` -> push `update:available` to renderer (autoDownload
 *    is OFF, so the user opts in via the About panel's "download" button).
 *  - `app.downloadUpdate()` -> `autoUpdater.downloadUpdate()`.
 *  - `download-progress` -> push `update:downloadProgress` (percent + bytes)
 *    and persist the snapshot so reopening the About panel keeps the bar.
 *  - `update-downloaded` -> push `update:downloaded`; the renderer offers
 *    "restart & install" -> `app.quitAndInstall()`.
 *
 * The download/downloaded states are persisted to the settings table
 * (UPDATE_STATE_SETTING_KEY) so that remounting the About panel or restarting
 * the app mid-flow restores the banner instead of dropping back to idle.
 *
 * Every public function is wrapped so update failures never crash the app -
 * the updater is a convenience, not a core path.
 */
import { app } from "electron";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
// electron-updater ships as CommonJS and exposes `autoUpdater` as a
// getter-defined named export on `module.exports`:
//   Object.defineProperty(exports, "autoUpdater", { enumerable: true, get() {...} })
// Under ESM output ("type": "module") a dynamic `await import()` does NOT
// surface getter-defined CJS named exports - `mod.autoUpdater` is `undefined`,
// so `autoUpdater.autoDownload = false` throws
// "Cannot set properties of undefined" and `initUpdater()` fails silently
// (every check then short-circuits to "up-to-date <current version>", making
// the app claim it's on the newest release even when a newer one exists).
//
// `createRequire` + `require()` loads the CJS module directly, which preserves
// the getter and correctly resolves `autoUpdater`. This mirrors how
// TerminalManager loads the CJS `node-pty` addon.
//
// Lazy-loaded: electron-updater only works in packaged builds and is never
// needed during startup (the first check is scheduled 10s after boot). Keeping
// the require() inside loadAutoUpdater() shaves load time in both dev (where
// it's a pure no-op) and prod. Mirrors the node-pty / SDK lazy-load pattern.
import type { AppUpdater } from "electron-updater";
const requireFromHere = createRequire(import.meta.url);
let autoUpdaterRef: AppUpdater | null = null;
function loadAutoUpdater(): AppUpdater {
  if (!autoUpdaterRef) {
    autoUpdaterRef = requireFromHere("electron-updater").autoUpdater as AppUpdater;
  }
  return autoUpdaterRef;
}
import {
  IPC,
  UPDATE_STATE_SETTING_KEY,
  type CheckForUpdatesResult,
  type PersistedUpdateState,
} from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { is } from "@main/utils.js";
import { SettingRepo } from "@main/store/repositories.js";

/** Delay before the first automatic update check after boot (ms). */
const FIRST_CHECK_DELAY_MS = 10_000;
/** Interval between recurring update checks (ms) - every 4 hours. */
const RECURRING_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Whether the updater is active (packaged app only). */
let initialized = false;

/** Track the latest update info so the check RPC can report it synchronously. */
let pendingVersion: string | null = null;

/** Source of the most recently initiated check ("auto" = boot/interval timer,
 *  "manual" = About panel RPC). The `update-available` listener reads this to
 *  tag its push, so the global notification card can distinguish a background
 *  discovery (pop the card) from a user-initiated one (panel already shows it). */
let lastCheckSource: "auto" | "manual" = "manual";

/** 交给用户看的那句话 —— **只留首行**。
 *
 *  这个模块的 error 来自 electron-updater / builder-util-runtime,而它们的
 *  `HttpError.message` 是一整段多行文本(实测):
 *
 *      404 Not Found
 *      "method: GET url: https://api.github.com/repos/x/y/releases\n\nPlease double check …"
 *      Headers: {
 *        "content-type": "application/json"
 *      }
 *
 *  这一整段会被渲染端**原样**填进 About 面板那句「更新检查失败:{message}」,于是
 *  用户为一次「网络不通」看到的是十几行原始响应 + 一串 headers —— 那不是在把话说
 *  清楚,是把内部错误对象的形状漏了出去。给用户看第一句就够(状态码或人写的那句),
 *  后面的形状留在日志里(`log.error` 那边仍然打全文)。
 *
 *  同 `ipc/terminal.ts` 的 `errText`:原来那些 message 本来就是人写的,所以只收口
 *  **多行**这一种形状,不重写内容。 */
function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? "未知错误";
}

/** Version currently being downloaded (set when download starts, cleared on
 *  *  completion/error). Used to tag download-progress events with a version. */
let downloadingVersion: string | null = null;

/** Cached result of {@link detectManualInstallRequired}. Undefined before the
 *  first computation. On macOS with an ad-hoc signed app (no Apple Developer
 *  ID), Squirrel.Mac silently fails to apply updates, so we must guide the
 *  user to a manual download instead. */
let manualInstallRequiredCache: boolean | undefined;

/** Detect whether the running macOS app is ad-hoc signed (TeamIdentifier not
 *  set), in which case Squirrel.Mac can't reliably auto-install updates and
 *  we must fall back to guiding the user to a manual download.
 *
 *  Returns false on non-macOS platforms (Windows uses NSIS, which doesn't
 *  verify a code-signing chain). The result is cached on first call.
 *  Guarded: any codesign failure conservatively returns true on macOS so the
 *  user is never left with a no-op "restart & install" button. */
function detectManualInstallRequired(): boolean {
  if (manualInstallRequiredCache !== undefined) return manualInstallRequiredCache;
  // Windows / Linux use installer-based update flows that don't depend on a
  // verifiable signature chain.
  if (process.platform !== "darwin") {
    manualInstallRequiredCache = false;
    return false;
  }
  try {
    // `codesign -dv` writes the signing info to STDERR (not stdout) and exits
    // 0 on success. TeamIdentifier is "not set" for ad-hoc ("-") signatures.
    //
    // ⚠️ 两条都必须按住了,少一条这段就失效(实测):
    //
    //  1. 读 **stderr**,不是返回值。原先写的是 `execFileSync(…, { encoding:
    //     "utf8", stdio: ["ignore", "ignore", "pipe"] })` —— 第三项接的是 stderr,
    //     而 stdout 被 ignore 之后**返回值是 `null`**(实测,即使设了 encoding),
    //     于是 `/TeamIdentifier…/` 在 `null` 上永远不命中。真实后果是
    //     **没有任何一台 macOS 机器被判成 ad-hoc**:用本项目 `build/adhoc-sign.cjs`
    //     签出来的那些用户拿到的是「重启安装」按钮,而 Squirrel.Mac 装不上 ad-hoc
    //     的包 —— 按下去就是没反应,也没人引导他们去发布页。下面 `catch` 里那句
    //     "任何 codesign 失败都保守地当作要手动安装,免得用户对着一个没反应的按钮"
    //     说的正是这个现场,而这条路**永远走不到**(二进制在就返回 null,不在就抛)。
    //  2. `spawnSync` 与 `execFileSync` 不同:**二进制不存在时它不抛**。失败躺在返回
    //     值里 —— `error` 有值、`status` 是 `null`。不显式抛出去,"问不出来"又会被
    //     当成"签名是好的"(空输出里当然没有 TeamIdentifier),与那条 catch 的意图
    //     正相反。`status !== 0` 同理。
    const res = spawnSync("codesign", ["-dv", app.getAppPath()], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (res.error || res.status !== 0) {
      throw res.error ?? new Error(`codesign exited with status ${res.status}`);
    }
    const output = `${res.stderr ?? ""}${res.stdout ?? ""}`;
    const isAdhoc = /TeamIdentifier\s*=\s*not set/.test(output);
    manualInstallRequiredCache = isAdhoc;
    log.info(`updater: macOS ad-hoc signature detected (manual install ${isAdhoc ? "required" : "not required"})`);
    return isAdhoc;
  } catch (err) {
    // If we can't determine the signature, conservatively assume manual install
    // is needed so the user isn't left with a silent no-op.
    log.warn(`updater: codesign check failed, assuming manual install required: ${err instanceof Error ? err.message : String(err)}`);
    manualInstallRequiredCache = true;
    return true;
  }
}

/** Wire autoUpdater event listeners and schedule periodic checks.
 *  Safe to call in dev - it short-circuits and does nothing.
 *  Async because electron-updater is lazy-loaded on first use. */
export async function initUpdater(): Promise<void> {
  if (!is.prod) {
    // electron-updater has no app-update.yml to read in dev; skip entirely.
    return;
  }

  try {
    const autoUpdater = loadAutoUpdater();
    // Don't auto-download - let the user opt in from the About panel.
    autoUpdater.autoDownload = false;
    // Install on quit if a download has completed (harmless if none pending).
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      pendingVersion = info.version ?? null;
      // Detect the ad-hoc signature at discovery time so macOS users are
      // guided to the releases page before downloading ~100MB that Squirrel.Mac
      // could never install. Cached after the first call.
      const manualInstallRequired = detectManualInstallRequired();
      log.info(`updater: update available ${pendingVersion ?? "(unknown version)"}`);
      sendToRenderer(IPC.UPDATE_AVAILABLE, {
        channel: IPC.UPDATE_AVAILABLE,
        version: info.version ?? "",
        releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
        releaseDate: info.releaseDate,
        source: lastCheckSource,
        manualInstallRequired,
      });
    });

    autoUpdater.on("update-not-available", (info) => {
      pendingVersion = null;
      // A previously discovered update may have been superseded; clear any
      // stale "downloading"/"downloaded" snapshot so the About panel doesn't
      // show a ghost banner for a version that no longer exists.
      clearPersistedUpdateState();
      log.info(`updater: up-to-date (${info.version ?? app.getVersion()})`);
    });

    autoUpdater.on("update-downloaded", (info) => {
      const version = info.version ?? "";
      downloadingVersion = null;
      // On macOS with an ad-hoc signature, Squirrel.Mac will silently fail to
      // apply this update. Detect that up front so the renderer can guide the
      // user to a manual download instead of offering a no-op "restart".
      const manualInstallRequired = detectManualInstallRequired();
      log.info(`updater: update downloaded ${version}${manualInstallRequired ? " (manual install required)" : ""}`);
      persistUpdateState({ status: "downloaded", version, manualInstallRequired });
      sendToRenderer(IPC.UPDATE_DOWNLOADED, {
        channel: IPC.UPDATE_DOWNLOADED,
        version,
        releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
        manualInstallRequired,
      });
    });

    autoUpdater.on("error", (err) => {
      log.error(`updater: error ${err?.message ?? String(err)}`);
      // A download error leaves no usable snapshot; clear it so the About
      // panel doesn't get stuck on a stale "downloading" bar on next open.
      if (downloadingVersion !== null) {
        downloadingVersion = null;
        clearPersistedUpdateState();
      }
    });

    autoUpdater.on("download-progress", (progress) => {
      const version = downloadingVersion ?? pendingVersion ?? "";
      const percent = progress.percent ?? 0;
      log.info(
        `updater: downloading ${percent.toFixed(1)}% (${progress.transferred}/${progress.total})`,
      );
      persistUpdateState({
        status: "downloading",
        version,
        percent,
        transferred: progress.transferred,
        total: progress.total,
      });
      sendToRenderer(IPC.UPDATE_DOWNLOAD_PROGRESS, {
        channel: IPC.UPDATE_DOWNLOAD_PROGRESS,
        version,
        percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    });

    // Delayed first check, then recurring. Both pass "auto" so the global
    // notification card knows the discovery came from the background check
    // (a "manual" tag means the user clicked the About panel's button).
    setTimeout(() => {
      void checkForUpdates("auto");
    }, FIRST_CHECK_DELAY_MS);
    setInterval(() => {
      void checkForUpdates("auto");
    }, RECURRING_CHECK_INTERVAL_MS);

    initialized = true;
    log.info("updater: initialized (GitHub Releases channel)");
  } catch (err) {
    log.error(`updater: init failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Check for updates. In dev, returns "up-to-date" without hitting the network.
 *  In prod, triggers autoUpdater.checkForUpdates() and resolves once the check
 *  completes (or errors). `source` tags the originating check so the
 *  `update-available` push can tell the renderer whether this was a background
 *  (auto) or user-initiated (manual) discovery. */
export async function checkForUpdates(source: "auto" | "manual" = "manual"): Promise<CheckForUpdatesResult> {
  // dev: electron-updater has no app-update.yml to read, so "up-to-date" is the
  // documented, intentional answer here. (见文件头:`pnpm dev` 下更新器不激活。)
  if (!is.prod) {
    return { status: "up-to-date", version: app.getVersion() };
  }
  // prod,但 `initUpdater()` 没成 —— 那条路只在 catch 里留一行日志。此时再报
  // 「已是最新版本」就是**在骗用户**:更新器根本没在跑,后面有没有新版本谁也不知道
  // (文件头警告过的正是这个形状:"the app claim it's on the newest release even
  // when a newer exists")。如实报错,让面板说「更新检查失败:…」。
  if (!initialized) {
    log.error("updater: checkForUpdates called while the updater is not initialized");
    return { status: "error", error: "更新器未启动" };
  }

  lastCheckSource = source;
  try {
    const autoUpdater = loadAutoUpdater();
    const result = await autoUpdater.checkForUpdates();
    // If a newer version exists, `update-available` will have fired and set
    // pendingVersion. Otherwise the check resolves and we're up-to-date.
    if (pendingVersion) {
      return {
        status: "available",
        version: pendingVersion,
        manualInstallRequired: detectManualInstallRequired(),
      };
    }
    const version = result?.updateInfo?.version ?? app.getVersion();
    return { status: "up-to-date", version };
  } catch (err) {
    const msg = errText(err);
    // 日志留全文(形状在这里有用),交给用户的那句只留首行。
    log.error(
      `updater: checkForUpdates failed ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: "error", error: msg };
  }
}

/** Begin downloading the pending update (user opted in from the UI).
 *  No-op in dev or when no update is pending. */
export async function downloadUpdate(): Promise<void> {
  if (!is.prod || !initialized) return;
  try {
    const autoUpdater = loadAutoUpdater();
    // Record the version being downloaded so download-progress events can tag
    // it, and seed the persisted state so an early remount shows "downloading"
    // even before the first progress chunk arrives.
    downloadingVersion = pendingVersion;
    if (downloadingVersion) {
      persistUpdateState({ status: "downloading", version: downloadingVersion });
    }
    await autoUpdater.downloadUpdate();
  } catch (err) {
    downloadingVersion = null;
    clearPersistedUpdateState();
    // 日志留全文;交给用户的那句只留首行(同 checkForUpdates —— 下载失败也走
    // `HttpError`,原来那段原始响应会原样出现在面板里)。
    log.error(
      `updater: downloadUpdate failed ${err instanceof Error ? err.message : String(err)}`,
    );
    // Re-throw so the initiator (About panel / notification card) can restore
    // its UI — otherwise the RPC resolves as success and the card is stuck on
    // a 0% progress bar forever.
    throw new Error(errText(err));
  }
}

/** Quit the app and install the downloaded update. No-op if nothing downloaded,
 *  or on macOS with an ad-hoc signature (Squirrel.Mac would silently fail to
 *  apply the update — the renderer guides the user to a manual download). */
export async function quitAndInstall(): Promise<void> {
  if (!is.prod || !initialized) return;
  // On macOS with an ad-hoc signature, quitAndInstall() would silently fail
  // (Squirrel.Mac can't verify the replacement). Bail out — the renderer
  // already knows (via manualInstallRequired on update-downloaded) and will
  // direct the user to the releases page instead.
  if (detectManualInstallRequired()) {
    log.info("updater: skipping quitAndInstall (ad-hoc signed app, manual install required)");
    return;
  }
  try {
    const autoUpdater = loadAutoUpdater();
    // The install will swap the binary and restart; clear the persisted state
    // so the next launch (running the new version) doesn't show a stale banner.
    clearPersistedUpdateState();
    autoUpdater.quitAndInstall();
  } catch (err) {
    log.error(`updater: quitAndInstall failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ── Persisted update-state helpers ──
 *  The download/downloaded states are written to the settings table so the
 *  About panel can restore its banner after remount or app restart. These are
 *  guarded so a DB write failure never breaks the update flow itself. */

/** Write a snapshot of the current update flow to the settings table. */
function persistUpdateState(
  state:
    | { status: "downloading"; version: string; percent?: number; transferred?: number; total?: number }
    | { status: "downloaded"; version: string; manualInstallRequired?: boolean },
): void {
  try {
    const snapshot: PersistedUpdateState = {
      status: state.status,
      version: state.version,
      percent: state.status === "downloading" ? (state.percent ?? 0) : 0,
      transferred: state.status === "downloading" ? (state.transferred ?? 0) : 0,
      total: state.status === "downloading" ? (state.total ?? 0) : 0,
      updatedAt: new Date().toISOString(),
      manualInstallRequired: state.status === "downloaded" ? state.manualInstallRequired : undefined,
    };
    SettingRepo.set(UPDATE_STATE_SETTING_KEY, JSON.stringify(snapshot));
  } catch (err) {
    // Persisting the snapshot is best-effort; never let it break the updater.
    log.error(`updater: persist state failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remove the persisted update state (after install, or when it goes stale). */
function clearPersistedUpdateState(): void {
  try {
    SettingRepo.set(UPDATE_STATE_SETTING_KEY, "");
  } catch (err) {
    log.error(`updater: clear state failed ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read the persisted update state, or null if none/cleared. Used by the About
 *  panel on mount to restore its banner without re-checking for updates. */
export function getPersistedUpdateState(): PersistedUpdateState | null {
  try {
    const raw = SettingRepo.get(UPDATE_STATE_SETTING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedUpdateState;
    if (parsed.status !== "downloading" && parsed.status !== "downloaded") return null;
    return parsed;
  } catch {
    return null;
  }
}
