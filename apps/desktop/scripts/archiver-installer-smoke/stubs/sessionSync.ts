/**
 * `@main/lib/sessionSync.js` 的替身 —— 真的那个要把会话变更推给桌面渲染端
 * (`sendToRenderer`)和每一台配对手机(`mobileEventBus`)。
 *
 * AutoArchiver 归档完一条会话就广播一条 —— 那是**界面和手机把这一行挪进归档箱的
 * 唯一信号**。漏发的话,会话在数据库里已经归档了,而用户看到的列表一动不动
 * (`SessionListEntry` 只在广播里走),他会以为功能没生效。
 *
 * 所以桩里按顺序把 id 记下来,断言直接看它。(经这份桩,`MobileEventBus` /
 * 真 `sessionSync` 以及它背后的 electron 都不在 import 图里了。)
 */
export const broadcastIds: string[] = [];

export function broadcastSessionChanged(session: { id: string }): void {
  broadcastIds.push(session.id);
}

export function broadcastSessionDeleted(id: string): void {
  broadcastIds.push(`deleted:${id}`);
}
