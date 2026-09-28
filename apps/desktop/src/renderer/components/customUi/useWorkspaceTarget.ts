/**
 * 工具栏与右栏页签的「目标」—— 它们没有右键的那一个,只有**当前工作区**:
 * 当前项目(会话在隔离工作树里跑时取工作树目录,同 Files / Git 面板)、当前对话、今天。
 *
 * 选择器全部返回原始值(字符串 / null),再 `useMemo` 拼成对象 —— 直接在选择器里拼对象
 * 每次都是新引用,会让订阅者无限重渲染(AGENTS.md 的那条规矩)。
 */
import { useMemo } from "react";
import { localDateString, type CustomUiTarget } from "@contracts/customUi";
import { selectActiveEnvPath, useSessionStore } from "@renderer/stores/sessionStore.js";

type SessionLookup = Parameters<typeof selectActiveEnvPath>[0];

function activeSessionTitle(s: SessionLookup): string | null {
  const sid = s.activeSessionId;
  if (!sid) return null;
  const hit =
    s.sessions.find((x) => x.id === sid) ??
    s.pinnedSessions.find((x) => x.id === sid) ??
    Object.values(s.sessionsByProject)
      .flatMap((list) => list ?? [])
      .find((x) => x.id === sid);
  return hit ? hit.title : null;
}

export function useWorkspaceTarget(): Extract<CustomUiTarget, { kind: "workspace" }> {
  const projectPath = useSessionStore(selectActiveEnvPath);
  const projectName = useSessionStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.name ?? null);
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const sessionTitle = useSessionStore(activeSessionTitle);
  // 日期按渲染时算:跨过午夜后下一次渲染(切对话、点按钮)就是新的一天,够用
  const today = localDateString(new Date());
  return useMemo(
    () => ({
      kind: "workspace" as const,
      ...(projectPath ? { project: { path: projectPath, name: projectName ?? "" } } : {}),
      ...(sessionId ? { session: { id: sessionId, title: sessionTitle ?? "" } } : {}),
      today,
    }),
    [projectPath, projectName, sessionId, sessionTitle, today],
  );
}
