/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 `import { sendToRenderer } from "@main/window.js"`，而 `window.js` 要
 * `BrowserWindow`（electron）。`automationRunner` 只用到它的四个成员：
 *
 *  - `subscribe(fn)` —— 记下回调，脚本自己 `emit()` 喂事件（事件触发器那条路）；
 *  - `isTurnEndHeld(sessionId)` —— 恒 false（本套不验对话节点扣回合）；
 *  - `bindSession(session)` —— 记一笔，证明"起运行之前真的绑了"；
 *  - 脚本侧 `emit()` —— 把一条事件推给所有订阅者。
 */
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";

type EventListener = (e: RuntimeEvent) => void;

const listeners: EventListener[] = [];
export const boundSessionIds: string[] = [];

export const runtimeManager = {
  subscribe(fn: EventListener): () => void {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  },

  isTurnEndHeld(_sessionId: string): boolean {
    return false;
  },

  bindSession(session: Session): void {
    boundSessionIds.push(session.id);
  },

  /* ── 只有脚本用 ── */

  emit(e: RuntimeEvent): void {
    for (const fn of listeners.slice()) fn(e);
  },
};
