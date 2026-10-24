/** Keyboard navigation for the project search dialog.
 * A pending/failed search must not activate stale matches from the previous
 * query, project or file-type filter. Pure logic shared by both result modes. */
export function searchResultsNavigable(
  loading: boolean,
  error: string | null,
  resultCount: number,
): boolean {
  return !loading && !error && resultCount > 0;
}

export function stepSearchResultIndex(
  index: number,
  resultCount: number,
  direction: -1 | 1,
): number {
  if (resultCount <= 0) return 0;
  return Math.max(0, Math.min(resultCount - 1, index + direction));
}
