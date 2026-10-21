/** REA ModelSwitcherWithTokenGauge: 24px SVG, r=10 and capacity clamp.
 * Occupancy is reported by the provider; never use cumulative throughput
 * as a context-window numerator (may span many model calls). */
export function modelTokenGauge(used: number, max: number) {
  const known = Number.isFinite(used) && used >= 0 && Number.isFinite(max) && max > 0;
  const ratio = known ? Math.min(1, Math.max(0, used / max)) : null;
  const circumference = 2 * Math.PI * 10;
  return {
    known,
    percent: ratio === null ? null : Math.round(ratio * 100),
    dashoffset: ratio === null ? circumference : circumference * (1 - ratio),
    circumference,
    nearLimit: ratio !== null && ratio > .8,
  };
}
