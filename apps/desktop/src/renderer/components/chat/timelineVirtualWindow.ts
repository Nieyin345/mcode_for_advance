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
  const view = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720;
  const pad = Number.isFinite(overscan) ? Math.max(0, Math.floor(overscan)) : TIMELINE_WINDOW_OVERSCAN;
  const totalHeight = count * TIMELINE_DASH_PITCH;
  // History can shrink dramatically (clear, truncate, switch sessions) while
  // the old strip scrollTop still points near the end of a much longer list.
  // A stale scroll offset must never produce an empty visible window for a
  // non-empty timeline. The browser may correct its native scrollTop on the
  // following layout frame, but the virtual range needs to be valid *now*.
  const requestedTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const top = Math.min(requestedTop, Math.max(0, totalHeight - view));
  const start = Math.min(count, Math.max(0, Math.floor(top / TIMELINE_DASH_PITCH) - pad));
  const end = Math.min(count, Math.max(start, Math.ceil((top + view) / TIMELINE_DASH_PITCH) + pad));
  return {start,end,totalHeight,pitch:TIMELINE_DASH_PITCH};
}
