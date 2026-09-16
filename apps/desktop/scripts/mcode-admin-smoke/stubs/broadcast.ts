/**
 * `@main/orchestration/broadcast.js` 的替身 —— 真的那个 import 了 `@main/window.js`
 * (electron 的 `webContents.send`)。
 *
 * 换掉它不只是为了能无头跑,更是为了**能断言"什么时候广播了"**:广播是"AI 改的东西
 * 用户看得见"那条链路的起点,而它的规矩是**存成功才发**(存失败还发,渲染端会去重拉
 * 一份没变的列表)。
 */
const calls: string[] = [];

export function notifyWorkflowsChanged(reason: string): void {
  calls.push(reason);
}

/** Smoke 专用:取走并清空到目前为止的广播记录。 */
export function __takeBroadcasts(): string[] {
  return calls.splice(0, calls.length);
}
