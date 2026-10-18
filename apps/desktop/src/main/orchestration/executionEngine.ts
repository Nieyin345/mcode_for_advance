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
import {
  NODE_RED_ENGINE_ID,
  NODE_RED_RUNNER_KIND,
  defaultNodeRedFetch,
  nodeRedExecutor,
  readRequestSpec,
} from "./nodeRedExecutor.js";
import { buildNodeInput, nodeInputBuilderRegistry } from "./nodeInputBuilders.js";
import type { EngineRuntimeStatus } from "@main/workflowEngines/runtimeSupervisor.js";

/** 【ARC-006 桥 1】`node-red` 节点的**输入构造** —— 让"变量展开后的三个扁平参数"
 *  真正到达执行器。
 *
 *  调度器的顺序是固定的：`expandParams`（`{{...}}` 解算）→ `buildNodeInput` →
 *  `ExecutionEngine.execute` → 执行器。`nodeRedExecutor` 从 `context.node.params` 读
 *  参数（那是**存盘原值**，没见过模板解算），而变量展开只发生在递进 buildInput 的那份
 *  `params` 上。没有这个 builder，`engineBody` 里写 `{{上游.字段}}` 会原样发出去 ——
 *  而调度器又**先跑 buildInput 再派发**：没有专用 builder 时它会落进默认模型轮构造并
 *  抛「提示词节点必须有指令」，节点在"变量展开"这一步就失败了，根本到不了执行器。
 *
 *  所以这里按其它"不起模型"的执行器（code / command）同一个接缝注册：把解算后的
 *  请求形状放进 `NodeRunInput.engineRequest`（宿主 → 执行器，不进清单），执行器优先读它。
 *  注册在模块加载时**无条件**发生 —— builder 只塑形、不派发：执行器缺席时调度器
 *  早在 `isNodeRunnable` 那道闸就拒绝了，走不到这里；按次注册反而会在
 *  `createBuiltinExecutionEngine`（每次运行一个实例）第二次调用时撞上重复注册。 */
nodeInputBuilderRegistry.register({
  kind: NODE_RED_RUNNER_KIND,
  build: ({ params, base }) => {
    const spec = readRequestSpec(params);
    return {
      ...base,
      prompt: "",
      skills: [],
      mcpServerNames: [],
      pluginNames: [],
      returnMode: "none",
      // `readRequestSpec` 对缺失路径返回 null；执行器自己要报那句明确错误，
      // 这里不抢先失败 —— 一份缺参数的节点在注册表里有执行器时，错误该由它说。
      ...(spec !== null ? { engineRequest: spec } : {}),
    };
  },
});

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

/** 【ARC-006 WF-INT · 桥 1】「引擎可用吗」的**注入点**。
 *
 *  `node-red` 是可选能力：没装/没起时它的 kind **不能**进执行器注册表（否则清单里
 *  出现一个永远跑不了的 kind）。而 `executionEngine.ts` 不能直接 import 生产注册表
 *  单例 —— `registry.ts` 会拖进 `dataRoot`（electron 的 `app.getPath`），而本模块被
 *  每一套无头 smoke 打包（`module-workflow-smoke` 用 AST 提取 `createBuiltinExecutionEngine`
 *  的注册表达式并在纯 node 里执行它）。所以判据做成**注入**：
 *
 *  - 生产在装配处（`main/index.ts`）调 `setWorkflowEngineStatusPort(() => workflowEngineRegistry.statusOf(id))`；
 *  - 套件注入假引擎状态（见 `execution-engine-smoke` §引擎执行器），不碰磁盘。
 *
 *  返回 `null` = **未知**（端口还没装、或引擎没注册）—— 与"未运行"同样处理：
 *  **fail-closed，不注册**。注册树在引擎第一次 running 之后出现，之后即使引擎停了
 *  也**不撤掉**（见 `createBuiltinExecutionEngine`）：撤掉会让一个正在跑的图在重启
 *  节点时从"引擎未运行"变成"没有执行器"，而前者才是用户能照着做的错误。
 */
export type WorkflowEngineStatusPort = (engineId: string) => EngineRuntimeStatus | null;

let workflowEngineStatusPort: WorkflowEngineStatusPort | null = null;

/** 装配引擎状态查询口（幂等；生产只在 `main/index.ts` 顶层调一次）。 */
export function setWorkflowEngineStatusPort(port: WorkflowEngineStatusPort | null): void {
  workflowEngineStatusPort = port;
}

/** 引擎此刻**可用**（running 且有端口）—— 读注入口；没装口一律不可用。 */
function workflowEngineUsable(engineId: string): boolean {
  if (workflowEngineStatusPort === null) return false;
  const status = workflowEngineStatusPort(engineId);
  return status !== null && status.state === "running" && status.port !== null;
}

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

/** Both the shared engine and runner's run-scoped engine use this registration.
 *
 *  【ARC-006 桥 1】第三方引擎（Node-RED）是**可选能力**：只有引擎此刻可用（注入的
 *  状态口说 running）才注册它的执行器。不可用时**不注册**，且 `node-red` **不在**
 *  `IMPLEMENTED_RUNNER_KINDS` 里 —— 于是 `isNodeRunnable` 对 `mcode.node-red` 为
 *  false，画布/检查器照常标"跑不了"，调度器也在 `isNodeRunnable` 那道闸明确拒绝，
 *  不会掉进模型兜底（那不是 fail-open，是**没有**执行器 —— 见 `ExecutionEngine.execute`
 *  的未知 kind 分支）。注册一次即保留：引擎随后停掉时，节点拿到的是代码里那句
 *  "引擎尚未运行 —— 请先启动它"（可照着做），而不是"没有能执行这种节点的执行器"。 */
export function createBuiltinExecutionEngine(): ExecutionEngine {
  const engine = new ExecutionEngine()
    .register(new CommandExecutor())
    .register(new CodeExecutor())
    .register(moduleExecutor());
  if (workflowEngineUsable(NODE_RED_ENGINE_ID)) {
    engine.register(nodeRedExecutor({
      // 惰性读取：start() 那一刻引擎可能已被用户停掉，执行器要报"未运行"而不是
      // 拿装配期的旧快照继续发请求。
      engine: {
        status: () =>
          workflowEngineStatusPort?.(NODE_RED_ENGINE_ID)
          ?? { engineId: NODE_RED_ENGINE_ID, state: "stopped", port: null, reason: null },
      },
      fetch: (request) => defaultNodeRedFetch(request),
    }));
  }
  return engine;
}

export const executionEngine = createBuiltinExecutionEngine();
