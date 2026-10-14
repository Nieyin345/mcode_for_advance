/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 只为 delegateHost 的无头验证存在。
 *
 * 真的那一份会拉进整条 provider 图(→ `agentTools` → `agentRemoteSsh` → `ssh2` 原生
 * 模块),无头 node 里 import 期就炸;而这一套要验的**不是**运行时本身,是 delegateHost
 * 怎么驱动它(把哪条会话绑过来、用哪个 cwd 起一轮、订阅挂在哪一步)。
 *
 * 所以这里把 delegateHost 用到的**那几步**照实记下来,并留几个探针:
 *   - `__setOnSend` —— 让 `sendTurn` 在**它自己执行期间**同步回调(模拟"第一段文字在
 *     `await sendTurn` 回来之前就发出来了");delegateHost 的注释点名订阅必须挂在这之前,
 *     这就是那条断言的抓手。
 *   - `__emit` —— 向已注册的订阅者派发一个运行时事件。
 *   - `__bound` / `__turns` —— 记下 bindSession / sendTurn 的真实入参供断言。
 */
type Listener = (e: { type: string; sessionId: string; [k: string]: unknown }) => void;

let listeners: Listener[] = [];
let bound: string[] = [];
let turns: { sessionId: string; prompt: string; cwd: string | null }[] = [];
let interrupted: string[] = [];
let pins: string[] = [];
const busy = new Set<string>();
let onSend: ((session: { id: string }) => void) | null = null;

export const runtimeManager = {
  bindSession(session: { id: string }): void {
    bound.push(session.id);
  },
  /** 「把某会话的审批模式钉死」—— publicMcpSession 每次取用合成/链接会话时都调它。
   *  delegateHost 的委派会话是同一条规矩(见 delegateHost.ts 文件头),所以这里也记下来,
   *  供「复用委派会话时重新钉 bypass」那条断言取证。 */
  setPermissionMode(sessionId: string, mode: string): void {
    pins.push(`${sessionId}:${mode}`);
  },
  subscribe(listener: Listener): () => void {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  },
  isBusy(sessionId: string): boolean {
    return busy.has(sessionId);
  },
  interrupt(sessionId: string): void {
    interrupted.push(sessionId);
  },
  sendTurn(session: { id: string }, input: { prompt: string; cwd: string | null }) {
    turns.push({ sessionId: session.id, prompt: input.prompt, cwd: input.cwd });
    // 关键:在 sendTurn **执行期间**就派发(见本文件头 `__setOnSend`)。
    if (onSend) onSend(session);
    // 立刻收场(done 已 resolve),让 delegateHost 的 runTurn 能走完全程。
    return Promise.resolve({ sessionId: session.id, done: Promise.resolve() });
  },
};

export function __resetRuntime(): void {
  listeners = [];
  bound = [];
  turns = [];
  interrupted = [];
  pins = [];
  busy.clear();
  onSend = null;
}
export function __pins(): string[] {
  return pins;
}
export function __setOnSend(fn: ((session: { id: string }) => void) | null): void {
  onSend = fn;
}
export function __emit(e: { type: string; sessionId: string; [k: string]: unknown }): void {
  for (const l of [...listeners]) l(e);
}
export function __listenerCount(): number {
  return listeners.length;
}
export function __bound(): string[] {
  return bound;
}
export function __turns(): { sessionId: string; prompt: string; cwd: string | null }[] {
  return turns;
}
export function __interrupted(): string[] {
  return interrupted;
}
export function __setBusy(sessionId: string, value: boolean): void {
  if (value) busy.add(sessionId);
  else busy.delete(sessionId);
}
