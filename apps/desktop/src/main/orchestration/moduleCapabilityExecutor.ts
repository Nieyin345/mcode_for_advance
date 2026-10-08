import { isAbsolute, resolve as resolveInCwd } from "node:path";
import {
  MODULE_CAPABILITY_RUNNER_KIND,
  ModuleWorkflowExecutionInputSchema,
} from "@contracts/moduleCapability";
import type { ModuleInvoke, ModuleReply, ModuleResult, ModuleTask, ModuleTaskRef } from "@contracts/modules";
import type { NodeOutcome } from "@contracts/nodeType";
import type { ExecutionContext } from "./executionContext.js";
import type { ExecutorCapabilities, NodeExecutor } from "./executorRegistry.js";

/**
 * **模块能力节点的执行器**(UI-MODULES-P2 / 任务 03)。
 *
 * 它把 `ModuleHost` 的一次受控调用翻译成一个普通的 {@link NodeOutcome} —— 下游节点
 * 和结果卡片看到的东西,与 `code` / `command` 节点没有区别。
 *
 * ## 它**不**做的四件事(都是刻意的)
 *
 * 1. **不做授权。** 真实路径、已登记工作区、symlink 逃逸、内置登记、只读类别,全部由
 *    宿主的 `invokeForWorkflow` 判定。这里再写一套等于给同一件事留两个真相,而两份
 *    判断迟早会漂移 —— 漂移的表现是"某条路径在菜单里被拒、在工作流里却放行"。
 * 2. **不读 `WorkflowNode.params`。** 参数解析与变量展开是调度器那一侧的职责
 *    (任务 05),执行器只认已经规范化好的 `input.moduleCall`。
 * 3. **不生成 `requestId`。** 它是**一次派发**的身份,由宿主侧产生(见
 *    `docs/parallel-ui-modules/interface-v2.md` 第 5 节)。执行器在一次 `execute()`
 *    里原样复用它 —— 轮询和传输重试都不换,于是宿主的去重天然生效;而"明确重跑/
 *    循环下一轮"拿到的是新的身份,于是真的会重跑。
 * 4. **不建第二套任务表。** 宿主已经有 job 表、并发上限、30 秒超时和淘汰策略,这里
 *    只是等它。
 *
 * ## 为什么要轮询
 *
 * 宿主**没有推送通道**:拿到句柄之后只能 `task(ref)` 同步查。所以这里是有上限的轮询
 * (退避到 {@link DEFAULT_MAX_POLL_INTERVAL_MS}),而且上限**必须大于宿主自己的 30 秒
 * 超时** —— 否则执行器永远抢在宿主判定之前先报错,用户看到的失败原因是错的。
 */
export interface WorkflowModuleHostPort {
  invokeForWorkflow(input: ModuleInvoke): Promise<ModuleReply>;
  task(ref: ModuleTaskRef): ModuleTask;
  cancel(ref: ModuleTaskRef): ModuleTask;
}

export interface ModuleCapabilityExecutorOptions {
  /**
   * 宿主。**允许传一个工厂** —— 生产侧注入 `getModuleHost`,懒加载语义不能因为构造
   * 一个执行器就被破坏(导入一个测试文件不应该打开真实数据根)。
   */
  host: WorkflowModuleHostPort | (() => WorkflowModuleHostPort);
  /** 首次轮询间隔,之后指数退避。仅测试注入。 */
  pollIntervalMs?: number;
  /** 退避上限。仅测试注入。 */
  maxPollIntervalMs?: number;
  /** 等待终态的总上限。**默认值大于宿主的 30 秒任务超时**,理由见类注释。 */
  maxWaitMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_MAX_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_WAIT_MS = 45_000;
/** 摘要长度上限,与冻结稿第 6 节一致。**只截摘要,不截 `outputs`。** */
const SUMMARY_MAX_CHARS = 2000;

const failedOutcome = (error: string): NodeOutcome => ({ status: "failed", summary: "", error });
const cancelledOutcome = (): NodeOutcome => ({ status: "cancelled", summary: "" });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 可被取消打断的等待。**计时器与监听器都在同一处摘干净**,不留悬挂。 */
const waitFor = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((done) => {
    if (ms <= 0 || signal.aborted) {
      done();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });

/** Built-in executor for `module-capability` workflow nodes. */
export class ModuleCapabilityExecutor implements NodeExecutor {
  readonly kind = MODULE_CAPABILITY_RUNNER_KIND;
  readonly capabilities: ExecutorCapabilities = {
    supportsProgress: true,
    supportsCancellation: true,
    supportsArtifacts: false,
  };

  /**
   * 这一刻**本执行器**持有的宿主任务。调度器的 `cancel` 钩子按它找回句柄 ——
   * 于是"只取消自己的任务"是结构上的保证,而不是一句约定。
   */
  private readonly active = new Map<string, ModuleTaskRef>();

  constructor(private readonly options: ModuleCapabilityExecutorOptions) {}

  private hostOf(): WorkflowModuleHostPort {
    const host = this.options.host;
    return typeof host === "function" ? host() : host;
  }

  private static keyOf(context: ExecutionContext): string {
    return `${context.metadata.runId}:${context.metadata.nodeId}`;
  }

  async execute(context: ExecutionContext): Promise<NodeOutcome> {
    // 05 交来的执行输入必须已经是合法的。这里再过一次冻结 schema 是 fail-closed:
    // 缺 requestId、混进 projectPath/trusted 之类的东西一律不发往宿主。
    const parsed = ModuleWorkflowExecutionInputSchema.safeParse(context.input.moduleCall);
    if (!parsed.success) {
      if (context.input.moduleCall === undefined) {
        return failedOutcome("模块能力节点没有配置要调用的能力");
      }
      const first = parsed.error.issues[0];
      return failedOutcome(`模块能力执行入参不合法:${first?.message ?? "未知问题"}`);
    }
    const call = parsed.data;
    const { signal } = context.input;

    // 预取消：一次宿主调用都不发（interface-v2 §6）。
    if (signal.aborted) return cancelledOutcome();

    // 工作区来自**可信的** ExecutionContext.cwd,永远不从节点参数取。相对路径相对它
    // 解析;真实路径/已登记根/普通文件的判定仍然是宿主的事。
    const invocation: ModuleInvoke = {
      moduleId: call.moduleId,
      contributionId: call.contributionId,
      requestId: call.requestId,
      resource: {
        projectPath: context.cwd,
        path: isAbsolute(call.path) ? call.path : resolveInCwd(context.cwd, call.path),
      },
    };

    let host: WorkflowModuleHostPort;
    try {
      host = this.hostOf();
    } catch (error) {
      return failedOutcome(`模块宿主不可用:${messageOf(error)}`);
    }

    let reply: ModuleReply;
    try {
      reply = await host.invokeForWorkflow(invocation);
    } catch (error) {
      // 未知贡献、用户模块、越界路径、并发超限……宿主的拒绝就是这一步的失败原因。
      return failedOutcome(messageOf(error));
    }

    if (reply.type === "result") {
      return signal.aborted ? cancelledOutcome() : ModuleCapabilityExecutor.succeed(reply.value);
    }

    const ref: ModuleTaskRef = { moduleId: invocation.moduleId, taskId: reply.task.id };
    const key = ModuleCapabilityExecutor.keyOf(context);
    this.active.set(key, ref);
    try {
      // **迟到句柄**:取消发生在 invoke 还没返回的窗口里。句柄现在才到手,必须立刻
      // 收掉,否则留下一个没人管的活动任务(它还占着宿主 4 个并发名额之一)。
      if (signal.aborted) {
        this.safeCancel(host, ref);
        return cancelledOutcome();
      }
      return await this.awaitTask(host, ref, reply.task, context, signal);
    } finally {
      this.active.delete(key);
    }
  }

  /** 调度器的显式取消钩子。只动本执行器登记过的句柄。 */
  cancel(context: ExecutionContext): void {
    const ref = this.active.get(ModuleCapabilityExecutor.keyOf(context));
    if (ref === undefined) return;
    let host: WorkflowModuleHostPort;
    try {
      host = this.hostOf();
    } catch {
      return;
    }
    this.safeCancel(host, ref);
  }

  private async awaitTask(
    host: WorkflowModuleHostPort,
    ref: ModuleTaskRef,
    first: ModuleTask,
    context: ExecutionContext,
    signal: AbortSignal,
  ): Promise<NodeOutcome> {
    let snapshot = first;
    let lastPercent = -1;
    const report = context.emitProgress;
    const emit = (task: ModuleTask): void => {
      if (report === undefined) return;
      // 宿主的 progress 是 **0～1**,ExecutionProgress.percent 是 **0～100**。
      // 量纲不同,必须显式换算 —— 直传的话进度条永远停在 1%。
      if (!Number.isFinite(task.progress)) return;
      const percent = Math.min(100, Math.max(0, task.progress * 100));
      if (percent === lastPercent) return;
      lastPercent = percent;
      report({ percent });
    };
    emit(snapshot);

    const deadline = Date.now() + (this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    const maxInterval = this.options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    let interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    while (snapshot.status === "running") {
      if (signal.aborted) {
        this.safeCancel(host, ref);
        return cancelledOutcome();
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.safeCancel(host, ref);
        return failedOutcome("模块能力任务在执行器截止时间之前没有结束");
      }
      await waitFor(Math.min(interval, remaining), signal);
      interval = Math.min(interval * 2, maxInterval);
      try {
        snapshot = host.task(ref);
      } catch (error) {
        // 任务被淘汰 / 应用重启后内存里已经没有它。**显式失败,不静默重跑** ——
        // 那一次调用的副作用是否发生过,这里无从得知。
        return failedOutcome(`模块能力任务已经不可用(可能被淘汰或应用重启):${messageOf(error)}`);
      }
      emit(snapshot);
    }

    if (snapshot.status === "completed") {
      if (signal.aborted) return cancelledOutcome();
      const result = snapshot.result;
      if (result === undefined) {
        return failedOutcome("模块能力任务完成了但没有结果");
      }
      return ModuleCapabilityExecutor.succeed(result);
    }
    if (snapshot.status === "cancelled") return cancelledOutcome();
    return failedOutcome(snapshot.error ?? "模块能力任务失败");
  }

  /** 取消是**尽力而为**:任务可能已经定案或被淘汰,那不是本节点的失败原因。 */
  private safeCancel(host: WorkflowModuleHostPort, ref: ModuleTaskRef): void {
    try {
      host.cancel(ref);
    } catch {
      /* 已定案 / 已淘汰 —— 没有需要收掉的活动任务 */
    }
  }

  private static succeed(result: ModuleResult): NodeOutcome {
    return {
      status: "success",
      // 摘要会被拼进下游指令,所以要截;`outputs` 是给下游取值的,**不截**。
      summary: JSON.stringify(result).slice(0, SUMMARY_MAX_CHARS),
      outputs: { ...result },
    };
  }
}
