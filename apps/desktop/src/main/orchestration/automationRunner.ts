import { automationOriginOf, readAutomationEventChain, EVENT_CHAIN_PREFIX, EVENT_CHAIN_LIMIT } from "./automationEventOrigin.js";
/**
 * **自动化的后台执行器** —— 把触发器节点上那句"什么情况下起一次运行"真正挂起来。
 *
 * ## 它和 HookRunner 是同一种东西
 *
 * 两个都是"挂在 `runtimeManager.subscribe` 上、按条件起一次活"的后台件,所以那三条
 * 不变量照抄一遍(见 `hooks/HookRunner.ts` 文件头):① **绝不把异常抛回事件流**;
 * ② **同一条同时只跑一次**;③ **失败只记日志**。
 *
 * ## 挂法与不变量(逐类)
 *
 * | 触发方式 | 怎么挂 | 不变量 |
 * |---|---|---|
 * | 手动 | **什么都不挂** —— 只在列表上点「立刻运行一次」时找得到它 | —— |
 * | 定时 | 一个**全局 30 秒只读 ticker**(`unref`),把全部定时触发器的 cron 求一遍 | 应用没开就不触发;错过的时间点**不补跑**(D13);同一分钟只跑一次,而这条记忆**跨重启**(见 `onTick` / `rememberLastMinute`) |
 * | 文件变化 | 每个**项目目录只 `fs.watch(dir, {recursive:true})` 一次**,多个触发器共享(同 `lib/walkCache.ts`) | 事件先等 `WATCH_SETTLE_MS` 再按各自的合并窗口收口;载荷里**只留还存在的文件**(见 `existingFilesOf`);目录不存在要**记日志**,不静默 |
 * | 事件发生时 | 复用既有事件流 + `HOOK_EVENT_OF` + `createEventSubjects()` | **不忽略来自本自动化自己会话的事件**(见下) |
 *
 * ## 事实状态(AUTO-09)
 *
 * 每条触发器「挂没挂好 / 最近一次跑 / 最近一次为什么没跑成」记在 `automationStatus.ts`
 * 的 `AutomationFacts` 里,`statusOf` / `statusAll` 是它的读口。挂载侧跟着 reload 重建,
 * 运行侧只增不改 —— 界面那一栏的事实来源是它,不是从运行史再猜一遍:一条挂不上、从来
 * 没跑过的自动化,运行史是空的,但这里说得出为什么。
 *
 * ## 自身事件的有限续跑
 *
 * 「上一轮完成后再跑一轮」仍是合法用途，但忙碌检查不等于循环保护：收尾事件
 * 可能在 active run 解除后到达。因此可识别的自身/所属节点事件共享每工作流10次
 * 派发额度（跨触发器、跨项目），只有明确手动起跑重置。计数保存到 settings。
 * 自动化来源链保存在后台会话上，回到链上任一工作流也使用同一额度；普通单向链
 * 不计入额度。去抖/重试保存事件到达时的链，混合批次剥离循环部分时也剥离它的链。
 * 外部事件不受此额度限制，也不重置它；混合批次含自身事件时仍计入额度。
 * 文件监听及无来源的系统事件无法据此归因，不声称覆盖任意事件链循环。
 *
 * ## 后台会话:按自动化与项目复用(D10)
 *
 * 运行时落在一条专用的隐藏会话(`kind: "automation"`,按 `workflowId + projectId` 找、同项目复用不重建)
 * 里。这样**运行存档天然分得开**(`workflow_runs` 本来就按会话索引),不需要新表新列;
 * 而那条会话的流水不进任何界面(`RuntimeManager` 按会话种类拦住了),运行历史是用户
 * 事后唯一读得到的东西。
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cronMatches } from "@contracts/cron";
import { HOOK_EVENT_OF, eventItemFactsOf, matchesAnyGlob, matchesGlobList, addToFileBacklog, capOldest, classifyFileChange, reconcileFileChangeKind, shouldIgnoreWatchPath, isWithinWatchRoot, type FileChange, type FileChangeKind, type HookEvent } from "@contracts/hook";
import { defaultProviderId } from "@main/providers/defaultProvider.js";
import {
  NODE_COMMAND_PARAM_KEY,
  NODE_MODEL_PARAM_KEY,
  NODE_PROMPT_PARAM_KEY,
  NODE_TRIGGER_PROJECT_PARAM_KEY,
  NODE_TRIGGER_TASK_PARAM_KEY,
  parseTriggerSpec,
  providerIdOf,
  triggerEnabledOf,
  triggerKindOf,
  type NodeTypeManifest,
  type TriggerSpec,
} from "@contracts/nodeType";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import type { WorkflowDoc, WorkflowEngine } from "@contracts/workflow";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { createEventSubjects, fileSubjects } from "@main/hooks/eventSubjects.js";
import { log } from "@main/lib/logger.js";
import { ProjectRepo, SessionRepo, SettingRepo, SYSTEM_AUTOMATION_PROJECT_ID } from "@main/store/repositories.js";
// 【MC-051】定时触发派发前要把去重记录**同步**落盘,才允许外部副作用发生。
// 【ARC-005】落盘走**结构化**的 `commitNow()` —— 只有 `DURABLE` 才算成功(判据 `isDurable`,
// 与 `runStore.saveRun` / `settingsTransfer` 同一份),不是旧的"失败即抛";非 durable 时连
// **内存表那一行**一起回滚(见 `rollbackSettingRow`),不留"调用方以为没写成、磁盘却多一行"的幻影。
import { commitNow } from "@main/store/db.js";
import { isDurable } from "@contracts/commit";
import { uid } from "@main/utils.js";
import { describeTriggerPayload, mergeEventPayload, payloadFactsOf, type TriggerPayload } from "./automationPayload.js";
import {
  AutomationFacts,
  automationTriggerKey as triggerKey,
  missedMinutesSince,
  shouldFireThisMinute,
  triggerSeedOf,
  triggerSpecKeyOf,
  watcherDirsOf,
  type AutomationFactsSeed,
  type AutomationTriggerFacts,
} from "./automationStatus.js";
import {
  claimCancelledReason,
  claimFailureReason,
  claimRecoveryReason,
  claimStatusOfRunOutcome,
  isTerminalClaimStatus,
  isTriggerClaims,
  pendingClaims,
  pruneClaims,
  runOutcomeOfStatus,
  scheduleClaimId,
  triggerKeyOfClaim,
  type AutomationRunOutcome,
  type TriggerClaim,
} from "./triggerClaim.js";
import { getWorkflow, listWorkflows, saveWorkflow } from "./library.js";
import { workflowSaveVersion } from "./workflowSaveVersion.js";
import { workflowReviewError, workflowRevision } from "./workflowTrust.js";
import { loadNodeTypes } from "./nodeTypes.js";
import { setWorkflowReloader } from "./reloadRequest.js";
import { hasActiveRun, startWorkflowRun } from "./runner.js";
import {
  createInMemoryExecutorOwnership,
  sharedExecutorOwnership,
  type ExecutorOwnershipRegistry,
} from "@main/workflowEngines/executorOwnership.js";
// 【T3】与保存 / 启动 / 派发三个闸门**同一份**引擎判据（`doc.engine ?? "mcode"`，
// 历史图无标记 → 旧 runner；新增引擎值未显式放行前一律不装监听 —— fail-closed）。
import { effectiveWorkflowEngine, retiredGraphError } from "@main/workflowEngines/workflowEngineSelection.js";

import {
  TICK_MS,
  WATCH_SETTLE_MS,
  WATCH_RETRY_MIN_MS,
  WATCH_RETRY_MAX_MS,
  LAST_MINUTE_SETTING_KEY,
  SELF_TRIGGER_LIMIT,
  SELF_TRIGGER_COUNT_PREFIX,
  SELF_TRIGGER_AT_PREFIX,
  SELF_TRIGGER_WINDOW_MS,
  SELF_TRIGGER_STOP_REASON,
  BUSY_RETRY_MIN_MS,
  BUSY_RETRY_MAX_MS,
  WATCH_IGNORED_DIRS,
  PENDING_FILES_LIMIT,
  GLOBAL_PENDING_LIMIT,
  LAST_MINUTE_HISTORY_KEEP,
  MISSED_SWEPT_SETTING_KEY,
  TRIGGER_CLAIMS_SETTING_KEY,
  TRIGGER_CLAIMS_HISTORY_KEEP,
  DROPPED_SETTING_KEY,
  DROPPED_HISTORY_KEEP,
  PENDING_BATCH_SETTING_KEY,
  PENDING_BATCH_HISTORY_KEEP,
  TYPES_CACHE_TTL_MS,
  isLastMinutes,
  isUndeliveredDrops,
  isPendingBatchMarks,
  existingFilesOf,
  type LoadedTrigger,
  type PendingFire,
  type UndeliveredDrop,
  type PendingBatchMark,
  type WatcherEntry,
  type AutomationRunResult,
} from "./automationRunnerTypes.js";
export type { AutomationRunResult } from "./automationRunnerTypes.js";

class AutomationRunner {
  private started = false;
  /**
   * 【AUTO-02】Node-RED 引擎是不是在跑 —— 装配层注入。
   *
   * 为什么不在这个文件里直接问引擎注册表：`automationRunner` 被一批无头套件
   * 打进纯 node（不引 electron），而引擎注册表会拖进 `window.ts`。用一个可选的
   * 注入点，套件不设它时按"引擎没跑"处理（那正是套件的语境）。
   */
  private nodeRedEngineRunning: (() => boolean) | null = null;

  /** 装配层调用：把"引擎在不在跑"接进来（状态行据此判 armed）。 */
  setNodeRedEngineProbe(probe: (() => boolean) | null): void {
    this.nodeRedEngineRunning = probe;
  }
  /** 已经解好的触发条件:`workflowId → 该自动化的全部触发器`。 */
  private entries = new Map<string, LoadedTrigger[]>();
  /** 每个项目目录一个监听(见 `rebuildWatchers`)。 */
  private watchers = new Map<string, WatcherEntry>();
  /** 攒着的触发:key 是 `workflowId:nodeId`。 */
  private pendingFires = new Map<string, PendingFire>();
  /**
   * 定时那一类**这一分钟跑过没有**(见 `onTick`)。
   *
   * 存在**磁盘上**(`LAST_MINUTE_SETTING_KEY`),不是进程里 —— 重启之后同一个分钟要
   * 接着认得出「这一分钟已经跑过了」,否则开一次应用就多跑一次。读进来一次(`start`),
   * 之后这一份就是内存里的真相,写由 `rememberLastMinute` 负责(它按分钟落一次盘)。
   */
  private lastMinute = new Map<string, number>();
  /** 去重历史损坏或与当前已认可快照不一致时，停止一切 schedule 派发。 */
  private lastMinutesReadable = true;
  /**
   * **定时触发的 durable 领取账本**(MC-051,见 {@link TRIGGER_CLAIMS_SETTING_KEY})。
   *
   * 与 `lastMinute` 并存、各答一个问题:`lastMinute` 是"这一分钟碰过没有"(去重),
   * 本表是"这一分钟确认完成了没有"(可追踪的领取)。**跨重启**——`start()` 先读回来,
   * 派发前 durable 写入,运行结束时 durable 结算成 `SUCCEEDED`。
   */
  private triggerClaims = new Map<string, TriggerClaim>();
  /** 领取历史不可读时，绝不把空 Map 当成可写空账本；仅下一次显式启动重新核验。 */
  private triggerClaimsReadable = true;
  /** 每条自动化连续 reload 的序号,防止慢的那次覆盖快的那次。 */
  private reloadSeq = new Map<string, number>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** 退订"机器醒了"那条监听(见 `watchPowerResume`)。无头环境里一直是 null。 */
  private powerResumeOff: (() => void) | null = null;
  /**
   * 「错过」这件事**已经结算到哪一分钟**了(见 `sweepMissedSchedules`)。
   *
   * **跟着 `lastMinute` 一起落盘**(`MISSED_SWEPT_SETTING_KEY`,2026-09-28 改)。
   *
   * 原来它刻意只活在进程里,理由是"重启之后重新算一遍正是对的"。但两张表不同寿这件事
   * 本身就是 bug 的来源:`lastMinute` **跨重启**,于是重启后的第一次结算会从上一次真的
   * 跑过的那一分钟重新数起 —— 同一段"错过"被反复数,用户每开一次应用都看到同一条
   * 「错过了 N 次」,而它说的是同一件五天前的事。
   *
   * ⚠️ **不能拿 `lastMinute` 兼职做这个游标。** 那张表回答的是「这一分钟跑过没有」,
   * 而它**跨重启**(见 `LAST_MINUTE_SETTING_KEY`)—— 往里写一个"结算到此"的分钟,
   * 等于把"刚刚跑过"的记忆抹掉,下一跳就会在同一分钟里再跑一次。那正是那张表当初
   * 要挡的 bug。
   */
  private missedSweptTo = new Map<string, number>();
  /**
   * 【MC-091 续】**被积压丢弃、但还没交付给任何一次运行**的条目数**(见
   * {@link DROPPED_SETTING_KEY})。`start()` 从盘上读回来;任何一次丢弃累加并落盘;
   * 下一次真正派发的运行把欠账并进载荷、随后清账。
   */
  /**
   * 【MC-091 续】**被积压丢弃、但还没交付给任何一次运行**的条目数(见
   * {@link DROPPED_SETTING_KEY})。`start()` 从盘上读回来;任何一次丢弃累加并落盘;
   * 下一次真正**派发**的运行把它并进载荷、随后清账(见 {@link drainDroppedUndelivered})。
   */
  private droppedUndelivered = new Map<string, UndeliveredDrop>();
  /** 欠账表自上次落盘后变过没有(见 {@link recordDropped} / {@link flushDroppedUndelivered})。 */
  private droppedDirty = false;
  /**
   * **攒着但还没派发**的批次标记(跨重启可见性,见 {@link PENDING_BATCH_SETTING_KEY})。
   *
   * 文件 / 事件批次只活在 `pendingFires` 里;进程在合并窗口里被杀死,那一批无声消失。
   * 这张表在批次开始攒时 durable 写一条标记,派发 / 明确放弃时清除 —— 残留标记就是
   * 「上一次有一批没派发」的证据,启动时按 uncertain 语义记进事实(界面可见),
   * **不自动补投**(那会造出第二次外部副作用)。
   */
  private pendingBatchMarks = new Map<string, PendingBatchMark>();
  /** `start()` 读盘那一刻的批次标记快照 —— 恢复只认它们(启动后新攒的批不是"崩溃残留")。 */
  private crashedPendingBatchMarks = new Map<string, PendingBatchMark>();
  private unsubscribe: (() => void) | null = null;
  /** 与钩子共用一份逻辑、各持一个实例 —— `tool.result` 要回查工具名,所以它**有状态**。 */
  private subjects = createEventSubjects();
  /**
   * **事实状态**(AUTO-09,见 `automationStatus.ts`):每条触发器挂没挂好、最近一次
   * 什么时候跑的、最近一次为什么没跑成。reload 重建挂载侧,运行侧只增不改。
   */
  private facts = new AutomationFacts();
  /**
   * 【ARC-006 MERGE-3 第二刀】**executor owner 判据**（同一 flow 只能一端执行）。
   *
   * 默认是**进程内内存注册表**：没有 Node-RED 侧登记时 `claim` 恒成功 —— 现有用户
   * 行为一字不变。装配处（或测试）用 {@link setExecutorOwnership} 换成真注册表
   * （将来是落盘版，与 flows.json 同一事务边界）。
   *
   * 接入点只有三处窄边界（见文件里的 `claimExecutorOwner` / `releaseExecutorOwner`）：
   * `fire()` 派发前 claim、`dispose()` 与 `apply()` 里 release。**Node-RED 侧启动
   * 入口本片不改**（下一片）。
   */
  private executorOwnership: ExecutorOwnershipRegistry = sharedExecutorOwnership;
  /** 本 runner 当前已登记为 `mcode` owner 的 flowId（只放行 release 自己登记过的）。 */
  private claimedFlowIds = new Set<string>();

  /** 装配/测试注入 executor owner 注册表（传 null 复位为进程内内存版）。 */
  setExecutorOwnership(registry: ExecutorOwnershipRegistry | null): void {
    // Never orphan live claims in the old store when tests or a host replace it.
    for (const id of [...this.claimedFlowIds]) this.releaseExecutorOwner(id);
    this.executorOwnership = registry ?? sharedExecutorOwnership;
    this.claimedFlowIds.clear();
  }

  /* ────────────────────────── 启停 ───────────────────────── */

  /** 由 `main/index.ts` 在 `awaitDb()` 之后调用(同 `hookRunner`)。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 【MC-091 续·启动竞态】**先把跨重启的持久状态读回来,再订阅事件。**
    //
    // 三张表(`lastMinute` / `triggerClaims` / `droppedUndelivered`)都必须在**任何事件
    // 可被受理之前**装进内存。反过来的话,启动窗口里若记下一笔丢弃(写进内存表),紧接着
    // 的读盘会**整份覆盖**它 —— 那笔丢弃就永久消失。读在前、订阅在后,这个窗口从
    // "靠顺序碰巧安全"变成"按构造安全";`readDroppedUndelivered` 本身也**并入**已有内存
    // 表(见那里),两层保险。
    this.lastMinute = this.readLastMinutes();
    this.triggerClaims = this.readTriggerClaims();
    this.droppedUndelivered = this.readDroppedUndelivered();
    this.pendingBatchMarks = this.readPendingBatchMarks();
    // 读盘那一刻的标记 = 上一个进程留下的(崩溃残留)。快照必须**现在就取**:之后
    // 启动窗口里的新批会往 `pendingBatchMarks` 写,恢复只认这份快照,不能把新批误报成崩溃。
    this.crashedPendingBatchMarks = new Map(this.pendingBatchMarks);

    // 见文件头不变量 ①:这里是同步回调,真正的活全在下面的计时器里,不 await。
    this.unsubscribe = runtimeManager.subscribe((e) => {
      try {
        this.onEvent(e);
      } catch (err) {
        log.warn(`[automation] 事件分发失败:${(err as Error).message}`);
      }
    });

    // **写工作流的人喊一声,这里就重读那一份**(见 `reloadRequest.ts`)。写成"登记"
    // 而不是让写路径直接调本模块,是因为写路径之一(`mcodeServer.ts`)**无头也会真的
    // 被调用**,而本模块这条依赖链会拉到 electron。
    setWorkflowReloader((workflowId) => {
      void this.reload(workflowId).catch((err: unknown) => {
        log.warn(`[automation] 重读「${workflowId}」失败:${(err as Error).message}`);
      });
    });

    // 三张跨重启的表(`lastMinute` / `triggerClaims` / `droppedUndelivered`)已在
    // `start()` 开头读回(见那里的「启动竞态」注释)—— 那里**先于**订阅事件,所以启动
    // 窗口里发生的任何丢弃都不会被这里的读盘覆盖。它们仍必须在 ticker 起跳**之前**就绪:
    // 第一跳要靠 `lastMinute` 去重、靠 `triggerClaims` 认出"领取了但没确认完成"的那些。

    this.ticker = setInterval(() => {
      try {
        this.onTick();
      } catch (err) {
        log.warn(`[automation] 定时检查失败:${(err as Error).message}`);
      }
    }, TICK_MS);
    // **不拖着进程不退出**:它只是一根看时钟的针,`before-quit` 那一头也会关掉它。
    this.ticker.unref();

    await this.reloadAll();
    // 上一次进程结算到哪一分钟(见 `missedSweptTo`)。**必须在 sweep 之前读回来**,
    // 否则重启一次就把同一段又数一遍,用户每开一次应用都看到同一条「错过了 N 次」。
    this.missedSweptTo = this.readMissedSwept();
    // **把上一次进程没确认完成的领取认出来**(MC-051)。放在 reloadAll **之后** —— 恢复
    // 要把「结果不确定」记进对应触发器的事实表,而那时 `all()` 才解得开;放在启动 tick
    // **之前** —— 那些领取对应的分钟已经被 `lastMinute` 记过,启动那一跳本就不会重跑它们
    // (`recoverIncompleteClaims` 不改变这一点,只是把"没确认完成"这件事显式化)。
    this.recoverIncompleteClaims();
    // **上一次进程攒着没派发的批次**:残留标记按 uncertain 上报(界面可见)、不补投,
    // 随后清掉。放在 reloadAll 之后(`all()` 才解得开触发器)、启动 tick 之前 ——
    // 与 `recoverIncompleteClaims` 同一时机、同一语义。
    this.recoverPendingBatches();
    // **启动即看本分钟**(MC-021)。ticker 的第一跳要等 30 秒,而"应用在本分钟里已经
    // 起来了"这件事本身就该让这一分钟的计划跑掉:每天 `0 9 * * *` 那条,09:00:45 开
    // 应用,若只等 ticker 就要到 09:01:15 才跑,而那一瞬间钟已经翻到 09:01 —— 这一次
    // 触发**整个丢了**。这不是"应用 09:30 才打开、故意不补 09:00"那条既定规则(那一条
    // 由 `sweepMissedSchedules` 只记账、不补跑);它是"本分钟还没过完,就该按本分钟算"。
    //
    // 位置在 **`sweepMissedSchedules` 之前**:本分钟先跑掉并记进 `lastMinute`,结算才
    // 不会把这一分钟又数成"错过"(它本来就只数 `nowMinute` 之前那些分钟)。同一分钟里的
    // 去重仍由 `lastMinute` 兜住(下面 ticker 的第一跳会看到"本分钟已经跑过")。
    //
    // 放在 reloadAll **之后**:触发器还没解出来时 `all()` 是空的,先看等于没看。
    this.onTick();
    // **先把"睡过去的那几天"结算掉,再宣布起来了。** 只记录,不补跑。
    this.sweepMissedSchedules();
    // 没人认领的来源链记录清掉(见 `sweepEventChains`)。
    this.sweepEventChains();
    await this.watchPowerResume();
    log.info(`AutomationRunner started:${this.all().length} 个触发器`);
  }

  dispose(): void {
    if (!this.started && this.ticker === null) return;
    this.started = false;
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.powerResumeOff?.();
    this.powerResumeOff = null;
    // 退订那条缝 —— 退出过程中还在写工作流的话,不该再让一个已经停掉的执行器去读盘。
    setWorkflowReloader(null);
    for (const [, entry] of this.watchers) {
      try {
        entry.watcher?.close();
      } catch {
        /* 关不掉就算了,进程都要退了 */
      }
    }
    this.watchers.clear();
    for (const [, pending] of this.pendingFires) {
      if (pending.timer !== null) clearTimeout(pending.timer);
    }
    this.pendingFires.clear();
    // 【跨崩溃可见性】退出时**不清**批次标记 —— 攒着没派发的那一批确实没跑,下次启动
    // 按 uncertain 上报(与崩溃同一语义:不需要区分"优雅退出"与"被杀",两者都没派发)。
    // 只把最终计数冲刷一次(非 durable:可见性退化的代价只是少报一次,不是副作用)。
    this.flushPendingBatchMarks(false);
    this.pendingBatchMarks.clear();
    this.crashedPendingBatchMarks.clear();
    this.lastMinute.clear();
    this.triggerClaims.clear();
    this.missedSweptTo.clear();
    // 【MC-091 续】退出前把内存里的欠账冲刷落盘 —— 否则"攒着没冲刷的丢弃"会随进程消失,
    // 与整个切片"不静默丢"的立场相悖(节流窗口最坏一个 tick)。清表在冲刷之后。
    this.flushDroppedUndelivered(true);
    this.droppedUndelivered.clear();
    this.droppedDirty = false;
    this.facts.clear();
    this.entries.clear();
    // 【MERGE-3】退出时释放本进程登记过的 owner（只释放自己 claim 过的，绝不偷别人的）。
    for (const flowId of [...this.claimedFlowIds]) this.releaseExecutorOwner(flowId);
    this.claimedFlowIds.clear();
    log.info("AutomationRunner disposed");
  }

  /* ────────────────────────── 重建监听 ────────────────────────── */

  /**
   * 全部工作流重新解一遍。启动时一次。
   *
   * `listWorkflows()` 里那些**没有触发器节点的**会被解成空数组(等于"它不是自动化"),
   * 所以这里不需要先猜哪些是自动化 —— `loadTriggers` 自己就是那个筛子。
   */
  async reloadAll(): Promise<void> {
    const types = await this.loadTypes();
    if (!this.started || types === null) return;
    const ids = new Set([...listWorkflows().map((w) => w.id), ...this.entries.keys()]);
    for (const id of ids) {
      // 把还在飞的那次单条 reload 作废:这一份是更新的(它读的是同一时刻的表)。
      this.reloadSeq.set(id, (this.reloadSeq.get(id) ?? 0) + 1);
      this.apply(id, this.buildTriggers(id, types));
    }
    this.rebuildWatchers();
  }

  /**
   * 一条工作流的触发器集合重新解一遍。**存盘 / 删除成功后调用**(同进程直接调,不需要
   * 事件总线)。
   *
   * ️ **这一步会读清单**(`loadNodeTypes` 每次都要扫插件目录、读并解析每一份清单),
   * 所以它不该在热路径上被调 —— 只有"保存"和"启动"两种时刻。
   */
  async reload(workflowId: string): Promise<void> {
    const seq = (this.reloadSeq.get(workflowId) ?? 0) + 1;
    this.reloadSeq.set(workflowId, seq);
    const types = await this.loadTypes();
    if (!this.started || types === null) return;
    // 读清单是异步的,期间可能又存了一版 —— 那时这一份已经过期,丢掉。
    if (this.reloadSeq.get(workflowId) !== seq) return;
    this.apply(workflowId, this.buildTriggers(workflowId, types));
    this.rebuildWatchers();
  }

  /** 换掉一条自动化的触发器集合(空数组 = 它不再是自动化,或者被删了)。 */
  private apply(workflowId: string, triggers: LoadedTrigger[]): void {
    if (triggers.length === 0) {
      this.entries.delete(workflowId);
      // 不再是自动化（或已被删除）→ 不再由 mcode 执行；释放所有权，另一端（将来的
      // Node-RED 切换流程）才能接手。
      this.releaseExecutorOwner(workflowId);
    } else {
      this.entries.set(workflowId, triggers);
    }

    // 已经不在表里的那些,攒着的触发要一起丢掉 —— 否则"改完触发方式"之后,旧配置
    // 那次还没跑出去的触发会按**旧条件**起一次运行(而那正是用户刚改掉的东西)。
    //
    // ⚠️ **"还在表里"不等于"还是那份配置"。** 触发器的身份是 `workflowId:nodeId`,
    // 而用户改的恰恰是**同一个节点上的参数**(glob、事件名、cron、合并窗口)—— 按身份
    // 判的话,这种改动攒着的那一次**判不出来**,几秒后照旧按旧条件跑。所以还要比
    // 一份**条件签名**(见 `triggerSpecKeyOf`):签名变了就当作"这一条已经不是它了"。
    for (const [key, pending] of this.pendingFires) {
      const current = this.findLoaded(pending.trigger);
      // Pending payloads belong to the enabled trigger and workspace that
      // collected them; never replay them after disable or a project switch.
      if (current === undefined || current.disarmed ||
          current.projectId !== pending.trigger.projectId || current.cwd !== pending.trigger.cwd ||
          triggerSpecKeyOf(current.spec) !== triggerSpecKeyOf(pending.trigger.spec)) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        this.pendingFires.delete(key);
        // 【跨崩溃可见性】配置改动 / 停用 / 项目切换让这一批作废 —— 清除标记:它不是
        // "没派发就崩了",下次启动不该报成不确定。
        this.clearPendingBatchMark(key);
        // 攒着的那一批作废了,界面上那行「排队中」也要跟着走(见 `recordQueued`)。
        this.facts.recordQueued(triggerSeedOf(pending.trigger), 0, Date.now());
      }
    }
    for (const key of [...this.lastMinute.keys()]) {
      if (!key.startsWith(`${workflowId}:`)) continue;
      const still = triggers.some((t) => triggerKey(t) === key);
      if (still) continue;
      // Let rememberLastMinute remove the key and persist it together.
      // **删掉的这一笔要落盘**(与 `onTick` 记的那一笔是同一个道理):不落的话重启
      // 之后它又会被 `readLastMinutes` 读回来,而那时这张表里已经没有这条触发器了 ——
      // 它只是白占一格,直到被 `LAST_MINUTE_HISTORY_KEEP` 修剪掉。落一下更省事,也让它不再
      // 有可能撞上一个**新**触发器(节点 id 被复用时 key 会一样)。
      this.rememberLastMinute(key, null);
    }
  }

  /**
   * 解一条工作流里的触发器。**认不出来 / 解不开的都跳过 + 记日志**:
   *
   *  - 类型认不出来(引用了没装的节点类型)—— 一份别人分享来的工作流会这样,它照样
   *    能存能看,只是跑不了;
   *  - 参数解不开 —— 存盘那一关本来就拦住了(`library.deriveTrigger`),能走到这里
   *    说明清单在存盘之后被改过(插件更新 / 手改本地清单);
   *  - 项目没了 —— 没有工作目录就不该起跑(否则会在宿主目录里跑,而那是个意外)。
   *
   * **静默跳过是这一处最坏的写法**:一条"存下来了却永远不响"的自动化,用户唯一能看到的
   * 现象就是"它没反应"。
   */
  /**
   * 【T3】这份工作流**该不该由旧 runner 装监听**？（cron / fs.watch / 事件订阅）
   *
   * 判据与保存、启动、派发三处是**同一份** `effectiveWorkflowEngine`（`doc.engine ??
   * "mcode"`）—— 不是在这里手写一遍 `doc.engine === "node-red"`：
   *
   *  - `mcode`（含历史无标记图）→ 交旧 runner，行为一字不变；
   *  - `node-red` → 它的触发由引擎自己的 inject / watch / `mcode-trigger` 拥有，
   *    旧 runner **一个监听都不装**（从前照样装 cron/fs.watch，只在 `fire()` 的
   *    owner claim 与 `runner.ts` 的 assert 才被挡住 —— 靠下游兜底，不是上游不装）；
   *  - **任何其它值**（引擎字段被手改成未知、未来新增引擎还没在这里放行）→
   *   同样不装，并且让事实表说清楚。**fail-closed**：宁可一条都不响，也不把
   *    权威不明的图交给旧 runner 猜。
   *
   * 注意 `WorkflowRepo.parseWorkflowDoc` 读行时把缺省引擎归一成 `"mcode"`，所以
   * 走到这里的 doc 一般已带显式值；这里仍按 `effectiveWorkflowEngine` 判，是为了
   * 与其它三处保持同一判据，而不是读一份可能被别处改过的 `doc.engine`。
   */
  private legacyTriggerOwnerOf(doc: Pick<WorkflowDoc, "engine">): { legacy: true } | { legacy: false; owner: WorkflowEngine | "unknown" } {
    const raw: unknown = doc.engine;
    if (raw !== undefined && raw !== "mcode" && raw !== "node-red") return { legacy: false, owner: "unknown" };
    const owner = effectiveWorkflowEngine(doc);
    // 【Q5】旧执行器**不再安装任何触发器**，包括归 mcode 的图：统一到 Node-RED 之后，
    // 旧 cron/文件监听/事件订阅如果还挂着就会和引擎侧的 inject/watch 抢同一张图。
    return owner === "mcode"
      ? { legacy: false, owner: "mcode" as WorkflowEngine }
      : { legacy: false, owner };
  }

  /** 事实表里那条「这条触发器由谁装」的句子（用户可见，界面读 `detail`）。 */
  private static foreignTriggerDetail(owner: WorkflowEngine | "unknown", workflowName: string): string {
    if (owner === "node-red") {
      return "由 Node-RED 引擎管理：旧自动化执行器不安装 cron / 文件监听 / 事件订阅（触发在引擎侧）";
    }
    if (owner === "mcode") {
      return retiredGraphError(workflowName);
    }
    return "工作流引擎标记无法识别（既不是 mcode 也不是 node-red）：旧自动化执行器拒绝安装任何监听（fail-closed）";
  }

  /** 手动入口的同一道闸：这幅图不归旧 runner 时给一句可读的拒绝，而不是"找不到触发器"。 */
  private foreignOwnerOf(workflowId: string): string | null {
    const doc = getWorkflow(workflowId);
    if (doc === null) return null;
    const owner = this.legacyTriggerOwnerOf(doc);
    return owner.legacy ? null : AutomationRunner.foreignTriggerDetail(owner.owner, doc.name);
  }

  private buildTriggers(workflowId: string, types: Map<string, NodeTypeManifest>): LoadedTrigger[] {
    const doc = getWorkflow(workflowId);
    if (doc === null) {
      // 工作流没了:它的事实一起清掉,界面上不留幽灵行。
      this.facts.retainWorkflow(workflowId, new Set());
      return [];
    }
    const revision = workflowRevision(doc);
    const out: LoadedTrigger[] = [];
    const pendingReview = workflowReviewError(doc);
    // 【T3】装监听**之前**先看引擎归属。Node-RED 拥有的图 / 权威不明的图：一个监听都不装，
    // 但每条触发器仍在事实表里留一行「由谁管」—— 不静默消失（AUTO-09 同一条立场）。
    const owner = this.legacyTriggerOwnerOf(doc);
    /** 这次 reload 里**还在**的触发器(挂上的 + 挂不上的),reload 完拿它清事实表。 */
    const seen = new Set<string>();
    for (const node of doc.nodes) {
      const manifest = types.get(node.type);
      if (manifest === undefined || manifest.runner.kind !== "trigger") continue;
      const where = `自动化「${doc.name}」的触发器「${node.title || node.id}」`;
      // 事实登记要的信息。**挂不上的也要记**(AUTO-09):一条「存下来了却永远不响」的
      // 自动化,跳过原因必须能被界面看见,而不只是一行日志。
      const seed: AutomationFactsSeed = {
        workflowId,
        nodeId: node.id,
        title: node.title || node.id,
        kind: triggerKindOf(node.params) ?? "unknown",
        // 用户那一票。`recordSetup` 会把它合进 `armed`,所以下面**不用**再为"关掉了"
        // 单独写一支 —— 关掉的和参数坏掉的最后都落在 `armed: false` 上,
        // 只是 `detail` 那句话不一样(`markDisarmed`)。
        enabled: triggerEnabledOf(node.params),
      };
      seen.add(triggerKey(seed));
      if (!owner.legacy) {
        /* 不装任何监听 —— 触发在引擎侧。这里**不**用 `parseTriggerSpec` 再验参数：
         * 参数好坏是引擎侧的事，旧 runner 没有立场对一张自己不执行的图报"参数写坏了"。
         *
         * 【AUTO-02】但 **`armed` 不能恒为 false**。界面上 `armed: false` 显示成黄色的
         * 「未挂上」（`AutomationRunSection` 的三态：绿=挂着 / 灰=用户关的 / 黄=出问题），
         * 而 node-red 图**其实是挂着的**，只是挂在引擎侧。恒 false 等于对每一条正常的
         * 自动化报一个不存在的故障。
         *
         * 所以：`armed` 取**引擎这一侧的真实状态** ——
         *   - 用户关掉这个触发器 → false，且 `enabled: false` 让界面走灰色的「已关闭」；
         *   - 引擎没在跑（没部署 / 进程不在）→ false，这时黄灯是**对的**；
         *   - 引擎在跑 → true。
         *
         * detail 仍然保留那句话 —— 它解释的是"为什么旧 runner 不装监听"，
         * 与"这条触发器到底有没有在工作"是两件事。 */
        const engineRunning = this.nodeRedEngineRunning?.() === true;
        const enabled = triggerEnabledOf(node.params);
        this.facts.recordSetup(
          seed,
          enabled && engineRunning,
          enabled
            ? (engineRunning
              ? "由 Node-RED 引擎管理：触发在引擎侧，引擎正在运行"
              : "由 Node-RED 引擎管理，但引擎当前没有运行 —— 部署并启动引擎后它才会触发")
            : "这条触发器已关闭（手动运行仍然可用）",
        );
        continue;
      }
      if (pendingReview !== null) {
        // Do not install a watcher or timer, but keep the reason in the facts.
        this.facts.recordSetup(seed, false, pendingReview);
        continue;
      }
      const check = parseTriggerSpec(manifest, node.params);
      if (!check.ok) {
        log.warn(`[automation] ${where}跳过:${check.error}`);
        this.facts.recordSetup(seed, false, check.error);
        continue;
      }
      const rawProject = node.params[NODE_TRIGGER_PROJECT_PARAM_KEY];
      const task = node.params[NODE_TRIGGER_TASK_PARAM_KEY];
      // ⚠️ **`project` 缺键要补成空串,不能在这里 `continue`。** `parseTriggerSpec`（上面那句
      //    `check`）对**「事件发生时」**故意允许 `project` 缺失/为空（另外三种它已经拦住），
      //    可它**不会**把缺的键补成空串 —— 它只 `params[...]` 读一次做校验。于是这里若要求
      //    `typeof projectId === "string"`，一条 `{"triggerKind":"event","task":"…","events":"…"}`
      //    （没写 `project` 键，内置模板正是这种）会命中 `continue`：**不入 entries、不 log.warn、
      //    也不记 setup 事实** —— 用户看到一条参数填得好好的自动化永远不响，而且
      //    `automation:statusAll` 里连一行"为什么没挂上"都没有。补成空串正合 `fire()` 的语义
      //    （空串 = 没有项目，退回宿主目录）。
      if (typeof task !== "string") continue; // `parseTriggerSpec` 已经查过,这里只为收窄类型
      const projectId = typeof rawProject === "string" ? rawProject : "";
      // **项目可以留空** —— 只有「事件发生时」允许(`parseTriggerSpec` 会拦住另外三种)。
      // 缺项目时退回宿主目录:那条运行要做的事(转录、抽图、送外部工具)都是拿绝对路径
      // 去操作库里的文件,根本不需要工作目录。而**内置模板预置不出项目 id**(项目 id 是
      // 建项目时现生成的),所以以前"一律要求项目"的写法让内置自动化**永远挂不上**。
      //
      // `projectId` 记成空串:它唯一的用处是 `fire()` 里现读一次项目(确认还在),
      // 而空串的语义就是"没有项目",那条查表据此跳过。
      const project = projectId.length > 0 ? ProjectRepo.get(projectId) : undefined;
      if (projectId.length > 0 && project === undefined) {
        log.warn(`[automation] ${where}跳过:项目不在了(${projectId})`);
        this.facts.recordSetup(seed, false, `项目不在了(${projectId})—— 这条自动化没有工作目录`);
        continue;
      }
      // **关掉的照样进表。** 第二参数说的是"我这一侧有没有问题"—— 这里没有
      // (参数解开了、项目在),用户那一票在 `seed.enabled` 里,由 `recordSetup` 合进去
      // 并写上一句「是你关的」。不写这一句的话,一条关掉的文件触发器会显示成光秃秃的
      // 「没挂上」,和"它坏了"分不清。
      const off = !triggerEnabledOf(node.params);
      this.facts.recordSetup(seed, true);
      out.push({
        workflowId,
        workflowRevision: revision,
        workflowName: doc.name,
        nodeId: node.id,
        title: node.title || manifest.name,
        spec: check.spec,
        projectId,
        // 没绑项目时退回用户主目录 —— 见上面那段。只可能是「事件发生时」。
        // 不用 `process.cwd()`:打包后那是 `/`(macOS 从访达启动)或安装目录,写不进东西。
        cwd: project?.path ?? homedir(),
        task: task.trim(),
        params: node.params,
        disarmed: off,
      });
    }
    this.facts.retainWorkflow(workflowId, seen);
    return out;
  }

  /**
   * 节点清单。**带一个几秒的短缓存**。
   *
   * `loadNodeTypes()` 每次都要扫插件目录、读并解析每一份清单(底下还会把每个启用插件的
   * 技能/命令/agent 文件再读一遍),所以文件头写着"它不该在热路径上被调"。可
   * `runNow` / `runWithTarget` 找不到触发器时就会 `reload()` —— 而右键菜单里的「运行
   * 自动化」正是热路径:连点几下就是连着几次全量扫盘。
   *
   * 缓存窗口取几秒:清单变化只来自装插件 / 手改清单文件,而那之后紧接着的"下一次运行"
   * 晚几秒读到新的一份,后果只是这一次按旧清单跑;而保存工作流那条路读的是**工作流
   * 文档**(`getWorkflow`),不经过这里,所以"存完马上点运行"照旧拿到新的图。
   */
  private typesCache: { at: number; types: Map<string, NodeTypeManifest> } | null = null;

  private async loadTypes(): Promise<Map<string, NodeTypeManifest> | null> {
    const cached = this.typesCache;
    if (cached !== null && Date.now() - cached.at < TYPES_CACHE_TTL_MS) return cached.types;
    try {
      const types = new Map((await loadNodeTypes()).entries.map((e) => [e.id, e.manifest]));
      this.typesCache = { at: Date.now(), types };
      return types;
    } catch (err) {
      log.warn(`[automation] 读节点清单失败:${(err as Error).message}`);
      return null;
    }
  }

  /**
   * 按"现在有哪些文件触发器"重开/关掉目录监听。
   *
   * 每个目录**只开一次**(同 `lib/walkCache.ts` 的做法):一条自动化挂两个监听同一目录的
   * 文件触发器、或者两条自动化盯同一个项目,都只该有一个 watcher —— 目录多一个监听,
   * 一次保存就多一条重复的事件。
   */
  private rebuildWatchers(): void {
    const wanted = watcherDirsOf(this.all().filter((trigger) => !trigger.disarmed));
    for (const [dir, entry] of this.watchers) {
      if (wanted.includes(dir)) continue;
      try {
        entry.watcher?.close();
      } catch {
        /* 关不掉就算了:它下面的目录已经不监听了 */
      }
      this.watchers.delete(dir);
    }
    for (const dir of wanted) {
      const existing = this.watchers.get(dir);
      if (existing !== undefined) {
        // **失效重试**(AUTO-06):上次挂失败(目录暂时不在 / 出错被关 / 平台不支持)
        // 的话,这次 reload 再试一次 —— 目录回来了就该复活,而不是等到重启。失败的那
        // 一侧继续在 `armWatcher` 里记日志与事实。
        if (existing.watcher === null) this.armWatcher(dir);
        continue;
      }
      this.watchers.set(dir, { watcher: null });
      this.armWatcher(dir);
    }
  }

  private armWatcher(dir: string): void {
    const entry = this.watchers.get(dir);
    if (entry === undefined) return;
    // 递归监听只在 win32 / darwin 上有(Node >= 19.1)。别的平台上文件触发**不会响**
    // —— 那是要**说出来**的事实,不是安静地少一个功能。事实表也要记上(AUTO-09):
    // 挂载侧从这里起是「挂不上」,界面那栏不能再说它启用着。
    // 递归监听:win32 / darwin 一直有,**Linux 从 Node 20 起也有**。
    // 从前这里把 win32/darwin 之外一律判死,于是 Linux 桌面与无头那条路上(`mcodeServer.ts`)
    // 文件触发是完全残废的 —— 而这个判断写下的时候 Linux 确实还不支持,如今只是过期了。
    // 真不支持的平台/内核照样会在下面 `watch()` 那一下抛 ERR_FEATURE_UNAVAILABLE,
    // 由 catch 如实记账 —— 与其在这里猜,不如试一次。
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    const recursiveMaybeSupported =
      process.platform === "win32" || process.platform === "darwin" || nodeMajor >= 20;
    if (!recursiveMaybeSupported) {
      const why = `这个运行环境不支持递归监听(Node ${process.versions.node} / ${process.platform}),文件触发不会响`;
      log.warn(`[automation] ${why}:${dir}`);
      for (const t of this.all()) {
        if (t.spec.kind === "file" && t.cwd === dir) {
          this.facts.recordSetup(triggerSeedOf(t), false, why);
        }
      }
      return;
    }
    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        // 回调里**只攒不跑**(见文件头不变量 ①):真正起运行的是下面那个计时器。
        // 【ARC-015①】把 `eventType`(`"rename"` / `"change"` / …)也带上 —— 它是合成
        // 结构化 `FileChange` 的三个输入之一(见 `classifyFileChange`)。
        try {
          this.onFsChange(dir, typeof filename === "string" ? filename : null, typeof eventType === "string" ? eventType : null);
        } catch (err) {
          log.warn(`[automation] ${dir} 的文件事件处理失败:${(err as Error).message}`);
        }
      });
      watcher.on("error", (err) => {
        log.warn(`[automation] 监听 ${dir} 出错,文件触发在这个目录上停了:${err.message}`);
        // **失效处理**(AUTO-06):这个目录上的文件触发器当场记成挂不住 —— 用户看着
        // 一条填好的触发器等它响,是这一路最坏的坏法。
        for (const t of this.all()) {
          if (t.spec.kind === "file" && t.cwd === dir) {
            this.facts.recordSetup(triggerSeedOf(t), false, `目录监听失效:${err.message}`);
          }
        }
        try {
          entry.watcher?.close();
        } catch {
          /* ignore */
        }
        entry.watcher = null;
        // **出错被关也要排重挂**(MC-020):`error` 之后目录可能只是暂时读不到(网络盘、
        // 权限抖动),不该等到重启才复活。与构造失败那条路走同一个退避。
        this.scheduleWatchRetry(entry);
      });
      entry.watcher = watcher;
      // 挂上了:把上次「监听失效」记的那笔还回来(reload 重试成功的那条路走这里)。
      // **经 `markArmed`**:用户关掉的那条不会被这笔说成"响着"。退避状态一并清掉 ——
      // 挂上之后就不该再有任何待重试(MC-020)。
      entry.nextRetryAt = undefined;
      entry.retryMs = undefined;
      for (const t of this.all()) {
        if (t.spec.kind === "file" && t.cwd === dir) {
          this.markArmed(t);
        }
      }
    } catch (err) {
      // 目录不存在 / 权限不够都走到这里。**记一行日志** —— "监听目录不存在"要让用户
      // 能在日志里看见,而不是对着一张填好的触发器等它响。事实表同步记上。
      log.warn(`[automation] 监听 ${dir} 失败(目录不存在?):${(err as Error).message}`);
      for (const t of this.all()) {
        if (t.spec.kind === "file" && t.cwd === dir) {
          this.facts.recordSetup(
            triggerSeedOf(t),
            false,
            `监听失败(目录不存在?):${(err as Error).message}`,
          );
        }
      }
      // **没挂上 → 排一次有上限的退避重挂**(MC-020)。从前只有 reload 会补挂,于是目录
      // 修好之后若不显式重存工作流,这条文件触发器永远不再响。
      this.scheduleWatchRetry(entry);
    }
  }

  /**
   * 给一个**没挂上**的目录排下一次重挂(MC-020)。退避从 {@link WATCH_RETRY_MIN_MS}
   * 起翻倍、封顶 {@link WATCH_RETRY_MAX_MS} —— 不是无限高频轮询,也不是永不重试。
   *
   * 由 `armWatcher` 的失败分支(error 回调 / 构造抛错)与 `retryWatchers`(ticker 那一跳
   * 到点时)调用。已挂上的(或重试途中被挂上 / 被停用的)不会被排 —— `watcher !== null`
   * 或条目已从表里消失都直接返回。
   */
  private scheduleWatchRetry(entry: WatcherEntry): void {
    if (entry.watcher !== null) return;
    const next = Math.min(
      entry.retryMs === undefined ? WATCH_RETRY_MIN_MS : entry.retryMs * 2,
      WATCH_RETRY_MAX_MS,
    );
    entry.retryMs = next;
    entry.nextRetryAt = Date.now() + next;
  }

  /**
   * 每个 tick 看一眼:有没有**没挂上、且退避到点了**的目录该重挂(MC-020)。
   *
   * 只对 `watcher === null` 的条目动手,而且必须在 `nextRetryAt` 到点之后 —— 退避由
   * `scheduleWatchRetry` 排,这里只消费。于是坏目录最多每 {@link WATCH_RETRY_MAX_MS}
   * 敲一次,不会成为高频轮询。停用 / dispose 时监听表被清掉,这里自然也不再碰它。
   */
  private retryWatchers(): void {
    const now = Date.now();
    for (const [dir, entry] of this.watchers) {
      if (entry.watcher !== null) continue;
      if (entry.nextRetryAt === undefined || entry.nextRetryAt > now) continue;
      // `armWatcher` 成功会清退避、失败会重排下一次 —— 两条都不会漏。
      this.armWatcher(dir);
    }
  }

  /* ────────────────────────── 四类触发 ────────────────────────── */

  /**
   * **应用没开 / 机器睡着的那段时间里,哪些定时触发器本该响。**
   *
   * ⚠️ **只记录,不补跑。** 不补跑是原来就定下的(见文件头那张表),而且是对的:一台
   * 关了五天的机器一开机连补五份「每天九点的日报」,只会刷出五份没人要的东西,其中
   * 四份的上下文还全是错的(它们本该在各自那天跑)。这里补的是**另一半** —— 让"没跑"
   * 这件事看得见。在这之前那几天连一条记录都不留:`lastFireAt` 停在五天前,界面照旧
   * 说它「响着」,用户唯一的线索是"怎么没收到日报"。
   *
   * 起点取 `lastMinute` 那张**跨重启**的表(见 `LAST_MINUTE_SETTING_KEY`)—— 它本来就是
   * 为「上次跑到哪一分钟」准备的,不用再存第二份真相。
   *
   * 数完把它推到**上一分钟**:不推的话下一次唤醒会把同一段再数一遍。推到上一分钟而不是
   * 当前这一分钟,是为了不吃掉 `onTick` 马上要看的那一格 —— 正好在整点醒过来时,这一分钟
   * 本身该不该跑由它自己判。
   */
  private sweepMissedSchedules(): void {
    const nowMinute = Math.floor(Date.now() / 60_000);
    for (const trigger of this.all()) {
      if (trigger.disarmed || trigger.spec.kind !== "schedule") continue;
      const key = triggerKey(trigger);
      // 起点取「上次真的跑过」和「上次已经结算到」里**靠后**的那个。前者是基准(见
      // `missedMinutesSince`:没跑过就不数),后者防的是同一段被数两遍 —— 启动结算过
      // 一次,睡醒再结算时不该把启动前那段又算进来。
      const swept = this.missedSweptTo.get(key);
      const fired = this.lastMinute.get(key);
      if (fired === undefined) continue;
      const from = swept === undefined ? fired : Math.max(fired, swept);
      const { cron } = trigger.spec;
      const missed = missedMinutesSince(from, nowMinute, (at) => cronMatches(cron, at));
      // **游标照推,哪怕这次一次都没错过** —— 它记的是"结算到哪儿了",不是"漏了几次"。
      this.missedSweptTo.set(key, Math.max(from, nowMinute - 1));
      if (missed.count <= 0) continue;
      this.facts.recordMissed(triggerSeedOf(trigger), missed.count, missed.lastAt ?? Date.now());
      log.warn(
        `[automation] 「${trigger.title}」在应用没运行的这段时间错过了 ${missed.count} 次定时(按设计不补跑)`,
      );
    }
    this.writeMissedSwept();
  }

  /**
   * 「结算到哪一分钟」现在**落盘**(`MISSED_SWEPT_SETTING_KEY`)。
   *
   * 原来它刻意只活在进程里,理由是"重启之后重新算一遍正是对的,那时 facts 也是空的"。
   * 可两边并不对称:`lastMinute` 是**跨重启**的,于是重启后的第一次结算会从上一次真的
   * 跑过的那一分钟重新数起 —— 同一段"错过"被反复数,用户每开一次应用就看到同一条警告,
   * 而它说的是同一件五天前的事。游标跟着 `lastMinute` 一起持久化,两张表才对得上。
   */
  private readMissedSwept(): Map<string, number> {
    try {
      const raw = SettingRepo.get(MISSED_SWEPT_SETTING_KEY);
      if (raw === null || raw.length === 0) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!isLastMinutes(parsed)) {
        log.warn("[automation] 错过结算游标读不回来(形状不对),当空表");
        return new Map();
      }
      return new Map(Object.entries(parsed));
    } catch (err) {
      log.warn(`[automation] 错过结算游标读不回来,当空表:${(err as Error).message}`);
      return new Map();
    }
  }

  /** 写回游标。写不进去只记日志 —— 退化成"重启后可能重复数一次",不影响任何运行。 */
  private writeMissedSwept(): void {
    try {
      // 与 `lastMinute` 同一条修剪规矩:按"最近"留一截,别让删掉的工作流白占字节。
      const rows = [...this.missedSweptTo.entries()].sort((a, b) => b[1] - a[1]).slice(0, LAST_MINUTE_HISTORY_KEEP);
      const next = JSON.stringify(Object.fromEntries(rows));
      if (SettingRepo.get(MISSED_SWEPT_SETTING_KEY) === next) return; // 值没变就不写(整库重写很贵)
      this.missedSweptTo = new Map(rows);
      SettingRepo.set(MISSED_SWEPT_SETTING_KEY, next);
    } catch (err) {
      log.warn(`[automation] 错过结算游标写不进去:${(err as Error).message}`);
    }
  }

  /**
   * 清掉**没人认领**的自动化来源链记录(`automation.eventChain.<sessionId>`)。
   *
   * 那一行在每次起跑时写(见 `fire`),而从前**没有任何一处删得掉**:会话删了、工作流删了
   * 都不管 —— settings 表只增不减,而每一次写又是一次整库重写。启动时按"这个会话还在不在"
   * 扫一遍,一次性删掉(`deleteMany` 只 `persist()` 一次)。
   *
   * 读不回来/删不掉都只记日志:这份数据坏掉最多让一条链的归因不准,不该让启动失败。
   */
  private sweepEventChains(): void {
    try {
      const stale = SettingRepo.keysWithPrefix(EVENT_CHAIN_PREFIX).filter((key) => {
        const sessionId = key.slice(EVENT_CHAIN_PREFIX.length);
        return sessionId.length === 0 || SessionRepo.get(sessionId) === undefined;
      });
      if (stale.length === 0) return;
      SettingRepo.deleteMany(stale);
      log.info(`[automation] 清掉 ${stale.length} 条没人认领的事件来源链记录`);
    } catch (err) {
      log.warn(`[automation] 清理事件来源链记录失败:${(err as Error).message}`);
    }
  }

  /**
   * 机器从睡眠里醒过来的那一下,再结算一次(见 `sweepMissedSchedules`)。
   *
   * 合盖一整夜是**最常见**的那种"错过":进程一直在,`started` 是 true,ticker 那根针却
   * 在休眠里一跳都没走 —— 启动时那一次结算根本轮不到。
   *
   * `powerMonitor` 只有 Electron 主进程有,而这个模块**在无头环境里也会被加载**
   * (`mcodeServer.ts` 那条路,见 `setWorkflowReloader` 那段注释)—— 所以用动态 import
   * 加 try:拿不到就安静退化成"只在启动时结算一次",别的什么都不受影响。
   */
  private async watchPowerResume(): Promise<void> {
    try {
      const { powerMonitor } = await import("electron");
      const onResume = (): void => {
        try {
          this.sweepMissedSchedules();
        } catch (err) {
          log.warn(`[automation] 唤醒后结算错过的定时失败:${(err as Error).message}`);
        }
      };
      powerMonitor.on("resume", onResume);
      this.powerResumeOff = () => powerMonitor.removeListener("resume", onResume);
    } catch {
      /* 无头环境没有 powerMonitor —— 启动时那一次结算已经覆盖了绝大多数场景 */
    }
  }

  /** 定时:30 秒一次,把全部定时触发器的 cron 求一遍;顺带有上限地补挂失败的目录监听。 */
  private onTick(): void {
    // 【MC-091 续】把攒着的未交付丢弃账冲刷落盘(节流窗口最坏一个 tick)。放在 tick 开头,
    // 与下面别的周期性动作并列 —— 它不做别的,只在标脏时写一次盘。
    this.flushDroppedUndelivered();
    // 先补挂:目录在两次 tick 之间回来了的话,这一跳就把它接上(MC-020)。它只对
    // `watcher === null` 且退避到点的目录动手,不会成为高频轮询。
    this.retryWatchers();
    // 别把另一个写者删除/换成合法空 JSON 的历史当成空白首次安装。
    // 要在本分钟 lastMinute 的首次持久写入之前检查内容一致性。
    this.validateTriggerClaimsStore();
    this.validateLastMinutesStore();
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    for (const trigger of this.all()) {
      if (trigger.disarmed || trigger.spec.kind !== "schedule") continue;
      if (!cronMatches(trigger.spec.cron, now)) continue;
      // 旧版坏 JSON 变空 Map 后会照常派发，并把坏原件覆盖成新领取，
      // 丢失 crash/CLAIMED 的去重事实。必须在 lastMinute 第一笔写盘之前挡住。
      if (!this.triggerClaimsReadable || !this.lastMinutesReadable) {
        this.skip(trigger, !this.triggerClaimsReadable
          ? "定时领取账本损坏或不可读，已拒绝派发；请先检查并恢复原始存档"
          : "定时去重账本损坏或与历史不一致，已拒绝派发；请先检查并恢复原始存档");
        continue;
      }
      const key = triggerKey(trigger);
      // **同一分钟只跑一次**(30 秒一跳会看两次)。不去重的话 `*/1 * * * *` 一分钟两次。
      // 这条记忆**跨重启**(见 `lastMinute` 的说明):重启后那一跳看到的还是"本分钟
      // 已经跑过",所以不会因为开了一次应用而多跑一次。
      if (!shouldFireThisMinute(this.lastMinute.get(key), minute)) continue;
      // 【MC-051】去重记录必须先**真的落盘**,才能派发。从前 `rememberLastMinute` 走
      // `SettingRepo.set` → **异步** persist(还吞错),于是"记下了"与"落盘了"之间有
      // 一个窗口:应用若在这个窗口里被杀 / 断电,重启后表里没有这一分钟 → 这一跳再跑
      // 一次。对**有外部副作用**的自动化(通知、写文件、调外部 API),那就是重复执行。
      //
      // 这里把它变成一道闸:**落不盘就不派发**。写不进去说明存储此刻是坏的,那一分钟
      // 的这次触发**跳过并如实记账**(不是静默),等下一次 tick / 下一个分钟照常——
      // 与 MC-028 同一条思路(声称 durable 的关口必须看返回值,而不是转圈重试)。
      if (!this.rememberLastMinuteDurable(key, minute, minute)) {
        log.warn(`[automation] 「${trigger.title}」这一分钟的去重记录没能落盘,跳过这次触发(避免存盘失败时的重复外部执行)`);
        this.skip(trigger, "这一分钟的去重记录没能落盘,已跳过这次触发");
        continue;
      }
      // 【MC-051】去重表(上一道闸)回答的是"这一分钟碰过没有" —— 它**当场就把这一格
      // 记成"跑过"**,哪怕后面 `fire` 根本没派发出去(项目没了 / 上一次还在跑 / 起跑
      // 抛错)。真正**可追踪的领取**是这一条:先 durable 写一条 `CLAIMED`,再派发;
      // 运行收尾 durable 结算成 `SUCCEEDED`。崩溃重启后,盘上任何仍是 `CLAIMED` 的
      // 领取都会被 `recoverIncompleteClaims` 认出来 —— **不重复执行**,也不静默丢弃,
      // 而是报成一次"上一次的运行结果不确定"。
      //
      // 与去重表同一条红线:**落不盘就不派发**。领取与去重各是一次同库 fsync,而定时
      // 触发本来就一分钟最多一次 —— 这点开销换"领取→执行"有一个真正 durable 的边界。
      const claimId = scheduleClaimId(key, minute);
      // 【自动化事件去重·重放】去重表不是唯一的事实来源:它可能丢(坏 JSON 当空表 /
      // 历史修剪 / 搬库),系统时钟也可能回拨到同一分钟。而**持久化领取账本**里
      // `workflowId:nodeId@minute` 已是终态 = 这一分钟**确实执行过**(SUCCEEDED/FAILED/
      // UNCERTAIN 都是"这一格已消费,不再重跑"—— 后者按 claimRecoveryReason 的口径
      // 明说"如需重跑请手动运行一次")。只查 lastMinute 的话,去重表一丢就会把同一
      // 事件键再执行一遍,对带外部副作用的自动化就是重复副作用。
      //
      // 命中终态:记账后跳过(记账失败也不影响跳过 —— 判据是账本,不是它),并把原因
      // 记进事实,界面看得见"为什么这一分钟没跑"。
      const knownClaim = this.triggerClaims.get(claimId);
      if (knownClaim !== undefined && isTerminalClaimStatus(knownClaim.status)) {
        this.rememberLastMinute(key, minute, minute); // 让后续 tick 走上面那道静默闸
        this.skip(trigger, "这一分钟已经执行过(持久化领取账本为终态),不重复执行");
        continue;
      }
      if (!this.writeTriggerClaimDurable(claimId, { status: "CLAIMED", minute, at: now.getTime() })) {
        log.warn(`[automation] 「${trigger.title}」这一分钟的领取记录没能落盘,跳过这次触发(避免领取不 durable 时的重复外部执行)`);
        this.skip(trigger, "这一分钟的领取记录没能落盘,已跳过这次触发");
        continue;
      }
      this.fire(trigger, { kind: "schedule", at: now.getTime() }, { claimId });
    }
  }

  /**
   * 记下「这一条定时触发器刚刚在这一分钟跑过」,并把这张表落到磁盘(见
   * `LAST_MINUTE_SETTING_KEY`)。
   *
   * `minute` 给 `null` = 这条触发器没了(被删 / 改了触发方式),把它那一格抹掉。
   *
   * ## 为什么值没变就不写
   *
   * ticker 是 30 秒一跳,而 `SettingRepo.set` 内部会 `persist()` —— **重写整个数据库
   * 文件**。每条定时触发器每个 tick 都写一次的话,一台挂十条定时自动化的机器就是每天
   * 近三万次整库重写,而这表里绝大多数时候一个字都没变(同一分钟里第二跳的 `minute`
   * 与第一跳完全相同)。所以这里只在**真的变了**的时候落盘,而"变了"按分钟算 ——
   * 同一触发器同一分钟最多更新一次；大量触发器仍各自先记去重、再尝试派发。
   */
  private rememberLastMinute(
    key: string,
    minute: number | null,
    protectedMinute = Math.floor(Date.now() / 60_000),
  ): void {
    if (!this.validateLastMinutesStore()) return;
    if (minute === null) {
      if (!this.lastMinute.has(key)) return;
      this.lastMinute.delete(key);
    } else {
      if (this.lastMinute.get(key) === minute) return;
      this.lastMinute.set(key, minute);
    }
    this.writeLastMinutes(protectedMinute);
  }

  /**
   * 【MC-051】与 {@link rememberLastMinute} 同一件事,但**同步落盘并返回是否成功** ——
   * 定时触发**派发之前**必须先过这一关。
   *
   * ## 为什么它与 `rememberLastMinute` 分开
   *
   * `rememberLastMinute` 是"记账"(还负责历史修剪、给 `apply` 的一族清理调),它的落盘走
   * `SettingRepo.set` 内部的**异步** persist、且吞错 —— 对"这一格记没记住"是够的,但定时
   * 触发要的比"记住"更强:它要保证**在外部副作用发生之前,去重这件事已经不可撤销地写进
   * 磁盘**。否则应用在"内存已改、文件未写"的窗口里被杀,重启后这一分钟又会跑一次 —— 对
   * 有外部副作用的自动化就是重复执行。
   *
   * 所以这里改成:写内存 → `SettingRepo.set`(写 SQLite 内存库)→ `commitNow()`
   * (**同步** fsync 到文件,**结构化**结果)。非 `DURABLE` / 任一步抛错即**回滚内存行与
   * 那一格并**返回 `false`,调用方据此**跳过这次触发**,而不是照常 fire。
   *
   * ⚠️ 不做无限重试:存储真坏了时重试只会转圈。跳过并记一行日志,下一个 tick / 分钟照常。
   *
   * ⚠️ 与 `writeLastMinutes` 的修剪口径保持一致(本分钟那些必留、历史封顶),这样同步
   * 落盘与异步记账写出去的是同一张表,不会互相覆盖出"历史忽多忽少"。
   */
  private rememberLastMinuteDurable(key: string, minute: number, protectedMinute: number): boolean {
    if (!this.validateLastMinutesStore()) return false;
    if (this.lastMinute.get(key) === minute) return true; // 本分钟已记过(同 tick 第二跳)→ 直接放行
    const prev = this.lastMinute.get(key);
    this.lastMinute.set(key, minute);
    // 【ARC-005】落盘前先记下这一格在**内存表**里的旧值 —— 非 durable 时要连它一起还原
    // (见 `rollbackSettingRow`:只回滚 JS Map 不够,`SettingRepo.set` 已经改过 sql.js 的内存行)。
    const priorRaw = SettingRepo.get(LAST_MINUTE_SETTING_KEY);
    try {
      const rows = [...this.lastMinute.entries()].sort((a, b) => b[1] - a[1]);
      let historyCount = 0;
      const kept = rows.filter(([, m]) => {
        if (m === protectedMinute) return true;
        historyCount += 1;
        return historyCount <= LAST_MINUTE_HISTORY_KEEP;
      });
      if (kept.length < rows.length) this.lastMinute = new Map(kept);
      SettingRepo.set(LAST_MINUTE_SETTING_KEY, JSON.stringify(Object.fromEntries(kept)));
      // 【ARC-005】同步 fsync 走**结构化**结果:非 `DURABLE` 一律当失败(派发前必须是 durable 的)。
      const commit = commitNow();
      if (isDurable(commit)) return true;
      this.rollbackSettingRow(LAST_MINUTE_SETTING_KEY, priorRaw);
      this.rollbackLastMinute(key, prev);
      log.warn(`[automation] 定时去重表没能同步落盘:${commit.reason ?? commit.outcome}`);
      return false;
    } catch (err) {
      // 写内存库(SettingRepo.set)、读旧值等任一环抛错 → 回滚内存那一格 + 那一行。
      this.rollbackSettingRow(LAST_MINUTE_SETTING_KEY, priorRaw);
      this.rollbackLastMinute(key, prev);
      log.warn(`[automation] 定时去重表没能同步落盘:${(err as Error).message}`);
      return false;
    }
  }

  /** 把 `lastMinute` 里那一格还原到先前(没有则删)—— 与"内存表"的回滚配套。 */
  private rollbackLastMinute(key: string, prev: number | undefined): void {
    if (prev === undefined) this.lastMinute.delete(key);
    else this.lastMinute.set(key, prev);
  }

  /**
   * **定时触发的 durable 领取纪律**(MC-051)。
   *
   * 去重表(上面的 `rememberLastMinuteDurable`)回答的是"这一分钟碰过没有" —— 它当场
   * 就把这一格记成"跑过",哪怕后面根本没派发出去。This is what makes the "领取任务→执行"
   * 边界不完整:崩溃重启后,盘上没有"这一分钟碰过没有"以外的任何东西,分不清
   * 「领取了、完成了」与「领取了、进程就没了」。本方法写一条**可追踪的领取** ——
   * `CLAIMED`(派发前 durable)或 `SUCCEEDED`(运行收尾 durable),崩溃点上残留的
   * `CLAIMED` 由 {@link recoverIncompleteClaims} 认出来。
   *
   * 落盘走**唯一**那条 durable 通路(`SettingRepo.set` + `commitNow` 的结构化结果,判据
   * `isDurable`),与 `lastMinute` 和 MC-084 的 `DurableOperationLedger` 同一份 ——
   * 绝不另立第二套写盘机制。非 durable 即回滚内存行 + JS Map 并返回 `false`,调用方据此
   * **拒绝派发**(不是转圈重试)。
   */
  private writeTriggerClaimDurable(claimId: string, claim: TriggerClaim): boolean {
    // 定时 tick 之外，恢复/异步结算也可能走此方法；写盘之前再次核对，
    // 避免用过时 Map 覆盖另一个 writer 的持久化历史。
    if (!this.validateTriggerClaimsStore()) return false;
    const prev = this.triggerClaims.get(claimId);
    // **单调性**:终态(`SUCCEEDED`/`FAILED`/`UNCERTAIN`)不许被迟到的 `CLAIMED` 覆盖回去
    // (见文件头那条"崩溃点不能被后来的内存值骗到")。终态之间可以互相推进(正常路径不会,
    // 但恢复时 `CLAIMED`→`UNCERTAIN` 与收尾时跑出 `FAILED` 都走这里)。这里只为防御。
    if (prev !== undefined && isTerminalClaimStatus(prev.status) && claim.status === "CLAIMED") return true;
    this.triggerClaims.set(claimId, claim);
    // 【ARC-005】落盘前先记下这一行在**内存表**里的旧值 —— 非 durable 时要连它一起还原。
    const priorRaw = SettingRepo.get(TRIGGER_CLAIMS_SETTING_KEY);
    try {
      const kept = pruneClaims(this.triggerClaims, TRIGGER_CLAIMS_HISTORY_KEEP);
      if (kept.size < this.triggerClaims.size) this.triggerClaims = kept;
      SettingRepo.set(TRIGGER_CLAIMS_SETTING_KEY, JSON.stringify(Object.fromEntries(kept)));
      // 【ARC-005】同步 fsync 走**结构化**结果:非 `DURABLE` 一律当失败(领取 / 结算在落盘之前不算数)。
      const commit = commitNow();
      if (isDurable(commit)) return true;
      this.rollbackSettingRow(TRIGGER_CLAIMS_SETTING_KEY, priorRaw);
      this.rollbackTriggerClaim(claimId, prev);
      log.warn(`[automation] 定时领取账本没能同步落盘:${commit.reason ?? commit.outcome}`);
      return false;
    } catch (err) {
      // 落盘失败 → 回滚内存那一格(JS Map **和** sql.js 内存行),免得内存说"领过了"而磁盘
      // 没有、下一次 `persist()` 又把这一行冲上去(下次重启被内存骗过去)。
      this.rollbackSettingRow(TRIGGER_CLAIMS_SETTING_KEY, priorRaw);
      this.rollbackTriggerClaim(claimId, prev);
      log.warn(`[automation] 定时领取账本没能同步落盘:${(err as Error).message}`);
      return false;
    }
  }

  /** 把 `triggerClaims` 里那一格还原到先前(没有则删)—— 与"内存表"的回滚配套。 */
  private rollbackTriggerClaim(claimId: string, prev: TriggerClaim | undefined): void {
    if (prev === undefined) this.triggerClaims.delete(claimId);
    else this.triggerClaims.set(claimId, prev);
  }

  /**
   * 【ARC-005】把 settings 里某一 key 还原到先前那一次读到的裸值。
   *
   * `SettingRepo.set` 改的是 **sql.js 的内存表**,`commitNow()` 才把它 fsync 到磁盘 —— 两者
   * **不是原子**的。非 durable 时只回滚 JS 侧的 `Map` 会留下一个幻影:内存行已经是新值,
   * 而 `commitNow` 失败又给后台 `persist()` 排了退避重试,于是**下一次成功落盘会把这一份
   * 调用方以为没写成的值冲上磁盘**。还原这一行(没有旧值就 `delete`)让"内存 == 磁盘"在出口成立。
   *
   * 还原本身**不走 durable**(内存回滚不需要再落盘 —— 磁盘没变),用普通 `set` / `delete` 的路径;
   * 它自己抛错就如实记日志(内存已污染),不再向上抛(调用方要的是"这次没能 durable"这个事实)。
   */
  private rollbackSettingRow(key: string, priorRaw: string | null): void {
    try {
      if (priorRaw === null) SettingRepo.delete(key);
      else SettingRepo.set(key, priorRaw);
    } catch (err) {
      log.error(`[automation] 回滚 settings 行「${key}」失败,本进程内存可能已污染:${(err as Error).message}`);
    }
  }

  /**
   * 核对内存领取快照和存档**内容**，不只是 JSON 形状。
   * 只有从未写过领取（内存 Map 空）时，真正缺失的 Setting 才是首次安装。
   * 拒绝外部删除、合法形状但丢行、同键状态倒退或另一 writer 插入新行：
   * 这些都不能被当前旧快照覆盖；绝不在此尝试自动修补/合并。
   *
   * 此闸门阻止可见的错账；跨 OS 进程在读/commit 之间替换仍需数据库 CAS/锁。
   */
  private validateTriggerClaimsStore(): boolean {
    if (!this.triggerClaimsReadable) return false;
    try {
      const raw = SettingRepo.get(TRIGGER_CLAIMS_SETTING_KEY);
      if (raw === null && this.triggerClaims.size !== 0) {
        throw new Error("领取历史记录在运行期间消失");
      }
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      if (!isTriggerClaims(parsed)) {
        throw new Error("领取账本 JSON 形状不正确");
      }
      const entries = Object.entries(parsed);
      if (entries.length !== this.triggerClaims.size || entries.some(([id, item]) => {
        const current = this.triggerClaims.get(id);
        return current === undefined
          || current.status !== item.status
          || current.minute !== item.minute
          || current.at !== item.at;
      })) {
        throw new Error("领取账本与当前已确认的历史记录不一致");
      }
      return true;
    } catch (err) {
      this.triggerClaimsReadable = false;
      log.error(`[automation] 定时领取账本损坏、丢失或被并行覆盖：已暂停定时派发且保留原件:${String(err)}`);
      return false;
    }
  }

  /** 读取 durable 领取账本：只有真正缺失才是空表；坏原件保留且锁住派发。 */
  private readTriggerClaims(): Map<string, TriggerClaim> {
    this.triggerClaimsReadable = true;
    try {
      const raw = SettingRepo.get(TRIGGER_CLAIMS_SETTING_KEY);
      if (raw === null) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!isTriggerClaims(parsed)) {
        this.triggerClaimsReadable = false;
        log.error("[automation] 定时领取账本损坏(形状不对)：已暂停所有定时派发，原始字节保留");
        return new Map();
      }
      return new Map(Object.entries(parsed));
    } catch (err) {
      this.triggerClaimsReadable = false;
      log.error(`[automation] 定时领取账本损坏或不可读：已暂停所有定时派发，原始字节保留:${(err as Error).message}`);
      return new Map();
    }
  }

  /**
   * 【MC-091 续】读回上一次进程留下的「被丢弃、未交付」欠账(见
   * {@link DROPPED_SETTING_KEY})。读不回来当空表,不抛(同 `readLastMinutes`)。
   */
  private readDroppedUndelivered(): Map<string, UndeliveredDrop> {
    try {
      const raw = SettingRepo.get(DROPPED_SETTING_KEY);
      if (raw === null || raw.length === 0) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!isUndeliveredDrops(parsed)) {
        log.warn("[automation] 未交付丢弃账读不回来(形状不对),当空表");
        return new Map();
      }
      // 【MC-091 续·启动竞态】**并入**已有内存表,不是覆盖 —— 万一启动窗口里已经记下
      // 一笔丢弃(先于这次读盘写进了 `this.droppedUndelivered`),覆盖会让它永久消失。
      // 同键时把盘上的历史欠账与内存里那一笔**相加**(两笔都还没交付),取较晚的时刻。
      const merged = new Map<string, UndeliveredDrop>(Object.entries(parsed));
      for (const [key, drop] of this.droppedUndelivered) {
        const prev = merged.get(key);
        merged.set(key, prev === undefined ? drop : { count: prev.count + drop.count, at: Math.max(prev.at, drop.at) });
      }
      return merged;
    } catch (err) {
      log.warn(`[automation] 未交付丢弃账读不回来,当空表:${(err as Error).message}`);
      return new Map();
    }
  }

  /* ─────────────────── 待派发批次的跨崩溃可见性 ─────────────────── */

  /**
   * 读回上一次进程留下的**待派发批次标记**(见 {@link PENDING_BATCH_SETTING_KEY})。
   * 读不回来当空表(同 `readDroppedUndelivered` 的立场:坏数据最多少报一次提示,
   * 不能让执行器起不来)。
   */
  private readPendingBatchMarks(): Map<string, PendingBatchMark> {
    try {
      const raw = SettingRepo.get(PENDING_BATCH_SETTING_KEY);
      if (raw === null || raw.length === 0) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!isPendingBatchMarks(parsed)) {
        log.warn("[automation] 待派发批次标记读不回来(形状不对),当空表");
        return new Map();
      }
      return new Map(Object.entries(parsed));
    } catch (err) {
      log.warn(`[automation] 待派发批次标记读不回来,当空表:${(err as Error).message}`);
      return new Map();
    }
  }

  /**
   * 把 `pendingBatchMarks` 落盘(按最近攒批时刻修剪)。值没变就不写(同
   * `flushDroppedUndelivered`)。`durable=true` 时走 `commitNow()` 同步 fsync 并返回
   * 是否 DURABLE —— 批次**开始攒**的那一次用 durable:标记必须先于任何派发可能,
   * 崩溃后才有证据。写失败只记日志、不挡攒批(可见性退化一次,不制造第二次副作用
   * 的风险 —— 与 MC-051「去重不 durable 就不派发」不同,这一步不是副作用闸门)。
   */
  private flushPendingBatchMarks(durable: boolean): boolean {
    try {
      const rows = [...this.pendingBatchMarks.entries()]
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, PENDING_BATCH_HISTORY_KEEP);
      const next = JSON.stringify(Object.fromEntries(rows));
      if (SettingRepo.get(PENDING_BATCH_SETTING_KEY) === next) return true;
      this.pendingBatchMarks = new Map(rows);
      SettingRepo.set(PENDING_BATCH_SETTING_KEY, next);
      if (!durable) return true;
      const commit = commitNow();
      if (isDurable(commit)) return true;
      log.warn(`[automation] 待派发批次标记没能同步落盘:${commit.reason ?? commit.outcome}`);
      return false;
    } catch (err) {
      log.warn(`[automation] 待派发批次标记写不进去:${(err as Error).message}`);
      return false;
    }
  }

  /**
   * 一次事件 / 文件路径被收进某一格:第一笔时 durable 写标记,之后只刷新内存计数。
   * 计数取"至少这么多"(单调不减):批次攒着期间条目只会被追加或按上限淘汰,淘汰掉的
   * 也算"曾经在这一批里"。
   */
  private notePendingBatch(trigger: LoadedTrigger, pending: PendingFire, kind: "file" | "event"): void {
    const count = Math.max(1, this.pendingBatchCount(pending));
    if (pending.batchMarked !== true) {
      pending.batchMarked = true;
      this.pendingBatchMarks.set(triggerKey(trigger), { kind, count, at: Date.now() });
      this.flushPendingBatchMarks(true);
      return;
    }
    const prev = this.pendingBatchMarks.get(triggerKey(trigger));
    if (prev === undefined) {
      // 标记被别处清掉(恢复路径按 at 比对只清崩溃残留)—— 重建一条,别让在飞的批次没有证据。
      pending.batchMarked = true;
      this.pendingBatchMarks.set(triggerKey(trigger), { kind, count, at: Date.now() });
      this.flushPendingBatchMarks(true);
      return;
    }
    if (count > prev.count) this.pendingBatchMarks.set(triggerKey(trigger), { ...prev, count });
  }

  /** 这一格此刻攒着多少条(与 `pendingItemsHeld` 同一口径:files + event.items)。 */
  private pendingBatchCount(pending: PendingFire): number {
    const items = pending.event?.kind === "event" ? (pending.event.items?.length ?? 0) : 0;
    return pending.files.length + items;
  }

  /**
   * 清除某条触发器的批次标记 —— 派发成立 / 明确跳过 / 配置作废 / 用户取消时调用。
   * 清除走普通 `SettingRepo.set`(异步 persist):崩在清除落盘之前只会让下次启动
   * 保守地报一次「不确定」,不会漏报。没有标记时是 no-op(不写盘)。
   */
  private clearPendingBatchMark(key: string): void {
    if (!this.pendingBatchMarks.has(key)) return;
    this.pendingBatchMarks.delete(key);
    this.flushPendingBatchMarks(false);
  }

  /**
   * **启动恢复**:上一次进程留下、这次启动读盘时仍在的批次标记 = 「有一批攒着的事件 /
   * 文件触发在派发前进程就没了」。按 `uncertain` 语义处理(与 `recoverIncompleteClaims`
   * 同一条纪律):
   *
   *  - **不自动补投** —— 那一批可能已经派发了一半、也可能完全没派发,补投会造出第二次
   *    外部副作用;要重跑由用户手动运行;
   *  - **必须可见** —— 记进触发器事实(`recordBlocked` + 用户能读的中文原因)并
   *    `log.warn`,界面那一栏说得出"上一次有一批没派发";
   *  - 处理完**清掉标记**(不重复报),并把清理落盘。
   *
   * 找不到对应触发器(工作流 / 节点已删)时只记日志 —— 没有界面位置挂这句话,但账
   * 不再留着(下次启动不再反复报同一笔)。
   */
  private recoverPendingBatches(): void {
    const crashed = this.crashedPendingBatchMarks;
    this.crashedPendingBatchMarks = new Map();
    if (crashed.size === 0) return;
    const now = Date.now();
    let cleared = false;
    for (const [key, mark] of crashed) {
      const trigger = this.all().find((t) => triggerKey(t) === key);
      const what = mark.kind === "file" ? "文件" : "事件";
      const reason = `上一次应用退出前有一批${what}触发(${mark.count} 条)攒着但未确认是否已派发,结果不确定;这次不自动补投,如需重跑请手动运行一次`;
      if (trigger !== undefined) this.facts.recordBlocked(triggerSeedOf(trigger), reason, now);
      log.warn(`[automation] 待派发批次「${key}」(${what} ${mark.count} 条)在上一次退出时未派发,${trigger === undefined ? "对应触发器已不存在" : "已记入事实"},不自动补投`);
      // 只清**这次启动读到的**那一条;启动后同一触发器新攒的批会重新写标记,
      // 不能被恢复路径顺手抹掉(按值比对:新标记的 at 一定不同)。
      const current = this.pendingBatchMarks.get(key);
      if (current !== undefined && current.at === mark.at) {
        this.pendingBatchMarks.delete(key);
        cleared = true;
      }
    }
    if (cleared) this.flushPendingBatchMarks(false);
  }

  /**
   * 【MC-091 续】把「被积压丢弃」累加进某个触发器的**未交付欠账**。**只改内存 + 标脏**;
   * 真正落盘由 {@link flushDroppedUndelivered} 按 `onTick`(30 秒)节流 —— 一条抖动 / 大批量的
   * 目录会在一次 `onFsChange` 风暴里连续丢上千条,每条都 `SettingRepo.set`(重写整个库文件)
   * 是不可接受的(同 `rememberLastMinute` 那条注释)。同一触发器反复丢弃只刷新**同一个键**,
   * 键数 = 有丢弃的触发器数,不会随丢弃次数增长。
   *
   * ⚠️ 与 MC-051「落不盘就不派发」那条红线**不同**:欠账不挡任何派发,落盘失败 / 崩溃前
   * 未及冲刷最多退化成"重启后**少报**一次积压",不造成重复的外部副作用 —— 所以节流的异步
   * 落盘足够。派发清账(`drainDroppedUndelivered`)与退出会**强制**冲刷,精度最坏一个 tick。
   */
  private recordDropped(key: string, dropped: number): void {
    if (dropped <= 0) return;
    const prev = this.droppedUndelivered.get(key);
    this.droppedUndelivered.set(key, { count: (prev?.count ?? 0) + dropped, at: Date.now() });
    this.droppedDirty = true;
  }

  /** 某条触发器**当前欠着多少条未交付的积压丢弃**(只读,不清)。见 {@link drainDroppedUndelivered}。 */
  private droppedCountOf(key: string): number {
    const entry = this.droppedUndelivered.get(key);
    return entry === undefined ? 0 : entry.count;
  }

  /**
   * 【MC-091 续·全局背压】此刻**所有触发器**攒着的条目总数。见 {@link GLOBAL_PENDING_LIMIT}。
   *
   * 只数两样:**每个 pending 的 `files`** 与 **`event.items`**。混合批次里那份
   * `externalEvent`(自我额度耗尽时的外部备用副本)**故意不数** —— 它恒是 `event` 里外部
   * 那部分的子集(同一 `itemId`、同一批),数它会把这批条目的内存占用**凭空翻倍**,
   * 而它自身又被 `MAX_EVENT_ITEMS` 逐条压着、不可能单独越界。所以数 `files + event.items`
   * 就是对"执行器此刻握着多少条元素"的诚实计量。
   *
   * 现算而不是维护一个增量计数器:攒着的那几格(`pendingFires`)本来就被触发器数量压着
   * (个位到几十),而所有删除点(`rearm` 的 `pendingFires.delete`、`apply` / 取消 / `dispose`
   * 的整表清、忙时重建)都要同步减计数 —— 漏一个就是一次"内存里对、计数错"的静默漂移,
   * 那比每到点扫一遍贵得多。判据宁可每次算准,也不要维护一份会漂的影子数。
   */
  private pendingItemsHeld(): number {
    let total = 0;
    for (const [, pending] of this.pendingFires) {
      total += pending.files.length;
      if (pending.event?.kind === "event") total += pending.event.items?.length ?? 0;
    }
    return total;
  }

  /**
   * 【MC-091 续·全局背压】全局预算里还放得下 `add` 条吗?
   *
   * 放得下 → `true`(调用方照常收进本格)。放不下 → **不放行**,并把 `add` 条如实记进
   * 恢复游标(`recordDropped`,于是界面与下一次派发的载荷都读得到"这台机器满过"),返回
   * `false`。**绝不静默丢** —— 与 `addToFileBacklog` / `mergeEventPayload` 同一条红线。
   */
  private admitGlobal(key: string, add: number): boolean {
    if (this.pendingItemsHeld() + add <= GLOBAL_PENDING_LIMIT) return true;
    this.recordDropped(key, add);
    return false;
  }

  /**
   * 【MC-091 续】清掉某条触发器的未交付欠账 —— 一次**真的派发了载荷**的运行把这份积压
   * **交付**了(欠账已并进它的载荷事实),不该在更晚的运行里重复报同一笔。清账**立即落盘**,
   * 否则重启后会把已经报过的那一笔又报一遍。
   */
  private drainDroppedUndelivered(key: string): void {
    if (!this.droppedUndelivered.has(key)) return;
    this.droppedUndelivered.delete(key);
    this.droppedDirty = true;
    this.flushDroppedUndelivered(true);
  }

  /**
   * 把内存里的欠账写回 settings(按"最近丢弃"修剪,同 `writeLastMinutes` 的立场)。
   * `force=false` 时**只在标脏后**写、写完清脏(节流);`force=true`(派发清账 / 退出)无视脏
   * 标记直接写。值没变就不写(`SettingRepo.set` 会整库重写)。写不进去只记日志,不影响运行。
   */
  private flushDroppedUndelivered(force = false): void {
    if (!force && !this.droppedDirty) return;
    try {
      const rows = [...this.droppedUndelivered.entries()]
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, DROPPED_HISTORY_KEEP);
      const next = JSON.stringify(Object.fromEntries(rows));
      if (SettingRepo.get(DROPPED_SETTING_KEY) === next) { this.droppedDirty = false; return; }
      this.droppedUndelivered = new Map(rows);
      SettingRepo.set(DROPPED_SETTING_KEY, next);
      this.droppedDirty = false;
    } catch (err) {
      log.warn(`[automation] 未交付丢弃账写不进去(重启后可能少报一次积压):${(err as Error).message}`);
    }
  }

  /**
   * 【MC-091 续】把 `mergeEventPayload` 的结果记进 pending,并把它**内部新丢的**事件条目数
   * 落进未交付欠账(见 {@link recordDropped})。
   *
   * 事件条目的容量上限与去重**只有一份逻辑**(在 `mergeEventPayload` 里);这里只负责
   * "这一次比上一次多丢了几条"的**差分**,不重抄那份截断。差分是完备的:同一批的欠账
   * 落到盘上后,重启 / 批次作废都不会把它弄丢。
   */
  private mergeEventInto(
    prior: TriggerPayload | undefined,
    event: HookEvent,
    facts: { toolName?: string; subjects?: readonly string[] },
    item: Parameters<typeof mergeEventPayload>[3],
    key: string,
  ): TriggerPayload {
    const before = prior?.kind === "event" ? (prior.itemsOverflowDropped ?? 0) : 0;
    // 【MC-091 续·全局背压】一条**新的**事件条目要进全局预算(`GLOBAL_PENDING_LIMIT`)。
    // 整台机器触顶时不收这一条(`admitGlobal` 已把丢弃记进恢复游标);事件名 / 工具名 /
    // 主语照旧覆盖 —— 它们说的是"这是个什么事件",与条目容量无关(同 `mergeEventPayload`
    // 的"谁覆盖、谁累加")。已见过的重条目不重复占预算(`payloadHoldsItem`),与本地去重一致。
    const isNewItem = item !== undefined && !this.payloadHoldsItem(prior, item.itemId);
    const admitted = !isNewItem || this.admitGlobal(key, 1);
    const merged = mergeEventPayload(prior, event, facts, admitted ? item : undefined);
    const after = merged.kind === "event" ? (merged.itemsOverflowDropped ?? 0) : 0;
    if (after > before) this.recordDropped(key, after - before);
    return merged;
  }

  /** `prior` 事件载荷里是否已经有这条 `itemId` 的条目(去重判据,与 `mergeEventPayload` 同口径)。 */
  private payloadHoldsItem(prior: TriggerPayload | undefined, itemId: string | undefined): boolean {
    if (prior?.kind !== "event" || itemId === undefined) return false;
    return (prior.items ?? []).some((existing) => existing.itemId === itemId);
  }

  /**
   * **重启恢复:把盘上那些没确认完成的领取认出来**(MC-051)。
   *
   * 盘上任何仍是 `CLAIMED` 的领取,都是"上一个进程在执行途中消失了" —— 它**绝不重复
   * 执行**(去重红线由 `lastMinute` 的跨重启记忆兜住:那一分钟已经记过,`shouldFireThisMinute`
   * 不会再放它进 onTick),但也**不被静默丢弃**:转成 `UNCERTAIN`(终态,不再每次重启
   * 反复报告同一件事),并把「上一次的运行结果不确定」记进事实表,让界面看得见。
   *
   * 于是崩溃的时间点各归各位:
   *  - 崩在**领取写盘之前** → 盘上没这一行 → 重启后能正常执行(这一分钟还没被记过);
   *  - 崩在**领取写盘之后、执行之前/之中** → 盘上是 `CLAIMED` → 不重复执行,报 UNCERTAIN;
   *  - 崩在**执行之后、结算之前** → 同上(结果不确定 —— 外部副作用可能已经发生);
   *  - 崩在**结算之后** → 盘上是 `SUCCEEDED` → 什么都不用做。
   *
   * 由 `start()` 在 `reloadAll()` 之后、启动 tick 之前调用。
   *
   * 【MC-091 E3】恢复把 `CLAIMED` 转成 `UNCERTAIN`(不是 `SUCCEEDED`)—— "拿不到结果"
   * 与"下游成功"是两件事,不再混同。
   */
  private recoverIncompleteClaims(): void {
    const pending = pendingClaims(this.triggerClaims);
    if (pending.length === 0) return;
    const now = Date.now();
    for (const claimId of pending) {
      const triggerKeyOf = triggerKeyOfClaim(claimId);
      const claim = this.triggerClaims.get(claimId);
      if (triggerKeyOf === null || claim === undefined) continue;
      // 先转成终态 `UNCERTAIN` 并 durable 落盘 —— 这样下次重启不会再把它当"待恢复"
      // 反复报。它仍是"没确认完成"这条历史事实,只是处置过了。
      this.writeTriggerClaimDurable(claimId, { ...claim, status: "UNCERTAIN", at: now });
      // 找到这条触发器,把它的事实记成一次"该跑而结果不确定"。找不到(工作流 / 触发器
      // 已经删了)就不记 —— 没有界面位置挂这句话,而账本那一行仍在。
      const trigger = this.all().find((t) => `${t.workflowId}:${t.nodeId}` === triggerKeyOf);
      if (trigger !== undefined) {
        this.facts.recordBlocked(triggerSeedOf(trigger), claimRecoveryReason(), now);
      }
      log.warn(`[automation] 领取「${claimId}」没有确认完成,不重复执行;如需重跑请手动运行一次`);
    }
  }

  /**
   * 一条定时领取**收尾结算**。没有对应领取就什么都不做。
   *
   * 【MC-091 E3】收尾分两种口径:
   *
   *  - **没指定业务结果**(`outcome === undefined`):这是"派发**没真的成立**、决策已落定"
   *    的那一组收尾(工作流删了 / 修订变了 / 关掉了 / 项目没了 / 上一次还在跑)。结算成
   *    `SUCCEEDED`,语义是"这一格领取被确定地关上、不会待恢复",**不是**下游业务成功 ——
   *    原因由 `skip()` 记进 `AutomationFacts.lastError`。
   *  - **指定了业务结果**(派发真的成立、运行 promise 收尾):按
   *    {@link AutomationRunOutcome} 落 `SUCCEEDED` / `FAILED` / `UNCERTAIN`,并给 FAILED /
   *    UNCERTAIN 记一条可读的事实,让界面分得出「成功 / 失败 / 结果不确定」。
   */
  private settleTriggerClaim(claimId: string | undefined, outcome?: AutomationRunOutcome): void {
    if (claimId === undefined) return;
    const prev = this.triggerClaims.get(claimId);
    if (prev === undefined) return;
    const status = outcome === undefined ? "SUCCEEDED" : claimStatusOfRunOutcome(outcome);
    const now = Date.now();
    this.writeTriggerClaimDurable(claimId, { status, minute: prev.minute, at: now });
    // FAILED / UNCERTAIN(业务层面)要让人看得见 —— 成功不记(界面那一栏"最近一次跑过"
    // 由 `recordFired` 说,不需要再挂一句"成功了")。
    if (outcome === "failed" || outcome === "uncertain") {
      const triggerKeyOf = triggerKeyOfClaim(claimId);
      const trigger = triggerKeyOf === null ? undefined : this.all().find((t) => `${t.workflowId}:${t.nodeId}` === triggerKeyOf);
      if (trigger !== undefined) {
        this.facts.recordBlocked(
          triggerSeedOf(trigger),
          outcome === "failed" ? claimFailureReason() : claimCancelledReason(),
          now,
        );
      }
    }
  }

  /**
   * 把 `lastMinute` 写进 settings。写不进去会记录失败；
   * 已检测到原始记录损坏时不得再写，避免抹掉用户的去重事实。
   *
   * ## 上限是给谁准备的
   *
   * 上限之所以必要:`persist()` 重写整库,而 `apply` 只清"这个工作流里没了的那条触发器
   * 的 key"(那一路是按 reload 走的)。**整个工作流被删掉**时它的那些 key 就再没人来清
   * —— 启动时的 `reloadAll` 只遍历现在还在的工作流。一条 old key 本身无害(它只在"新建
   * 的触发器恰好复用了同一个 `workflowId:nodeId`"时才会误吞一次,而那些 id 都是 `uid()`
   * 现生成的),但攒着就是白占一次整库重写的字节。所以修剪放在写入前,按"最久没跑过"丢。
   */
  private writeLastMinutes(protectedMinute: number): void {
    // 已检测出坏账时不能通过配置刷新/恢复路径再次覆盖原始证据。
    if (!this.lastMinutesReadable) return;
    try {
      // Retain every key for the current tick. Only OTHER minutes compete for
      // the historical budget; the same retained rows go to memory and settings.
      const rows = [...this.lastMinute.entries()].sort((a, b) => b[1] - a[1]);
      let historyCount = 0;
      const kept = rows.filter(([, minute]) => {
        if (minute === protectedMinute) return true;
        historyCount += 1;
        return historyCount <= LAST_MINUTE_HISTORY_KEEP;
      });
      if (kept.length < rows.length) {
        // Apply the same historical cleanup to memory and persisted settings.
        // Current-minute keys must remain in both until that minute is over.
        this.lastMinute = new Map(kept);
      }
      SettingRepo.set(LAST_MINUTE_SETTING_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch (err) {
      log.warn(`[automation] 定时去重表写不进去(重启后同一分钟可能多跑一次):${(err as Error).message}`);
    }
  }

  /**
   * 读回上次进程的耐久去重历史。不存在才视为首次初始化；损坏/拒读
   * 保留原始 Settings 字节，锁住 schedule 的派发，但不让整个 UI/执行器启动失败。
   * 数据库尚未就绪也会被记录为阻断，不能退化成允许重复外部副作用。
   */
  private validateLastMinutesStore(): boolean {
    if (!this.lastMinutesReadable) return false;
    try {
      const raw = SettingRepo.get(LAST_MINUTE_SETTING_KEY);
      if (raw === null && this.lastMinute.size !== 0) {
        throw new Error("已认可的去重历史在运行期间消失");
      }
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      if (!isLastMinutes(parsed)) throw new Error("去重历史形状不正确");
      const entries = Object.entries(parsed);
      if (entries.length !== this.lastMinute.size || entries.some(([key, value]) =>
        this.lastMinute.get(key) !== value
      )) {
        throw new Error("去重历史与内存中的已认可记录不一致");
      }
      return true;
    } catch (err) {
      this.lastMinutesReadable = false;
      log.error(`[automation] 定时去重账本损坏、丢失或被并行更改：暂停定时派发并保留原件:${String(err)}`);
      return false;
    }
  }

  private readLastMinutes(): Map<string, number> {
    this.lastMinutesReadable = true;
    try {
      const raw = SettingRepo.get(LAST_MINUTE_SETTING_KEY);
      if (raw === null) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!isLastMinutes(parsed)) {
        // setting 是用户数据,可能被手改坏 —— 坏的一整份丢掉(与 `loadWatchTemplates`
        // 逐条过 schema 同一个立场,只是这里没有"坏的那一条还能用"这回事:
        // 一格坏值就让整张表当空,代价只是重启后可能多跑一次)。
        this.lastMinutesReadable = false;
        log.error("[automation] 定时去重账本损坏(形状不对)：暂停全部定时派发并保留原件");
        return new Map();
      }
      return new Map(Object.entries(parsed));
    } catch (err) {
      this.lastMinutesReadable = false;
      log.error(`[automation] 定时去重账本损坏或不可读：暂停全部定时派发并保留原件:${(err as Error).message}`);
      return new Map();
    }
  }

  /** 文件变化:`fs.watch` 那一路。`filename` 可能是 null(平台差异)。`eventType` 是
   *  `fs.watch` 给的事件类型(`"rename"` / `"change"` / 平台相关的其它值 / null)—— 合成
   *  结构化 `FileChange` 的输入之一(见 `classifyFileChange`)。 */
  private onFsChange(dir: string, filename: string | null, eventType: string | null = null): void {
    // `filename` 给不出时用目录本身去比:那能匹配 `**` 这类规则;匹配不上具体的
    // `*.md` 也不冤 —— 平台没说改的是哪个文件,而"整个目录里有东西动了"是它给的全部。
    const abs = filename === null ? dir : join(dir, filename);
    // 【ARC-015③】**越界防线。** `join(dir, filename)` 会把 `..` 归约掉,一个越界的
    // `filename`(如 `../secret.md`)于是解析到**被监听根之外**的路径,再配一条泛化
    // glob 就可能命中 —— 已授权 workspace 被一条相对路径悄悄走出(验收:「不逃出已授权
    // workspace」)。这里用**字面前缀**判定(不 realpath,不碰磁盘),越界就**记一行并丢弃**,
    // 不静默。`filename === null` 那条用 `dir` 本身,必在根内,不受影响。
    //
    // 关于**目录 symlink/junction 逃逸**:实测(win32 / Node 22)`fs.watch(dir,{recursive:true})`
    // **不会跟**一个指向根外的 in-tree junction 走 —— 从那个 junction 写进去的文件不产生任何
    // 事件(只有根内直写才有事件);所以运行期并不存在"靠 junction 把监听引到根外"这条路径。
    // 真正的缺口是**字面路径解析**,由上面这道前缀判定堵上。
    if (filename !== null && !isWithinWatchRoot(abs, dir)) {
      log.warn(`[automation] 丢弃越出监听根的路径事件:${String(filename)}(根 ${dir})`);
      return;
    }
    // 【ARC-015】默认忽略目录(node_modules/dist/…)的性能价值仍保留,但**不再无条件**盖住用户
    // 显式选的触发源 —— 判定移到**每个触发器**里,由 shouldIgnoreWatchPath 结合该触发器的 include
    // glob 与 defaultIgnorePolicy 决定「dist/*.js 构建完后处理」这类场景能否生效。
    const rawIgnored = filename !== null && filename.split(/[\\/]/).some((seg) => WATCH_IGNORED_DIRS.has(seg));
    // **先 glob 后问盘**(顺序的理由见原注释:glob 是纯字符串比、`existsSync` 是一次系统调用;
    // 项目里多数事件匹配不上任何 glob)。但 `classifyFileChange` 要一次 "此刻在不在" —— 用个
    // 记忆化的惰性求值,让这一趟最多只 stat 一次,且**只在真有触发器命中该 glob 之后**才发生。
    let statCache: boolean | undefined;
    const existsNow = (): boolean => (statCache ??= existsSync(abs));
    for (const trigger of this.all()) {
      if (trigger.disarmed || trigger.spec.kind !== "file" || trigger.cwd !== dir) continue;
      if (rawIgnored && shouldIgnoreWatchPath(filename ?? "", trigger.spec.globs, trigger.spec.defaultIgnorePolicy)) continue;
      // 绝对路径与**相对这个触发器项目目录**的路径都试一遍(同 `fileSubjects` 的理由:
      // 用户写下的是 `src/*.ts` 还是 `*.ts`,两种都有)。
      const subjects = fileSubjects([abs], trigger.cwd);
      if (!trigger.spec.globs.some((glob) => subjects.some((s) => matchesGlobList(glob, s)))) continue;
      // 可选排除规则也用同一组绝对/相对主语与 glob 语义。只排除明确命中的路径
      // (平台不给文件名时,按上面的约定只拿目录本身来匹配);不按"自动化正在运行"一概吞事件。
      if (trigger.spec.excludeGlobs.some((glob) => subjects.some((s) => matchesGlobList(glob, s)))) continue;
      // glob 全部通过后才问盘(见上 `statCache` 的注释)。
      const present = existsNow();
      // 【ARC-015①】**不再**"不存在就 continue" —— 那正是删除/改名方向无处表达的根因。
      // 改成:先看这一格**之前见过这个路径没有**(`seenBefore`),再据此合成结构化方向。
      // 从没见过的、且此刻不在的 → 转瞬即逝的临时文件,没什么好说,跳过(不建空的一格)。
      const existing = this.pendingFires.get(triggerKey(trigger));
      const seenBefore =
        (existing?.files.includes(abs) ?? false) || (existing?.changes.has(abs) ?? false);
      const kind = classifyFileChange(eventType, present, seenBefore);
      if (!present && !seenBefore) continue;
      const pending = this.pendingOf(trigger);
      // **方向记在 changes 里**(last-write-wins):删除/改名的路径进不了 `files`(那份只装
      // "存在、要办"的),但它的方向必须留下来 —— 否则模型看不出"这个文件是被删了"。
      // changes 与 files 是**同一批路径**(见 PendingFire.changes 的说明),一并按上限收口,
      // 免得一条抖动的目录把方向表也顶到无限长。丢的条数只由 `files` 那一侧统计一次。
      // 收口走**唯一一份** `capOldest`(MC-091 统一截断原语):加**新**路径时才裁,先丢到
      // `limit-1` 再 set 新路径(与 `files` 那一路同一取舍:丢最早的)。已在表里的路径是
      // 原地更新值(不重排、不触发裁剪),与从前 `Map.set` 的行为一致。
      if (!pending.changes.has(abs) && pending.changes.size >= PENDING_FILES_LIMIT) {
        const { kept } = capOldest([...pending.changes.entries()], PENDING_FILES_LIMIT - 1);
        pending.changes = new Map(kept);
      }
      pending.changes.set(abs, kind);
      if (present && !pending.files.includes(abs)) {
        // 【MC-091 续·全局背压】这一条要进全局预算(`GLOBAL_PENDING_LIMIT`)。整台机器攒着
        // 的条目触顶时**不收这一条**,并如实记进恢复游标(`admitGlobal` 内部做)—— 与单条
        // 那一路同一个「丢要报出来」的立场。方向仍留在 `changes` 里(那一份按单条上限收口,
        // 不占全局的**文件**预算),计时器照旧往后推,不丢"这一格还在动"的事实。
        if (!this.admitGlobal(triggerKey(trigger), 1)) {
          pending.busyRetryMs = undefined;
          this.rearm(pending, WATCH_SETTLE_MS + trigger.spec.debounceMs);
          continue;
        }
        // 上限(见 `PENDING_FILES_LIMIT`):收进队列,超限时丢**最早**的几条。丢掉多少
        // **要说出来** —— 静默少办一件事是这一路最坏的坏法。【ARC-015】现在这层不只是
        // 一句 `log.warn`,通过 `addToFileBacklog` 把丢的条数**累加进 `pending.overflowDropped`**
        // (②),收口时并入载荷事实(`payload.overflowDropped`),让人话描述与 `data.trigger`
        // 都明说"输入不完整"。
        const { backlog, dropped } = addToFileBacklog(pending.files, abs, PENDING_FILES_LIMIT);
        pending.files = backlog;
        // 【MC-091 续】丢的条数**同步记进落盘欠账**(`automation.droppedUndelivered`)——
        // `pending.overflowDropped` 只在**内存**里,应用在合并窗口里重启 / 这一批被
        // 配置改动或用户取消作废时,它整份消失,"丢了几条"就静默没了。落盘那份是恢复游标:
        // 下一次真正派发的运行把欠账并进载荷事实、随后清账(见 {@link recordDropped})。
        if (dropped > 0) {
          pending.overflowDropped += dropped;
          this.recordDropped(triggerKey(trigger), dropped);
        }
      }
      // **来了新东西 → 回看间隔从头数。** 退避(见 `BUSY_RETRY_MIN_MS`)管的是
      // "一直没新输入、只是在上一次运行没结束时反复回看"这一种;新文件到达说明
      // 这一批**变了**,该尽快收口而不是接着等比等下去。
      pending.busyRetryMs = undefined;
      // 【跨崩溃可见性】这一批开始攒 / 又多了东西:先 durable 写标记(每格只写一次),
      // 进程若在合并窗口里被杀,重启后仍有证据说"有一批没派发"。放在累计之后,计数
      // 取的是这批此刻的真实条目数(文件 + 事件条目)。
      this.notePendingBatch(trigger, pending, "file");
      this.rearm(pending, WATCH_SETTLE_MS + trigger.spec.debounceMs);
    }
  }

  /** 事件流那一路。 */
  /** Resolve only automation-owned node/side ancestry. A normal chat using
   * the same workflow is still external. The visited set also handles corrupt cycles. */
  private automationSourceOf(sessionId: string): Session | undefined {
    const visited = new Set<string>();
    let id: string | null = sessionId;
    while (id !== null && !visited.has(id)) {
      visited.add(id);
      const session = SessionRepo.get(id);
      if (session === undefined) return undefined;
      if (session.kind === "automation") return session;
      if (session.kind !== "node" && session.kind !== "side") return undefined;
      id = session.parentSessionId ?? null;
    }
    return undefined;
  }

  private mergeEventChains(...chains: Array<readonly string[] | undefined>): string[] {
    return [...new Set(chains.flatMap((chain) => chain ?? []))];
  }

  private eventChainForRun(chain: readonly string[] | undefined, workflowId: string): string[] {
    const result = this.mergeEventChains(chain, [workflowId]);
    if (result.length > EVENT_CHAIN_LIMIT) {
      throw new Error(`自动化事件来源链超过${EVENT_CHAIN_LIMIT}个工作流，已停止扩张；请手动运行建立新链`);
    }
    return result;
  }

  /** Session-level ancestry of its latest automation dispatch. Not a universal
   * per-event causal trace: unattributed system/file events still start new roots. */

  private selfTriggerCount(workflowId: string): number {
    const raw = SettingRepo.get(SELF_TRIGGER_COUNT_PREFIX + workflowId);
    if (raw === null) return 0;
    const count = Number(raw);
    if (raw.trim().length === 0 || !Number.isInteger(count) || count < 0 || count > SELF_TRIGGER_LIMIT) {
      throw new Error("自触发计数损坏；请手动运行一次重置后继续");
    }
    if (count === 0) return 0;
    // **窗口过期就从头数**(见 `SELF_TRIGGER_AT_PREFIX`)。时刻读不回来/形状不对时
    // 按"还在窗口里"处理 —— 循环保护宁可严一点,也不能因为一格坏数据放开。
    const at = Number(SettingRepo.get(SELF_TRIGGER_AT_PREFIX + workflowId) ?? "");
    if (Number.isFinite(at) && at > 0 && Date.now() - at > SELF_TRIGGER_WINDOW_MS) return 0;
    return count;
  }

  /** 花掉一格额度(带时刻)。`0` = 清零(手动运行那一下)。 */
  private writeSelfTriggerCount(workflowId: string, count: number): void {
    // **值没变就不写** —— `SettingRepo.set` 内部 `persist()` 会重写整个库文件
    // (同 `rememberLastMinute` 那条注释)。
    const key = SELF_TRIGGER_COUNT_PREFIX + workflowId;
    if (SettingRepo.get(key) !== String(count)) SettingRepo.set(key, String(count));
    const atKey = SELF_TRIGGER_AT_PREFIX + workflowId;
    if (count === 0) {
      if (SettingRepo.get(atKey) !== null) SettingRepo.delete(atKey);
      return;
    }
    SettingRepo.set(atKey, String(Date.now()));
  }

  private selfTriggerBlockReason(workflowId: string): string | null {
    try {
      return this.selfTriggerCount(workflowId) >= SELF_TRIGGER_LIMIT ? SELF_TRIGGER_STOP_REASON : null;
    } catch (err) {
      return `无法读取自触发额度：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private onEvent(e: RuntimeEvent): void {
    const event = HOOK_EVENT_OF[e.type];
    if (event === null) return;
    // 与钩子同一条判据:"对话节点"跑完的那条 `turn.done` 是**图内部的一步**,用户那一轮
    // 还没结束(见 `RuntimeManager.holdTurnEnd`)。不挡的话,一张十步的图会把一条
    // `turn.done` 触发器叫起来十次。
    if (e.type === "turn.done" && runtimeManager.isTurnEndHeld(e.sessionId)) return;

    // A user's stop discards the pending next batch too. Otherwise its retry
    // timer would silently restart the automation just after cancellation.
    let cancelledWorkflow: string | undefined;
    if (e.type === "turn.done" && e.reason === "interrupted") {
      const source = SessionRepo.get(e.sessionId);
      if (source?.kind === "automation") {
        cancelledWorkflow = source.workflowId;
        for (const [key, pending] of this.pendingFires) {
          if (pending.trigger.workflowId !== cancelledWorkflow) continue;
          if (pending.timer !== null) clearTimeout(pending.timer);
          this.pendingFires.delete(key);
          // 用户按了停止 —— 排着的那一批也没了,别在界面上留一行永远不会开跑的「排队中」。
          this.facts.recordQueued(triggerSeedOf(pending.trigger), 0, Date.now());
        }
      }
    }

    // ⚠️ **一次事件只取一次事实。** `factsOf()` 是**有状态**的:`tool.result` 那个事件
    // 本身不带工具名,靠前面那条 `tool.use` 记下来的小表回查,而**回查即消费**
    // (见 `eventSubjects.ts`)。早先这里在循环里对每条触发器各调一次 `of()`,于是第一个
    // 触发器就把工具名取走了,后面那些拿到的是空 —— 两条 `tool.result` 触发器盯着同一个
    // 工具时,只有排在前面那条会响,而且是**安静地**不响。
    //
    // 事实取一次;主语是纯的,按每条触发器自己的 cwd 各算一遍(路径主语要看 cwd)。
    const facts = this.subjects.factsOf(e);
    // "这件事是关于哪一条"同样是**事件本身**的事实(资料库那两个事件有,其余没有)。
    // 与上面那条同理取一次 —— 它不是主语,不进 matcher(那两个事件压根没有可筛的维度)。
    const item = eventItemFactsOf(e);
    // 屏蔽**不管**自动化(2026-09-26 用户定的规矩:屏蔽只管给 AI 看的)。屏蔽了 pdf 的条目
    // 照样下载、照样转录 —— 转录出的 md 才是给模型看的那份。别在这里加屏蔽过滤。
    const source = this.automationSourceOf(e.sessionId);
    let sourceChain: string[] = [];
    let sourceError: string | undefined;
    try {
      const origin = automationOriginOf(e);
      if (origin) sourceChain = [...origin.workflowIds];
      else if (source) sourceChain = readAutomationEventChain(source);
    }
    catch (err) { sourceError = `自动化事件来源链读取失败：${err instanceof Error ? err.message : String(err)}`; }

    for (const trigger of this.all()) {
      if (trigger.workflowId === cancelledWorkflow) continue;
      if (trigger.disarmed || trigger.spec.kind !== "event" || !trigger.spec.events.includes(event)) continue;
      // 主语按**触发器自己的项目目录**算(相对路径那一份才有意义)。工具名那部分是
      // 上面取过一次的事实,与钩子共用同一份逻辑,不各记一份。
      const subjects = this.subjects.subjectsOf(e, trigger.cwd, facts.toolName);
      const { toolName } = facts;
      // `matcher` 是**分号/逗号分隔的一串**,按后缀 glob 比(见 `matchesAnyGlob`)。
      // 留空 = 不限制。**没给主语却写了 matcher → 不匹配**("配错了不跑"比"配错了却
      // 每次都跑"安全)。这与 `matchesAnyGlob` 对空主语返回 false 是同一条。
      if (trigger.spec.matcher.length > 0 && !matchesAnyGlob(trigger.spec.matcher, subjects ?? [])) {
        continue;
      }
      if (sourceError !== undefined) { this.skip(trigger, sourceError); continue; }
      // A return to ANY ancestor is a cycle, including A -> B -> A. Ordinary
      // A -> B traffic remains independent and does not spend the loop budget.
      const selfOrigin = sourceChain.includes(trigger.workflowId);
      if (selfOrigin) {
        const reason = this.selfTriggerBlockReason(trigger.workflowId);
        // Filter blocked self events BEFORE merging, so they cannot contaminate
        // an otherwise valid external batch or keep rearming its timer.
        if (reason !== null) { this.skip(trigger, reason); continue; }
      }
      const chain = this.mergeEventChains(this.pendingFires.get(triggerKey(trigger))?.eventChain, sourceChain);
      try { this.eventChainForRun(chain, trigger.workflowId); }
      catch (err) { this.skip(trigger, err instanceof Error ? err.message : String(err)); continue; }
      const pending = this.pendingOf(trigger);
      pending.eventChain = chain;
      pending.selfOrigin = pending.selfOrigin === true || selfOrigin;
      if (!selfOrigin) {
        // `externalEvent` 只是**混合批次**里"自我部分被扣光后"的备用副本(见 `fire`),
        // 与下面的 `pending.event` 累加同一批外部条目。丢弃计数**只从下面那份规范载荷记
        // 一次** —— 两份都记会把这批的丢弃翻倍。
        pending.externalEvent = mergeEventPayload(pending.externalEvent, event, { toolName, subjects }, item);
        pending.externalChain = this.mergeEventChains(pending.externalChain, sourceChain);
      }
      // **这件事是关于哪一条**。与工具名同一条判据:它是**事件本身**的事实,与哪条触发器
      // 无关,所以只取一次。
      //
      // ⚠️ 攒载荷这件事**必须累加,不是覆盖** —— 合并窗口(默认 2 秒)里连着来的几条是
      // 这次运行要办的**全部**,而下载是并发跑的,两篇同时下完就落在同一个窗口里。直接
      // 赋值的话后一条会**静默顶掉**前一条,另一篇再也没人管。这段逻辑在
      // `mergeEventPayload` 里(纯函数,冒烟钉得住)—— 别再在这儿手写一遍。
      // 【MC-091 续】经 `mergeEventInto`:它把这一次**新丢的**条目数落进未交付欠账。
      pending.event = this.mergeEventInto(
        pending.event,
        event,
        { toolName, subjects },
        item,
        triggerKey(trigger),
      );
      // **来了新东西 → 回看间隔从头数。** 同 `onFsChange` 那条:退避只管"没有新输入、
      // 只是在上一次运行没结束时反复回看"这一种,新事件说明这一批变了,该尽快收口。
      pending.busyRetryMs = undefined;
      // 【跨崩溃可见性】这一批(事件)开始攒 / 又多了一条:durable 写标记(每格一次)。
      this.notePendingBatch(trigger, pending, "event");
      this.rearm(pending, trigger.spec.debounceMs);
    }
  }

  /**
   * **手动运行一次。** 走的就是 `manual` 触发器那条路(`entry` = 指定的那个触发器),
   * 界面上那个「立刻运行一次」按钮调它。
   *
   * 与自动触发共用 `fire()`,所以"项目不在了 / 上一次还在跑"这两种情形两边说法一致。
   */
  async runNow(workflowId: string, triggerNodeId: string): Promise<AutomationRunResult> {
    const saved = getWorkflow(workflowId);
    if (saved !== null) {
      const reviewError = workflowReviewError(saved);
      if (reviewError !== null) return { ok: false, error: reviewError };
    }
    // 【Q5】原生图的手动运行**转发到引擎**，不是拒绝：用户图统一到 Node-RED 之后，
    // 「立刻运行一次」是用户唯一的手动入口，拒绝它等于删掉这个功能。
    if (saved !== null && effectiveWorkflowEngine(saved) === "node-red") {
      return this.runNativeFromLegacyEntry(workflowId, triggerNodeId);
    }
    const foreign = this.foreignOwnerOf(workflowId);
    if (foreign !== null) return { ok: false, error: foreign };
    const find = (): LoadedTrigger | undefined =>
      this.all().find((t) => t.workflowId === workflowId && t.nodeId === triggerNodeId);
    let trigger = find();
    if (trigger === undefined) {
      // 图刚存下、而这次点击紧跟着来的时候,这一份可能还没被 reload 进表。现读一次,
      // 比回一句"找不到这个触发器"有用 —— 用户明明看着它在图上。
      await this.reload(workflowId);
      trigger = find();
    }
    if (trigger === undefined) {
      return { ok: false, error: "这个触发器不在一条已保存的自动化里(存一次再试)" };
    }
    return this.fire(trigger, { kind: "manual" }, { manual: true });
  }

  /**
   * **带着目标手动跑一次** —— 自定义 UI 的「运行自动化」动作(见 `@contracts/customUi`)。
   *
   * 与 {@link runNow} 同一条查找路、同一个 `fire`(`manual: true`:用户关掉的触发器
   * 照样能从右键跑,上一次还在跑就如实说),差别只在**载荷**:
   *
   *   - `files` → 与文件触发同形的 `{ kind: "file" }`;
   *   - `items` → 与资料库事件同形的条目清单。事件名取**这条触发器自己订阅的**资料库
   *     事件(典型:「下载完自动转录」订的是 `library.item.downloaded`),没订阅就按
   *     「导入」说 —— 这样同一条自动化被事件叫起来和被右键叫起来,读到的载荷一模一样。
   *   - `collectionId` → **只定位、不带条目**(自定义 UI 的 `targetMode: "context"`,
   *     典型:文献导入)。用户右键的那个分类是**落点**,不是"这次要办的那一批" ——
   *     所以载荷里只有分类 id 和运行前输入,`items` 一条都不给。
   */
  /**
   * 【Q5】把旧入口（「立刻运行一次」、自定义界面右键、手机端）转发到 Node-RED。
   *
   * 这些入口共用 `AutomationRunResult` 与"起跑前拒绝用 ok:false"的约定；各改各的会把
   * 同一条转换抄三份。引擎侧的错误本来就是人话、也是 ok:false，直接搬过来就对得上。
   */
  private async runNativeFromLegacyEntry(
    workflowId: string, triggerNodeId: string,
  ): Promise<AutomationRunResult> {
    const { workflowEngineRegistry } = await import("@main/workflowEngines/registry.js");
    const runtime = workflowEngineRegistry.get("node-red");
    if (runtime === null) return { ok: false, error: "Node-RED 引擎未注册" };
    const tool = runtime as unknown as {
      runNativeManual?: (
        docId: string, triggerNodeId: string, facts: Readonly<Record<string, unknown>>,
      ) => Promise<{ ok: boolean; error?: string }>;
    };
    if (typeof tool.runNativeManual !== "function") {
      return { ok: false, error: "当前引擎不支持原生手动触发" };
    }
    const result = await tool.runNativeManual(workflowId, triggerNodeId, { kind: "manual", at: Date.now() });
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "引擎拒绝了这次手动运行" };
  }

  async runWithTarget(
    workflowId: string,
    triggerNodeId: string,
    target:
      | { files: readonly string[] }
      | { items: NonNullable<Extract<TriggerPayload, { kind: "event" }>["items"]> }
      | { collectionId: string },
    input?: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<AutomationRunResult> {
    // 【Q5】同 `runNow`：原生图转发到引擎，不在这里拒绝。
    const targetDoc = getWorkflow(workflowId);
    if (targetDoc !== null && effectiveWorkflowEngine(targetDoc) === "node-red") {
      return this.runNativeFromLegacyEntry(workflowId, triggerNodeId);
    }
    // 【T3】不归旧 runner 的图在自定义 UI 这条入口也直接说明由谁管。
    const foreign = this.foreignOwnerOf(workflowId);
    if (foreign !== null) return { ok: false, error: foreign };
    const find = (): LoadedTrigger | undefined =>
      this.all().find((t) => t.workflowId === workflowId && t.nodeId === triggerNodeId);
    let trigger = find();
    if (trigger === undefined) {
      await this.reload(workflowId);
      trigger = find();
    }
    if (trigger === undefined) {
      return { ok: false, error: "这个触发器不在一条已保存的自动化里(存一次再试)" };
    }
    let payload: TriggerPayload;
    const withInput = input !== undefined && Object.keys(input).length > 0 ? { input } : {};
    const subscribed = trigger.spec.kind === "event"
      ? trigger.spec.events.find((e) => e === "library.item.downloaded" || e === "library.item.imported")
      : undefined;
    if ("files" in target) {
      payload = { kind: "file", files: target.files, ...withInput };
    } else if ("collectionId" in target) {
      // 「只定位」那一种:没有 items。**别在这里塞一个空数组** —— `payloadFactsOf` 对
      // 空 items 是不给键的,塞了也白塞,而读的人会以为"这次真有一批条目、只是空的"。
      payload = {
        kind: "event",
        event: subscribed ?? "library.item.imported",
        collectionId: target.collectionId,
        ...withInput,
      };
    } else {
      payload = { kind: "event", event: subscribed ?? "library.item.imported", items: target.items, ...withInput };
    }
    return this.fire(trigger, payload, { manual: true });
  }

  /* ────────────────────────── 事实状态(AUTO-09)────────────────────────── */

  /**
   * 一条自动化的**触发器事实**:挂没挂好、为什么挂不上、最近一次什么时候跑的、最近
   * 一次为什么没跑成(形状见 `automationStatus.ts`)。界面那一栏的事实**来源**就是它
   * —— 不是从运行史再猜一遍:一条挂不上、从来没跑过的自动化,运行史是空的,但这里
   * 说得出为什么。
   *
   * ⚠️ 这份事实**经 `automation:statusAll` 通道送出去**(见 `main/ipc/orchestration.ts`
   * 与 `@contracts/ipc` 的 `AutomationTriggerFacts` 镜像)—— 运行史只回答"跑过什么",
   * 这里回答"它现在挂没挂上"。 */
  statusOf(workflowId: string): AutomationTriggerFacts[] {
    return this.withDropped(this.withSelfTriggerStatus(this.facts.ofWorkflow(workflowId)));
  }

  /** 全部触发器事实 —— 「所有自动化」那个列表视角用的。 */
  statusAll(): AutomationTriggerFacts[] {
    return this.withDropped(this.withSelfTriggerStatus(this.facts.all()));
  }

  /**
   * 【MC-091 续】把**未交付的积压丢弃**欠账(见 `automation.droppedUndelivered`)合进事实。
   *
   * 这份欠账**不活在 `AutomationFacts` 里**(它是落盘的恢复游标,跨重启),所以读的时候
   * 现并进来 —— 界面那一栏于是能说出「自上次交付以来积压丢了 N 条、还没交给任何运行」。
   * 有欠账的行才带这个键(同 `queuedCount`/`missedCount` 的口径:没有就不给键)。
   */
  private withDropped(rows: AutomationTriggerFacts[]): AutomationTriggerFacts[] {
    return rows.map((row) => {
      const count = this.droppedCountOf(row.key);
      return count > 0 ? { ...row, droppedUndelivered: count } : row;
    });
  }

  /** A persisted pause must be visible after reload/restart, before another event arrives. */
  private withSelfTriggerStatus(rows: AutomationTriggerFacts[]): AutomationTriggerFacts[] {
    const reasons = new Map<string, string | null>();
    return rows.map((row) => {
      if (row.kind !== "event") return row;
      if (!reasons.has(row.workflowId)) reasons.set(row.workflowId, this.selfTriggerBlockReason(row.workflowId));
      const reason = reasons.get(row.workflowId);
      // ⚠️ **时刻要跟着这句话一起换。** 只改 `lastError` 的话,界面拿到的是"刚发生的
      // 原因 + 上一条旧账的时刻";而 `latestFailureOf`(契约里那个判据)正是拿
      // `lastErrorAt` 与 `lastFireAt` 比大小来决定显不显示 —— 时刻还停在起跑之前的话,
      // 这条停摆提示会被整个吞掉,用户看到的是一条"一切正常却再也不跑"的自动化。
      return reason ? { ...row, lastError: reason, lastErrorAt: Date.now() } : row;
    });
  }

  /* ────────────────────────── 起一次运行 ────────────────────────── */

  /** 攒着的那一格(同一个触发器同时只留一个计时器 —— 见 `rearm`)。 */
  private pendingOf(trigger: LoadedTrigger): PendingFire {
    const key = triggerKey(trigger);
    const existing = this.pendingFires.get(key);
    if (existing !== undefined) return existing;
    const fresh: PendingFire = { trigger, timer: null, files: [], changes: new Map(), overflowDropped: 0 };
    this.pendingFires.set(key, fresh);
    return fresh;
  }

  /** 重新起计时:合并窗口里又来了一个,就把这一跑往后推(推的是同一个计时器,不是新起一个)。 */
  private rearm(pending: PendingFire, delayMs: number): void {
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      this.pendingFires.delete(triggerKey(pending.trigger));
      // ⚠️ **按现在这一份跑,不是攒着的那一份。** 攒下这条触发之后、计时器到点之前,
      // 用户可能改过这个节点(换了项目、改了「这次要做什么」、把「启用」勾掉),也可能
      // 存过盘(`apply` 会把 `entries` 换成新解的那一批)。`pending.trigger` 是**旧对象**
      // —— 拿它起跑就是按旧配置跑,而那正是用户刚改掉的东西。
      //
      // 已删除、停用或停止服务的触发器不再派发旧批次。
      const trigger = this.findLoaded(pending.trigger);
      if (!this.started) return; // dispose 中:标记留给下次启动按 uncertain 上报(优雅退出也是"没派发")
      if (trigger === undefined || trigger.disarmed) {
        // 【跨崩溃可见性】这一批被明确放弃(触发器没了 / 停用),清除标记
        // —— 它不会再"悬着",下次启动不该把它报成崩溃残留。
        this.clearPendingBatchMark(triggerKey(pending.trigger));
        return;
      }
      let payload: TriggerPayload;
      if (trigger.spec.kind === "file") {
        // **载荷按 flush 这一刻现拼,并丢掉此刻已经不在了的那些**(见 `existingFilesOf`)。
        // 攒着的那几秒里文件可能又被删掉 —— 事件到达时判过一次,这里再判一次,管的是
        // 那一段。`pending.files` 本身**不动**:留着它,下一次 flush 时那些路径要是又
        // 回来了(重命名来回、编辑器"写临时文件再改名"那种)就还在。
        const files = existingFilesOf(pending.files);
        // **整批都空 → 这一次不跑**(MC-022)。从前这里照样 `fire(trigger, {files: []})`,
        // 于是"建了又删"的文件会叫起一轮**没有任何要办的事**的运行 —— 模型白跑一次、
        // 白花钱。合并窗口里还有别的存活文件时 `files` 非空,那条路不受影响。
        //
        // 取舍(明说):删除事件本身**不**单独唤醒模型。用户在意的一般是"有东西要处理",
        // 而不是"某处少了个文件";把删除也当成一次触发会让"编辑器写临时文件再改名"
        // 那种日常操作多跑一轮。要判删除语义得另开一条有方向的信息通道,而现在没有
        // (见 `existingFilesOf` 那段:`fs.watch` 的 `rename` 给不出方向)。
        if (files.length === 0) {
          // 这一格刚在计时器回调开头被删掉(见上一行 `pendingFires.delete`),不重建
          // —— 下一次 `onFsChange` 会按需建新的一格。只记一行,别静默。
          // ⚠️ 【ARC-015①】**纯删除批(只有 deleted/unknown 方向、没有一个存活文件)仍然
          // 不唤醒模型** —— 这是 MC-022 的产品取舍,本切片不改它。方向信息只在**这一次
          // 真的为存活文件跑起来时**随 `changes` 捎上(见下);「某处少了个文件」不单独起一轮。
          log.info(`[automation] 「${trigger.title}」攒着的文件在收口前都不在了,这一次不跑`);
          // 【跨崩溃可见性】这是"明确放弃",不是"没派发就崩了" —— 清标记,下次启动不报。
          this.clearPendingBatchMark(triggerKey(trigger));
          return;
        }
        // 【ARC-015①】收口这一刻**再问一次盘**(二次 stat):一个方向说"还在"的路径若此刻
        // 又没了,降级成 `deleted`(见 `reconcileFileChangeKind`)—— 免得模型去读一个不存在
        // 的文件。这与 `existingFilesOf` 对 `files` 做的过滤是同一次判定,只是这里保留方向。
        const changes: FileChange[] = [];
        for (const [path, seenKind] of pending.changes) {
          changes.push({ path, kind: reconcileFileChangeKind(seenKind, existsSync(path)) });
        }
        payload = {
          kind: "file",
          files,
          // 【ARC-015①】把**方向**带进载荷(created/modified/deleted/unknown)。只在有可说的
          // 变更时才给键(空不给,同 overflowDropped 口径)。`unknown` 是刻意保留的诚实档。
          ...(changes.length > 0 ? { changes } : {}),
          // 【ARC-015】这一格攒着期间若因超限丢过路径,把条数**带进载荷事实** —— 让
          // `describeTriggerPayload` 与 `data.trigger.overflowDropped` 都明说"这次输入
          // 不完整"。没丢过(`0`)时不带这个键(同 `itemCount` 的口径)。
          ...(pending.overflowDropped > 0 ? { overflowDropped: pending.overflowDropped } : {}),
        };
      } else {
        payload = pending.event ?? { kind: "manual" };
      }
      this.fire(trigger, payload, { selfOrigin: pending.selfOrigin === true, externalEvent: pending.externalEvent,
        eventChain: pending.eventChain, externalChain: pending.externalChain,
        // 这一格刚在这一句之前被删掉(见上一行 `pendingFires.delete`),忙时分支
        // 会重建一格 —— 把退避累乘值一起带过去,否则它每次都从下限重新数(见 `fire`)。
        ...(pending.busyRetryMs !== undefined ? { busyRetryMs: pending.busyRetryMs } : {}) });
      // 【跨崩溃可见性】这一次要么已派发、要么明确跳过 —— 标记清除。忙时重排队那条
      // 路会在 `fire` 里重建一格并重新写标记(`notePendingBatch`),这里按"有没有新格"区分。
      if (!this.pendingFires.has(triggerKey(trigger))) this.clearPendingBatchMark(triggerKey(trigger));
    }, Math.max(0, delayMs));
    // 攒着的那一下不该拖着进程不退出(退出时这一跑本来就该丢 —— 它还没开始)。
    pending.timer.unref();
  }

  /**
   * 真正起一次运行。**返回的结论只给手动那条路用** —— 自动触发那三条只看日志
   * (见文件头不变量 ③)。
   *
   * `opts.originSessionId`:守望起跑带来的发起会话 —— 落到后台会话的
   * `parentSessionId` 上,「注入到发起会话」那一步靠它解析(见 `runner.ts` 的
   * `runInConversation`)。其余三条触发路不给,保持"没有发起人"的原样。
   */
  private fire(
    trigger: LoadedTrigger,
    payload: TriggerPayload,
    opts?: { originSessionId?: string; manual?: boolean; selfOrigin?: boolean; externalEvent?: TriggerPayload;
      eventChain?: readonly string[]; externalChain?: readonly string[];
      /** 上一格攒着的那次**忙时回看间隔**。见 {@link rearm} 里那段:计时器回调先删掉
       *  pending 再 fire,于是忙时分支重建的那一格会丢掉这个累乘值 —— 带着它走,
       *  退避才真的会退。 */
      busyRetryMs?: number;
      /** 【MC-051】定时那一路派发前 durable 领取的 id(见 `onTick`)。运行收尾 / 未派发的
       *  跳过都把这条领取结算成 `SUCCEEDED` —— 崩在中间的则留给 `recoverIncompleteClaims`。
       *  其余触发路(手动 / 文件 / 事件)不带 —— 只有定时走这条 claim 状态机。 */
      claimId?: string },
  ): AutomationRunResult {
    // 【MC-051】定时领取的**收尾结算**。任何一条**没真的把工作派发出去**的返回路径
    // (项目没了 / 工作流改了 / 关掉了 / 上一次还在跑 / 起跑抛错)都要把它结算成
    // `SUCCEEDED`:这一次的**决策已经落定**(不重跑),不是"崩在中间"那种不确定态。
    // 只有真正进入 `startWorkflowRun` 的那条路把结算推到运行 promise 落地上。
    //
    // 【MC-091 E3】不带 `outcome` 的调用 = "决定不跑、决策已落定"那组收尾(语义见
    // `settleTriggerClaim`);真正派发那一路的 `.finally` 带**业务结果**走三态映射。
    const claimId = opts?.claimId;
    const settleClaim = (outcome?: AutomationRunOutcome): void => this.settleTriggerClaim(claimId, outcome);
    try {
      // An old debounced event may fire while a new workflow revision reloads.
      const current = getWorkflow(trigger.workflowId);
      if (current === null) { settleClaim(); return this.skip(trigger, "这份自动化已被删除"); }
      const reviewError = workflowReviewError(current);
      if (reviewError !== null) { settleClaim(); return this.skip(trigger, reviewError); }
      // 【T3】派发这一刻**再核一次引擎归属**（同 `buildTriggers` 的同一份判据）。
      // 这是"换引擎之后晚到的旧 watcher / crontick / 去抖计时器"那条缝的闸门：
      // 保存把引擎切到 node-red 之后、`reload` 真正把 `entries` 换掉之前的这段时间里，
      // 旧触发器仍可能被叫醒 —— 到这里一律不派发。若本进程此前已为这条 flow 登记过
      // mcode（切换前它确实是旧图），**在这里释放**：这幅图今后不归旧 runner，占着
      // owner 只会挡住 Node-RED 接管（与 `apply()` 里"触发器没了就释放"同一条路径）。
      // 自身从未登记过时释放是 no-op —— 绝不会去动 Node-RED 的登记。
      const engineOwner = this.legacyTriggerOwnerOf(current);
      if (!engineOwner.legacy) {
        this.releaseExecutorOwner(trigger.workflowId);
        settleClaim();
        return this.skip(trigger, AutomationRunner.foreignTriggerDetail(engineOwner.owner,
          getWorkflow(trigger.workflowId)?.name ?? trigger.workflowId));
      }
      // A save reloads node manifests asynchronously. A debounce timer or cron
      // tick can fire before `entries` is replaced; never execute that stale
      // trigger against the newly saved graph.
      if (workflowRevision(current) !== trigger.workflowRevision) {
        settleClaim();
        return this.skip(trigger, `工作流已修改（「${current.name}」），旧触发配置已作废，本次触发已跳过`);
      }
      // **关掉的只挡自动那三条路,不挡手动。** 用户正盯着「立刻运行一次」那个按钮,
      // 点了就是"我现在要它跑" —— 被一个他在别的页面上设过的开关挡回去,只会让人
      // 以为坏了(见 `NODE_TRIGGER_ENABLED_PARAM_KEY`)。
      //
      // 不写成"手动那条路绕开 fire"是因为其余每一条判定(项目在不在、上一次还在不在跑)
      // 手动这条路**都要**。所以挡的是这里,不是调用方。
      if (trigger.disarmed && opts?.manual !== true) {
        settleClaim();
        return { ok: true };
      }
      let selfOrigin = opts?.manual !== true && opts?.selfOrigin === true;
      let eventChain = opts?.eventChain;
      if (selfOrigin) {
        // Recheck at dispatch: another trigger may have spent the last unit
        // after this batch was accepted into the debounce window.
        const reason = this.selfTriggerBlockReason(trigger.workflowId);
        if (reason !== null) {
          if (opts?.externalEvent?.kind !== "event") { settleClaim(); return this.skip(trigger, reason); }
          log.info(`[automation] 循环事件部分已跳过：${reason}；保留外部事件`);
          // Another trigger exhausted the budget while this mixed batch waited.
          // Discard only its self-origin part, not the legitimate external data.
          payload = opts.externalEvent;
          eventChain = opts.externalChain;
          selfOrigin = false;
        }
      }
      const runChain = this.eventChainForRun(
        payload.kind === "event" && opts?.manual !== true ? eventChain : undefined, trigger.workflowId);
      // 项目**每次现读**:建会话时用的是它,而用户完全可能把项目移走。
      //
      // **可以没有用户项目**(空串 = 触发器没绑):事件运行用宿主目录。
      // sessions.project_id 有外键,不能把空串直接存进去;sessionOf 会仅给
      // 这种后台会话挂一个隐藏的系统项目,绝不偷借用户的真实项目。
      const project = trigger.projectId.length > 0 ? ProjectRepo.get(trigger.projectId) : undefined;
      if (trigger.projectId.length > 0 && project === undefined) {
        settleClaim();
        return this.skip(trigger, `项目不在了(${trigger.projectId})—— 这条自动化没有工作目录`);
      }
      const cwd = project?.path ?? homedir(); // 不用 process.cwd(),理由同上
      // Check ALL project sessions before creating/rebinding one. A newer idle
      // session must not hide an older active run or let us rewrite its origin.
      // Never overlap runs. Data-bearing triggers retain ONE coalesced next
      // batch; schedule/status events keep the existing skip policy (no cron
      // catch-up or replay storm). An explicit manual click still reports busy.
      if (SessionRepo.listAutomationsByWorkflow(trigger.workflowId).some((s) => hasActiveRun(s.id))) {
        if (opts?.manual !== true && (payload.kind === "file" ||
            (payload.kind === "event" && (payload.items?.length ?? 0) > 0))) {
          const pending = this.pendingOf(trigger);
          // 【跨崩溃可见性】忙时重排队也是"攒着没派发" —— 重建的格子要重新写标记
          // (计时器回调删旧格时已清掉旧标记,这里按新格补上)。
          this.notePendingBatch(trigger, pending, payload.kind === "file" ? "file" : "event");
          // **接着上一格的退避走。** `rearm` 的计时器回调**先删掉**那一格再 fire
          // (见那里的注释),于是忙时分支这里 `pendingOf` 建的是**全新**的一格 ——
          // `busyRetryMs` 不复原的话它每次都是 undefined,`next` 永远等于下限,
          // 退避形同虚设(一次跑几小时的自动化仍然每秒重扫一遍)。把上一轮的值接回来。
          if (pending.busyRetryMs === undefined) pending.busyRetryMs = opts?.busyRetryMs;
          pending.selfOrigin = pending.selfOrigin === true || selfOrigin;
          pending.eventChain = this.mergeEventChains(pending.eventChain, eventChain);
          pending.externalChain = this.mergeEventChains(pending.externalChain, selfOrigin ? opts?.externalChain : eventChain);
          const external = selfOrigin ? opts?.externalEvent : payload;
          if (external?.kind === "event") {
            for (const item of external.items?.length ? external.items : [undefined]) {
              pending.externalEvent = mergeEventPayload(pending.externalEvent, external.event,
                { toolName: external.toolName, subjects: external.subjects }, item);
            }
          }
          if (payload.kind === "file") {
            // 【MC-091 续·全局背压】**这里不必再判全局额度** —— 重排队的 `payload.files`
            // 是**收口那一刻**已过 `admitGlobal` 的那一份(`onFsChange` 逐条判过),这里只是
            // 把同一批搬进重建的空格(相等地守恒),不会凭空多出未计费的条目。全局那一层
            // 的入口只有 `onFsChange` / `mergeEventInto` 两处,已经覆盖全部增长路径。
            pending.files = [...new Set([...pending.files, ...payload.files])];
            // 【ARC-015①】方向也要接回来 —— 忙时重建的那一格若丢了 `changes`,下一次收口
            // 就只剩 `files`(没有删除/改名方向),模型又看不出"这个文件是被删了"。
            // last-write-wins:同一路径以这一批刚合成的方向为准(它是二次 stat 校正过的)。
            for (const change of payload.changes ?? []) pending.changes.set(change.path, change.kind);
            // 【ARC-015】上一批若已因超限丢过,把它累加进来 —— 否则忙时重建的那一格会把
            // "输入不完整"这件事实丢掉,下次收口时又当成"这就是全部"。
            if (payload.overflowDropped !== undefined) pending.overflowDropped += payload.overflowDropped;
          } else {
            // 【MC-091 续·全局背压】同文件那一路:重排队的 `payload.items` 是收口那一刻已
            // 过闸门的那一份,搬进重建的空格守恒 —— 全局入口只有 `onEvent`(`mergeEventInto`)
            // 与文件那一路的 `onFsChange`,这里不重复判。
            for (const item of payload.items ?? []) {
              pending.event = mergeEventPayload(pending.event, payload.event,
                { toolName: payload.toolName, subjects: payload.subjects }, item);
            }
          }
          // Reuse the same lifecycle as debounce: disable, project changes,
          // deletion, cancellation and dispose all clear the pending batch.
          //
          // **指数退避**(见 `BUSY_RETRY_MIN_MS`):写死 1 秒的话,一次跑几小时的运行
          // 期间就是每秒一遍"读工作流 + 查会话 + 问活跃",而那批本来就在等一个以小时
          // 计的东西。
          const next = Math.min(
            pending.busyRetryMs === undefined ? BUSY_RETRY_MIN_MS : pending.busyRetryMs * 2,
            BUSY_RETRY_MAX_MS,
          );
          pending.busyRetryMs = next;
          // **让"排着队"看得见**(AUTO-09 那条规矩的另一半):它没失败、也没起跑,从前
          // 在界面上和"跑完了"完全一样 —— 用户改完文件等了十分钟,没有任何一处说得出
          // 它在等什么。
          this.facts.recordQueued(
            triggerSeedOf(trigger),
            pending.files.length > 0 ? pending.files.length : (pending.event?.kind === "event" ? (pending.event.items?.length ?? 1) : 1),
            Date.now(),
          );
          this.rearm(pending, next);
          // 【MC-051】定时那一路忙时是**跳过**(下面那条 return),不看这个分支;真来到
          // 这里的是文件 / 事件(调度 / 手动都不带 claimId)—— 结算是个 no-op,带着无害。
          settleClaim();
          return { ok: true };
        }
        settleClaim();
        return this.skip(trigger, "上一次还在跑,这一次触发已跳过");
      }

      // 【ARC-006 MERGE-3 第二刀】派发前先确认「这条 flow 归 mcode 执行」。另一端
      // （Node-RED）已登记 → **不启动**，走现有的可见诊断通道（界面 statusOf 的
      // lastError + 日志），而不是起跑后才发现两端各跑了一遍。
      // 默认注册表是进程内内存版：没有 Node-RED 侧登记时恒成功，现有行为不变。
      const ownership = this.claimExecutorOwner(trigger.workflowId);
      if (!ownership.ok) {
        settleClaim();
        return this.skip(trigger, ownership.reason);
      }
      const session = this.sessionOf(trigger, project?.id ?? "", opts?.originSessionId);
      // 【MC-091 续】**派发这一刻把未交付的积压丢弃并进载荷事实。** 之前批次里被超限丢掉的
      // 条目,有些**没能随它的载荷交出去** —— 那一批被配置改动 / 用户取消作废了,或应用在
      // 合并窗口里重启了(见 `recordDropped`)。落盘那份欠账就是恢复游标:它记着"还有多少条
      // 丢了却没交给任何运行",在这里补报,并**立即清账** —— 更晚的运行不再重复报同一笔。
      //
      // ⚠️ **只对承载数据的那两路(file / event)交付**:手动(`manual`)/ 定时(`schedule`)的
      // 载荷里没有条目列表可并,拿它们清账等于把这份欠账**静默吞掉**(下一个数据批再也读不到)。
      // 所以那两路走过这里时不动账 —— 欠账留着,等下一次真正的数据批交付。
      const undelivered = this.droppedCountOf(triggerKey(trigger));
      // 把欠账并进载荷事实(file/event 两路);**但先不清账** —— 清账必须等这次运行**真的
      // 派发出去**之后(见下面 `startWorkflowRun` 之后的 drain)。从前在这里就 drain,若紧接着
      // 的 `bindSession` / `SettingRepo.set` / 建运行抛错(走 catch),欠账**已经被清**而运行
      // 从未发生 —— 那笔丢弃就永久静默丢了(复核点名的 E2 窗口:清账早于真正派发)。
      if (undelivered > 0 && payload.kind === "file") {
        payload = { ...payload, overflowDropped: undelivered };
      } else if (undelivered > 0 && payload.kind === "event") {
        payload = { ...payload, itemsOverflowDropped: undelivered };
      }
      const payloadText = describeTriggerPayload(payload);
      const prompt = `${trigger.task}\n\n${payloadText}`;
      // 运行时可能还没绑(应用刚起来,或者这条自动化是新建的)—— `bindSession` 幂等。
      runtimeManager.bindSession(session);
      // Reserve synchronously BEFORE dispatch. Busy/rejected/manual-validation
      // failures do not reset or spend the budget; failed provider starts may
      // conservatively spend a unit. A synchronous settings error prevents self
      // dispatch; crash durability still follows SettingRepo's persistence policy.
      //
      // 手动运行**同步清零**是故意的:这是用户从"自触发额度耗尽/损坏"里恢复的唯一途径
      // (automation-smoke 有专门的用例:手动运行能恢复损坏的计数)。即使这次手动运行
      // 随后因 provider 预检失败而没跑成,也保持清零 —— 用户点"跑一次"的语义就是"重置"。
      if (opts?.manual === true) {
        this.writeSelfTriggerCount(trigger.workflowId, 0);
      } else if (selfOrigin) {
        this.writeSelfTriggerCount(trigger.workflowId, this.selfTriggerCount(trigger.workflowId) + 1);
      }
      // Capture ancestry before the runner can emit events. Explicit manual,
      // schedule, file and genuinely unattributed external runs start new roots.
      SettingRepo.set(EVENT_CHAIN_PREFIX + session.id, JSON.stringify({ version: 1, workflowIds: runChain }));
      // **起跑即记**(AUTO-09):这是「最近一次什么时候跑的」的那一笔。守望起跑那条
      // ad-hoc 路径没有经过 buildTriggers 的登记,这一笔顺带就是它的登记。
      this.facts.recordFired(triggerSeedOf(trigger), Date.now());
      log.info(
        `[automation] 「${trigger.workflowName}」/「${trigger.title}」起了一次运行(${payload.kind})`,
      );
      // **不 await**(同 `runner.startWorkflowRun` 的约定):一次运行可能好几分钟。
      void startWorkflowRun({
        session,
        originSessionId: opts?.originSessionId ?? null,
        cwd,
        prompt,
        // 这一格就是这次运行的起点:调度器把它**预置进结局**,于是触发器节点自己
        // 不会被派发,别的触发器会连同它们独占的下游一起标成「没走这条路」。
        // `payload` 是载荷的**事实键值**(G3/VAR-06):调度器把它递进每个节点的
        // `data.trigger`,节点参数里的 `{{trigger.<key>}}` 从这里取(键是平面事实
        // kind / at / files / event / toolName / subjects,见 `payloadFactsOf`)。
        entry: {
          nodeId: trigger.nodeId,
          summary: payloadText,
          // `TriggerPayloadFacts` 是无索引签名的 interface,赋给键值记录要过一道断言;
          // 形状本身是纯数据,这道断言不丢信息。
          payload: {
            ...(payloadFactsOf(payload) as unknown as Record<string, unknown>),
            // **手动起跑标一下**(右键自定义 UI / 「立刻运行一次」)。载荷形状与事件叫起来
            // 的一模一样(见 `runWithTarget`),节点要区分"用户正等着"和"后台自己响的"只能
            // 靠它 —— 典型:转录脚本没配 token 时,手动的要报错,自动的只记一句跳过。
            ...(opts?.manual === true ? { manual: true } : {}),
          },
        },
      }).then((result) => {
        // 【MC-091 E3】运行 promise **成功落地** → 按**业务结果**结算领取(不再一律
        // `SUCCEEDED`)。`RunResult.status` ∈ success/failed/cancelled;`null` = 运行没能
        // 真正跑起来(启动早退)。后两者都映成 **UNCERTAIN**(取消 / 拿不到结果,绝不假装成功)。
        // 崩溃点若落在这之前,盘上仍是 `CLAIMED` → 重启时 `recoverIncompleteClaims` 会把它
        // 认出来,不重复执行、报成"结果不确定"。这就是"领取→执行"的收尾边界。
        settleClaim(runOutcomeOfStatus(result?.status));
      }).catch((err) => {
        log.warn(`[automation] 运行失败:${(err as Error).message}`);
        // 起跑之后才失败的,`lastFire` 已经记了;这里补上「为什么没跑成」。
        this.facts.recordBlocked(triggerSeedOf(trigger), `运行失败:${(err as Error).message}`, Date.now());
        // 【MC-091 E3】引擎预检 / 起跑抛错 = 这一次运行**明确失败** → 领取落 `FAILED`
        // (不再落 `SUCCEEDED` 冒充成功)。
        settleClaim("failed");
      });
      // 【MC-091 续】**真正派发出去之后**才清欠账 —— 到这一行说明 `bindSession` / `SettingRepo.set`
      // / 建 `startWorkflowRun` 都成功了(没走上面的 catch)。只对承载数据的 file/event 两路清:
      // manual/schedule 不并账、也不清账(留给下一次真正的数据批交付,避免静默吞债)。
      if (undelivered > 0 && (payload.kind === "file" || payload.kind === "event")) {
        this.drainDroppedUndelivered(triggerKey(trigger));
      }
      return { ok: true };
    } catch (err) {
      // 见文件头不变量 ①:从这里冒出去炸的是**事件流**(这条路是从 `subscribe` / 计时器进来的)。
      log.warn(`[automation] 起运行失败:${(err as Error).message}`);
      this.facts.recordBlocked(triggerSeedOf(trigger), (err as Error).message, Date.now());
      // 【MC-051】走到这里说明**没有成功派发**(建会话 / 绑引擎 / 组提示词这几步抛了)——
      // 这一次的决策已经落定,结算掉这条领取;下次这一分钟本就被 `lastMinute` 去重,
      // 不会再来一次。**不**留成 `CLAIMED`(那会被恢复误报成"结果不确定")。
      settleClaim();
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * 把「目录监听重新挂上了」登记进事实表。
   *
   * 手上只有 `LoadedTrigger`、没有 seed,所以走 `triggerSeedOf` 现拼一个 —— 它按
   * **参数袋**读「启用」那一格,于是用户关掉的那条不会在这笔登记里被说成"响着"
   * (理由见 `AutomationFacts.recordSetup`)。
   */
  private markArmed(trigger: LoadedTrigger): void {
    this.facts.recordSetup(triggerSeedOf(trigger), true);
  }

  /**
   * 派发前确认 owner。**幂等**：同一条 flow 重复 claim 会得到 `alreadyOwned`，不重复登记。
   * 冲突时把原因原样返回（调用方走 `skip` —— 界面可见）。
   */
  private claimExecutorOwner(flowId: string): { ok: true } | { ok: false; reason: string } {
    const result = this.executorOwnership.claim(flowId, "mcode", {
      reason: "automationRunner：自动化触发器起跑",
      now: () => Date.now(),
    });
    if (!result.ok) {
      return {
        ok: false,
        reason:
          `这条工作流当前由 ${result.conflict?.current ?? "另一端"} 执行，自动化触发器本次未启动`
          + `（同一 flow 只能有一个 executor owner；${result.reason}）`,
      };
    }
    this.claimedFlowIds.add(flowId);
    return { ok: true };
  }

  /** 释放本 runner 登记过的 owner。失败只记日志 —— 关闭路径不该因为账本坏了而卡住。 */
  private releaseExecutorOwner(flowId: string): void {
    if (!this.claimedFlowIds.has(flowId)) return;
    const result = this.executorOwnership.release(flowId, "mcode");
    if (result.ok) {
      this.claimedFlowIds.delete(flowId);
    } else {
      log.warn(`[automation] 释放「${flowId}」的 executor owner 失败：${result.reason}`);
    }
  }

  private skip(trigger: LoadedTrigger, reason: string): AutomationRunResult {
    log.info(`[automation] 「${trigger.workflowName}」/「${trigger.title}」这一次没跑:${reason}`);
    // 「该跑而没跑成」也要让界面看见(AUTO-09):重入跳过尤其如此 —— 界面上只写
    // 「上次运行:进行中」,而这里的原因是用户问「我改了文件它怎么没跑」的答案。
    this.facts.recordBlocked(triggerSeedOf(trigger), reason, Date.now());
    return { ok: false, error: reason };
  }

  /**
   * 这条自动化在当前项目的后台会话。**同项目复用，跨项目隔离**(D10)。
   *
   * 身份为(workflowId, projectId)。切项目不改写旧会话，也不继承旧项目的提供方/
   * 节点上下文；切回来仍认回原会话。历史按工作流汇总全部项目，不丢旧记录。
   *
   * `originSessionId`(守望起跑才有):复用时发起会话换了就**落库再返回新值** ——
   * 运行路径读的是手里这一份,不回头查表;新建时直接带上。别的触发路不传,
   * 保持"没有发起人"。
   */
  private sessionOf(trigger: LoadedTrigger, projectId: string, originSessionId?: string): Session {
    projectId = projectId || SYSTEM_AUTOMATION_PROJECT_ID;
    if (projectId === SYSTEM_AUTOMATION_PROJECT_ID) {
      // 项目为空的事件触发器是合法的(内置「导入后下载/下载后转录」就是这样),
      // 但 sessions.project_id 是 NOT NULL + 外键。以前建会话填 "" 会在这里
      // FOREIGN KEY constraint failed,图明明响着却永远跑不起来。
      // 专用行只满足 FK;ProjectRepo.list / listPaths 会隐藏它,不把宿主 cwd
      // 变成用户可浏览的项目根,也不拿别人的项目给无人值守的自动化用。
      // 路径用用户主目录 —— 对话节点跑在这个会话上时,工作目录取的就是它。
      // ⚠️ 必须在「复用已有会话」那条早返回**之前** —— 老用户的系统会话一直被复用,
      // 放在新建分支里的话,存坏的路径永远校正不到。
      const systemPath = homedir();
      const systemProject = ProjectRepo.get(SYSTEM_AUTOMATION_PROJECT_ID);
      // 老版本存的是 `process.cwd()`(打包后为 `/` 或安装目录):不一致就校正。
      if (systemProject !== undefined && systemProject.path !== systemPath) {
        ProjectRepo.setSystemAutomationPath(systemPath);
      }
      if (systemProject === undefined) {
        ProjectRepo.create({
          id: SYSTEM_AUTOMATION_PROJECT_ID,
          name: "后台自动化(系统)",
          path: systemPath,
          archived: true,
          group: null,
          sortOrder: 0,
          pinnedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }
    const origin = originSessionId ? SessionRepo.get(originSessionId) : undefined;
    const configuredProviderId = providerIdOf(trigger.params);
    const rawConfiguredModel = trigger.params[NODE_MODEL_PARAM_KEY];
    const configuredModel = typeof rawConfiguredModel === "string" && rawConfiguredModel.trim().length > 0
      ? rawConfiguredModel.trim() : undefined;
    // Origin conversations win for watch-style runs. Truly unattended runs use
    // the trigger's explicit host engine/model, then the application default.
    const desiredProviderId = origin?.providerId ?? configuredProviderId ?? defaultProviderId();
    const desiredModel = origin?.model ?? configuredModel ?? "default";
    const existing = SessionRepo.findAutomationByWorkflow(trigger.workflowId, projectId);
    if (existing !== undefined) {
      const parentSessionId = originSessionId ?? null;
      const providerId = desiredProviderId;
      const providerChanged = providerId !== existing.providerId;
      const model = desiredModel;
      const effort = origin?.effort ?? (providerChanged ? "default" : existing.effort);
      const customModelId = origin?.customModelId ?? null;
      if (existing.parentSessionId !== parentSessionId) SessionRepo.setParentSessionId(existing.id, parentSessionId);
      if (
        providerChanged || model !== existing.model || effort !== existing.effort ||
        customModelId !== existing.customModelId
      ) {
        SessionRepo.updateSettings(existing.id, { providerId, model, effort, customModelId });
        if (providerChanged) {
          SessionRepo.updateClaudeSessionId(existing.id, null);
          runtimeManager.dispose(existing.id);
        }
      }
      return {
        ...existing, parentSessionId, providerId, model, effort, customModelId,
        claudeSessionId: providerChanged ? null : existing.claudeSessionId,
      };
    }
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId,
      // A watch started from a conversation follows that conversation's engine;
      // truly unattended triggers have no origin and deliberately use the app default.
      providerId: desiredProviderId,
      claudeSessionId: null,
      kind: "automation",
      // **null 不是偷懒**:后台自动化属于**工作流**,不属于任何一个对话(见 `Session.kind`)。
      // 守望起跑是唯一的例外 —— 它由某条对话发起,发起人记在这儿(D3)。
      parentSessionId: originSessionId ?? null,
      nodeId: null,
      // 它不进任何列表,标题纯粹是给排查用的(日志、运行历史那一栏)。
      title: `自动化:${trigger.workflowName}`,
      status: "idle",
      model: desiredModel,
      effort: origin?.effort ?? "default",
      // ️ **最保守的那个值。** 这一条只对「对话节点」有影响(它跑在**这个**会话上):
      // 那种节点会把指令当成用户消息发出去,权限模式没有别的地方能覆盖(节点自己的
      // 能力位只作用于它自己的节点会话)。`plan` = 写一律弹审批,而无人值守时审批
      // **自动按拒绝落地**(见 `RuntimeManager.autoDeclineIfUnattended`)—— 也就是
      // D11 的 fail-closed。真正干活的步骤各自开自己的节点会话,按自己的能力位定权限,
      // 不受这里影响。
      permissionMode: "plan",
      workflowId: trigger.workflowId,
      customModelId: origin?.customModelId ?? null,
      // 本地目录:**工作树是要有人管生管死的**(谁创建、什么时候合并、什么时候删),
      // 而自动化没有人在场。跑在项目根目录就好,那里本来就是它的工作目录。
      envMode: "local",
      worktreePath: null,
      archived: false,
      pinnedAt: null,
      contextSnapshot: null,
      todos: null,
      subagents: null,
      planDraft: null,
      turnFiles: null,
      usageHistory: null,
      bookmarks: null,
      subagentTranscripts: null,
      createdAt: now,
      updatedAt: now,
    };
    SessionRepo.create(session);
    log.info(`[automation] 为「${trigger.workflowName}」建了后台会话 ${session.id}`);
    return session;
  }

  /* ───────────────────────── 小工具 ────────────────────────── */

  private all(): LoadedTrigger[] {
    const out: LoadedTrigger[] = [];
    for (const [, triggers] of this.entries) out.push(...triggers);
    return out;
  }

  /** 表里**现在**这一格(按身份找:同一工作流、同一节点 id)。找不到 = 它已经没了。 */
  private findLoaded(trigger: LoadedTrigger): LoadedTrigger | undefined {
    const list = this.entries.get(trigger.workflowId);
    return list?.find((t) => t.nodeId === trigger.nodeId);
  }
}

/** 单例。在 `index.ts` 里随其它 manager 一起 start / dispose。 */
export const automationRunner = new AutomationRunner();
