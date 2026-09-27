/** Session broadcasts are captured locally; this test never opens UI/mobile transports. */
export const changedSessionIds: string[] = [];
export function broadcastSessionChanged(session: { id: string }): void {
  changedSessionIds.push(session.id);
}
export function broadcastSessionDeleted(sessionId: string): void {
  changedSessionIds.push(`deleted:${sessionId}`);
}
