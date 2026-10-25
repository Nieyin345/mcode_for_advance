/** Resolve the right-pane chat for the CURRENT parent and selected id.
 * Async node-session lookups can finish after the user switches main chats.
 * Never briefly render a cached node belonging to the previous parent. */
export interface ScopedSideNode<T extends { id: string }> {
  parentId: string;
  targetId: string;
  row: T;
}

export function visibleSideChat<T extends { id: string }>(
  parentId: string | null,
  selectedId: string | null,
  sideChats: readonly T[] | undefined,
  node: ScopedSideNode<T> | null,
  parentRow: T | undefined,
): T | undefined {
  if (!parentId || !selectedId) return undefined;
  // The main row always wins over a cached node with the same id.
  if (selectedId === parentId) return parentRow?.id === parentId ? parentRow : undefined;
  const side = sideChats?.find((row) => row.id === selectedId);
  if (side) return side;
  return node?.parentId === parentId && node.targetId === selectedId && node.row.id === selectedId
    ? node.row
    : undefined;
}
