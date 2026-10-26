/**
 * 【WF-09】**复制一份工作流**。
 *
 * ## 为什么不能只换个 id
 *
 * 图里的**节点与边**也各有自己的 id，运行史、断点、运行中的进度都按它们索引。
 * 只换工作流 id 会让两份图共用同一批节点 id —— 一份在跑时另一份的进度会串过去。
 * 所以复制必须**重新发一批节点/边 id**，并同步改写引用它们的字段：
 *
 *   - `edges[].from` / `edges[].to`（连的是节点 id）；
 *   - 触发器节点的 `branch`（如果有）。
 *
 * ## 它**不**复制什么
 *
 * - **运行史**：新图没跑过，没有历史可复制（复制历史会让"这份跑得怎么样"说谎）；
 * - **审查状态**：原图审过不代表副本审过 —— 副本按**新导入**处理（需要用户再确认）；
 * - **是否为默认**：默认只能有一个，复制出来的永远不是。
 */
import type { WorkflowDoc } from "@contracts/workflow";
import { makeEdgeId, makeNodeId, makeWorkflowId } from "@contracts/workflow";

export interface DuplicateResult {
  /** 新的一份（还没落盘）。 */
  doc: WorkflowDoc;
}

/**
 * 生成一份副本。`name` 省略时在原名后加「 副本」（仓储再做一次去重）。
 *
 * **确定性来源是 `now`**：调用方可以传固定值让结果可复现（套件要能断言）。
 */
export function duplicateWorkflowDoc(
  source: WorkflowDoc,
  opts: { name?: string; now?: number } = {},
): DuplicateResult {
  const now = opts.now ?? Date.now();
  // 旧 id → 新 id。边与分支引用都靠这张表改写 —— **一张表，不各写一遍**：
  // 分开写时很容易漏掉某一处，而漏掉的那处只在运行到某个节点时才暴露。
  const idMap = new Map<string, string>();
  for (const node of source.nodes) idMap.set(node.id, makeNodeId(now));

  const nodes = source.nodes.map((node) => {
    const mapped = idMap.get(node.id)!;
    const params: Record<string, unknown> = { ...node.params };
    // 触发器节点的 `branch` 指一个节点 id；照表改写。
    if (typeof params["branch"] === "string") {
      const target = idMap.get(params["branch"] as string);
      if (target !== undefined) params["branch"] = target;
    }
    return { ...node, id: mapped, params };
  });

  const edges = source.edges.map((edge) => ({
    ...edge,
    id: makeEdgeId(now),
    // `from`/`to` 是节点 id；**找不到就不改**（旧图可能有悬空边，那是既有问题，
    // 复制不该假装修好它 —— 修悬空边是校验器的职责，见 `workflowValidation`）。
    from: idMap.get(edge.from) ?? edge.from,
    to: idMap.get(edge.to) ?? edge.to,
  }));

  return {
    doc: {
      ...source,
      id: makeWorkflowId(now),
      name: opts.name ?? " 副本",
      nodes,
      edges,
      builtin: false,
      updatedAt: now,
    },
  };
}
