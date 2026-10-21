/**
 * T18 — physical interaction rules transcribed from the three
 * open-claude-ui composer reconstructions. Kept pure so the behavior (including
 * the flip and height limit) can be exercised without mocking Tiptap.
 */
export type ComposerSendAction = "disabled" | "send" | "stop" | "enqueue";

/** A running turn accepts type-ahead; never replace an existing draft with stop. */
export function composerSendAction(busy: boolean, hasContent: boolean): ComposerSendAction {
  if (busy) return hasContent ? "enqueue" : "stop";
  return hasContent ? "send" : "disabled";
}

/** max-h-[min(40svh,24rem)], but never less than the 3rem editor minimum. */
export function composerEditorHeightCap(viewportHeight: number, remPx = 16): number {
  return Math.max(3 * remPx, Math.min(0.4 * viewportHeight, 24 * remPx));
}

/** The post-composition false Enter emitted by WebKit must not submit. */
export function isPostCompositionEnter(
  key: string,
  timestamp: number,
  lastCompositionEnd: number,
  vendor: string,
  ctrlOrMeta: boolean,
): boolean {
  return key === "Enter" && !ctrlOrMeta && /Apple Computer/.test(vendor) &&
    lastCompositionEnd >= 0 && timestamp >= lastCompositionEnd &&
    timestamp - lastCompositionEnd < 500;
}

export interface ComposerPickerPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: "top" | "bottom";
}

/**
 * Decide by ACTUAL available space, not merely by anchor.top. Prefer above,
 * flip below when it cannot fit and below offers more room, then constrain
 * height and shift horizontally within the viewport (8px safety margin).
 */
export function placeComposerPicker(
  anchor: Pick<DOMRect, "left" | "top" | "bottom" | "width">,
  requestedHeight: number,
  viewport: { width: number; height: number },
  maxWidth: number,
): ComposerPickerPosition {
  const margin = 8;
  const gap = 8;
  const above = Math.max(0, anchor.top - margin - gap);
  const below = Math.max(0, viewport.height - anchor.bottom - margin - gap);
  const side = above >= requestedHeight || above >= below ? "top" : "bottom";
  const availableHeight = side === "top" ? above : below;
  const maxHeight = Math.max(0, Math.min(256, requestedHeight, availableHeight));
  const width = Math.max(0, Math.min(Math.max(anchor.width, 280), maxWidth, viewport.width - 2 * margin));
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin));
  const top = side === "top" ? anchor.top - gap - maxHeight : anchor.bottom + gap;
  return { left, top, width, maxHeight, side };
}
