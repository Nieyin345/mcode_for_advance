/** F024 — validation and preparation for Theia TextEditor.edit.
 * No disk writes: only an editor owner is allowed to apply a transaction.
 * Ranges and positions use Theia/Monaco 1-based coordinates; offsets are UTF-16.
 */
export interface TheiaTextRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
export interface TheiaTextEdit {
  range?: TheiaTextRange;
  text?: string;
  forceMoveMarkers?: boolean;
}
export interface TheiaEditOptions {
  undoStopBefore: boolean;
  undoStopAfter: boolean;
  setEndOfLine?: number;
}
export interface EditorEditTransaction {
  filePath: string;
  version: number;
  beforeText: string;
  afterText: string;
  edits: ReadonlyArray<{ range: TheiaTextRange; text: string; rangeOffset: number; rangeLength: number }>;
  undoStopBefore: boolean;
  undoStopAfter: boolean;
}
export interface PreparedEdits {
  text: string;
  changes: EditorEditTransaction["edits"];
}

/** Returns null for malformed, overlapping or unsupported edits. No partial application. */
export function prepareTheiaEdits(
  original: string,
  edits: readonly TheiaTextEdit[],
  options: TheiaEditOptions,
): PreparedEdits | null {
  if (!Array.isArray(edits) || !options || edits.length === 0) return null;
  if (typeof options.undoStopBefore !== "boolean" || typeof options.undoStopAfter !== "boolean") return null;
  // Explicit EOL conversion requires a separate Monaco transaction. Never claim to have done it.
  if (options.setEndOfLine !== undefined) return null;
  const lines = original.split(/\r\n|\n/);
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + (original.slice(cursor + line.length).startsWith("\r\n") ? 2 : 1);
  }
  const offsetOf = (line: unknown, column: unknown): number | null => {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) return null;
    const l = line as number;
    const c = column as number;
    if (l < 1 || l > lines.length || c < 1 || c > lines[l - 1].length + 1) return null;
    return offsets[l - 1] + c - 1;
  };
  const prepared: { range: TheiaTextRange; text: string; rangeOffset: number; rangeLength: number }[] = [];
  for (const edit of edits) {
    if (!edit || typeof edit.text !== "string" || !edit.range) return null;
    const r = edit.range;
    const start = offsetOf(r.startLineNumber, r.startColumn);
    const end = offsetOf(r.endLineNumber, r.endColumn);
    if (start === null || end === null || start > end) return null;
    prepared.push({ range: { ...r }, text: edit.text, rangeOffset: start, rangeLength: end - start });
  }
  // Reverse order lets all ranges refer to the original document.
  prepared.sort((a, b) => b.rangeOffset - a.rangeOffset || b.rangeLength - a.rangeLength);
  for (let i = 1; i < prepared.length; i++) {
    const right = prepared[i - 1];
    const left = prepared[i];
    if (left.rangeOffset + left.rangeLength > right.rangeOffset || left.rangeOffset === right.rangeOffset) return null;
  }
  let text = original;
  for (const edit of prepared) {
    text = text.slice(0, edit.rangeOffset) + edit.text + text.slice(edit.rangeOffset + edit.rangeLength);
  }
  return { text, changes: prepared };
}
