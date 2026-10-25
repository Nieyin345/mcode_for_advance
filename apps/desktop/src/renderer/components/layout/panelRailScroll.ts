/** Keep the currently selected right-rail action visible without scrolling
 * the whole workspace or stealing focus from the chat composer. */
export function railScrollLeft(
  scrollLeft: number,
  viewportStart: number,
  viewportEnd: number,
  itemStart: number,
  itemEnd: number,
  padding = 8,
): number {
  if (![scrollLeft, viewportStart, viewportEnd, itemStart, itemEnd, padding].every(Number.isFinite)) {
    return scrollLeft;
  }
  if (viewportEnd <= viewportStart || itemEnd <= itemStart) return scrollLeft;
  const span = Math.max(0, viewportEnd - viewportStart);
  // A very wide contributed module tab should not oscillate between edges.
  if (itemEnd - itemStart > span - 2 * padding) {
    return Math.max(0, scrollLeft + itemStart - viewportStart - padding);
  }
  if (itemStart < viewportStart + padding) {
    return Math.max(0, scrollLeft + itemStart - viewportStart - padding);
  }
  if (itemEnd > viewportEnd - padding) {
    return Math.max(0, scrollLeft + itemEnd - viewportEnd + padding);
  }
  return scrollLeft;
}
