/** A file menu belongs to both a project and a live file-tab identity.
 * A stale context menu must never close current-project files after switching
 * project, even when both projects happen to contain the same path.
 */
export interface ProjectFileTabMenu {
  path: string;
  x: number;
  y: number;
  projectId: string | null;
}
/** Check the latest Zustand snapshot synchronously when a menu command
 * executes, not just when React last rendered the popup. The selected project
 * can change between those two moments.
 */
export function fileTabMenuActionPath(
  menu: ProjectFileTabMenu | null,
  getSnapshot: () => {
    activeProjectId: string | null;
    ideOpenFilesByProject: Record<string, readonly string[]>;
  },
): string | null {
  const state = getSnapshot();
  const projectId = state.activeProjectId;
  const files = projectId ? state.ideOpenFilesByProject[projectId] ?? [] : [];
  return liveFileTabMenu(menu, projectId, files)?.path ?? null;
}

export function liveFileTabMenu(
  menu: ProjectFileTabMenu | null,
  activeProjectId: string | null,
  openFiles: readonly string[],
): ProjectFileTabMenu | null {
  if (!menu || !menu.projectId || !activeProjectId ||
      menu.projectId !== activeProjectId || !openFiles.includes(menu.path)) return null;
  return menu;
}
