/** Position a portaled text-selection toolbar from its measured dimensions.
 * Preserve the selection center when possible. For a narrow window or a long
 * custom button set, clamp both axes instead of guessing a 128px toolbar. */
export function selectionToolbarPosition(
  selection: { top: number; bottom: number; left: number; right: number },
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { left: number; top: number } {
  const clamp = (value: number, hi: number) => Math.max(margin, Math.min(value, Math.max(margin, hi)));
  const x = (selection.left + selection.right - width) / 2;
  const above = selection.top - margin - height >= margin;
  const y = above ? selection.top - margin - height : selection.bottom + margin;
  return { left: clamp(x, viewportWidth - margin - width), top: clamp(y, viewportHeight - margin - height) };
}
