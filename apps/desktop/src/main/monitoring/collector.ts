/**
 * 监控采集器 —— 订运行事件流,攒出"一次运行长什么样",收口时落一条摘要。
 *
 * ## 事件从哪儿来(为什么是 mobileEventBus)
 *
 * 工作流的节点事件(`workflow.node.*`)由 runner 用 `broadcastRuntimeEvent` 发,
 * 而那条路**只走两处**:渲染端的 `sendToRenderer` 和 **`mobileEventBus`** ——
 * `runtimeManager.subscribe` 的观察者收不到它们(runner 里 `emitExternal` 与
 * `broadcastRuntimeEvent` 的那段注释说的就是这件事)。运行收口用的 `turn.done`
 * 走 `emitExternal`,它同样广播进 mobileEventBus。所以**订阅这一个口,一次运行
 * 的开始(第一条带 runId 的节点事件)、每一步的定案、收口,全都看得见** ——
 * 不建新总线、不碰 runner。
 *
 * ## 它维护什么状态
 *
 * 「活跃 run 登记」:`runId → {sessionId, startedAt, nodes}`。进程重启后这份
 * 登记是空的 —— 正在跑的那次运行收不了口(可接受);已收口的都在 NDJSON 里。
 * 收口信号是**父会话**上的 `turn.done`(节点会话自己的 turn.done 的 sessionId
 * 不在登记里,自然被忽略;普通聊天的 turn.done 同样)。
 *
 * ## 失败语义(任务的红线)
 *
 * 采集是**旁路**:这里出的任何错都不能影响工作流运行本体。所以 `handle`
 * 顶层吞错记日志,事件字段全部防御式读取,`lookupWorkflowId`(查会话行拿
 * workflowId)单独包 try/catch —— 数据库没起来时它抛,不能把采集带下去。
 */
import type { RuntimeEvent, TurnDoneEvent } from "@contracts/runtime";
import { mobileEventBus } from "@main/mobile/MobileEventBus.js";
import { log } from "@main/lib/logger.js";
import { appendRunSummary } from "./store.js";
import type { MonitoringNodeSummary, MonitoringRunSummary } from "./types.js";

/** 采集器的依赖。全走注入,本目录里没有 electron 也没有数据库 —— 无头脚本喂得进。 */
export interface MonitoringCollectorDeps {
  /** 数据根(生产传 `dataRoot`;摘要写到 <root>/monitoring/runs.ndjson)。 */
  root: () => string;
  /** 会话行 → 工作流 id。事件本身不带 workflowId,只能查会话;查不到给空串。 */
  lookupWorkflowId?: (sessionId: string) => string | undefined;
}

/** 一个进行中的运行 —— 与 runner 里那张 `runs` 表一一对应(一个对话同时最多一张图)。 */
interface ActiveRunRecord {
  runId: string;
  sessionId: string;
  /** 登记那一刻查到的会话工作流 id;查不到是空字符串(诚实于"不知道")。 */
  workflowId: string;
  startedAt: number;
  /** nodeId → 定案摘要。**覆盖式 upsert**:回头重跑同一步,后者为准。 */
  nodes: Map<string, MonitoringNodeSummary>;
  /** nodeId → 这一步第一条进度事件的时刻(耗时 = 结果时刻 − 它,尽力而为)。 */
  nodeStarts: Map<string, number>;
}

export class MonitoringCollector {
  private active = new Map<string, ActiveRunRecord>();
  /** sessionId → 挂在这个对话上的活跃 runId(收口按 sessionId 找运行)。 */
  private runsBySession = new Map<string, Set<string>>();

  constructor(private readonly deps: MonitoringCollectorDeps) {}

  /**
   * 事件入口。**永远不抛** —— 采集器出的事故只配一行日志,不该越出这个函数。
   * 生产走 `startMonitoringCollector` 的订阅;无头脚本可以直接拿实例喂假事件。
   */
  handle(event: RuntimeEvent): void {
    try {
      switch (event.type) {
        case "workflow.node.progress":
          this.onNodeProgress(event);
          break;
        case "workflow.node.choice":
          // 岔路口不进 nodes(它没有定案),但它证明这次运行还活着 —— 登记。
          this.ensureActive(event.runId, event.sessionId, Date.now());
          break;
        case "workflow.node.result":
          this.onNodeResult(event);
          break;
        case "turn.done":
          this.onTurnDone(event);
          break;
        default:
          // 其余事件(text.delta / tool.use / …)与监控无关,白来一趟是常态
          break;
      }
    } catch (err) {
      const kind = (event as { type?: unknown } | null)?.type;
      log.warn(`monitoring: 采集器处理事件出错(type=${String(kind)}): ${(err as Error).message}`);
    }
  }

  /** 登记一个活跃 run(已存在就原样返回 —— 续跑沿用旧 id,登记不重置)。 */
  private ensureActive(runId: string, sessionId: string, now: number): void {
    // 畸形事件(缺 id)不登记 —— 一条没有身份的运行没法收口也没法查
    if (typeof runId !== "string" || runId.length === 0) return;
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const existing = this.active.get(runId);
    if (existing) return;

    let workflowId = "";
    try {
      workflowId = this.deps.lookupWorkflowId?.(sessionId) ?? "";
    } catch (err) {
      // 会话行查不到(库还没起来/行被删了)不拦着登记 —— workflowId 记空串
      log.warn(`monitoring: 会话 ${sessionId} 的工作流 id 查不到: ${(err as Error).message}`);
    }
    const record: ActiveRunRecord = {
      runId,
      sessionId,
      workflowId,
      startedAt: now,
      nodes: new Map(),
      nodeStarts: new Map(),
    };
    this.active.set(runId, record);
    const bucket = this.runsBySession.get(sessionId) ?? new Set<string>();
    bucket.add(runId);
    this.runsBySession.set(sessionId, bucket);
  }

  /** 节点开跑:登记活跃 run + 记下这一步的起点(结果事件来时好算耗时)。 */
  private onNodeProgress(e: Extract<RuntimeEvent, { type: "workflow.node.progress" }>): void {
    const now = Date.now();
    this.ensureActive(e.runId, e.sessionId, now);
    // 只记第一次:回头/重试会让同一 nodeId 反复发进度,起点还是最早那次
    if (!this.active.get(e.runId)?.nodeStarts.has(e.nodeId)) {
      this.active.get(e.runId)?.nodeStarts.set(e.nodeId, now);
    }
  }

  private onNodeResult(e: Extract<RuntimeEvent, { type: "workflow.node.result" }>): void {
    const now = Date.now();
    this.ensureActive(e.runId, e.sessionId, now);
    const record = this.active.get(e.runId);
    if (!record) return;

    const startedAt = record.nodeStarts.get(e.nodeId);
    if (startedAt === undefined) record.nodeStarts.set(e.nodeId, now);
    const node: MonitoringNodeSummary = {
      nodeId: typeof e.nodeId === "string" ? e.nodeId : String(e.nodeId),
      kind: typeof e.nodeType === "string" ? e.nodeType : "",
      status: typeof e.status === "string" ? e.status : String(e.status),
      // 进度事件来过才有耗时;没有(直接跳过/取消的节点)就缺席,不给 0
      ...(startedAt !== undefined ? { durationMs: Math.max(0, now - startedAt) } : {}),
      ...(typeof e.error === "string" ? { error: e.error } : {}),
    };
    record.nodes.set(node.nodeId, node);
  }

  /** 收口:这个对话上登记过的运行,写盘、摘牌。 */
  private onTurnDone(e: TurnDoneEvent): void {
    const runIds = this.runsBySession.get(e.sessionId);
    if (!runIds || runIds.size === 0) return;
    this.runsBySession.delete(e.sessionId);
    const endedAt = typeof e.endedAt === "number" ? e.endedAt : Date.now();
    for (const runId of runIds) {
      const record = this.active.get(runId);
      if (!record) continue;
      this.active.delete(runId);
      appendRunSummary(this.deps.root(), {
        runId: record.runId,
        workflowId: record.workflowId,
        sessionId: record.sessionId,
        status: runStatusOf(e.reason, record.nodes.values()),
        startedAt: record.startedAt,
        durationMs: Math.max(0, endedAt - record.startedAt),
        nodes: [...record.nodes.values()],
        endedAt,
      });
    }
  }
}

/**
 * 运行终态。优先级:`turn.done` 的 reason 先说话(用户按停 → cancelled,就算
 * 前面有节点失败也是取消),`error` 收口按失败;都不沾边才看节点里有没有
 * failed —— 调度器把节点失败降级成自己的失败后照常 `end_turn` 收口。
 */
function runStatusOf(reason: string, nodes: Iterable<MonitoringNodeSummary>): string {
  if (reason === "interrupted") return "cancelled";
  if (reason === "error") return "failed";
  for (const node of nodes) {
    if (node.status === "failed") return "failed";
  }
  return "success";
}

/**
 * 生产装配:订阅广播总线,返回退订函数(进程生命周期内不会退,签名对称而已)。
 * 重复调用会挂第二个采集器 —— 同一份事件会写两遍盘,调用方(注册 IPC 的那处)
 * 用模块级标记保证只调一次。
 */
export function startMonitoringCollector(deps: MonitoringCollectorDeps): () => void {
  const collector = new MonitoringCollector(deps);
  return mobileEventBus.subscribe((e) => collector.handle(e));
}
