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
  /** 配置侧:这条触发器现在**能不能被触发**。 */
  armed: boolean;
  /** `armed: false` 的原因(参数解不开 / 项目不在了 / 目录监听失效)。 */
  detail?: string;
  /** 最近一次**真的起跑**的时刻(ms)。缺席 = 它从来没跑过。 */
  lastFireAt?: number;
  /** 最近一次「该跑而没跑成」的原因(上一次还在跑 / 项目不在了 / 起跑失败)。 */
  lastError?: string;
  lastErrorAt?: number;
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
