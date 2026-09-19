/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 `import { sendToRenderer } from "@main/window.js"`,而 `window.js` 要
 * `BrowserWindow`(electron)。无头脚本给不出窗口,但 `HookRunner` 只用到它的**两个**
 * 成员,所以这一份只实现那两个:
 *
 *  - `subscribe(fn)` —— 真的那个是"所有事件的唯一出口";这里把回调**记下来**,由脚本
 *    自己 `emit()` 喂事件。这样"事件进来 → 钩子跑起来"这条路是真的走了一遍,只是事件的
 *    来源从三个提供方换成了脚本。
 *  - `isTurnEndHeld(sessionId)` —— 真的那个由工作流调度器扣住(对话节点跑在主对话里,
 *    它跑完那条 `turn.done` 不算用户的回合结束)。脚本可以直接摆这个状态来验钩子有没有
 *    照那条判据挡。
 *
 * ⚠️ **这是一个诚实的替身,不是空壳。** 每加/改一个 `HookRunner` 用到的方法,这里都要
 * 跟着补 —— 少一个的表现是打包时 `undefined is not a function`,不会静默通过。
 */
type EventListener = (e: unknown) => void;

const listeners: EventListener[] = [];
const held = new Set<string>();

export const runtimeManager = {
  subscribe(fn: EventListener): () => void {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  },

  isTurnEndHeld(sessionId: string): boolean {
    return held.has(sessionId);
  },

  /* ── 下面两个只有脚本用,生产代码里没有 ── */

  /** 把一条事件推给所有订阅者(就是三个提供方平时干的事)。 */
  emit(e: unknown): void {
    for (const fn of listeners.slice()) fn(e);
  },

  /** 摆 `isTurnEndHeld` 的状态。 */
  holdTurnEnd(sessionId: string): void {
    held.add(sessionId);
  },
  releaseTurnEnd(sessionId: string): void {
    held.delete(sessionId);
  },
};
