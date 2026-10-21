/** REA McpToolDecisionCard: presentation follows the *real* engine state.
 * Approvals are owned by ChatPane/ApprovalPrompt, never simulated here. */
export type McpExecutionState = "running" | "done" | "error";
export type McpDecisionView = "running" | "success" | "user_denied" | "policy_denied" | "permissions_error" | "error";
export function mcpDecisionView(status: McpExecutionState, result: string): McpDecisionView {
  if (status === "running") return "running";
  if (status === "done") return "success";
  if (/user[_ ]denied|user denied tool|rejected by user/i.test(result)) return "user_denied";
  if (/policy[_ ]denied|blocked by policy|sandbox policy/i.test(result)) return "policy_denied";
  if (/PERMISSIONS_ERROR|permission(?:s)? error|access denied/i.test(result)) return "permissions_error";
  return "error";
}
/** All three decisions reach the actual approval callback; no local fake
 * lifecycle or automatic approval ever runs. */
export function mcpApprovalVerdict(verdict: "allow_once" | "always_allow" | "deny") {
  return verdict === "deny" ? { granted: false, always: false }
    : { granted: true, always: verdict === "always_allow" };
}
