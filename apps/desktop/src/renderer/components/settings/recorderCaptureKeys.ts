/**
 * Shared keyboard gate for the shortcut and gesture recorders.
 * Preserve Tab and native action-button activation while swallowing other
 * global app shortcuts and preventing Escape from closing the Settings page.
 */
export type RecorderCaptureMode = "recording" | "conflict";
export type RecorderKeyDecision = "pass" | "cancel" | "capture" | "swallow";

export function recorderKeyDecision(
  mode: RecorderCaptureMode,
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  onRecorderActionButton: boolean,
): RecorderKeyDecision {
  if (e.key === "Escape") return "cancel";
  if (e.key === "Tab") return "pass";
  if (
    onRecorderActionButton &&
    !e.ctrlKey && !e.metaKey && !e.altKey &&
    (e.key === "Enter" || e.key === " " || e.key === "Spacebar")
  ) return "pass";
  return mode === "recording" ? "capture" : "swallow";
}
