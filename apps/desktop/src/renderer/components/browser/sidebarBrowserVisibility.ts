/**
 * Native WebContentsView is above DOM z-index. A kept-mounted sidebar MUST
 * still deactivate its native view whenever its containing pane is hidden.
 * Overlay mode is independent of the sidebar.
 */
/** Never show a floating WebContentsView before we have measured a real,
 * positive renderer stage. Native views ignore CSS clipping and z-index.
 */
export function mayShowNativeBrowserView(
  active: boolean,
  width: number | undefined,
  height: number | undefined,
): boolean {
  return active && typeof width === "number" && Number.isFinite(width) && width > 0 &&
    typeof height === "number" && Number.isFinite(height) && height > 0;
}

export function sidebarBrowserIsActive(
  mode: "overlay" | "sidebar",
  overlayOpen: boolean,
  rightOpen: boolean,
  settingsOpen: boolean,
  sidebarSelected = true,
): boolean {
  if (settingsOpen) return false;
  return mode === "overlay" ? overlayOpen : !overlayOpen && rightOpen && sidebarSelected;
}
