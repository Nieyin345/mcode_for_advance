/** 候选图中任意疑似重复对都至少要留下一条：整组选空也不能暗删最后一份。 */
import type { MemoryReviewResult } from "@contracts/memory";

export function reviewSelectionConflict(
  review: Pick<MemoryReviewResult, "duplicates">,
  selected: readonly string[],
): boolean {
  const picked = new Set(selected);
  return review.duplicates.some(({ a, b }) => picked.has(a.path) && picked.has(b.path));
}
