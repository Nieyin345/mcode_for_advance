/**
 * `@main/lib/sessionSync.js` 的替身 —— 真的那个要往每个窗口的 webContents 推事件,
 * 无头脚本里没有窗口。
 *
 * **不静默**:把广播过的会话 id 记下来,脚本据此断言"新会话真的广播出去了"。少了这一
 * 条,分叉出来的对话在左栏里**不会自己冒出来** —— 而那正是用户唯一能发现它成了的方式。
 */
export const broadcastIds: string[] = [];

export function broadcastSessionChanged(session: { id: string }): void {
  broadcastIds.push(session.id);
}

export function broadcastSessionDeleted(id: string): void {
  broadcastIds.push(`deleted:${id}`);
}
