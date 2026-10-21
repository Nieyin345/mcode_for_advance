/** Monaco's selection model is independent from the DOM Selection API.
 * Capture a viewport-space citation snapshot without ever querying window.getSelection().
 * The same SelectionToolbar consumes these coordinates as chat and file preview.
 */
import type { editor } from "monaco-editor";
import type { SelectionToolbarState } from "@renderer/components/chat/SelectionToolbar.js";

/** Hard limits keep Ctrl+A on huge files from filling a conversation's context. */
export const MAX_MONACO_QUOTE_LINES = 200;
export const MAX_MONACO_QUOTE_CHARS = 12_000;

type MonacoCitationEditor = Pick<
  editor.IStandaloneCodeEditor,
  "getModel" | "getSelection" | "getSelections" | "getDomNode" | "getScrolledVisiblePosition"
>;

/**
 * Bind the real Monaco selection event, not document.selectionchange.
 * Keeping this subscription in one helper makes the behavior testable with a
 * fake Monaco editor (including the mutation: remove the event → assertion red).
 */
export function subscribeMonacoCitationChanges(
  ed: MonacoCitationEditor & Pick<editor.IStandaloneCodeEditor, "onDidChangeCursorSelection">,
  isDragging: () => boolean,
  onChange: (selection: SelectionToolbarState | null) => void,
): { dispose(): void } {
  return ed.onDidChangeCursorSelection(() => {
    if (!isDragging()) onChange(captureMonacoCitationSelection(ed));
  });
}

export function captureMonacoCitationSelection(ed: MonacoCitationEditor | null): SelectionToolbarState | null {
  if (!ed) return null;
  // Monaco supports multiple cursors. A combined quote would have ambiguous
  // source lines, so keep the toolbar hidden until there's exactly one range.
  const ranges = ed.getSelections();
  if (ranges && ranges.length > 1) return null;
  const sel = ed.getSelection();
  const model = ed.getModel();
  const node = ed.getDomNode();
  if (!sel || sel.isEmpty() || !model || !node) return null;

  // A selection ending at column 1 of the next line does NOT include that line.
  const selectedLastLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber
    ? sel.endLineNumber - 1
    : sel.endLineNumber;
  const lastLine = Math.min(selectedLastLine, sel.startLineNumber + MAX_MONACO_QUOTE_LINES - 1);
  const wholeRange = {
    startLineNumber: sel.startLineNumber,
    startColumn: sel.startColumn,
    endLineNumber: lastLine,
    endColumn: lastLine < sel.endLineNumber
      ? model.getLineMaxColumn(lastLine)
      : sel.endColumn,
  };
  const captured = model.getValueInRange(wholeRange);
  const clipped = captured.slice(0, MAX_MONACO_QUOTE_CHARS);
  const text = clipped.trim();
  if (!text) return null;
  const truncated = lastLine < selectedLastLine || captured.length > MAX_MONACO_QUOTE_CHARS;
  const lastQuotedLine = Math.min(lastLine, sel.startLineNumber + clipped.split("\n").length - 1);

  // getScrolledVisiblePosition returns EDITOR-relative coordinates (or null
  // outside the viewport). A very long range may have only one visible end.
  // Never anchor to an offscreen end or leave a floating toolbar behind.
  const box = node.getBoundingClientRect();
  const positions = [
    ed.getScrolledVisiblePosition(sel.getEndPosition()),
    ed.getScrolledVisiblePosition(sel.getStartPosition()),
  ];
  const pos = positions.find((p) =>
    p !== null && p.top >= 0 && p.top < box.height && p.left >= 0 && p.left <= box.width
  );
  if (!pos) return null;
  const left = box.left + pos.left;
  const top = box.top + pos.top;
  return {
    rect: { top, bottom: top + (pos.height || 18), left, right: left + 1 },
    text,
    messageId: "",
    role: "assistant",
    lines: { start: sel.startLineNumber, end: lastQuotedLine },
    ...(truncated ? { truncated: { maxLines: MAX_MONACO_QUOTE_LINES, maxChars: MAX_MONACO_QUOTE_CHARS } } : {}),
  };
}
