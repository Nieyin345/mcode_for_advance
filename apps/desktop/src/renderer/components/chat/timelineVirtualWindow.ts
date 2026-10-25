/** Virtual window for the narrow chat-timeline dash strip.
 * Each dash is min-height 24px with a 6px gap. Keeping that pitch constant
 * prevents scroll jumps while allowing all message/bookmark targets to remain
 * addressable by scrolling the strip.
 */
export const TIMELINE_DASH_PITCH = 30;
export const TIMELINE_WINDOW_THRESHOLD = 120;
export const TIMELINE_WINDOW_OVERSCAN = 8;

export function timelineDashWindow(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = TIMELINE_WINDOW_OVERSCAN,
): { start: number; end: number; totalHeight: number; pitch: number } {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const view = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720;
  const pad = Number.isFinite(overscan) ? Math.max(0, Math.floor(overscan)) : TIMELINE_WINDOW_OVERSCAN;
  const start = Math.min(count, Math.max(0, Math.floor(top / TIMELINE_DASH_PITCH) - pad));
  const end = Math.min(count, Math.max(start, Math.ceil((top + view) / TIMELINE_DASH_PITCH) + pad));
  return {start,end,totalHeight:count * TIMELINE_DASH_PITCH,pitch:TIMELINE_DASH_PITCH};
}
