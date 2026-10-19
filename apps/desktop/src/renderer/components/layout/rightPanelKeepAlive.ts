import type { RightPanelTab } from "@contracts/ipc";

/** Only high-value stateful panes are retained after being visited.
 * Don't mount the entire workflow/task/preview suite in the background.
 */
export const CACHED_BUILTIN_RIGHT_TABS = ["files", "git", "browser"] as const;

export function isCachedRightTab(id: string): id is (typeof CACHED_BUILTIN_RIGHT_TABS)[number] {
  return (CACHED_BUILTIN_RIGHT_TABS as readonly string[]).includes(id);
}

/** Use the SAME tab element across rail switches; never eagerly mount
 * unvisited tabs. Return the original Set to avoid redundant React updates.
 */
export function rememberRightTab(
  visited: ReadonlySet<RightPanelTab>,
  active: RightPanelTab,
): ReadonlySet<RightPanelTab> {
  if (!isCachedRightTab(active) || visited.has(active)) return visited;
  return new Set([...visited, active]);
}

export function shouldMountCachedBuiltin(
  id: (typeof CACHED_BUILTIN_RIGHT_TABS)[number],
  active: RightPanelTab,
  visited: ReadonlySet<RightPanelTab>,
): boolean {
  return id === active || visited.has(id);
}

export function rememberPanelId(visited: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!id || visited.has(id)) return visited;
  return new Set([...visited, id]);
}

/** A custom panel can disappear from the effective rail (deleted, hidden or
 * different workspace). Forget its remembered ID so a later re-add starts
 * fresh instead of auto-mounting an unvisited sandbox with stale state.
 */
export function prunePanelIds(
  visited: ReadonlySet<string>,
  availablePanelIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if ([...visited].every((id) => availablePanelIds.has(id))) return visited;
  return new Set([...visited].filter((id) => availablePanelIds.has(id)));
}
