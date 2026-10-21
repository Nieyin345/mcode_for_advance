/** REA DraggableSessionList ordering: stable item ids, global pin buckets,
 * and exact before/after insertion to prevent downward off-by-one errors. */
export interface SessionDragOrder { pinned: string[]; recent: string[] }
export function sortSessionsForSidebar<T extends { id: string }>(sessions: readonly T[], order: readonly string[]): T[] {
  if (order.length === 0) return [...sessions];
  const ranks = new Map(order.map((id, i) => [id, i]));
  return [...sessions].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}
export function moveSidebarSession(
  order: SessionDragOrder, activeId: string, targetId: string, after = false,
): SessionDragOrder & { changedPin: boolean; toPinned: boolean } {
  const fromPinned = order.pinned.includes(activeId);
  const toPinned = order.pinned.includes(targetId);
  if (activeId === targetId) return { pinned: [...order.pinned], recent: [...order.recent], changedPin: false, toPinned: fromPinned };
  if (!fromPinned && !order.recent.includes(activeId) || (!toPinned && !order.recent.includes(targetId))) {
    return { pinned: [...order.pinned], recent: [...order.recent], changedPin: false, toPinned: fromPinned };
  }
  const pinned = order.pinned.filter((id) => id !== activeId);
  const recent = order.recent.filter((id) => id !== activeId);
  const destination = toPinned ? pinned : recent;
  const targetIndex = destination.indexOf(targetId);
  if (targetIndex >= 0) destination.splice(targetIndex + (after ? 1 : 0), 0, activeId);
  else if (activeId === targetId) destination.push(activeId);
  return { pinned, recent, changedPin: fromPinned !== toPinned, toPinned };
}
export function keyboardMoveSidebarSession(order: SessionDragOrder, id: string, delta: -1 | 1): SessionDragOrder {
  const inPinned = order.pinned.includes(id);
  const current = inPinned ? order.pinned : order.recent;
  const index = current.indexOf(id);
  const to = index + delta;
  if (index < 0 || to < 0 || to >= current.length) return order;
  const next = [...current];
  next.splice(index, 1);
  next.splice(to, 0, id);
  return inPinned ? { ...order, pinned: next } : { ...order, recent: next };
}
