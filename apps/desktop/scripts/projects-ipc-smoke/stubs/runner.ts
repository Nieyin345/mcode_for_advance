/**
 * `@main/orchestration/runner.js` 的替身 —— 这一套只用到 `cancelWorkflowRun`。
 *
 * ## ⚠️ 返回值不是装饰,它就是"停掉了吗"本身
 *
 * `ipc/projects.ts` 的 `PROJECT_DELETE` 对每个会话调一次 `cancelWorkflowRun(id)`,
 * 但**不看返回值** —— 它是在"不管有没有图在跑都要收尾"那个语境里调的
 * (见 `SESSION_DELETE` 上那句"不能省")。所以这一套要验的是**调到了、而且每个会话
 * 都调到了**,不是它返不返回 true。
 *
 * 这里照样维护一个 `activeRuns`,让返回值**有意义**:一律返回 true 的桩会让
 * 「图上没有图时不认领」这类断言永远绿,而那正是 `claude-ipc-smoke` 踩过的坑。
 */
const activeRuns = new Set<string>();

/** 被问过的会话 id,按顺序(可能重复)。 */
export const cancelAsked: string[] = [];
/** 真被认领(返回 true)的那些。 */
export const stoppedRuns: string[] = [];

export function resetRunnerStub(): void {
  activeRuns.clear();
  cancelAsked.length = 0;
  stoppedRuns.length = 0;
}

/** 显式声明"这个会话上有一张图正在跑"。 */
export function markRunActive(sessionId: string): void {
  activeRuns.add(sessionId);
}

export function cancelWorkflowRun(sessionId: string): boolean {
  cancelAsked.push(sessionId);
  const claimed = activeRuns.delete(sessionId);
  if (claimed) stoppedRuns.push(sessionId);
  return claimed;
}
