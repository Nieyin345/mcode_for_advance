import type { PersistedWorkflowRunLite, RpcMap } from "@contracts/ipc";

/** Re-read session identities on every refresh: a project switch may add one.
 * Keep the legacy single-session response usable during mixed-version reloads. */
export async function loadAutomationHistory(
  workflowId: string,
  port: { sessions: RpcMap["automation.sessions"]; history: RpcMap["runs.history"] },
  limit = 50,
): Promise<PersistedWorkflowRunLite[]> {
  const res = await port.sessions({ workflowId });
  const ids = [...new Set(res.sessionIds ?? (res.sessionId === null ? [] : [res.sessionId]))];
  const batches = await Promise.all(ids.map((sessionId) => port.history({ sessionId, limit })));
  return batches.flat().filter((row) => row.workflowId === workflowId)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))
    .slice(0, limit);
}
