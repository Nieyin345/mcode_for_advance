/**
 * Line-level diff using the LCS (longest common subsequence) table.
 *
 * Why LCS and not Myers: file-level Edit snippets from Claude are small
 * (typically < 200 lines) so the O(n*m) memory cost is trivial. LCS is
 * ~40 lines, dead-obvious to audit, and gives the standard "diff" output
 * users expect from a code-review tool: kept lines, removed lines
 * (red), added lines (green).
 *
 * Output: a flat list of `{op, text}` in old-then-new order, suitable
 * for rendering as a single column. `equal` lines have no prefix; the
 * caller decides the visual prefix (+/-/space).
 */

export type DiffOp = "equal" | "delete" | "insert";
export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** Compute a line-level diff from `oldText` to `newText`. Empty lines
 *  are preserved (a blank line in the source is a real unit). */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;

  // Keep the exact LCS table for normal edit snippets, but don't allocate
  // unbounded O(m*n) memory on a pasted/generated multi-thousand-line diff.
  // 1M Int32 cells = 4 MiB; above that use a linear-memory prefix/suffix
  // fallback, preserving every line and the existing insert-before-delete
  // presentation order without freezing the whole Electron renderer.
  const cols = n + 1;
  if ((m + 1) * cols > 1_000_000) {
    let commonStart = 0;
    while (commonStart < m && commonStart < n && oldLines[commonStart] === newLines[commonStart]) commonStart++;
    let oldEnd = m;
    let newEnd = n;
    while (oldEnd > commonStart && newEnd > commonStart && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const coarse: DiffLine[] = [];
    for (let i = 0; i < commonStart; i++) coarse.push({ op: "equal", text: oldLines[i] });
    for (let j = commonStart; j < newEnd; j++) coarse.push({ op: "insert", text: newLines[j] });
    for (let i = commonStart; i < oldEnd; i++) coarse.push({ op: "delete", text: oldLines[i] });
    for (let i = oldEnd; i < m; i++) coarse.push({ op: "equal", text: oldLines[i] });
    return coarse;
  }
  // Build the exact LCS length table, in a bounded allocation.
  const lcs = new Int32Array((m + 1) * cols);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i * cols + j] = lcs[(i - 1) * cols + (j - 1)] + 1;
      } else {
        const up = lcs[(i - 1) * cols + j];
        const left = lcs[i * cols + (j - 1)];
        lcs[i * cols + j] = up > left ? up : left;
      }
    }
  }

  // Backtrace from (m, n) to (0, 0), pushing ops in reverse. We then
  // reverse the whole list to get old-then-new order.
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      out.push({ op: "equal", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (lcs[(i - 1) * cols + j] >= lcs[i * cols + (j - 1)]) {
      // Came from above → old line was deleted.
      out.push({ op: "delete", text: oldLines[i - 1] });
      i--;
    } else {
      // Came from the left → new line was inserted.
      out.push({ op: "insert", text: newLines[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ op: "delete", text: oldLines[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ op: "insert", text: newLines[j - 1] });
    j--;
  }
  out.reverse();
  return out;
}

/** Tally inserts and deletes for a quick "+N -M" summary badge. */
export function diffSummary(diff: ReadonlyArray<DiffLine>): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const d of diff) {
    if (d.op === "insert") adds++;
    else if (d.op === "delete") dels++;
  }
  return { adds, dels };
}

/** Split text on `\n` while preserving empty trailing lines (so a file
 *  ending with `\n` doesn't get a phantom empty last line, but a blank
 *  line in the middle of the file does show up as an empty string).
 *  Matches what most diff tools do: drop a single trailing empty that
 *  comes from the final newline. */
function splitLines(s: string): string[] {
  if (s === "") return [];
  // Treat CRLF and LF as the same line boundary. Otherwise a Windows file
  // rendered against an LF-formatted edit marks EVERY line as removed/added.
  const parts = s.replace(/\r\n/g, "\n").split("\n");
  // If the text ends with `\n`, split produces a trailing "" — drop it
  // so an "old == new" file of just "\n" diffs to empty.
  if (parts.length > 0 && parts[parts.length - 1] === "" && s.endsWith("\n")) {
    parts.pop();
  }
  return parts;
}

/** 一段文本有几行 —— **判据与 {@link splitLines} 同一份**(末尾单个 `\n` 是终止符,
 *  不是幽灵行)。凡是界面上要报"N 行"的地方都走这里,别再各写一句
 *  `text.split("\n").length`:那样一个以换行结尾的文件会被多算一行,而且**同一屏上
 *  两个"N 行"会用不同的口径**(实测:NodeInspector 的代码卡片与 Write 卡的徽标、
 *  与它们各自的预览/diff 全都不一样)。 */
export function countLines(s: string): number {
  return splitLines(s).length;
}
