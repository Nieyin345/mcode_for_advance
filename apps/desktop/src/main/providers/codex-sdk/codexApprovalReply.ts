/** Codex app-server approval replies. Kept separate so native-protocol grants can be tested without a live model. */
export function codexApprovalReply(
  answer: { allow: boolean; persist?: boolean } | null,
  alwaysAllowed = false,
): { decision: "accept" | "decline" } {
  // Only the host knows the current permission mode. A server-scoped grant
  // would outlive a mid-turn switch to read-only and suppress future prompts.
  // The host may remember a user-approved tool; each server request still
  // receives only a one-shot answer, so the next request rechecks host policy.
  return { decision: alwaysAllowed || answer?.allow ? "accept" : "decline" };
}
