/** REA StreamingDiffViewer geometry and incremental render identity.
 * Streaming chunks can arrive mid-line: a changed final row is replaced,
 * but stable prefix rows retain identity for React's incremental DOM commit. */
export interface PresentDiffLine {
  op: "equal" | "insert" | "delete";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export function reconcileStreamingRows<T extends PresentDiffLine>(previous: readonly T[], next: readonly T[]): T[] {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length &&
    previous[prefix].op === next[prefix].op && previous[prefix].text === next[prefix].text &&
    previous[prefix].oldNo === next[prefix].oldNo && previous[prefix].newNo === next[prefix].newNo) prefix++;
  return [...previous.slice(0, prefix), ...next.slice(prefix)];
}

export interface DiffTextPart { text: string; changed: boolean }
/** Highlight only altered characters for adjacent +/- lines (not whole lines).
 * Keeps surrounding equal prefix/suffix as normal code. Supports streaming
 * incomplete lines and CRLF without relying on HTML string injection. */
export function inlineDiffParts(before: string, after: string): { before: DiffTextPart[]; after: DiffTextPart[] } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start &&
    before[before.length - end - 1] === after[after.length - end - 1]) end++;
  const split = (s: string): DiffTextPart[] => [
    { text: s.slice(0, start), changed: false },
    { text: s.slice(start, s.length - end), changed: true },
    { text: end ? s.slice(-end) : "", changed: false },
  ].filter((part) => part.text.length > 0);
  return { before: split(before), after: split(after) };
}

/** Feed complete hunk lines only; retain a partial last line until the next
 * chunk (avoids premature punctuation/highlighting and phantom empty rows). */
export function feedUnifiedDiff(state: { lines: string[]; rest: string }, chunk: string) {
  const raw = state.rest + chunk;
  const parts = raw.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: [...state.lines, ...parts.map((line) => line.replace(/\r$/, ""))], rest };
}
