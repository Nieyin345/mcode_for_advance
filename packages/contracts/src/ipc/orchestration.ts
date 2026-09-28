/**
 * 编排域(run orchestration)的 IPC 契约 —— 运行史、触发器事实、监控三块。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。这里的类型是**渲染端能看到的形状**:主进程侧
 * 的同名结构(见 `main/orchestration/automationStatus.ts` 的 `AutomationTriggerFacts`
 * 与 `main/orchestration/runStore.ts` 的 `PersistedWorkflowRun`)**不 import 本文件**,
 * 靠结构化类型对表 —— 哪边多一个字段/改一个类型,赋值的那一行就编译不过,那正是
 * 镜像存在的意义(同 `AutomationRunStatus` 的做法)。
 *
 * 记忆(memory)的契约**不在这里**:存储、检索、维护共用的一份在 `../memory.ts`,
 * 渠道字符串也钉在那边(见 `MEMORY_LIST_CHANNEL` 等常量)。
 */
import { z } from "zod";
import type { TriggerKind } from "../nodeType.js";
import type { AutomationRunStatus } from "./workflow.js";

/* ── 运行史(runs.history)── */

/** 取某个对话的图运行历史(新的在前)。 */
export const RunsHistorySchema = z.object({
  sessionId: z.string().min(1),
  /** 最多几条。不给就用主进程的默认值。 */
  limit: z.number().int().min(1).max(50).optional(),
});
export type RunsHistoryInput = z.infer<typeof RunsHistorySchema>;

/**
 * 运行历史里的一次运行 —— `main/orchestration/runStore.ts` 的 `PersistedWorkflowRun`
 * **丢掉 snapshot 本体、换成一个计数**之后的轻量版:历史列表只关心"跑过几次、成没成、
 * 几步",整份快照(含每一步的产出全文)不该为了一行列表过 IPC。
 */
export interface PersistedWorkflowRunLite {
  runId: string;
  sessionId: string;
  workflowId: string;
  status: AutomationRunStatus;
  /** 这次运行什么时候开始的。 */
  createdAt: number;
  /** 最后一次更新(收尾时刻)。 */
  updatedAt: number;
  /** 图里**定过案**的节点数(存档读不回来的老运行 = 0 —— 那一行照样列出)。 */
  nodeCount: number;
}

/* ── 触发器事实(automation.statusAll)── */

/**
 * 一条自动化触发器的**事实状态**(AUTO-09):挂没挂上、为什么挂不上、最近一次什么
 * 时候跑的、最近一次为什么没跑成。`main/orchestration/automationStatus.ts` 那份
 * `AutomationTriggerFacts` 的镜像 —— 事实的**真相**在那边(内存里),这里只是
 * "过 IPC 的形状"。
 */
export interface AutomationTriggerFacts {
  /** `workflowId:nodeId`(与主进程侧 `automationTriggerKey` 同一个拼法)。 */
  key: string;
  workflowId: string;
  nodeId: string;
  /** 给界面看的名字(节点标题)。 */
  title: string;
  /** 触发方式。`"unknown"` = 参数里连触发方式都认不出来(多半是清单变了)。 */
  kind: TriggerKind | "unknown";
  /**
   * **用户在图上开着**这条触发器。缺席 = 开(老存档里没有这个键)。
   *
   * 界面靠它把「你自己关的」和「它坏了」分开说 —— 两者 `armed` 都是 `false`,
   * 光看 `armed` 分不清。
   */
  enabled?: boolean;
  /** 配置侧:这条触发器现在**自动响不响**(已经把 `enabled` 算进去了)。 */
  armed: boolean;
  /** `armed: false` 的原因(用户关掉了 / 参数解不开 / 项目不在了 / 目录监听失效)。 */
  detail?: string;
  /** 最近一次**真的起跑**的时刻(ms)。缺席 = 它从来没跑过。 */
  lastFireAt?: number;
  /** 最近一次「该跑而没跑成」的原因(上一次还在跑 / 项目不在了 / 起跑失败)。 */
  lastError?: string;
  lastErrorAt?: number;
  /**
   * 定时那一路:应用没开 / 机器睡着的那段时间里,它**本该响却一次都没响**的次数。
   *
   * 「错过不补跑」是设计(补五份昨天的日报没有意义),但**不补跑不等于不告诉人** ——
   * 在这个字段之前,那几天在界面上完全没有痕迹:`lastFireAt` 停在几天前,而那一行照旧
   * 写着「已挂上」,用户唯一的线索是"怎么没收到日报"。
   *
   * 真的跑成一次就清零(见主进程 `recordFired`)—— 它说的是「自上一次成功以来」。
   */
  missedCount?: number;
  /** 最近一次错过的那个时间点(ms)。 */
  lastMissedAt?: number;
}

/**
 * 「最近一次为什么没跑成」该不该显示。
 *
 * ⚠️ **不能只看 `lastError` 在不在。** 主进程那侧 `recordFired` 是**只增不改**的
 * (见 `automationStatus.ts` 类头那条不变量):它不会把 `lastError` 清掉。而重入跳过
 * ("上一次还在跑")这种东西,一条**经常**触发的自动化一两天就会攒下一条 —— 无条件显示
 * 的话,那条触发器上永远挂着一行红字说它"最近一次没跑成",而它其实一直在正常跑。
 * 用户消不掉它(除非删了重建),只能学会无视它。
 *
 * 判据是**谁的更近**:起跑之后,那次失败就成了旧账。同毫秒算"跑过了"(`<` 而不是
 * `<=`)—— 两个时刻都是调用方给的 `Date.now()`,同毫秒完全可能,而那种情况下判成
 * "还在失败"会让红字赖着不走。
 *
 * 放在契约里而不是各写一份:主进程记的事实(`automationStatus.ts` 的 `AutomationFacts`)
 * 与渲染端(设置页那一栏)读的是**同一份事实** —— 一处判"该显示"、另一处判"不该",
 * 这种分家只会在界面上显形,而且看起来像"主进程记错了"。(主进程自己不调用它:它只写
 * 事实,不决定要不要显示。)
 *
 * 返回那句话本身(而不是布尔):调用方要的就是它,少一层间接。
 */
export function latestFailureOf(facts: AutomationTriggerFacts): string | undefined {
  if (facts.lastError === undefined) return undefined;
  const at = facts.lastErrorAt;
  // 没记时刻(不该发生,但事实是外部来的)时照旧显示 —— 宁可多显示一句,也不静默吞掉。
  if (at === undefined) return facts.lastError;
  if (facts.lastFireAt !== undefined && facts.lastFireAt >= at) return undefined;
  return facts.lastError;
}

/**
 * 「这段时间漏了几次」该不该显示 —— 返回要显示的次数,`0` = 不显示。
 *
 * 和 {@link latestFailureOf} 同一个道理、同一处摆放:判据只能有一份,否则设置页说
 * 「漏了 3 次」、首屏说「一切正常」,而两边读的是同一条事实。
 *
 * 主进程 `recordFired` 已经会在真的跑成时清零,这里那道时刻比对是**第二道保险**:
 * 事实是从 IPC 过来的外部数据,而"起跑之后那笔旧账就该翻篇"这条规则,不该指望
 * 另一侧永远记得清。
 */
export function missedNoticeOf(facts: AutomationTriggerFacts): number {
  const count = facts.missedCount ?? 0;
  if (count <= 0) return 0;
  const at = facts.lastMissedAt;
  if (at !== undefined && facts.lastFireAt !== undefined && facts.lastFireAt >= at) return 0;
  return count;
}

/* ── 监控(monitoring.*)── */

/**
 * 监控总览(`monitoring.overview`)的**一次快照**:已收口工作流运行的成败与耗时汇总。
 * `main/monitoring/types.ts` 那份 `MonitoringOverview` 的镜像 —— 真相在那边(从持久化
 * 的 run summary 现算),这里只是"过 IPC 的形状";哪边漂了,handler 的返回值就对不上
 * preload 的签名。
 */
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

/** 取最近的运行摘要(新的在前)。 */
export const MonitoringRunsSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});
export type MonitoringRunsInput = z.infer<typeof MonitoringRunsSchema>;

/**
 * 监控列表里的一次已收口运行 —— `main/monitoring/types.ts` 的 `MonitoringRunSummary`
 * 的镜像(监控存储 NDJSON 里的一行;续跑沿用旧 runId,同 id 可能多行,查询取最新)。
 */
export interface MonitoringRunSummary {
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
  /** 收口的时刻。缺席 = 倒推(`startedAt + durationMs`)也拿得到同一个数,显式记下更诚实。 */
  endedAt?: number;
}

/** 一次运行里单个节点的定案摘要 —— `main/monitoring/types.ts` 同名类型的镜像。 */
export interface MonitoringNodeSummary {
  nodeId: string;
  /** 节点类型(事件里现成的 `nodeType`)。 */
  kind: string;
  /** 节点定案状态,透传 `NodeOutcomeStatus`(success/failed/cancelled/skipped/unselected)。 */
  status: string;
  /** 节点耗时:第一条进度事件到结果事件之间隔了多少毫秒。没有进度事件(比如
   *  上游失败直接跳过)就不知道 —— 缺席,而不是 0。 */
  durationMs?: number;
  /** 失败原因(事件里现成的 `WorkflowNodeResultEvent.error`)。 */
  error?: string;
}
