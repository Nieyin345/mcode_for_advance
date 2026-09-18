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
};

export type ExecutionMetadata = WorkflowExecutionMetadata;
export type ExecutionResult = NodeOutcome;
