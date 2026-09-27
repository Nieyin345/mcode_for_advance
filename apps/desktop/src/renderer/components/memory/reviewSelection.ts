/** 候选图中任意疑似重复对都至少要留下一条：整组选空也不能暗删最后一份。 */
import type { MemoryReviewResult } from "@contracts/memory";

export function reviewSelectionConflict(
  review: Pick<MemoryReviewResult, "duplicates">,
  selected: readonly string[],
): boolean {
  const picked = new Set(selected);
  return review.duplicates.some(({ a, b }) => picked.has(a.path) && picked.has(b.path));
}

/** 编辑器为某个文件保留着**未保存的草稿**（切换文件/卸载面板后仍保留）时，
 *  不能从整理面板把它的磁盘文件删掉：草稿会失去可保存的目标，等于暗中丢弃用户正在写的内容。 */
export function reviewSelectionHasUnsavedDraft(
  selected: readonly string[],
  unsavedPaths: readonly string[],
): boolean {
  const unsaved = new Set(unsavedPaths);
  return selected.some((path) => unsaved.has(path));
}
