/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 只给 `mcode-node-pack-ports-smoke` 用。
 *
 * 被测的生产端口只用到它的**三个**成员:
 *   - `emitExternal(event)` —— 节点阶段事件的唯一出口(真的那个还会 fan-out 给订阅者,
 *     这里照做:先记下来,再推给订阅者);
 *   - `subscribe(fn)` —— 生产代码在**发起 turn 之前**订阅、`finally` 里退订;
 *   - `sendTurn(session, { prompt, cwd })` —— 返回 `{ done }` 或 `null`(会话忙)。
 *
 * 这套桩的意义是让脚本**摆出**真引擎会给的三种结果:
 *   1. 正常:`text.delta` 若干 + `turn.done(end_turn)`;
 *   2. 异常:`error` 事件 / `turn.done(interrupted)` / 干脆没有 `turn.done`;
 *   3. 忙:`sendTurn` 返回 null。
 * 三条都是 `runSelectedSession` 的 fail-closed 分支,不摆状态就验不到。
 *
 * ⚠️ `sendTurnCalls` 记的是**生产代码交给引擎的原文**(prompt / cwd / 整个 session),
 * 断言打在这个上 —— 「端口把什么交给引擎」正是本套要验的东西。
 */
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";

type Listener = (e: RuntimeEvent) => void;
const listeners: Listener[] = [];

/** `emitExternal` 收到的每一条事件(节点阶段事件)。 */
export const externalEvents: RuntimeEvent[] = [];

export interface SendTurnCall {
  session: Session;
  input: { prompt: string; cwd: string };
}
/** `sendTurn` 收到的每一次调用。 */
export const sendTurnCalls: SendTurnCall[] = [];

/** 脚本摆的「这一轮引擎会怎么演」。每次 `sendTurn` 消费一次。 */
export type TurnScript = (emit: (e: RuntimeEvent) => void) => void | Promise<void>;
let script: TurnScript | null = null;
let busy = false;

/** 块级隔离:清空全部记录与状态。 */
export function resetRuntime(): void {
  externalEvents.length = 0;
  sendTurnCalls.length = 0;
  listeners.length = 0;
  script = null;
  busy = false;
}

/** 摆下一轮 `sendTurn` 的演出脚本(消费一次就作废)。 */
export function scriptNextTurn(next: TurnScript | null): void {
  script = next;
}

/** 摆「会话忙」状态(`sendTurn` 返回 null)。 */
export function setSessionBusy(next: boolean): void {
  busy = next;
}

/** 脚本/其它订阅源往运行时里推一条事件 —— 真的那个是三个 provider 在推。 */
export function emitEvent(event: RuntimeEvent): void {
  for (const listener of listeners.slice()) listener(event);
}

export const runtimeManager = {
  subscribe(fn: Listener): () => void {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  },

  emitExternal(event: RuntimeEvent): void {
    externalEvents.push(event);
    for (const listener of listeners.slice()) listener(event);
  },

  async sendTurn(session: Session, input: { prompt: string; cwd: string }) {
    sendTurnCalls.push({ session, input });
    if (busy) return null;
    const scripted = script;
    script = null;
    // 微任务里演:调用方 `await sendTurn(...)` 让出之后、`await handle.done` 之前,
    // 事件正好落在「已订阅、还没收口」的窗口里 —— 与真引擎的时序一致。
    const done = Promise.resolve().then(async () => {
      if (scripted) await scripted(emitEvent);
    });
    return { done, isRunning: () => false, interrupt: () => {} };
  },
};
