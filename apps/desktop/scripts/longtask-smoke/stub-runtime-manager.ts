/**
 * RuntimeManager 的冒烟替身 —— 给 longtask-smoke 用。
 *
 * 真的 RuntimeManager 会拉起 SDK 子进程;这里只记录调用、按剧本回 sendTurn,
 * 再把 `subscribe` 收到的订阅者暴露出来,让 main.ts 能**手动喂事件**(模拟上游
 * 吐 text.delta / turn.done)。导出面刻意与真模块对齐(`runtimeManager` 单例),
 * 这样 taskRunner 的用法漂了这里也会露馅。
 *
 * main.ts 走**相对路径**直接 import 这个文件(绕开 tsconfig 的 @main 路径映射,
 * typecheck 才不会去对真模块要测试钩子);run.sh 里用 esbuild `--alias` 把
 * taskRunner 内部的 `@main/claude/RuntimeManager.js` 也指到本文件 —— 两个入口
 * 解析到同一个文件,bundle 里就是同一个模块实例,记录的调用互相看得见。
 */
import type { Session } from "@contracts/session";
import type { RuntimeEvent } from "@contracts/runtime";

type Subscriber = (e: RuntimeEvent) => void;

/** sendTurn 的剧本项:busy = 这次返回 null(会话忙),ok = 正常受理,
 *  throw = 抛异常(验"续轮崩了要把任务收尾,而不是永远卡在 running")。 */
type SendScript = "busy" | "ok" | "throw";

const state = {
  subscribers: [] as Subscriber[],
  /** sendTurn 受理过的续轮(不记 busy 被拒的那次)。 */
  sent: [] as { sessionId: string; prompt: string; cwd: string | undefined }[],
  /** interrupt 被调过的 sessionId(按顺序)。 */
  interrupts: [] as string[],
  /** emitExternal 广播过的事件(渲染端状态条的唯一事实来源,冒烟里断言它)。 */
  externals: [] as RuntimeEvent[],
  /** sendTurn 剧本:按序弹出;空了默认 ok。 */
  sendScript: [] as SendScript[],
  /** 被 hold 了 turn 边界的会话(测 isTurnEndHeld 闸门)。 */
  held: new Set<string>(),
};

export function resetRuntimeStub(): void {
  state.subscribers = [];
  state.sent = [];
  state.interrupts = [];
  state.externals = [];
  state.sendScript = [];
  state.held.clear();
}

/** 只读快照,断言用。 */
export function runtimeStub() {
  return state;
}

export const runtimeManager = {
  subscribe(cb: Subscriber): () => void {
    state.subscribers.push(cb);
    return () => {
      state.subscribers = state.subscribers.filter((x) => x !== cb);
    };
  },

  /** 冒烟专用:手动喂一个上游事件给所有订阅者(替代 RuntimeManager 的真实事件源)。 */
  feed(e: RuntimeEvent): void {
    for (const cb of [...state.subscribers]) cb(e);
  },

  isTurnEndHeld(sessionId: string): boolean {
    return state.held.has(sessionId);
  },

  interrupt(sessionId: string): void {
    state.interrupts.push(sessionId);
  },

  bindSession(_session: Session): unknown {
    return null;
  },

  async sendTurn(
    session: Session,
    input: { prompt: string; cwd?: string },
  ): Promise<Record<string, unknown> | null> {
    const next = state.sendScript.shift() ?? "ok";
    if (next === "busy") return null;
    if (next === "throw") throw new Error("stub: sendTurn 炸了");
    state.sent.push({ sessionId: session.id, prompt: input.prompt, cwd: input.cwd });
    return {};
  },

  emitExternal(event: RuntimeEvent): void {
    state.externals.push(event);
  },
};
