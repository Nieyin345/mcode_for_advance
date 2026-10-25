export type SlashTabKind = "skill" | "command" | "engine";

/** Only a new search/open/busy state should prompt a tab switch. A user
 * manually opening an empty Engine tab must be able to read "not supported"
 * or "waiting for commands" instead of immediately bouncing away. */
export function preferredSlashTab(
  active: SlashTabKind,
  counts: Readonly<Record<SlashTabKind, number>>,
): SlashTabKind {
  if (counts[active] > 0) return active;
  return (["skill", "command", "engine"] as const).find((tab) => counts[tab] > 0) ?? active;
}

export function clampSlashIndex(index: number, count: number): number {
  return Math.max(0, Math.min(index, Math.max(0, count - 1)));
}
