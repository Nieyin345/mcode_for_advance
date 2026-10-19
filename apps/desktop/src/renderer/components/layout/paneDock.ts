/** UI docking for the single stateful IDE panel. Do not reconstruct the pane
 * tree to move it: ThreePaneLayout applies flex order only.
 */
export type PaneDock = "left" | "right";
export const PANE_DOCK_MIME = "application/x-mcode-pane-dock";
export const RIGHT_PANE_DRAG_ID = "mcode-right-panel";

export function parsePaneDock(value: unknown): PaneDock {
  return value === "left" ? "left" : "right";
}

/** A dropped panel docks on the side of the workspace under the pointer.
 * Unmeasured, non-finite or zero-size rectangles never change the layout.
 */
export function dockSideAtPoint(x: number, left: number, width: number): PaneDock | null {
  if (!Number.isFinite(x) || !Number.isFinite(left) ||
      !Number.isFinite(width) || width <= 0) return null;
  return x < left + width / 2 ? "left" : "right";
}

/** Store adjustRightWidth/adjustWidePanelPct subtract their input deltas
 * because the handle used to be LEFT of the pane. When docked on the left,
 * the divider sits on the RIGHT: invert the delta so it follows the pointer.
 */
export function dockResizeDelta(deltaPx: number, dock: PaneDock): number {
  return dock === "left" ? -deltaPx : deltaPx;
}

/** Explicit keyboard docking for the rail drag handle. Keyboard arrows map to
 * the visual side, not to a toggle, so repeated presses are deterministic.
 * Ignore IME composition and modifier shortcuts owned by the workspace/OS.
 */
export function paneDockFromKeyboard(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}): PaneDock | null {
  if (event.isComposing || event.keyCode === 229 || event.altKey ||
      event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === "ArrowLeft") return "left";
  if (event.key === "ArrowRight") return "right";
  return null;
}

/** Flex order values are stable even while switching right panel side.
 * "aside" keeps its React key and element identity, so PTY/Monaco/iframe
 * descendants aren't destroyed by docking operations.
 */
export function dockFlexOrder(dock: PaneDock) {
  return dock === "left"
    ? { center: 5, toolbar: 4, divider: 3, aside: 2 } as const
    : { center: 2, toolbar: 3, divider: 4, aside: 5 } as const;
}
