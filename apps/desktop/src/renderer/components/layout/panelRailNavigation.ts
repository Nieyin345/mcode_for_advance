/**
 * Keyboard roving for the right-side pane rail.
 * This module is intentionally a pure function so every visual shell shares
 * exactly one Arrow/Home/End behavior and tests do not need an Agent or IPC.
 * Movement changes focus, never pane selection or permissions.
 */
export function nextRailFocusIndex(
  key: string,
  currentIndex: number,
  buttonCount: number,
): number | null {
  if (!Number.isSafeInteger(buttonCount) || buttonCount < 1 ||
      !Number.isSafeInteger(currentIndex) || currentIndex < 0 || currentIndex >= buttonCount) {
    return null;
  }
  switch (key) {
    case "ArrowRight": return (currentIndex + 1) % buttonCount;
    case "ArrowLeft": return (currentIndex - 1 + buttonCount) % buttonCount;
    case "Home": return 0;
    case "End": return buttonCount - 1;
    default: return null;
  }
}
