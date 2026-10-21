import type { Session } from "@contracts/session";
export const runs: Array<{ session: Session; prompt?: string; cwd?: string }> = [];
export async function startWorkflowRun(input: { session: Session; prompt?: string; cwd?: string }) {
  runs.push(input);
  return { status: "completed" };
}