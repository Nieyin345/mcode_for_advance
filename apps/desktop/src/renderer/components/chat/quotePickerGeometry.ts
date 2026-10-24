/** Viewport bounds for the portaled quote target picker. A fixed 320px
 * picker is wider than a small Electron window, and a selection at the very
 * bottom may have room neither directly above nor below. Prefer below,
 * flip above when it fits, otherwise clamp a scrollable panel on-screen. */
export function quotePickerBounds(
  anchor: { top: number; bottom: number; left: number; right: number },
  viewportWidth: number,
  viewportHeight: number,
  preferredWidth = 320,
  preferredHeight = 348,
  margin = 8,
): { left: number; top: number; width: number; maxHeight: number } {
  const width = Math.max(0, Math.min(preferredWidth, viewportWidth - 2 * margin));
  const maxHeight = Math.max(0, Math.min(preferredHeight, viewportHeight - 2 * margin));
  const clamp = (value: number, maximum: number) =>
    Math.max(margin, Math.min(value, Math.max(margin, maximum)));
  const left = clamp((anchor.left + anchor.right - width) / 2, viewportWidth - width - margin);
  const below = anchor.bottom + margin;
  const above = anchor.top - margin - maxHeight;
  const top = below + maxHeight <= viewportHeight - margin
    ? below
    : above >= margin
      ? above
      : clamp(below, viewportHeight - margin - maxHeight);
  return { left, top, width, maxHeight };
}
