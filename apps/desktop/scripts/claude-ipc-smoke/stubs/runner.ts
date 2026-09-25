/**
 * `@main/orchestration/runner.js` 的替身 —— 真的那四个函数会拉起调度器、会话、执行器。
 *
 * ## 为什么换掉
 *
 * `ipc/claude.ts` 的分岔那一段要问三件事、做一件事:
 *   - `graphRunIntent(session)` —— 这一轮该不该推图?(返回 "start" / "busy" / null)
 *   - `parkedRunTeardown(id)` —— 图停着等人的时候要不要放弃它?(返回 Promise 或 null)
 *   - `startWorkflowRun({...})` —— 真的推一遍图
 *   - `cancelWorkflowRun(id)` —— 停止按钮
 *
 * 真的那四个每一个都会拉起调度器 + 隐藏子会话 —— 无头跑不完。而本套要验的是
 * **`ipc/claude.ts` 自己那段判断**:什么时候推图、什么时候拦住用户的消息、
 * 什么时候等收尾、什么时候走普通回合。所以这四个换成可编程的替身。
 *
 * ## ⚠️ 这三个函数的返回值是本套的**输入**,不是被测对象
 *
 * `graphRunIntent` / `parkedRunTeardown` 的结果由本套按场景摆 —— 它们的实现归
 * `workflow-validation-smoke` 与 `scheduler-smoke` 管,这边只用它们把分岔摆到各个道上。
 */
export const started: Array<Record<string, unknown>> = [];
/**
 * 每一次 `cancelWorkflowRun` 的**调用**(没认领的也在里面)。
 *
 * ⚠️ 这和 {@link stoppedRuns} 是两件事,不能合成一个数组 —— 踩过:
 * 「普通会话按停止时**不碰图**」那条断言最初读的是这个数组,于是永远是 1。
 * 但 `ipc/claude.ts` 那句 `if (cancelWorkflowRun(id))` 的语义是
 * **"先问一句'这张图是不是你的'"** —— 它当然会被调到,关键是它**返回了什么**。
 * 想验"没碰图",要读的是真被停掉的那张图。
 */
export const cancelled: string[] = [];
/** 真正被认领、真停掉了的那几次(`cancelWorkflowRun` 返回 true 的那些)。 */
export const stoppedRuns: string[] = [];
export const teardowns: string[] = [];

/**
 * 哪些会话上"有一张图正在跑"。
 *
 * ⚠️ 这个集合不是装饰:`ipc/claude.ts` 的 `CLAUDE_INTERRUPT` 是
 * `if (cancelWorkflowRun(id)) { 落图那条路 } else { 打断普通回合 }` —— `cancelWorkflowRun`
 * 的返回值**就是那个分岔本身**。桩要是一律返回 true,普通会话的「停止」就永远走不到
 * `runtimeManager.interrupt` 那一行,而那正是最常被按的那个按钮。
 *
 * 真实现里这个判据是"调度器上有这个会话的运行没有";桩里由 `startWorkflowRun` 记、
 * `resetRunnerStub` 清。
 */
const activeRuns = new Set<string>();

/** 下一次 `graphRunIntent` 返回什么。默认 null(= 不是图型会话)。 */
let intent: "start" | "busy" | null = null;
export function setGraphRunIntent(v: "start" | "busy" | null): void {
  intent = v;
}

/**
 * 下一次 `parkedRunTeardown` 返回什么。
 *   - `"never"` → 永远 resolve 不完(模拟"有节点真在跑",此时应当**拦住**用户的消息)
 *   - 数字      → 等这么多毫秒后 resolve(模拟"图停着等人、被放弃掉了")
 */
let teardown: "never" | number = 0;
export function setParkedTeardown(v: "never" | number): void {
  teardown = v;
}

export function resetRunnerStub(): void {
  started.length = 0;
  cancelled.length = 0;
  stoppedRuns.length = 0;
  teardowns.length = 0;
  activeRuns.clear();
  intent = null;
  teardown = 0;
}

/** 显式声明"这个会话上有一张图正在跑"(给不经过 `startWorkflowRun` 的场景用)。 */
export function markRunActive(sessionId: string): void {
  activeRuns.add(sessionId);
}

export function graphRunIntent(_session: unknown): "start" | "busy" | null {
  return intent;
}

export function parkedRunTeardown(sessionId: string): Promise<void> | null {
  teardowns.push(sessionId);
  if (teardown === "never") return null;
  const ms = teardown;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startWorkflowRun(input: Record<string, unknown>): void {
  const session = input.session as { id?: string } | undefined;
  if (session?.id) activeRuns.add(session.id);
  started.push(input);
}

export function cancelWorkflowRun(sessionId: string): boolean {
  cancelled.push(sessionId);
  // 只有真有一张图在这个会话上跑的时候才认领(见 `activeRuns` 那段)。
  const claimed = activeRuns.delete(sessionId);
  if (claimed) stoppedRuns.push(sessionId);
  return claimed;
}

/* ── 岔路口 / 重试 ────────────────────────────────────────────────────────────
 *
 * 加这两个是因为 **`ipc/index.ts` 的总注册表把 `ipc/orchestration.ts` 也串了进来**
 * (本套要验"注册表里没漏域",就得让 37 个 register* 全都 import 得过)。那个域从
 * `@main/orchestration/runner.js` 具名 import 了这两个函数,少一个就是一句 esbuild
 * 的 `No matching export` —— 而那条错误会盖住本套真正要报的东西。
 *
 * ⚠️ 语义**照抄真的那一份**(见 `orchestration/runner.ts`):两者都是"认领成功回 true,
 * 这张卡过期了回 false",**不抛**。真实现里那四道门(找不到 / 不是 failed / 存档坏了 /
 * 那一步没失败)归 `workflow-validation-smoke` 管,这边只用它们把返回值摆住。
 */
let choiceResult = false;
let retryResult = false;

export function setWorkflowChoiceResult(v: boolean): void {
  choiceResult = v;
}
export function setWorkflowRetryResult(v: boolean): void {
  retryResult = v;
}

/** 用户点岔路口卡片上某个选项。 */
export function resolveWorkflowChoice(_args: {
  sessionId: string;
  runId: string;
  nodeId: string;
  edgeId: string;
  comment?: string;
}): { ok: boolean } {
  return { ok: choiceResult };
}

/** 用户在一张**失败**的卡片上点「再试一次」。 */
export function resolveWorkflowRetry(_args: {
  sessionId: string;
  runId: string;
  nodeId: string;
  note?: string;
}): { ok: boolean } {
  return { ok: retryResult };
}
