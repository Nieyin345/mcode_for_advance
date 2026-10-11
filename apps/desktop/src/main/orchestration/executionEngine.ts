import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { NodeOutcome } from "@contracts/nodeType";
import {
  MODULE_CAPABILITY_RUNNER_KIND,
  ModuleWorkflowCallSchema,
  ModuleWorkflowExecutionInputSchema,
} from "@contracts/moduleCapability";
import { CodeExecutor } from "./codeExecutor.js";
import { CommandExecutor } from "./commandExecutor.js";
import { NodeExecutorRegistry, type NodeExecutor } from "./executorRegistry.js";
import type { ExecutionContext, ExecutionMetadata } from "./executionContext.js";
import { ModuleCapabilityExecutor, type WorkflowModuleHostPort } from "./moduleCapabilityExecutor.js";
import { buildNodeInput, nodeInputBuilderRegistry } from "./nodeInputBuilders.js";

// The existing builder seam receives params/base, not trusted run identity. Bind
// that identity around synchronous input construction; never put it in params or
// mutate the shared registry for an individual run. Concurrent runs stay isolated.
const inputIdentity = new AsyncLocalStorage<ExecutionMetadata>();
nodeInputBuilderRegistry.register({
  kind: MODULE_CAPABILITY_RUNNER_KIND,
  build: ({ params, base }) => {
    const call = ModuleWorkflowCallSchema.parse(params);
    const identity = inputIdentity.getStore();
    if (!identity) throw new Error("Module input requires a host-bound workflow identity");
    // Allocate once per NEW dispatch, including loops and explicit failed-node
    // retries. Transport retries reuse this finished input, not this builder.
    const requestId = "wf:" + createHash("sha256")
      .update(JSON.stringify([identity.sessionId, identity.runId, identity.nodeId, randomUUID()]))
      .digest("hex");
    return {
      ...base, prompt: "", skills: [], mcpServerNames: [], pluginNames: [], returnMode: "none",
      moduleCall: ModuleWorkflowExecutionInputSchema.parse({ ...call, requestId }),
    };
  },
});

/** Use the existing parameter/variable pipeline, with trusted run-scoped identity. */
export function createWorkflowInputBuilder(
  identity: Pick<ExecutionMetadata, "sessionId" | "runId">,
): typeof buildNodeInput {
  const { sessionId, runId } = identity;
  if (!sessionId || !runId) throw new Error("Workflow input identity is incomplete");
  return (params, manifest, scope, signal) => inputIdentity.run(
    { sessionId, runId, nodeId: scope.nodeId },
    () => buildNodeInput(params, manifest, scope, signal),
  );
}

/** Task 03's host factory is synchronous; the real service is asynchronous.
 * Resolve the SAME lazy service in the engine's start hook, then pass an actual
 * host to the unchanged executor. Import/construction alone opens no data root. */
function moduleExecutor(): NodeExecutor {
  let host: WorkflowModuleHostPort | undefined;
  const executor = new ModuleCapabilityExecutor({ host: () => {
    if (!host) throw new Error("Module host has not been initialized");
    return host;
  } });
  return {
    kind: executor.kind,
    capabilities: executor.capabilities,
    start: async ({ input }) => {
      if (input.signal.aborted || !ModuleWorkflowExecutionInputSchema.safeParse(input.moduleCall).success) return;
      host = await (await import("@main/modules/service.js")).getModuleHost();
    },
    execute: (context) => executor.execute(context),
    cancel: (context) => executor.cancel(context),
  };
}

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

  kinds(): string[] {
    return this.registry.kinds();
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
    // A missing controlled capability executor must NEVER become a model turn.
    // Preserve the established fallback for the other (including plugin) kinds.
    const executor = this.registry.get(kind)
      ?? (kind === MODULE_CAPABILITY_RUNNER_KIND ? undefined : this.fallback);
    if (!executor) {
      const finishedAt = Date.now();
      return {
        status: "failed",
        summary: "",
        // 用户可见(失败节点卡片)。生产里 `setDefault` 总会兜底,只有"清单声明了一个
        // 没注册的 runner kind"才走得到这里 —— 一句配置错误。与编排其它节点错误同用中文。
        error: `没有能执行这种节点的执行器:${kind}`,
        execution: executionOf(finishedAt),
      };
    }
    try {
      await executor.start?.(context);
      const outcome = await executor.execute(context);
      // 【MC-075】`settle` 必须在**独立**的异常边界里调用一次且仅一次 —— 从前它与
      // start/execute 共用一个 try:settle(成功结果)一抛,就落进 catch,再拿**失败**
      // 结果调一次 settle,把**已经成功执行**(副作用已落)的节点反向标成 failed;
      // 若第二次 settle 也抛,异常还会直接逃出执行引擎(不再返回 NodeOutcome)。
      // 现在:业务事实(outcome)先定下来;settle 失败只作为**收尾告警**,绝不改业务状态。
      // settle 只是广播/清理的语义 —— 成功仍报成功(把告警拼进 summary,不写 error,免得
      // 下游把"已成功"当成失败)。`NodeOutcome` 暂无 SUCCEEDED_WITH_WARNINGS 态,故用
      // summary 承载告警文本(节点卡片能看到),status 不翻转。
      try {
        await executor.settle?.(context, outcome);
        return { ...outcome, execution: executionOf(Date.now()) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const warning = `收尾钩子报错(业务结果不受影响):${msg}`;
        return {
          ...outcome,
          summary: [outcome.summary, warning].filter((s) => s !== "").join("\n"),
          execution: executionOf(Date.now()),
        };
      }
    } catch (err) {
      // 这里只可能是 start / execute 抛错 —— **业务未成功**。同样用独立边界调一次 settle
      // (失败结果),settle 再抛也**不逃出**执行引擎,只是把收尾错误拼进 summary。
      const finishedAt = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      const failedOutcome: NodeOutcome = { status: "failed", summary: "", error: msg };
      try {
        await executor.settle?.(context, failedOutcome);
        return { ...failedOutcome, execution: executionOf(finishedAt) };
      } catch (settleErr) {
        const settleMsg = settleErr instanceof Error ? settleErr.message : String(settleErr);
        return {
          ...failedOutcome,
          summary: `收尾钩子也报错:${settleMsg}`,
          execution: executionOf(finishedAt),
        };
      }
    }
  }
}

/** Both the shared engine and runner's run-scoped engine use this registration. */
export function createBuiltinExecutionEngine(): ExecutionEngine {
  return new ExecutionEngine()
    .register(new CommandExecutor())
    .register(new CodeExecutor())
    .register(moduleExecutor());
}

export const executionEngine = createBuiltinExecutionEngine();
