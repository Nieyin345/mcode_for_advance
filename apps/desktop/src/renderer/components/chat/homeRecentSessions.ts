/** ARC-005: "Continue chatting" is scoped to the active project.
 * A pinned/stream session from another project must never leak into the
 * current project's empty-thread home. Pure helper for deterministic tests. */
import type { Session } from "@contracts/session";

export function recentProjectSessions(
  sessions: readonly Session[],
  activeProjectId: string | null,
  activeSessionId: string | null,
  limit = 3,
): Session[] {
  if (!activeProjectId || limit <= 0) return [];
  return sessions
    .filter((s) =>
      s.projectId === activeProjectId &&
      s.kind === "chat" &&
      !s.archived &&
      s.id !== activeSessionId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
