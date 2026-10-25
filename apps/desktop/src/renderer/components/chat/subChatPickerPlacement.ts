/** Viewport-safe geometry for the profile picker launched from the
 * composer's "+" button. Width and height are constrained by the *available*
 * space, not by a fixed 48px minimum that can escape very short windows.
 * Keep the picker attached to its trigger on both standard and side-chat
 * surfaces while remaining fully inside the current visual viewport. */
export function subChatPickerPlacement(
  anchor: { left: number; top: number; bottom: number; width: number },
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
  maxWidth = 420,
  maxHeight = 320,
): { left: number; top: number; width: number; maxHeight: number } {
  const vw = Math.max(0, viewportWidth);
  const vh = Math.max(0, viewportHeight);
  const width = Math.max(0, Math.min(maxWidth, Math.max(300, anchor.width), vw - 2 * margin));
  const left = Math.max(margin, Math.min(anchor.left, Math.max(margin, vw - margin - width)));
  const above = Math.max(0, anchor.top - margin);
  const below = Math.max(0, vh - anchor.bottom - margin);
  const openUp = above >= Math.min(maxHeight, below);
  const available = openUp ? above : below;
  const height = Math.max(0, Math.min(maxHeight, available, vh - 2 * margin));
  const top = openUp ? anchor.top - margin - height : anchor.bottom + margin;
  return {
    left,
    top: Math.max(margin, Math.min(top, Math.max(margin, vh - margin - height))),
    width,
    maxHeight: height,
  };
}

/** Place the error feedback *after measuring its real size*. When it cannot
 * fit above the trigger, try below; otherwise clamp to the nearest visible
 * area. Fixed-position content never crosses the viewport bounds. */
export function subChatErrorPlacement(
  anchor: { left: number; top: number; bottom: number },
  popupWidth: number,
  popupHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewportWidth - margin - popupWidth);
  const maxTop = Math.max(margin, viewportHeight - margin - popupHeight);
  const above = anchor.top - margin - popupHeight;
  const below = anchor.bottom + margin;
  const prefer = above >= margin ? above : below;
  return {
    left: Math.max(margin, Math.min(anchor.left, maxLeft)),
    top: Math.max(margin, Math.min(prefer, maxTop)),
  };
}
