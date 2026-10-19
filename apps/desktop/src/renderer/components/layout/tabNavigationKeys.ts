/**
 * ARC-004/005: only unmodified, non-composing keys may activate a tab.
 * The same guard applies to Home/End and Enter/Space; Shift+Arrow is reserved
 * for selection conventions and IME keyCode 229 must not switch sessions.
 */
export interface TabNavigationKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  nativeEvent: { isComposing: boolean; keyCode: number };
}

export function canNavigateTabKey(event: TabNavigationKey): boolean {
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
    !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229;
}

/** Roving focus and activation within exactly the calling tab list. */
export function tabNavigationTargetIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (!Number.isSafeInteger(currentIndex) || !Number.isSafeInteger(count) ||
      count < 1 || currentIndex < 0 || currentIndex >= count) return null;
  switch (key) {
    case "Home": return 0;
    case "End": return count - 1;
    case "ArrowRight": return (currentIndex + 1) % count;
    case "ArrowLeft": return (currentIndex - 1 + count) % count;
    default: return null;
  }
}
