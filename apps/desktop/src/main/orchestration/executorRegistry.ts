import type { NodeOutcome } from "@contracts/nodeType";
import type { ExecutionContext } from "./executionContext.js";

/** A host-side executor for one runner kind. */
export interface NodeExecutor {
  readonly kind: string;
  readonly capabilities?: ExecutorCapabilities;
  /** Called immediately before execution starts. */
  start?(context: ExecutionContext): Promise<void> | void;
  execute(context: ExecutionContext): Promise<NodeOutcome>;
  /** Called after an executor settles, regardless of success/failure. */
  settle?(context: ExecutionContext, outcome: NodeOutcome): Promise<void> | void;
  /** Optional explicit cancellation hook for executors with external resources. */
  cancel?(context: ExecutionContext): Promise<void> | void;
}

export interface ExecutorCapabilities {
  supportsProgress?: boolean;
  supportsCancellation?: boolean;
  supportsArtifacts?: boolean;
  inputKinds?: string[];
  outputKinds?: string[];
}

/**
 * Runtime registry for node executors.
 *
 * The scheduler should not know which concrete runner kinds exist. The
 * registry is the extension seam: built-ins, plugins, or future executors can
 * register one implementation without adding another scheduler branch.
 */
export class NodeExecutorRegistry {
  private readonly executors = new Map<string, NodeExecutor>();

  register(executor: NodeExecutor): this {
    if (this.executors.has(executor.kind)) {
      throw new Error(`Executor already registered: ${executor.kind}`);
    }
    this.executors.set(executor.kind, executor);
    return this;
  }

  has(kind: string): boolean {
    return this.executors.has(kind);
  }

  get(kind: string): NodeExecutor | undefined {
    return this.executors.get(kind);
  }

  kinds(): string[] {
    return [...this.executors.keys()];
  }

  capabilities(kind: string): ExecutorCapabilities | undefined {
    return this.executors.get(kind)?.capabilities;
  }
}
