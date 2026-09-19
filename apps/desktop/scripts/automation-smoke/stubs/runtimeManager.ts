/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 只为无头脚本存在。
 *
 * 真的那一个 `import { sendToRenderer } from "@main/window.js"`,而 `window.js` 要
 * `BrowserWindow`(electron)。`automationRunner` 只用到它的**三个**成员,这一份就只
 * 实现那三个:
 *
 *  - `subscribe(fn)` —— 真的那个是"所有事件的唯一出口"。这里把回调**记下来**,脚本可以
 *    自己 `emit()` 喂事件(事件触发器那条路就是这么验的)。
 *  - `isTurnEndHeld(sessionId)` —— 真的那个由工作流调度器扣住(对话节点跑在主对话里,
 *    它跑完那条 `turn.done` 不算用户的回合结束)。脚本可以直接摆这个状态。
 *  - `bindSession(session)` —— 起一次运行之前那一句"把会话绑给运行时"。桩里只记一笔,
 *    真正的绑定发生在引擎那边,无头脚本给不出来。**不是空实现**:记下来之后"起一次运行
 *    到底有没有真的走到"就多了一个可观察点。
 *
 * ⚠️ 这份**与 `hook-runner-smoke` 那份不是同一个文件**(那一份没有 `bindSession`)。
 * 两份各留在各自的套件里,与仓库里其它桩同一条规矩:桩贴着用它的人放,宁可多一份也不
 * 让一个套件的需要去改另一个套件。
 */
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";

type EventListener = (e: RuntimeEvent) => void;

const listeners: EventListener[] = [];
const held = new Set<string>();
/** 被绑过的会话 id(按顺序)—— 断言"起运行之前真的绑了"用。 */
export const boundSessionIds: string[] = [];

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

  bindSession(session: Session): void {
    boundSessionIds.push(session.id);
  },

  /* ── 下面这几个只有脚本用,生产代码里没有 ── */

  /** 把一条事件推给所有订阅者(三个提供方平时干的就是这件事)。 */
  emit(e: RuntimeEvent): void {
    for (const fn of listeners.slice()) fn(e);
  },

  /** 摆 `isTurnEndHeld` 的状态(对话节点扣住收口那条判据)。 */
  holdTurnEnd(sessionId: string): void {
    held.add(sessionId);
  },
  releaseTurnEnd(sessionId: string): void {
    held.delete(sessionId);
  },
};
