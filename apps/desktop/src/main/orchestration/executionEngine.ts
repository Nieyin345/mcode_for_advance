import type { NodeOutcome } from "@contracts/nodeType";
import { CodeExecutor } from "./codeExecutor.js";
import { CommandExecutor } from "./commandExecutor.js";
import { NodeExecutorRegistry, type NodeExecutor } from "./executorRegistry.js";
import type { ExecutionContext } from "./executionContext.js";

export type { ExecutionContext, ExecutionMetadata, ExecutionProgress } from "./executionContext.js";
export type { NodeExecutor } from "./executorRegistry.js";

export class ExecutionEngine {
  /** 兜底执行器:`execute` 必备,`start`/`settle` 可选(与 NodeExecutor 同一套钩子)。 */
  private fallback?: Pick<NodeExecutor, "execute"> & Partial<Pick<NodeExecutor, "start" | "settle">>;

  constructor(private readonly registry = new NodeExecutorRegistry()) {}

  register(executor: NodeExecutor): this {
    this.registry.register(executor);
    return this;
  }

  /**
   * 兜底执行器:按 kind 精确匹配不到时用它。
   *
   * 有了它,"默认怎么跑"(模型轮)也走同一条 `ExecutionContext → NodeExecutor` 边界,
   * 分派链上就不再需要任何 `kind === xxx` 分支 —— 注册表里有什么就交给什么,没有的
   * 全部落到这里。
   */
  setDefault(
    executor: Pick<NodeExecutor, "execute"> & Partial<Pick<NodeExecutor, "start" | "settle">>,
  ): this {
    this.fallback = executor;
    return this;
  }

  has(kind: string): boolean {
    return this.registry.has(kind);
  }

  async execute(context: ExecutionContext): Promise<NodeOutcome> {
    const kind = context.manifest.runner.kind;
    const startedAt = Date.now();
    const executionOf = (finishedAt: number) => ({
      executorKind: kind,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
    });
    const executor = this.registry.get(kind) ?? this.fallback;
    if (!executor) {
      const finishedAt = Date.now();
      return {
        status: "failed",
        summary: "",
        error: `No executor registered: ${kind}`,
        execution: executionOf(finishedAt),
      };
    }
    try {
      await executor.start?.(context);
      const outcome = await executor.execute(context);
      await executor.settle?.(context, outcome);
      return { ...outcome, execution: executionOf(Date.now()) };
    } catch (err) {
      const finishedAt = Date.now();
      await executor.settle?.(context, {
        status: "failed",
        summary: "",
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: "failed",
        summary: "",
        error: err instanceof Error ? err.message : String(err),
        execution: executionOf(finishedAt),
      };
    }
  }
}

export const executionEngine = new ExecutionEngine()
  .register(new CommandExecutor())
  .register(new CodeExecutor());
