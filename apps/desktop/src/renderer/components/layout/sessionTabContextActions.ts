/** ARC-005 session-tab close plan.
 * Keep "close tab" separate from deleting the underlying session or cancelling
 * its in-flight SDK turn. The caller feeds this plan into the existing store's
 * closeTab action; missing/stale targets never cause a bulk close.
 */
export type SessionTabCloseMode = "one" | "others" | "all";

/** A context-menu click can arrive after the selected project or open tabs
 * changed. Session IDs may still exist in the global openTabs array, so just
 * checking that ID is present cannot protect an old menu from closing tabs in
 * the newly selected project.
 */
export interface ProjectSessionTabMenu {
  id: string;
  x: number;
  y: number;
  projectId: string | null;
}

export function liveSessionTabMenu(
  menu: ProjectSessionTabMenu | null,
  activeProjectId: string | null,
  openTabs: readonly string[],
): ProjectSessionTabMenu | null {
  if (!menu || !menu.projectId || !activeProjectId ||
      menu.projectId !== activeProjectId || !openTabs.includes(menu.id)) return null;
  return menu;
}

/** Mouse contextmenu events often also have detail === 0.
 * Use coordinates, not detail, to distinguish keyboard Shift+F10 fallback. */
export function sessionTabMenuPosition(
  clientX: number,
  clientY: number,
  tabRect: Pick<DOMRect, "left" | "bottom">,
): { x: number; y: number } {
  if (Number.isFinite(clientX) && Number.isFinite(clientY) &&
      (clientX !== 0 || clientY !== 0)) return { x: clientX, y: clientY };
  return { x: tabRect.left + 16, y: tabRect.bottom };
}

export function sessionTabsToClose(
  openTabs: readonly string[],
  target: string,
  mode: SessionTabCloseMode,
): string[] {
  if (!target || !openTabs.includes(target)) return [];
  if (mode === "one") return [target];
  if (mode === "others") return openTabs.filter((id) => id !== target);
  if (mode === "all") return [...openTabs];
  return [];
}
