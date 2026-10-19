/** Shared keyboard delta for the resizable pane separator.
 * No knowledge of store, persistence, or pointer capture.
 */
export interface DividerKeyboardEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  keyCode: number;
}
export type DividerAction = { kind: "resize"; delta: number } | { kind: "reset" };
export function dividerKeyboardAction(
  event: DividerKeyboardEvent,
  orientation: "vertical" | "horizontal",
): DividerAction | null {
  if (event.isComposing || event.keyCode === 229 ||
    event.altKey || event.ctrlKey || event.metaKey) return null;
  const negative = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
  const positive = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
  if (event.key === negative || event.key === positive) {
    return { kind: "resize", delta: (event.key === positive ? 1 : -1) * (event.shiftKey ? 40 : 10) };
  }
  if (event.key === "Enter" || event.key === "Home") return { kind: "reset" };
  return null;
}
