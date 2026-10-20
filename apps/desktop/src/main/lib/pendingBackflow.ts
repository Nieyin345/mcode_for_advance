/**
 * 「并回主对话」的待办 —— 隔离节点跑完之后,那些该让**主对话那个助手**看见的东西先存在
 * 这里,等它下一次开口时带进去(见 `@contracts/nodeType` 的 `NODE_RETURN_PARAM_KEY`)。
 *
 * ## 为什么是"先存着,等下一次"
 *
 * 主对话的上下文在**提供方那边**(CLI 自己的会话记录,靠 `resume` 续上),主进程没有
 * 往里面插一条的接口。唯一能确定它会被看见的地方,是**下一次发出去的提示词**。所以这里
 * 存一段,`RuntimeManager.sendTurn` 在发之前取走、拼在最前面。
 *
 * ## 为什么只放在内存里
 *
 * 它是**一次性的**:取走就没了。落盘要额外回答两个问题 —— 什么时候过期、重启之后还算
 * 不算 —— 而它要解决的那件事(图跑完了、主对话不知道)在重启之后本来就过期了:用户
 * 重新问一句就是了。**宁可丢了让他重问,也不要几天之后突然有一段莫名其妙的话冒出来。**
 *
 * ## 为什么放在 `lib/` 而不是 `orchestration/`
 *
 * 写它的是调度器(`orchestration/runner.ts`),读它的是运行时(`claude/RuntimeManager.ts`),
 * 而运行时**不能反过来 import 调度器**(那边已经 import 了它,会成环)。放中间这一层,
 * 两边都只依赖它。
 */
import { log } from "@main/lib/logger.js";

/** sessionId → 还没被带进去的那几段。**按顺序**,先跑完的在前。 */
interface PendingBackflowEntry { text: string; source?: string; sequence: number }
const pending = new Map<string, PendingBackflowEntry[]>();
let nextBackflowSequence = 0;
// Backflow may contain large workflow/tool output. Keep a bounded in-memory
// handoff rather than creating an unbounded next-turn prompt / main-process
// allocation. Reject before mutating the queue: never silently drop a result.
const MAX_PENDING_SESSIONS = 64;
const MAX_BACKFLOW_ENTRIES = 1024;
const MAX_BACKFLOW_CHARS = 4 * 1024 * 1024;
function assertBackflowBudget(entries: readonly PendingBackflowEntry[], body: string): void {
  if (entries.length >= MAX_BACKFLOW_ENTRIES || body.length > MAX_BACKFLOW_CHARS
    || entries.reduce((sum, entry) => sum + entry.text.length, body.length) > MAX_BACKFLOW_CHARS) {
    throw new RangeError("待并回上下文超过内存预算，请缩短工作流输出后重试");
  }
}

function assertSessionCapacity(sessionId: string): void {
  if (!pending.has(sessionId) && pending.size >= MAX_PENDING_SESSIONS) {
    throw new RangeError("待并回会话已达全局资源上限，请先消费或清理旧会话结果");
  }
}

/** 挂一段并回内容。空的一律丢掉 —— 上层算出来是空的,不该在白名单里占一个位置。
 *
 *  ⚠️ **不去重。** 队列是"按顺序追加的一次性待办",两段文字相同不代表是同一件事
 *  (用户可以把同一张工作流跑两遍)。要避免重复的调用方自己判 —— 见
 *  `sessionStart.ts` 的 `queueSessionMemory`。 */
export function queueBackflow(sessionId: string, text: string): void {
  const body = text.trim();
  if (body.length === 0) return;
  const list = pending.get(sessionId) ?? [];
  assertSessionCapacity(sessionId);
  assertBackflowBudget(list, body);
  list.push({ text: body, sequence: ++nextBackflowSequence });
  pending.set(sessionId, list);
}

/**
 * 有东西等着进去吗(**不动队列**)。
 *
 * 取用分成两步(`peek` 再 `clear`)是为了那个"回合没起来"的分支:先把内容拼进这一轮的
 * 提示词,等回合**真的起来了**才清空。只在发之前 take 的话,回合没起成(上一个回合还没
 * 收干净、提供方抛错)那一段就**永久丢了**,而用户完全看不出来 —— 他只发现助手"没记住
 * 刚才那些产出"。
 */
export function peekBackflow(sessionId: string): string {
  const list = pending.get(sessionId);
  return list === undefined ? "" : list.map(entry => entry.text).join("\n\n");
}

/** 带进去了,清掉。 */
export function clearBackflow(sessionId: string): void {
  const list = pending.get(sessionId);
  if (list === undefined) return;
  pending.delete(sessionId);
  log.info(`backflow: 已带进会话 ${sessionId}(${list.map(entry => entry.text).join("").length} 字)`);
}

/** 会话没了(删会话),待办一起清掉 —— 留着也永远没人取了。 */
export function dropBackflow(sessionId: string): void {
  pending.delete(sessionId);
}

/**
 * 拼成要带进提示词的那一段(**带一个说明头**),没东西就返回空串。
 *
 * 那个头不能省:这段文字是拼在**用户这一轮的话前面**发出去的,而模型分不清"哪部分是新
 * 指令、哪部分是背景"时,最常见的反应是**去回复背景那一段** —— 用户会看到助手莫名其妙
 * 地总结起一张他早就看完的图。写明"这不是用户刚说的、不用回复",这一类跑偏就没了。
 */
export function backflowPrompt(text: string): string {
  const body = text.trim();
  if (body.length === 0) return "";
  return [
    `## 背景:用户刚才跑的工作流`,
    `以下是这个对话里刚跑完的一张工作流、各步交出来的东西。**这不是用户刚说的话**,是系统带进来的背景 —— 不需要回复这一段,当作你已经知道即可。`,
    ``,
    body,
  ].join("\n");
}

/** Replace/remove only this producer's pending entry, never other layers' results. */
export function replaceBackflowSource(sessionId: string, source: string, text: string): void {
  const list = (pending.get(sessionId) ?? []).filter(entry => entry.source !== source);
  const body = text.trim();
  if (body) {
    assertSessionCapacity(sessionId);
    assertBackflowBudget(list, body);
    list.push({ source, text: body, sequence: ++nextBackflowSequence });
  }
  if (list.length) pending.set(sessionId, list); else pending.delete(sessionId);
}

/** Preserve producer identity in the model-visible framing. */
export function pendingBackflowPrompt(sessionId: string): string {
  const entries = pending.get(sessionId) ?? [];
  const workflow = entries.filter(entry => entry.source !== "memory.creation-snapshot").map(entry => entry.text).join("\n\n");
  return [backflowPrompt(workflow), pendingCreationMemoryPrompt(sessionId)].filter(Boolean).join("\n\n");
}

/** Snapshot the exact material about to be sent in a provider startTurn.
 * Other workflow events and source replacements may arrive during its await;
 * acknowledge only these existing sequence numbers after successful start. */
export function pendingBackflowBatch(sessionId: string): { text: string; through: number } {
  const entries = pending.get(sessionId);
  return {
    text: pendingBackflowPrompt(sessionId),
    through: entries?.at(-1)?.sequence ?? 0,
  };
}

/** Acknowledge only the snapshot that was actually put in the last request.
 * Never erase backflow queued/replaced after the snapshot while startTurn ran. */
export function clearBackflowThrough(sessionId: string, through: number): void {
  if (!Number.isSafeInteger(through) || through < 0) return;
  const entries = pending.get(sessionId);
  if (!entries) return;
  const retained = entries.filter((entry) => entry.sequence > through);
  if (retained.length === entries.length) return;
  if (retained.length > 0) pending.set(sessionId, retained);
  else pending.delete(sessionId);
  const consumed = entries.filter((entry) => entry.sequence <= through);
  log.info(`backflow: 已带进会话 ${sessionId}(${consumed.map((entry) => entry.text).join("").length} 字)`);
}

/** The SAME fragment used by dispatch and inspection; never re-read the library. */
export function pendingCreationMemoryPrompt(sessionId: string): string {
  const memory = (pending.get(sessionId) ?? []).filter(entry => entry.source === "memory.creation-snapshot").map(entry => entry.text).join("\n\n");
  return memory ? `## 背景：子代理创建时的记忆快照\n以下不是用户的新指令，也不是工作流执行结果；它只反映创建时的项目＋全局记忆。需要最新事实时再按需检索。\n\n${memory}` : "";
}
