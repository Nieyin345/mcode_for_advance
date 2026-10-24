/** Pure viewport-safe positioning for chat attachment/tag previews.
 * Measurements are from the rendered element, never a guessed width.
 * Keep the entire preview visible where possible; prefer above the chip,
 * but fall back below when above has less space. */
export interface PreviewAnchor {
  top: number;
  right: number;
  bottom: number;
}
export interface PreviewPosition {
  left: number;
  top: number;
}
export function previewPosition(
  anchor: PreviewAnchor,
  popoverWidth: number,
  popoverHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
  gap = 8,
): PreviewPosition {
  const w = Math.max(0, Math.min(popoverWidth, Math.max(0, viewportWidth - 2 * margin)));
  const h = Math.max(0, Math.min(popoverHeight, Math.max(0, viewportHeight - 2 * margin)));
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const left = clamp(anchor.right - w, margin, Math.max(margin, viewportWidth - margin - w));
  const roomAbove = anchor.top - margin - gap;
  const roomBelow = viewportHeight - margin - anchor.bottom - gap;
  const above = roomAbove >= h || roomAbove > roomBelow;
  const top = clamp(
    above ? anchor.top - gap - h : anchor.bottom + gap,
    margin,
    Math.max(margin, viewportHeight - margin - h),
  );
  return { left, top };
}
