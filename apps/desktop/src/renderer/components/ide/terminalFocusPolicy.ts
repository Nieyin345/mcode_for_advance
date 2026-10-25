/** Respect the user's keyboard focus when a terminal becomes active.
 * xterm should not steal focus from a selected tab or keyboard navigator,
 * but may focus naturally after opening a terminal via the + action. */
export function mayAutoFocusTerminal(
  activeElement: { closest: (selector: string) => unknown } | null,
): boolean {
  return !activeElement?.closest('[role="tablist"]');
}
