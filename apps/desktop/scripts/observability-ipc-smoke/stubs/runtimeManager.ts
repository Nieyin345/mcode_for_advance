/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程。
 *
 * `ipc/longtask.ts` → `longtask/taskRunner.ts` 顶层就 `import { runtimeManager }`,
 * 并调用它的 `subscribe` / `interrupt` / `isTurnEndHeld` / `emitExternal` /
 * `bindSession` / `sendTurn`。本套要的是**真的那条 IPC 函数**转发出的东西,所以
 * 这个替身只记账、不干活(同 `longtask-smoke/stub-runtime-manager.ts` 的取舍)。
 *
 * `attach` 成功那条路会 `emit(task)`,断言就从这里读 —— 那是渲染端状态条的
 * 唯一事实来源。
 */
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";

const state = {
  /** emitExternal 广播过的事件(按顺序)。 */
  externals: [] as RuntimeEvent[],
  /** interrupt 被调过的 sessionId(按顺序)。 */
  interrupts: [] as string[],
  /** sendTurn 受理过的续轮。 */
  sent: [] as { sessionId: string; prompt: string }[],
  /** 被 hold 了 turn 边界的会话。 */
  held: new Set<string>(),
};

export function resetRuntimeStub(): void {
  state.externals = [];
  state.interrupts = [];
  state.sent = [];
  state.held.clear();
}

export function runtimeStub() {
  return state;
}

export const runtimeManager = {
  subscribe(_cb: (e: RuntimeEvent) => void): () => void {
    // 本套不喂事件给循环器(那是 longtask-smoke 的事),订阅只为不让 start() 炸。
    return () => {};
  },

  interrupt(sessionId: string): void {
    state.interrupts.push(sessionId);
  },

  isTurnEndHeld(sessionId: string): boolean {
    return state.held.has(sessionId);
  },

  bindSession(_session: Session): unknown {
    return null;
  },

  async sendTurn(
    session: Session,
    input: { prompt: string; cwd?: string },
  ): Promise<Record<string, unknown> | null> {
    state.sent.push({ sessionId: session.id, prompt: input.prompt });
    return {};
  },

  emitExternal(event: RuntimeEvent): void {
    state.externals.push(event);
  },
};
