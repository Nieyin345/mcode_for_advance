import type { WebContents } from "electron";

/** Only web pages and mail links may dispatch from renderer-created popups.
 * File launching remains behind the explicit project-scoped shell IPC. */
export function externalWindowUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["https:", "http:", "mailto:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Query/hash updates may use the trusted entry; other documents must not load
 * with the full main-window preload. Embedded browser views have their own policy. */
export function isMainWindowEntry(raw: string, entry: string): boolean {
  try {
    const target = new URL(raw);
    const trusted = new URL(entry);
    return target.protocol === trusted.protocol && target.host === trusted.host
      && target.pathname === trusted.pathname && !target.username && !target.password;
  } catch { return false; }
}

export function installMainWindowNavigation(
  webContents: Pick<WebContents, "on" | "setWindowOpenHandler">,
  entry: string,
  openExternal: (url: string) => Promise<unknown>,
  warn: (message: string) => void,
): void {
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!isMainWindowEntry(url, entry)) {
      event.preventDefault();
      // Do not write arbitrary URLs/tokens into the persistent app log.
      warn("Blocked navigation away from the trusted application entry");
    }
  };
  webContents.on("will-navigate", guard);
  webContents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) guard(event, url);
  });
  webContents.setWindowOpenHandler(({ url }) => {
    const allowed = externalWindowUrl(url);
    if (allowed === null) {
      warn("Blocked unsupported external URL scheme or credentials");
    } else {
      // Also catch synchronous failures from a platform adapter.
      void Promise.resolve().then(() => openExternal(allowed)).catch(() => {
        warn("Could not open the external URL in the system application");
      });
    }
    return { action: "deny" };
  });
}
