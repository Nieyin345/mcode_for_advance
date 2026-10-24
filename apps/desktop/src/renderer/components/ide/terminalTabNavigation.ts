/** Pure keyboard navigation for the live terminal tab strip.
 * Navigation changes focus and active *tab*, never creates/closes a PTY.
 * The last tab wraps; Home/End jump to the bounds. */
export function terminalTabTarget(key: string, index: number, count: number): number | null {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) ||
      count <= 0 || index < 0 || index >= count) return null;
  switch (key) {
    case "ArrowLeft": return (index - 1 + count) % count;
    case "ArrowRight": return (index + 1) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}
