/** Sanitize progress supplied by native workflow event adapters.
 * NaN/Infinity or a percent outside the 0–100 range must not produce an
 * invalid aria-valuenow / CSS width, nor a misleading "NaN%" label.
 * A missing/non-finite value is indeterminate and gets no progressbar. */
export function workflowProgressPercent(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(100, raw));
}
