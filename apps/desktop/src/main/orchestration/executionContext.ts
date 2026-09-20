import type { NodeOutcome } from "@contracts/nodeType";
import type { NodeRunInput, WorkflowExecutionContext, WorkflowExecutionMetadata } from "@contracts/runtime";

/** Progress emitted by a host-side node executor. */
export interface ExecutionProgress {
  percent?: number;
  message?: string;
  phase?: string;
}

/**
 * Host runtime context passed to every executor.
 *
 * Stable workflow data lives in `input.data`; host-only controls such as
 * cancellation and progress stay here and never leak into the contracts
 * package.
 */
export type ExecutionContext = Omit<WorkflowExecutionContext, "input"> & {
  input: NodeRunInput & { signal: AbortSignal };
  emitProgress?: (progress: ExecutionProgress) => void;
  /**
   * **清单文件所在目录。** 只有 `runner.entry`(第三方插件自带脚本)要用它 ——
   * `entry` 是相对清单目录写的,没有它执行器只知道"要跑 ./x.py"却不知道 `./` 是哪儿。
   * 内置类型缺席(它们没有文件);命令来自节点参数的那一支用不上(它相对工作目录)。
   *
   * 它是**宿主侧**的信息,所以放这里而不是进 `NodeRunInput` 契约。
   */
  manifestDir?: string;
};

export type ExecutionMetadata = WorkflowExecutionMetadata;
export type ExecutionResult = NodeOutcome;
