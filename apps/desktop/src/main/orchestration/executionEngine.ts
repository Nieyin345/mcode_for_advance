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
 *  `node-red` 是**可选能力**：没装/没起时它的执行器不注册（否则这条节点拿到的是
 *  "没有执行器"，而不是一句能照着做的"去启动引擎"）。而 `executionEngine.ts` 不能
 *  直接 import 生产注册表单例 —— `registry.ts` 会拖进 `dataRoot`（electron 的
 *  `app.getPath`），而本模块被每一套无头 smoke 打包（`module-workflow-smoke` 用 AST
 *  提取 `createBuiltinExecutionEngine` 的注册表达式并在纯 node 里执行它）。所以判据
 *  做成**注入**：
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
  /** 「此刻能不能注册」要**晚于构造**才判得出来的执行器(见 `registerWhenAvailable`)。 */
  private readonly deferred = new Set<() => NodeExecutor | null>();

  constructor(private readonly registry = new NodeExecutorRegistry()) {}

  register(executor: NodeExecutor): this {
    this.registry.register(executor);
    return this;
  }

  /**
   * 注册一个**可用性晚于构造才成立**的执行器。
   *
   * 条件:执行器的前置状态(如可选引擎在不在跑)由宿主在**构造之后**注入,构造那一刻
   * 答不出来。`create` 返回 `null` = 此刻仍不可用 —— **不注册**,但留在队列里,下一次
   * 观察注册表时再问;返回执行器 = 注册并移出队列(注册一次即保留,与 `register` 同语义)。
   *
   * 后果(不这样做的代价):模块级单例在 `main/index.ts` 调用
   * `setWorkflowEngineStatusPort` **之前**就已经构造完(W4 探针实测:单例的 `kinds()`
   * 永远缺 `node-red`,而同一时刻新建的引擎有),读单例的预检入口会拿到一份错误的
   * 执行器清单。
   *
   * 重复注册不靠调用方自律:`settleDeferred` 先移出队列再注册,而注册表本身对
   * 同名 kind 抛错(第二道闸)。
   */
  registerWhenAvailable(create: () => NodeExecutor | null): this {
    this.deferred.add(create);
    return this;
  }

  /** 每次观察注册表前,逐个重试延迟注册;仍返回 `null` 的留在队列里等下次。 */
  private settleDeferred(): void {
    if (this.deferred.size === 0) return;
    for (const create of [...this.deferred]) {
      const executor = create();
      if (executor === null) continue;
      // 先移出再注册:注册抛错时异常照常上抛(不静默吞),队列不保留半注册状态。
      this.deferred.delete(create);
      this.registry.register(executor);
    }
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
    this.settleDeferred();
    return this.registry.has(kind);
  }

  kinds(): string[] {
    this.settleDeferred();
    return this.registry.kinds();
  }

  async execute(context: ExecutionContext): Promise<NodeOutcome> {
    // 派发前先补齐延迟注册:构造后才可用的执行器不该被当成"没有执行器"落进兜底。
    this.settleDeferred();
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
 *  状态口说 running）才注册它的执行器。不可用时**不注册**；`node-red` **在**
 *  `IMPLEMENTED_RUNNER_KINDS` 里（执行方式已实现，那张表不回答"这台机器装没装"），
 *  引擎缺席由清单 `mcode.node-red` 的 executor `requirements` 表达 —— 调度器的能力预检
 *  对**本次运行**真正注册的执行器列表（`runEngine.kinds()`）求值，缺了就以
 *  「缺少执行器「node-red」」明确失败。这一道闸**必须在调度器预检里**：`ExecutionEngine.execute`
 *  对未注册的 kind 会落模型兜底（只有 module-capability 例外），不能指望执行引擎替它拦。
 *  注册一次即保留：引擎随后停掉时，节点拿到的是代码里那句"引擎尚未运行 —— 请先启动它"
 *  （可照着做），而不是"没有能执行这种节点的执行器"。
 *
 *  **判据的时机是「观察注册表那一次」，不是「构造那一刻」** —— 见下面
 *  `registerWhenAvailable` 那段为什么不能写成构造期 `if`。
 *  （`workflows/W4` 实测：模块单例在端口注入前构造，构造期判据恒假。） */
export function createBuiltinExecutionEngine(): ExecutionEngine {
  const engine = new ExecutionEngine()
    .register(new CommandExecutor())
    .register(new CodeExecutor())
    .register(moduleExecutor());
  // **不能在这里 `if (workflowEngineUsable(...))`**：模块级单例由
  // `export const executionEngine = createBuiltinExecutionEngine()` 在**模块加载时**
  // 构造，而 `main/index.ts` 要到更晚才调 `setWorkflowEngineStatusPort` —— 构造那一刻
  // 端口必然还是 null，条件恒假，单例永远不注册 node-red（W4 探针实测：单例
  // `kinds()` 缺 node-red，同一时刻新建的引擎有）。于是读单例的自动化预检 / 场景预检
  // 谎报「缺执行器」，而那条流在运行期其实跑得起来。
  // `registerWhenAvailable` 把判据挪到**观察注册表时**：端口没装 / 引擎没跑时仍不注册
  // （fail-closed 不变），装好并 running 之后的下一次 `kinds()`/`has()`/`execute()`
  // 补上。按次新建的引擎（runner）行为不变 —— 它们构造时端口早已就位。
  engine.registerWhenAvailable(() =>
    workflowEngineUsable(NODE_RED_ENGINE_ID)
      ? nodeRedExecutor({
          // 惰性读取：start() 那一刻引擎可能已被用户停掉，执行器要报"未运行"而不是
          // 拿装配期的旧快照继续发请求。
          engine: {
            status: () =>
              workflowEngineStatusPort?.(NODE_RED_ENGINE_ID)
              ?? { engineId: NODE_RED_ENGINE_ID, state: "stopped", port: null, reason: null },
          },
          fetch: (request) => defaultNodeRedFetch(request),
        })
      : null);
  return engine;
}

export const executionEngine = createBuiltinExecutionEngine();
