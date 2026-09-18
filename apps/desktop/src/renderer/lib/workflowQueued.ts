/**
 * 「排队中」的小仓库:`workflow.node.queued` 事件到卡片之间那一段状态。
 *
 * ## 为什么单独一个文件
 *
 * 队列事实是**跨卡片的运行时状态**,但它只有两个动词(进队/出队),进 store
 * (`sessionStore`)得为一句话搬动那张几千行的状态表。这里是一个模块级的微仓库:
 * `useSyncExternalStore` 直连,谁要显示「排队中」谁订阅,不经过任何 store。
 *
 * ## 认卡的方式
 *
 * 事件带 `{ workflowId, runId, nodeId }`,卡片上能对上的就是 `runId + nodeId`(与
 * 进度/结果卡认卡用的是同一对)。所以:
 *  - `workflow.node.queued` → 记上这一对;
 *  - `workflow.node.progress` / `result` / `choice`(同一对)→ 摘掉 —— 节点已经起跑
 *    或收场了,「排队中」的说法到此为止。
 *
 * ## 订阅是**惰性**的
 *
 * 第一个订阅者出现才挂 `api.on.claudeEvent`,最后一个退订就摘 —— 没人显示这个 chip
 * 的页面不为它收事件。卸载发生在热重载/关窗时,主进程那边少收几条没有任何后果。
 */
import { useSyncExternalStore } from "react";
import { api } from "@renderer/lib/api.js";

/** 一次运行的哪一步在排队。`runId + nodeId` 唯一定位 —— 与卡片认卡同一对。 */
function keyOf(runId: string, nodeId: string): string {
  return `${runId}\u0000${nodeId}`;
}

/** 不可变快照:Set 本体只在换快照时重建,`useSyncExternalStore` 比的是引用。 */
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

let unsubscribe: (() => void) | null = null;

function ensureSubscribed(): void {
  if (unsubscribe !== null) return;
  unsubscribe = api.on.claudeEvent((msg) => {
    // 四种事件都是 `@contracts/runtime` 的 RuntimeEvent 成员,都带 runId/nodeId 这
    // 对身份;别的成员在 type guard 这里自然被跳过。
    const event = msg?.event;
    if (event === undefined) return;
    const type = event.type;
    if (
      type !== "workflow.node.queued" &&
      type !== "workflow.node.progress" &&
      type !== "workflow.node.result" &&
      type !== "workflow.node.choice"
    ) {
      return;
    }
    if (typeof event?.runId !== "string" || typeof event?.nodeId !== "string") return;
    const key = keyOf(event.runId, event.nodeId);
    if (type === "workflow.node.queued") {
      if (snapshot.has(key)) return;
      const next = new Set(snapshot);
      next.add(key);
      snapshot = next;
    } else {
      // 起跑/收场都会来很多次,快照没变就不吵订阅者。
      if (!snapshot.has(key)) return;
      const next = new Set(snapshot);
      next.delete(key);
      snapshot = next;
    }
    for (const listener of listeners) listener();
  });
}

function releaseIfIdle(): void {
  if (listeners.size > 0 || unsubscribe === null) return;
  unsubscribe();
  unsubscribe = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureSubscribed();
  return () => {
    listeners.delete(listener);
    releaseIfIdle();
  };
}

/** 这一步现在**在排队**吗。给它的是卡片上本来就有的那一对 id。 */
export function useQueuedNode(runId: string, nodeId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.has(keyOf(runId, nodeId)),
    () => false,
  );
}
