import type { PermissionMode } from "@contracts/runtime";

/** Pi's read-only built-in tools — safe to auto-approve in every mode. */
const PI_READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Decide whether a Pi tool may skip host approval. `planModeActive` is
 * provided separately from the persisted permission mode because EnterPlanMode
 * updates it synchronously; the UI-backed permission value can lag one tool
 * call behind. `alwaysAllowed` is a per-session user decision, but plan mode
 * deliberately requires fresh approval for each mutating operation.
 */
export function shouldAutoApproveForPi(
  mode: PermissionMode | undefined,
  toolName: string,
  planModeActive = false,
  alwaysAllowed = false,
): boolean {
  if (PI_READONLY_TOOLS.has(toolName)) return true;
  // EnterPlanMode flips this synchronous per-turn flag before the next tool
  // call. It overrides stale UI permission state and saved allow rules so
  // every mutation still receives a fresh host approval.
  if (planModeActive) return false;
  if (!mode) return alwaysAllowed;
  if (mode === "bypassPermissions" || mode === "dontAsk") return true;
  if (mode === "acceptEdits") return toolName === "write" || toolName === "edit";
  return alwaysAllowed;
}
