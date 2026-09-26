import type { MemoryWriteOrigin } from "@contracts/memory";
import { SessionRepo } from "@main/store/repositories.js";
import { MEMORY_PROJECT_ID, visibleMemory } from "./paths.js";
export function memoryProjectForSession(sessionId: string): string {
  const session = SessionRepo.get(sessionId);
  if (!session || typeof session.projectId !== "string" || !MEMORY_PROJECT_ID.test(session.projectId)) throw new Error("记忆工具没有有效的宿主会话，拒绝访问");
  return session.projectId;
}
export function requireMemoryAccess(path: string, projectId: string): void {
  if (!visibleMemory(path, projectId)) throw new Error("记忆不属于本项目或显式全局范围；旧记忆需先在设置中确认导入");
}

export function memoryWriteOrigin(sessionId: string): MemoryWriteOrigin {
  memoryProjectForSession(sessionId);
  const session = SessionRepo.get(sessionId)!;
  return { sessionId: session.id, kind: session.kind,
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.nodeId ? { nodeId: session.nodeId } : {}) };
}
