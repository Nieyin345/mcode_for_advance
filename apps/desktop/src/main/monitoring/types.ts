/**
 * 监控面板的数据形状(设置/仪表盘那一侧的只读查询)。
 *
 * ## 边界说明
 *
 * 这里的两个接口是 v2 计划(§4-G6)冻结的形状。它们最终应该搬进
 * `@contracts/ipc`(由 contracts 的 owner 统一定义,preload 也要引用同一份);
 * 在那边就位之前先住在这里 —— **只加可选字段,不改冻结字段**,gate 时对齐。
 *
 * 与 `@contracts/ipc/usage.ts`(用量统计)是两回事:那份聚合的是**对话回合**的
 * token/花费;这里聚合的是**工作流运行**的成败与耗时。
 */

/** 仪表盘顶上的那块汇总。全部从持久化的 run summary 现算,不落第二份。 */
export interface MonitoringOverview {
  /** 已收口的运行总数(不含重启前丢掉的进行中运行 —— 活跃登记不落盘)。 */
  totalRuns: number;
  /** 收成 `success` 的次数。 */
  succeeded: number;
  /** 收成 `failed` 的次数。 */
  failed: number;
  /** 平均耗时(毫秒)。拿不到耗时的运行不进平均;一条都没有时是 0。 */
  avgDurationMs: number;
  /** 最近一次失败发生的时刻(该运行收口的那一刻)。没有失败就不带。 */
  lastErrorAt?: number;
  /** 最近一次失败里第一个失败节点说出的原因。没有失败就不带。 */
  lastErrorMessage?: string;
}

/** 一次已收口的工作流运行 —— 监控存储里的一行(NDJSON 的一行)。 */
export interface MonitoringRunSummary {
  /** 一次图执行的 id(续跑沿用旧 id,存储里可能因此有同 id 的多行 —— 查询取最新)。 */
  runId: string;
  /** 跑的是哪张工作流。会话行查不到(比如被删了)时是空字符串。 */
  workflowId: string;
  /** 发起这次运行的对话。 */
  sessionId: string;
  /** 运行终态:`success` / `failed` / `cancelled`(开放字符串,随事件流演进)。 */
  status: string;
  /** 这一轮开跑的时刻(第一条带这个 runId 的事件到达时记下)。 */
  startedAt: number;
  /** 从开跑到收口的毫秒数。 */
  durationMs: number;
  /** 定过案的节点,按定案顺序。 */
  nodes: MonitoringNodeSummary[];
  /**
   * 收口的时刻。**本文件对冻结形状的扩展**(可选,gate 时一并搬进 contracts):
   * 汇总"最近一次失败发生在什么时候"需要它,拿 `startedAt + durationMs` 倒推
   * 也能得到同一个数,但显式记下比倒推诚实。
   */
  endedAt?: number;
}

/** 一次运行里单个节点的定案摘要。 */
export interface MonitoringNodeSummary {
  nodeId: string;
  /** 节点类型(事件里现成的 `nodeType`)。 */
  kind: string;
  /** 节点定案状态,透传 `NodeOutcomeStatus`(success/failed/cancelled/skipped/unselected)。 */
  status: string;
  /** 节点耗时:第一条进度事件到结果事件之间隔了多少毫秒。没有进度事件(比如
   *  上游失败直接跳过)就不知道 —— 缺席,而不是 0。 */
  durationMs?: number;
  /**
   * 失败原因。**本文件对冻结形状的扩展**(可选):汇总的 `lastErrorMessage`
   * 与仪表盘的排障都靠它,事件里现成(`WorkflowNodeResultEvent.error`)。
   */
  error?: string;
}
