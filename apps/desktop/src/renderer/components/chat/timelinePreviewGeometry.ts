/** Viewport-safe placement of a timeline preview portaled outside the
 * scrollable message index. Keep the anchor's visual center when possible,
 * with 8px of room on all sides (also for high-DPI narrow windows). */
export function timelinePreviewPosition(
  anchor: { top: number; right: number; height: number },
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewportWidth - margin - Math.max(0, width));
  const maxTop = Math.max(margin, viewportHeight - margin - Math.max(0, height));
  return {
    left: Math.max(margin, Math.min(anchor.right + margin, maxLeft)),
    top: Math.max(margin, Math.min(anchor.top + (anchor.height - height) / 2, maxTop)),
  };
}
