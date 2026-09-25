/** 只记录 IPC 删除后的通知；真实窗口与用户数据均不参与烟测。 */
export const notifications: string[] = [];
export function notifyMemoryChanged(reason: string): void {
  notifications.push(reason);
}
