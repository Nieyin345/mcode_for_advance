import type { AutomationEventOrigin } from "@main/orchestration/automationEventOrigin.js";
/**
 * `@main/claude/RuntimeManager.js` 的替身 —— 见 main.ts 文件头「为什么引擎那一侧是假的」。
 * 真的那个一旦 `bindSession` 就会 `providerRegistry.resolve`,整条引擎链(三个 SDK 实现
 * + 每个的 MCP 工具表)全在链上。
 *
 * ## 它只做真 RuntimeManager 对 `runner.ts` 可见的那几件
 *
 *  - `subscribe` / `emitExternal` 的**扇出语义** —— `emitExternal` 要送到订阅者,否则
 *    `runner.ts` 收不到节点产出;
 *  - **隐藏会话的流水不上界面、但要进订阅者**(真那个的 `destinationKind` 分支):节点
 *    会话的 `tool.use` / `text.delta` 只进 `subscribers`(以及节点转录),**不**进
 *    `published` —— 渲染端那条路上出现它们就是"幻影消息"那条老毛病;
 *  - `setInteractiveProxy` 把**交互**事件改道到父对话;改道过的那条**要**进 `published`
 *    (用户得看得见审批弹窗);
 *  - **事件从会话的 emit 进订阅者时,`sessionId` 用节点会话自己的 id** —— 真那个的
 *    `emit` 闭包就是这么发的,`runner.ts` 的订阅者按它筛 `observed`。改道只影响"去哪儿",
 *    不改事件的身份。
 *
 * ## 时间冻结
 *
 * 装上之后 `Date.now()` **原地不动**,只有 `advance(ms)` 拨一下它才走。这一套要验的是
 * "时间推进之后主进程有没有再发一条" —— 让时钟自己走的话,"已跑 3 分 12 秒"就只验得出
 * "有个数字",验不出"它在走"。
 *
 * ⚠️ 墙上时钟和 node 的定时器(`setTimeout`)是**两回事**:冻结的只是前者,事件循环照常。
 * 被测代码里任何拿 `setInterval` 做节流的写法都还能推进(它读的是冻结的那个数,所以
 * "同一时刻"就是同一条)。
 */
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import type { StartTurnRequest, TurnHandle } from "@contracts/provider";

/* ── 冻结时钟 ── */

const realNow = Date.now;
/** 真时钟 —— 冒烟自己的超时/轮询要用它,不能用被冻住的那个。 */
export const realNowMs = (): number => realNow.call(Date);

let fakeNow = 1_700_000_000_000;
Date.now = () => fakeNow;

/** 拨一下(冒烟用)。 */
export function advance(ms: number): number {
  fakeNow += ms;
  return fakeNow;
}

/** 拨回真时钟(用完还原,别把别的也冻住)。 */
export function unfreeze(): void {
  Date.now = realNow;
}

/* ── 扇出 ── */

const subscribers = new Set<(e: RuntimeEvent) => void>();

/** 送到**渲染端那条路**的事件(真那个里是 `fanOutToClients`)。 */
export const published: RuntimeEvent[] = [];
export function resetPublished(): void {
  published.length = 0;
}

/** 每一次 `sendTurn` 收到的提示词 —— 用来分辨"今天这一趟"和"上一趟留下的会话"。 */
export const sentPrompts: { sessionId: string; prompt: string; automationOrigin?: AutomationEventOrigin }[] = [];

/** 节点会话当前那一轮的 emit —— 冒烟靠它往指定会话里灌事件。 */
const turnEmitters = new Map<string, (e: RuntimeEvent) => void>();
/** nodeSessionId → 父对话(交互事件改道的目标)。 */
const proxies = new Map<string, string>();
export const boundSessions = new Set<string>();
/** 每一次 `bindSession` 调用,按顺序、**允许重复**(同一格跑第二趟用的是同一个会话 id)。 */
export const bindLog: string[] = [];
const disposed = new Set<string>();
/** 父会话 id → 那次运行建出来的节点会话(按 `kind: "node"` 认)。 */
const nodeSessions = new Map<string, string[]>();

/**
 * 这次运行绑上来的节点会话(最近一个)。
 *
 * ⚠️ **必须在这里记,不能等收尾之后再从 `boundSessions` 里翻。** `runner.ts` 收尾时遍历
 * `active.nodeSessionIds` 放掉运行时,而那时它已经……(不,它是先 dispose 再清的);
 * 真正的问题是**别的队里正在跑的那张图也会往 `boundSessions` 里加东西** —— 按"新出现的
 * 那个 id"去认,认到谁都说不准。按父会话分组才是稳的。
 */
export function nodeSessionOf(parentSessionId: string): string {
  return nodeSessions.get(parentSessionId)?.at(-1) ?? "";
}

export function resetRuntime(): void {
  subscribers.clear();
  published.length = 0;
  turnEmitters.clear();
  proxies.clear();
  boundSessions.clear();
  bindLog.length = 0;
  disposed.clear();
  nodeSessions.clear();
}

/** 往某个会话里灌一条事件(冒烟模拟"引擎报了……")。 */
export function nodeEmit(sessionId: string): ((e: RuntimeEvent) => void) | undefined {
  return turnEmitters.get(sessionId);
}

export function isDisposed(sessionId: string): boolean {
  return disposed.has(sessionId);
}

/* ── 回合 ── */

/** 这一套里"回合在跑"是**默认状态**:起跑之后就一直在跑,直到冒烟调 `finishTurn`。 */
const running = new Set<string>();
let holdConversations = false;
export let busyRejections = 0;
export function holdConversationTurns(hold: boolean): void { holdConversations = hold; }
/** 每个会话那一轮的 `done` 落地函数。 */
const doneResolvers = new Map<string, () => void>();

/** 收掉某个会话那一轮(`await handle.done` 从此往下走)。 */
export function finishTurn(sessionId: string): void {
  runtimeManager.interrupt(sessionId);
}

/** 这个会话这一轮还在跑吗。 */
export function isTurnRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

export const runtimeManager = {
  isBusy(sessionId: string): boolean { return running.has(sessionId); },
  subscribe(fn: (e: RuntimeEvent) => void): () => void {
    subscribers.add(fn);
    return () => void subscribers.delete(fn);
  },

  emitExternal(e: RuntimeEvent): void {
    published.push(e);
    for (const fn of subscribers) fn(e);
  },

  bindSession(s: Session): void {
    if (turnEmitters.has(s.id)) return; // 幂等(同真那个 `bindSession` 开头那句)
    /*
     * ⚠️ **每一次调用都要记,不能只往 `boundSessions` 这个 Set 里加。**
     * `node-session-smoke` 要问的是"**这一趟**派了哪几个格子",而一格跑第二次时
     * 绑的是**同一个**会话 id —— Set 早就有了,从"新出现的 id"里一个都数不出来。
     * (那会退化成"这一趟一个格子都没跑",而断言在上一趟留下的行上照绿。)
     */
    bindLog.push(s.id);
    boundSessions.add(s.id);
    if (s.kind === "node" && s.parentSessionId) {
      const list = nodeSessions.get(s.parentSessionId) ?? [];
      list.push(s.id);
      nodeSessions.set(s.parentSessionId, list);
    }
    const emit = (e: RuntimeEvent): void => {
      // **隐藏会话的流水不上界面**(同真那个的 `destinationKind` 分支):节点会话的
      // text / tool 只进订阅者。被改道过的那条(交互事件代父对话提问)才进 `published`。
      const destination = proxies.get(s.id) ?? s.id;
      if (destination !== s.id) published.push({ ...e, sessionId: destination } as RuntimeEvent);
      for (const fn of subscribers) fn(e);
    };
    turnEmitters.set(s.id, emit);
  },

  setInteractiveProxy(nodeSessionId: string, parentSessionId: string): void {
    proxies.set(nodeSessionId, parentSessionId);
  },

  sendTurn(s: Session, input: StartTurnRequest & { prompt: string; cwd: string; automationOrigin?: AutomationEventOrigin }): Promise<TurnHandle | null> {
    if (running.has(s.id)) { busyRejections++; return Promise.resolve(null); }
    sentPrompts.push({ sessionId: s.id, prompt: input.prompt, automationOrigin: input.automationOrigin });
    running.add(s.id);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    doneResolvers.set(s.id, resolveDone);
    // **跑在主对话里的那一步(入口 / 对话节点)立刻收场。** 它是真实的形状:入口
    // 节点就是把用户那句话发进他自己的对话,而这一套要盯的是**另一个格子**
    // (隐藏子会话里的模型轮,也就是绝大多数节点)。不这么做的话整张图会永远停在
    // 入口那一步上 —— 那正是 `runner.ts` 里那些"图停在某一步等人"的机制在起作用
    // (它们是对的,只是这一套不给入口配一个会结束的回合)。
    if (s.kind !== "node" && !holdConversations) {
      queueMicrotask(() => runtimeManager.interrupt(s.id));
    }
    const handle: TurnHandle = {
      done,
      interrupt: () => runtimeManager.interrupt(s.id),
      isRunning: () => running.has(s.id),
    };
    return Promise.resolve(handle);
  },

  interrupt(sessionId: string): void {
    if (!running.has(sessionId)) return;
    running.delete(sessionId);
    doneResolvers.get(sessionId)?.();
  },

  dispose(sessionId: string): void {
    disposed.add(sessionId);
    turnEmitters.delete(sessionId);
    // 放掉运行时 = 这一轮到此为止(真那个 dispose 之后那个回合也没了)。
    runtimeManager.interrupt(sessionId);
  },

  echoUserMessage(): void {
    /* 本套只盯节点那一路 */
  },

  usageOf(): undefined {
    return undefined;
  },

  transcriptOf(): readonly never[] {
    return [];
  },

  holdTurnEnd(): null {
    return null;
  },

  holdTurnText(): null {
    return null;
  },
};
