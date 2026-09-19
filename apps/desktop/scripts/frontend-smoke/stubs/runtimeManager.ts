/**
 * `@main/claude/RuntimeManager.js` 的替身。真的那个会拉起三个引擎的 SDK 子进程。
 *
 * ## 为什么不能只给空实现
 *
 * `NotificationManager.evaluate` 在 `turn.done` 那条路上问了一句
 * `runtimeManager.isTurnEndHeld(sessionId)`(「对话节点」跑在主对话上,它跑完的那一条
 * `turn.done` 是**图内部的一步**,不是用户这一轮的结束 —— 由调度器扣住,见
 * `RuntimeManager.holdTurnEnd`)。桩上少这个成员的话,报的是
 * `isTurnEndHeld is not a function`,看起来像"被测代码调了个不存在的 API",其实只是
 * 替身不全。
 *
 * 这里把它做成**能拨的** —— 于是"被扣住时不该弹"这条也成了可断言的,而不只是
 * 让代码别炸。
 */
import type { RuntimeEvent } from "@contracts/runtime";

/** 真的那个会把这些事件转发给钩子与自动化的事件触发器;本套不验那两条,记下来。 */
export const externals: RuntimeEvent[] = [];

export function resetExternals(): void {
  externals.length = 0;
}

/** 哪些会话被扣住了收口(真的那个是调度器在整张图的收口处调的)。 */
const held = new Set<string>();

export function setTurnEndHeld(sessionId: string, value: boolean): void {
  if (value) held.add(sessionId);
  else held.delete(sessionId);
}

export const runtimeManager = {
  emitExternal(event: RuntimeEvent): void {
    externals.push(event);
  },
  subscribe(): () => void {
    return () => {};
  },
  isTurnEndHeld(sessionId: string): boolean {
    return held.has(sessionId);
  },
};
