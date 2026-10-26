/**
 * 【Q11 / WF-06】**原生 Node-RED 运行的持久记录。**
 *
 * ## 为什么需要
 *
 * 在本次改动之前，原生运行只活在内存里：`@node-red-runboard:<workflowId>` 这条
 * 合成的会话命名空间把节点事件推给渲染端，进程一关就全没了。后果是：
 *
 * - 运行历史页看不到 Node-RED 跑过什么；
 * - 节点失败之后，用户没有"那一步失败了、我改一下再试"的入口 ——
 *   因为**连"那一步失败过"这个事实都没有落下来**。
 *
 * ## 它记录什么，不记录什么
 *
 * **记录**：一次运行的开始/结束、每个节点的一次结果（成功/失败/摘要/错误）。
 * **不记录**：Node-RED 自己的消息队列状态。上游的消息流不持久化"执行到哪一格"，
 * 我们也不假装有 —— 那不是本模块能给的，硬造一份假的图状态只会在续跑时骗人。
 *
 * 因此这里的定位是**运行史**，不是**崩溃续跑的存档**：
 * - 「失败那一步重试」← 成立（知道哪一步失败、失败在哪张图的哪个节点）；
 * - 「崩溃后从停下处接着跑」← **不成立**，如实不给这个承诺（见功能文档 WF-06）。
 *
 * ## 存哪
 *
 * `workflow_runs` 表（`WorkflowRunRepo`），与旧调度器**同一张表**。理由：运行史
 * 是同一类事实，分两张表会让"这个工作流最近跑得怎么样"要 union 两次；而且
 * `runHistory()` 已经会按 `session_id` 读它，渲染端一行都不用改。
 *
 * `session_id` 用与 runboard 事件**完全相同**的 `@node-red-runboard:<workflowId>`
 * —— 事件流和运行史指向同一条会话命名空间，界面按它取的卡片和列表才对得上。
 */
import { log } from "@main/lib/logger.js";

/**
 * `WorkflowRunRepo` **惰性取**，不在模块顶层 import。
 *
 * 多个无头套件把 `@main/store/repositories.js` 整个桩掉（`--alias:`），桩里只导出
 * 它们用到的那几个仓储。顶层 import 一个桩里没有的名字会在**打包期**就失败
 * （实测 `mcode-admin-smoke` 报 "No matching export in stubs/repositories.ts"），
 * 而这个模块只是"记一行运行史"，不该有能力拖垮那些套件。
 *
 * 动态 import 之后：真正写运行史时才需要它；桩环境里 `persistRun` 的 catch 会把
 * 失败降级成一条日志（运行史是观测面，缺了不该让运行本身失败）。
 */
async function workflowRunRepo(): Promise<{ save(args: {
  id: string; sessionId: string; workflowId: string;
  status: "running" | "interrupted" | "success" | "failed" | "cancelled";
  payload: string; awaiting: readonly string[];
}): void }> {
  const mod = await import("@main/store/repositories.js");
  return mod.WorkflowRunRepo as never;
}

/** runboard 事件的会话命名空间 —— 与 `registry.ts:534` 必须逐字一致。 */
export function nativeRunboardSessionId(workflowId: string): string {
  return "@node-red-runboard:" + workflowId;
}

/** 一次原生运行在内存里累积的样子。 */
interface NativeRunRecord {
  runId: string;
  workflowId: string;
  startedAt: number;
  nodes: Map<string, NativeNodeRecord>;
}

interface NativeNodeRecord {
  nodeId: string;
  title: string;
  status: "running" | "success" | "failed";
  summary: string;
  error: string | null;
  updatedAt: number;
}

/** 进程内活动记录。key 是 `workflowId + "\u0000" + runId`。 */
const active = new Map<string, NativeRunRecord>();

function keyOf(workflowId: string, runId: string): string {
  return `${workflowId}\u0000${runId}`;
}

/**
 * 一次原生运行开始了。**幂等**：同 `(workflowId, runId)` 重复调用不重置。
 *
 * `runId` 来自节点消息里的 `mcode.runId`。没有 runId 的节点（尚未经过
 * 一次 Mcode 节点）不会调用这里 —— 调用方只在拿得到身份时记。
 */
export function beginNativeRun(workflowId: string, runId: string): void {
  const key = keyOf(workflowId, runId);
  if (active.has(key)) return;
  active.set(key, { runId, workflowId, startedAt: Date.now(), nodes: new Map() });
  void persistRun(active.get(key)!, "running");
}

/**
 * 一步的结果。`status` 为 `running` 时只更新内存（避免每个节点开始都写一次库），
 * 落定（success/failed）时才写 —— 运行史的读者关心的是"这一步的结局"。
 */
export function recordNativeNode(
  workflowId: string,
  runId: string,
  node: { nodeId: string; title: string; status: "running" | "success" | "failed"; summary?: string; error?: string },
): void {
  const key = keyOf(workflowId, runId);
  const run = active.get(key);
  if (run === undefined) {
    // 没有 begin 就收到节点事件（例如引擎重启后残留的旧消息）：补建一条，
    // 而不是丢掉这个事实 —— 丢掉的话界面上会出现"有结果卡、没有运行记录"。
    beginNativeRun(workflowId, runId);
    return recordNativeNode(workflowId, runId, node);
  }
  run.nodes.set(node.nodeId, {
    nodeId: node.nodeId,
    title: node.title,
    status: node.status,
    summary: node.summary ?? "",
    error: node.error ?? null,
    updatedAt: Date.now(),
  });
  if (node.status !== "running") void persistRun(run, "running");
}

/** 一次运行收尾。失败的运行会带着"哪几步失败"一起落下来。 */
export function settleNativeRun(workflowId: string, runId: string, status: "success" | "failed" | "cancelled"): void {
  const key = keyOf(workflowId, runId);
  const run = active.get(key);
  if (run === undefined) {
    // 只收到收尾事件：仍然记一行，让用户看得见"它跑过、而且是这个结局"。
    const fresh: NativeRunRecord = { runId, workflowId, startedAt: Date.now(), nodes: new Map() };
    void persistRun(fresh, status);
    return;
  }
  void persistRun(run, status);
  active.delete(key);
}

/**
 * 把这次运行此刻的样子写进 `workflow_runs`。
 *
 * **失败不抛**：运行史是观测面，写不进去不该让一次已经跑完的运行变成错误。
 * 但必须留日志 —— 否则用户会看到"跑完了却没有历史"，而没有任何线索。
 */
async function persistRun(run: NativeRunRecord, status: "running" | "success" | "failed" | "cancelled"): Promise<void> {
  const nodes = [...run.nodes.values()];
  const failed = nodes.filter((node) => node.status === "failed");
  try {
    const repo = await workflowRunRepo();
    repo.save({
      id: run.runId,
      sessionId: nativeRunboardSessionId(run.workflowId),
      workflowId: run.workflowId,
      status,
      // 「停在等用户」这一列对原生运行没有等价物 —— Node-RED 的等待是节点自己的
      // 状态，不是宿主的岔路口。空数组是**如实**的答复，不是漏填。
      awaiting: [],
      // payload 的形状归 `runStore` 管；这里写的是**本模块自己的**最小形状，
      // `decodeSnapshot` 对不认识的形状返回 null（见下），不会污染旧续跑路径。
      payload: JSON.stringify({
        kind: "node-red-native",
        version: 1,
        capturedAt: Date.now(),
        startedAt: run.startedAt,
        nodes: nodes.map((node) => ({
          nodeId: node.nodeId,
          title: node.title,
          status: node.status,
          summary: node.summary,
          ...(node.error === null ? {} : { error: node.error }),
        })),
        ...(failed.length === 0 ? {} : { failedNodeIds: failed.map((node) => node.nodeId) }),
      }),
    });
  } catch (err) {
    log.warn(`[workflow-engine:node-red] 原生运行记录写入失败（${run.runId}）：${(err as Error).message}`);
  }
}

/** 只给测试用：清空进程内活动表。 */
export function resetNativeRunRecordsForTests(): void {
  active.clear();
}
