/**
 * 无头脚本用的**最小**工作流文档工厂。
 *
 * 真的那一头是 `@contracts/workflow` 的 `newWorkflowDoc` / 画布。这里只需要一个
 * "有个主节点、节点上挂着一张条件表"的壳 —— 被测的 `injectEntryCriteria` 只读
 * `nodes[].type` 和 `params`,文档上别的字段一个字都不看。
 */
import type { WorkflowDoc } from "@contracts/workflow";

export function docWithMainNode(params: Record<string, unknown>): WorkflowDoc {
  return {
    id: "wf_smoke",
    name: "冒烟",
    kind: "graph",
    nodes: [
      {
        id: "n_main",
        type: "mcode.main",
        title: "定方向",
        position: { x: 0, y: 0 },
        params,
      },
    ],
    edges: [],
  } as unknown as WorkflowDoc;
}
