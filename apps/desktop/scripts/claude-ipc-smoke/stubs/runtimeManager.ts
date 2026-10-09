/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 真的那个会拉起 SDK 子进程、真的持有
 * 会话与审批桥。
 *
 * ## 为什么必须换掉
 *
 * 真的那个一 `bindSession` 就会把三个引擎实现、每个的 MCP 工具表、以及
 * `workflows/seed.js` 那一坨 Vite `?raw`(二十几个 `.py`)全拉起来 —— 无头跑不起来。
 *
 * ⚠️ **但 `ipc/claude.ts` 的另一半(落库、标题、广播、覆盖值)全是真的。**
 * 这一套要验的是那一半:哪些东西该落盘、哪些只该活在内存里、什么时候广播、
 * 什么时候不该广播。运行时那一侧只需要"被调到了、参数是什么"。
 *
 * ## ⚠️ 不是空实现 —— 每一条都记下来
 *
 * `sendTurn` 的那个 `cwd` 参数是本套最要紧的观测点:`resolveSessionCwd` 决定了每一轮
 * 在哪个目录里跑,而工作树那条路会**先建目录、先落盘、再派发**。记下每次调用的实参,
 * 断言才有东西可看。
 *
 * 审批那几个的返回值语义是**"这个 id 认不认得"**、不是"命令执行成功没有" —— 这是真的
 * 那边的契约(见 `RuntimeManager.resolveApproval`),桩照抄,否则本套验的就不是真的契约。
 */
import type { RuntimeEvent } from "@contracts/runtime";

export interface SendTurnCall {
  sessionId: string;
  prompt: string;
  cwd: string;
  skills?: unknown;
  images?: unknown;
  userMessage?: unknown;
}

/** 按顺序记下每一次 `sendTurn` 的实参。 */
export const sendTurns: SendTurnCall[] = [];
/** 按顺序记下 `interrupt` 的会话 id。 */
export const interrupts: string[] = [];
/** 按顺序记下 `injectMessage` 的 (会话, 文本)。 */
export const injected: Array<{ sessionId: string; text: string }> = [];
/** 按顺序记下 `resolveApproval` 的 (请求 id, 允许, 理由, 始终)。 */
export const approvals: Array<{ requestId: string; allow: boolean; reason?: string; always?: boolean }> = [];
/** 按顺序记下 `notifyRequestResolved`。 */
export const notified: Array<{ sessionId: string; requestId: string; kind: string }> = [];
/** 按顺序记下 `resolveUserInput` 的答案。 */
export const userAnswers: Array<{ requestId: string; answers: unknown }> = [];
/** 按顺序记下 `dismissUserInput`。 */
export const dismissed: string[] = [];
/** 按顺序记下 `resolvePlanApproval`。 */
export const planApprovals: Array<{ requestId: string; payload: unknown }> = [];
/** 按顺序记下 `bindSession`。 */
export const bound: string[] = [];
/** 按顺序记下 `bindSession` 收到的**整份会话快照** —— 运行时正是拿它解析引擎 / 工作流的,
 *  所以"这一轮实际用了什么"要看这里,不是看库里的行(见 §3d)。 */
export const boundSessions: Array<{ id: string; providerId?: string; workflowId?: string }> = [];
/** 按顺序记下 `setPermissionMode`。 */
export const permissionModes: Array<{ sessionId: string; mode: string }> = [];

/**
 * 下一次 `resolveApproval` / `resolveUserInput` / `dismissUserInput` / `resolvePlanApproval`
 * 该返回什么。默认 **true**(=「认得这个 id」,正常路径)。
 *
 * ⚠️ 这一项存在的理由:那四个方法的返回值**只表示"认不认得"**,而 handler 拿到 false 时
 * 的处理是各不相同的 —— `approve` 只记一行 warn 就静默成功,`respondQuestion` 那条
 * sentinel 路却要继续跑下去。要验那些分支就得能把返回值拨走。
 */
const nextResolve = new Map<string, boolean>();
export function setNextResolve(method: string, value: boolean): void {
  nextResolve.set(method, value);
}
function take(method: string): boolean | undefined {
  const v = nextResolve.get(method);
  if (v === undefined) return undefined;
  nextResolve.delete(method);
  return v;
}

/** 一次性覆盖 / 兜底值的合并:一次性优先,其次兜底,最后默认 true。 */
function decide(method: string, dflt: boolean): boolean {
  return take(method) ?? defaults.get(method) ?? dflt;
}

/** `setNextResolve` 的兜底值(不设时默认 true)。 */
const defaults = new Map<string, boolean>();
export function setDefaultResolve(method: string, value: boolean): void {
  defaults.set(method, value);
}

export function resetStub(): void {
  sendTurns.length = 0;
  interrupts.length = 0;
  injected.length = 0;
  approvals.length = 0;
  notified.length = 0;
  userAnswers.length = 0;
  dismissed.length = 0;
  planApprovals.length = 0;
  bound.length = 0;
  boundSessions.length = 0;
  permissionModes.length = 0;
  nextResolve.clear();
  defaults.clear();
}

/** 按顺序记下每一次 `rewindTurn`。 */
export const rewinds: Array<{ sessionId: string; files: unknown; targetFiles: unknown }> = [];
/** 下一次 `rewindTurn` 该返回什么(恢复成功的路径列表)。 */
export let rewindResult: string[] = [];
export function setRewindResult(v: string[]): void {
  rewindResult = v;
}

export const runtimeManager = {
  bindSession(session: { id: string; providerId?: string; workflowId?: string }): void {
    bound.push(session.id);
    boundSessions.push({ id: session.id, providerId: session.providerId, workflowId: session.workflowId });
  },
  async sendTurn(
    session: { id: string },
    opts: { prompt: string; cwd: string; skills?: unknown; images?: unknown; userMessage?: unknown },
  ): Promise<void> {
    sendTurns.push({
      sessionId: session.id,
      prompt: opts.prompt,
      cwd: opts.cwd,
      skills: opts.skills,
      images: opts.images,
      userMessage: opts.userMessage,
    });
  },
  interrupt(sessionId: string): void {
    interrupts.push(sessionId);
  },
  injectMessage(sessionId: string, text: string): boolean {
    injected.push({ sessionId, text });
    return decide("injectMessage", true);
  },
  resolveApproval(requestId: string, allow: boolean, reason?: string, always?: boolean): boolean {
    approvals.push({ requestId, allow, reason, always });
    return decide("resolveApproval", true);
  },
  resolveUserInput(requestId: string, answers: unknown): boolean {
    userAnswers.push({ requestId, answers });
    return decide("resolveUserInput", true);
  },
  dismissUserInput(requestId: string): boolean {
    dismissed.push(requestId);
    return decide("dismissUserInput", true);
  },
  resolvePlanApproval(requestId: string, payload: unknown): boolean {
    planApprovals.push({ requestId, payload });
    return decide("resolvePlanApproval", true);
  },
  notifyRequestResolved(sessionId: string, requestId: string, kind: string): void {
    notified.push({ sessionId, requestId, kind });
  },
  async rewindTurn(sessionId: string, files: unknown, targetFiles: unknown): Promise<string[]> {
    rewinds.push({ sessionId, files, targetFiles });
    return rewindResult;
  },
  setPermissionMode(sessionId: string, mode: string): void {
    permissionModes.push({ sessionId, mode });
  },
  emitExternal(_event: RuntimeEvent): void {},
  subscribe(): () => void {
    return () => {};
  },
};
