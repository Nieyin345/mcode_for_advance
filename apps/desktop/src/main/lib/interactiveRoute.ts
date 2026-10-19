/** Follow host-owned interactive proxies; malformed cycles fail closed at the original session. */
export function interactiveRoute(sessionId: string, next: (id: string) => string | undefined): string {
  const seen = new Set<string>();
  let id = sessionId;
  while (seen.size < 32) {
    if (seen.has(id)) return sessionId;
    seen.add(id);
    let parent: string | undefined;
    try {
      parent = next(id);
    } catch {
      // The lookup is not an authorization decision. A temporary store/DB
      // failure must not crash the caller or route to an intermediate worker.
      return sessionId;
    }
    if (parent === undefined || parent === null) return id;
    if (typeof parent !== "string" || !parent.trim() || /[\u0000-\u001f\u007f]/.test(parent)) {
      return sessionId;
    }
    id = parent;
  }
  return sessionId;
}
