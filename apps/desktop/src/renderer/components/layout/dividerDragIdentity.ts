/** A secondary pointer's release/cancel/lostcapture must not end the
 * primary pointer that actually owns a resize drag.
 */
export function shouldFinishDividerDrag(activePointerId: number | null, eventPointerId: number): boolean {
  return activePointerId !== null && activePointerId === eventPointerId;
}
