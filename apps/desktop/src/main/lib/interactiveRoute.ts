/** Follow host-owned interactive proxies; malformed cycles fail closed at the original session. */
export function interactiveRoute(sessionId: string, next: (id: string) => string | undefined): string {
  const seen = new Set<string>(); let id = sessionId;
  while (seen.size < 32) {
    if (seen.has(id)) return sessionId;
    seen.add(id);
    const parent = next(id);
    if (!parent) return id;
    id = parent;
  }
  return sessionId;
}
