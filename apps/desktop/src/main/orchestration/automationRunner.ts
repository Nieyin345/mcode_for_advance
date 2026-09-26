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
import { join } from "node:path";
import { cronMatches } from "@contracts/cron";
import { HOOK_EVENT_OF, eventItemFactsOf, matchesAnyGlob, matchesGlobList, type HookEvent } from "@contracts/hook";
import { DEFAULT_PROVIDER_ID } from "@contracts/ipc";
import {
  NODE_COMMAND_PARAM_KEY,
  NODE_PROMPT_PARAM_KEY,
  NODE_TRIGGER_PROJECT_PARAM_KEY,
  NODE_TRIGGER_TASK_PARAM_KEY,
  parseTriggerSpec,
  triggerEnabledOf,
  triggerKindOf,
  type NodeTypeManifest,
  type TriggerSpec,
} from "@contracts/nodeType";
import type { RuntimeEvent } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { createEventSubjects, fileSubjects } from "@main/hooks/eventSubjects.js";
import { log } from "@main/lib/logger.js";
import { ProjectRepo, SessionRepo, SettingRepo, SYSTEM_AUTOMATION_PROJECT_ID } from "@main/store/repositories.js";
import { uid } from "@main/utils.js";
import { describeTriggerPayload, mergeEventPayload, payloadFactsOf, type TriggerPayload } from "./automationPayload.js";
import {
  AutomationFacts,
  automationTriggerKey as triggerKey,
  shouldFireThisMinute,
  triggerSeedOf,
  triggerSpecKeyOf,
  watcherDirsOf,
  type AutomationFactsSeed,
  type AutomationTriggerFacts,
} from "./automationStatus.js";
import {
  WATCH_COMMAND_NODE_ID,
  WATCH_DEFAULT_TASK,
  WATCH_SAY_NODE_ID,
  WATCH_TRIGGER_NODE_ID,
  WATCH_WORKFLOW_ID,
} from "./builtins.js";
import { getWorkflow, listWorkflows, saveWorkflow } from "./library.js";
import { workflowReviewError } from "./workflowTrust.js";
import { loadNodeTypes } from "./nodeTypes.js";
import { setWorkflowReloader } from "./reloadRequest.js";
import { hasActiveRun, startWorkflowRun } from "./runner.js";

/**
 * 定时那一路**多久看一次时钟**。
 *
 * 30 秒是"分钟级 cron"的一个务实取舍:最坏情况晚触发 30 秒,而一秒一跳纯属浪费
 * (`cronMatches` 只到分钟这一位,跳得再密也不会更准)。代价是同一分钟**会看两次**
 * —— 所以 `onTick` 里必须去重,否则「每一分钟都跑」那条表达式会一分钟跑两次。
 */
const TICK_MS = 30_000;

/**
 * 一条文件事件先等这么久,再按触发器自己的合并窗口收口。
 *
 * 为什么除了 `debounceMs` 还要这 300ms:编辑器保存一个文件往往是"写临时文件 → 改名
 * → 更新目录"好几下,而**第一下到达时文件还没写完**。立刻按 `debounceMs` 起跑的话,
 * `debounceMs: 0`(用户明确要求"每次都跑")那条配置会对着半个文件跑一次。
 */
const WATCH_SETTLE_MS = 300;

/**
 * 「这一条定时触发器上一次是在哪一分钟跑的」存在这个 settings 键下。
 *
 * ## 为什么必须落盘
 *
 * 这条记忆原本是执行器里一个 Map(`lastMinute`),**应用一关就没了**。而它要挡的那件
 * 事恰恰发生在重启那一下:去重只对「最近这个分钟已经跑过」生效(`shouldFireThisMinute`),
 * 记忆一没,重启后那一跳看到的就是「本分钟没见过」—— 于是**同一分钟里的第二个进程**
 * 又跑一次。症状是「每次开应用,那个「每分钟一次」的自动化就额外多跑一次」,而日志里
 * 两次运行的时间戳只差几秒,看不出是哪来的。
 *
 * ## 为什么存 settings,不是新开一张表
 *
 * 形状是**一张小映射**(`触发器的 key → 分钟序号`),不是"一次运行的存档" —— 与
 * `browser.addressHistory` / `browser.bookmarks` 同一类东西,那两处都走 `SettingRepo`。
 * 开一张新表要动 `store/db.ts`(建表 + 迁移)再加一个 Repo,而换来的只是"能按列查" ——
 * 这里没有任何按列查的需求(每次都是整张读进来、整张写回去)。
 *
 * ⚠️ **`SettingRepo.set` 内部会 `persist()`(重写整个数据库文件)**,所以这张表必须
 * 按分钟变一次才写、值没变就不写 —— 按 tick(30 秒)无条件写就是每天几万次整库重写,
 * 见 `rememberLastMinute`。
 *
 * 键名沿用 `automation.watch.templates` 那种 `automation.` 前缀(按模块分空域),不插进
 * contracts 的 `*_SETTING_KEY` 那一堆 —— 那边是**界面也要读**的偏好项;这一份是执行器
 * 的内部状态,没有第二个读者,放这儿离用它的人最近。
 */
const LAST_MINUTE_SETTING_KEY = "automation.lastMinute";
const SELF_TRIGGER_LIMIT = 10;
const SELF_TRIGGER_COUNT_PREFIX = "automation.selfTriggerCount.";
const SELF_TRIGGER_STOP_REASON = `自身或回环事件触发已达${SELF_TRIGGER_LIMIT}次，自动续跑已停止；请手动运行一次后继续`;


/** 非本轮分钟的历史最多保留60条；本轮分钟记录不受条数限制。
 *  同分钟已触发的 key 是正确性状态，不能按容量淘汰，否则第61条之后的
 *  触发器会在下一次tick/重启后重复运行。保护分钟推进后，旧记录重新受限。 */
const LAST_MINUTE_HISTORY_KEEP = 60;

/**
 * 落盘那份能读的判据。读不回来**不抛**,当空表 —— 见 `readLastMinutes`。
 */
function isLastMinutes(raw: unknown): raw is Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  return Object.entries(raw).every(
    ([key, value]) => key.length > 0 && typeof value === "number" && Number.isFinite(value),
  );
}

/**
 * 文件触发那一路:一个**刚被创建、还没来得及写完**的文件不该被当成"不存在"。
 *
 * 症状(问题 2):`fs.watch` 的 `rename` 事件同时覆盖新建与删除,载荷里于是可能带着一个
 * **已经被删掉的路径**,模型拿着它去读,得到"文件不存在";而它本该去办的是这一批里
 * 别的文件 —— 一个不存在的路径不会让运行失败,只是**悄悄少办一件事**。
 *
 * ## 取舍:判"此刻在不在",不判"这个事件是新建还是删"
 *
 * 不判方向是因为 `fs.watch` 给不出方向 —— `rename` 对新建、删除、改名一律是
 * `"rename"`。而"文件此刻在不在"是这件事里唯一确定的事实。
 *
 * 为什么不误伤**刚创建、还没来得及写完**的那个:文件节点在创建那一刻就存在了(写内容
 * 发生在后面),所以 `existsSync` 当场是 true,不会被丢掉。真正会漏掉的只有"创建后在
 * 合并窗口内又被删掉"的那种 —— 而那种本来就不该跑。
 *
 * ## 为什么问两遍(事件到达时 + flush 前)
 *
 * 两边管的是不同的缝:
 *
 *  - **事件到达时**(`onFsChange`)决定"这一次要不要攒起来"。拦在这里,一次纯删除不会
 *    攒出一次**空载荷**的运行(模型被叫起来却没有任何要办的事)。
 *  - **flush 前**(`rearm`)管攒着的那几秒里被删掉的路径 —— 那期间文件可能又没了,
 *    而载荷是按 flush 那一刻现拼的。
 *
 * 代价(明说):一个文件被删除到 flush 之间的删除事件**不会**让已经攒着的那一次取消,
 * 它只是从载荷里消失 —— 如果整批都这样,这次运行带着空载荷照跑。要更严就得在"攒着的
 * 那几秒里全空了"时把这一次整个丢掉,那会让"新建 + 改动"变成"删掉一半"的正常批被吞。
 */
function existingFilesOf(files: readonly string[]): string[] {
  return files.filter((file) => existsSync(file));
}

/** 一条自动化的**触发条件(已解好)** —— 执行器要的全部信息。 */
interface LoadedTrigger {
  workflowId: string;
  /** 工作流的名字,只用于给后台会话起个能给排查看的标题。 */
  workflowName: string;
  /** 触发器节点的 id —— 它同时是 `entry.nodeId`(这次运行从哪一格起)。 */
  nodeId: string;
  /** 给日志看的名字(节点标题 > 清单名)。 */
  title: string;
  spec: TriggerSpec;
  projectId: string;
  /** 这次运行的工作目录。**每次触发都从项目表读**,所以项目被移走了会当场发现。 */
  cwd: string;
  /** 「这次要做什么」—— 整次运行的用户请求。 */
  task: string;
  /**
   * 触发器节点上的**完整参数袋**。只为 `triggerSeedOf` 登记事实时读「启用」那一格
   * (`NODE_TRIGGER_ENABLED_PARAM_KEY`)—— 它按**键**读,所以这里存一份比再拆一个
   * 布尔字段更省事:事实那边的 `enabled` 与下面 `disarmed` 于是永远不会漂。
   *
   * ad-hoc 那条路(守望入口)不在图上、没有参数袋,给空对象 —— 缺席即开,
   * 与它本来就在响的事实一致。
   */
  params: Record<string, unknown>;
  /**
   * 用户在图上**关掉了**这条触发器(见 `NODE_TRIGGER_ENABLED_PARAM_KEY`)。
   *
   * 关掉的照样进这张表、照样登记事实 —— 界面上要看得见"有这一条,是你关的",
   * 而不是整行消失(那和"触发器没了"分不清)。只是**自动那三条路不派发它**。
   */
  disarmed: boolean;
}

/** 攒着还没跑的那一次。文件连着变、事件连着来时,同一格只留一个计时器。 */
interface PendingFire {
  trigger: LoadedTrigger;
  timer: ReturnType<typeof setTimeout> | null;
  /** 已经按 glob 筛过的文件(绝对路径)。只有文件那一路会往里放。 */
  files: string[];
  /** 最后一条事件载荷(事件那一路用;文件那一路的载荷在 flush 时现拼)。 */
  event?: TriggerPayload;
  /** Internal provenance, never inferred from model-supplied payload fields. */
  selfOrigin?: boolean;
  /** Preserve external data independently if the self budget runs out while queued. */
  externalEvent?: TriggerPayload;
  /** Ancestors captured when events arrive, not re-read after debounce/retry. */
  eventChain?: readonly string[];
  externalChain?: readonly string[];
}

/** 一次手动运行的结论。IPC 那一路要把它变成给用户看的一句话。 */
export type AutomationRunResult = { ok: true } | { ok: false; error: string };

/** 一个项目目录的监听 `fs.watch` 只开一个,多个触发器共享。 */
interface WatcherEntry {
  watcher: FSWatcher | null;
  /** 这个平台上/这个目录上监听是否可用。不可用时不再反复重试(同 walkCache)。 */
  watchOk: boolean;
}

class AutomationRunner {
  private started = false;
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
  /** 每条自动化连续 reload 的序号,防止慢的那次覆盖快的那次。 */
  private reloadSeq = new Map<string, number>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** 与钩子共用一份逻辑、各持一个实例 —— `tool.result` 要回查工具名,所以它**有状态**。 */
  private subjects = createEventSubjects();
  /**
   * **事实状态**(AUTO-09,见 `automationStatus.ts`):每条触发器挂没挂好、最近一次
   * 什么时候跑的、最近一次为什么没跑成。reload 重建挂载侧,运行侧只增不改。
   */
  private facts = new AutomationFacts();

  /* ────────────────────────── 启停 ───────────────────────── */

  /** 由 `main/index.ts` 在 `awaitDb()` 之后调用(同 `hookRunner`)。 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

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

    // **把上一次进程留下的"哪一分钟跑过"读回来。** 这一步必须在 ticker 起来**之前**
    // 做 —— 反过来的话,第一跳就会把重启前那一分钟当成"没见过",于是同分钟跑第二次,
    // 而那次多跑正是要挡的东西。读失败不是致命的:`readLastMinutes` 内部兜成空表,
    // 退化成"重启后可能多跑一次"的老行为。
    this.lastMinute = this.readLastMinutes();

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
    this.lastMinute.clear();
    this.facts.clear();
    this.entries.clear();
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
    if (triggers.length === 0) this.entries.delete(workflowId);
    else this.entries.set(workflowId, triggers);

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
  private buildTriggers(workflowId: string, types: Map<string, NodeTypeManifest>): LoadedTrigger[] {
    const doc = getWorkflow(workflowId);
    if (doc === null) {
      // 工作流没了:它的事实一起清掉,界面上不留幽灵行。
      this.facts.retainWorkflow(workflowId, new Set());
      return [];
    }
    const out: LoadedTrigger[] = [];
    const pendingReview = workflowReviewError(doc);
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
      const projectId = node.params[NODE_TRIGGER_PROJECT_PARAM_KEY];
      const task = node.params[NODE_TRIGGER_TASK_PARAM_KEY];
      if (typeof projectId !== "string" || typeof task !== "string") continue; // `parseTriggerSpec` 已经查过,这里只为收窄类型
      // **项目可以留空** —— 只有「事件发生时」允许(`parseTriggerSpec` 会拦住另外三种)。
      // 缺项目时退回宿主目录:那条运行要做的事(转录、抽图、送外部工具)都是拿绝对路径
      // 去操作库里的文件,根本不需要工作目录。而**内置模板预置不出项目 id**(项目 id 是
      // 建项目时现生成的),所以以前"一律要求项目"的写法让内置自动化**永远挂不上** ——
      // 用户对着一条参数填得好好的触发器等它响,却没有任何地方说得出为什么。
      //
      // `projectId` 仍然记成空串:它唯一的用处是 `fire()` 里现读一次项目(确认还在),
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
        workflowName: doc.name,
        nodeId: node.id,
        title: node.title || manifest.name,
        spec: check.spec,
        projectId,
        // 没绑项目时退回宿主目录 —— 见上面那段。只可能是「事件发生时」。
        cwd: project?.path ?? process.cwd(),
        task: task.trim(),
        params: node.params,
        disarmed: off,
      });
    }
    this.facts.retainWorkflow(workflowId, seen);
    return out;
  }

  private async loadTypes(): Promise<Map<string, NodeTypeManifest> | null> {
    try {
      return new Map((await loadNodeTypes()).entries.map((e) => [e.id, e.manifest]));
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
      this.watchers.set(dir, { watcher: null, watchOk: false });
      this.armWatcher(dir);
    }
  }

  private armWatcher(dir: string): void {
    const entry = this.watchers.get(dir);
    if (entry === undefined) return;
    // 递归监听只在 win32 / darwin 上有(Node >= 19.1)。别的平台上文件触发**不会响**
    // —— 那是要**说出来**的事实,不是安静地少一个功能。事实表也要记上(AUTO-09):
    // 挂载侧从这里起是「挂不上」,界面那栏不能再说它启用着。
    if (process.platform !== "win32" && process.platform !== "darwin") {
      const why = "这个平台不支持递归监听,文件触发不会响";
      log.warn(`[automation] ${why}:${dir}`);
      for (const t of this.all()) {
        if (t.spec.kind === "file" && t.cwd === dir) {
          this.facts.recordSetup(triggerSeedOf(t), false, why);
        }
      }
      return;
    }
    try {
      const watcher = watch(dir, { recursive: true }, (_type, filename) => {
        // 回调里**只攒不跑**(见文件头不变量 ①):真正起运行的是下面那个计时器。
        try {
          this.onFsChange(dir, typeof filename === "string" ? filename : null);
        } catch (err) {
          log.warn(`[automation] ${dir} 的文件事件处理失败:${(err as Error).message}`);
        }
      });
      watcher.on("error", (err) => {
        entry.watchOk = false;
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
      });
      entry.watcher = watcher;
      entry.watchOk = true;
      // 挂上了:把上次「监听失效」记的那笔还回来(reload 重试成功的那条路走这里)。
      // **经 `markArmed`**:用户关掉的那条不会被这笔说成"响着"。
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
    }
  }

  /* ────────────────────────── 四类触发 ────────────────────────── */

  /** 定时:30 秒一次,把全部定时触发器的 cron 求一遍。 */
  private onTick(): void {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    for (const trigger of this.all()) {
      if (trigger.disarmed || trigger.spec.kind !== "schedule") continue;
      if (!cronMatches(trigger.spec.cron, now)) continue;
      const key = triggerKey(trigger);
      // **同一分钟只跑一次**(30 秒一跳会看两次)。不去重的话 `*/1 * * * *` 一分钟两次。
      // 这条记忆**跨重启**(见 `lastMinute` 的说明):重启后那一跳看到的还是"本分钟
      // 已经跑过",所以不会因为开了一次应用而多跑一次。
      if (!shouldFireThisMinute(this.lastMinute.get(key), minute)) continue;
      // Protect the tick's captured minute, even if a large batch crosses a
      // wall-clock minute boundary while dispatching/persisting its entries.
      this.rememberLastMinute(key, minute, minute);
      this.fire(trigger, { kind: "schedule", at: now.getTime() });
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
   * 把 `lastMinute` 写进 settings。**写不进去只记一行日志** —— 这一份坏掉不该让
   * 定时触发整个停摆(它只影响"重启后可能多跑一次"这一种退化)。
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
   * 读回上一次进程留下的那张表。**读不回来当空表**,不抛(同 `db.ts` 的 `persist`
   * 与 `automationStatus` 的读法:执行器启动时的一处坏数据不该让整个自动化挂不上)。
   *
   * ⚠️ **`SettingRepo.get` 在库还没就绪时会抛**(`getDb()` 的"called before initDb
   * resolved")。本执行器由 `main/index.ts` 在 `awaitDb()` 之后才 `start()`,所以正常
   * 走到这里是就绪的;但这条读被包在 try 里,是为了让"顺序被改动过"这件事表现为
   * "重启后可能多跑一次",而不是让整个 `start()` 炸掉、所有触发器一条都不挂。
   */
  private readLastMinutes(): Map<string, number> {
    try {
      const raw = SettingRepo.get(LAST_MINUTE_SETTING_KEY);
      if (raw === null || raw.length === 0) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!isLastMinutes(parsed)) {
        // setting 是用户数据,可能被手改坏 —— 坏的一整份丢掉(与 `loadWatchTemplates`
        // 逐条过 schema 同一个立场,只是这里没有"坏的那一条还能用"这回事:
        // 一格坏值就让整张表当空,代价只是重启后可能多跑一次)。
        log.warn("[automation] 定时去重表读不回来(形状不对),当空表");
        return new Map();
      }
      return new Map(Object.entries(parsed));
    } catch (err) {
      log.warn(`[automation] 定时去重表读不回来,当空表:${(err as Error).message}`);
      return new Map();
    }
  }

  /** 文件变化:`fs.watch` 那一路。`filename` 可能是 null(平台差异)。 */
  private onFsChange(dir: string, filename: string | null): void {
    // `filename` 给不出时用目录本身去比:那能匹配 `**` 这类规则;匹配不上具体的
    // `*.md` 也不冤 —— 平台没说改的是哪个文件,而"整个目录里有东西动了"是它给的全部。
    const abs = filename === null ? dir : join(dir, filename);
    for (const trigger of this.all()) {
      if (trigger.disarmed || trigger.spec.kind !== "file" || trigger.cwd !== dir) continue;
      // 绝对路径与**相对这个触发器项目目录**的路径都试一遍(同 `fileSubjects` 的理由:
      // 用户写下的是 `src/*.ts` 还是 `*.ts`,两种都有)。
      const subjects = fileSubjects([abs], trigger.cwd);
      if (!trigger.spec.globs.some((glob) => subjects.some((s) => matchesGlobList(glob, s)))) continue;
      // **删掉的文件不进载荷**(问题 2,取舍见 `existingFilesOf`)。`fs.watch` 的 `rename`
      // 事件同时覆盖新建与删除,而这里**从前不区分** —— 于是删掉的路径也会进去,模型去读
      // 一个不存在的文件。
      //
      // 判**存在性**而不是"这个事件是新建还是删除":`fs.watch` 给的那个 `eventType` 对
      // 新建 / 删除 / 改名一律是 `"rename"`,拿它判方向必然漏掉改名;而"文件此刻在不在"
      // 是这件事里唯一确定的事实。
      //
      // 顺序是**先 glob 后问盘**:glob 是纯字符串比,`existsSync` 是一次系统调用 ——
      // 项目里绝大多数事件都匹配不上任何一条 glob(编译产物、临时文件),那些走不到 stat。
      //
      // 拦在这一层的收益是**这一次运行压根不起**:只在载荷那一侧过滤的话,一个"文件被删"
      // 的事件照样会攒起一次运行,载荷却是空的 —— 模型被叫起来却没有任何要办的事。
      // flush 时还会再问一遍(见 `rearm`),管的是攒着这几秒里被删掉的那些。
      if (!existsSync(abs)) continue;
      const pending = this.pendingOf(trigger);
      if (!pending.files.includes(abs)) pending.files.push(abs);
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
    return count;
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
      pending.event = mergeEventPayload(
        pending.event,
        event,
        { toolName, subjects },
        item,
      );
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
   * **守望起跑**(会话输入区那颗「守望」按钮,D3)。它不挂任何后台监听 —— 点击
   * 就是给**当前这条会话**起一次模板运行,命令跑完由「回话」那一步把结果注回来。
   *
   * ## 它和 `runNow` 走的不是同一条查找路
   *
   * `runNow` 从 `this.all()` 里找触发器,而那张表要求触发器的项目**真实存在**
   * (`buildTriggers` 查不到项目就跳过)。守望模板没法预知这台机器上有哪些项目,
   * 它的触发器在起跑之前一直处于"项目没填"状态,进不了那张表 —— 所以这里**自己
   * 拼一次运行**:项目、工作目录、发起会话全部按**这一次**的来,模板只是形状。
   *
   * ## 起跑会顺手改模板,这是有意的
   *
   * 命令与消息长在**节点参数**里(`D1`:模板就是配置的真相),面板上现写的命令、
   * 自定义的消息要落到参数里才跑得起来。所以起跑前把这几样写进模板并存一份
   * (对内置 id 就是覆盖行):项目、任务兜底、命令(给了才写)、消息(给了才写)。
   * 副作用是**看得见的** —— 库里那份「长任务守望」显示的就是上一次守望用的配置,
   * 想改默认去节点上改,和 `D1` 说的是同一件事。
   *
   * ## 重入保护在改模板**之前**
   *
   * 上一次还在跑时,这一次带来的新命令不能把正在跑的那条覆盖掉 —— 先查活跃,
   * 再动参数。`fire()` 里那道是**通用**的 D12(按后台会话判),这里是守望自己的
   * 入口提示,两边都要。
   */
  async startWatch(args: {
    /** 发起会话(按钮所在的那个对话)。命令在**它的**项目目录里跑,结果注回**它**。 */
    originSessionId: string;
    /** 这一次要跑的命令(面板选的模板或现写的)。不给 = 沿用模板里现在那条。 */
    command?: string;
    /** 注入时说的那句话。不给/空 = 沿用模板默认。 */
    message?: string;
  }): Promise<AutomationRunResult> {
    const origin = SessionRepo.get(args.originSessionId);
    if (origin === undefined) {
      return { ok: false, error: "发起会话不在了(它可能已经被删)—— 回到那条对话再点一次" };
    }
    const project = ProjectRepo.get(origin.projectId);
    if (project === undefined) {
      return {
        ok: false,
        error: `发起会话的项目不在了(${origin.projectId})—— 守望要在那个项目目录里跑命令`,
      };
    }

    if (SessionRepo.listAutomationsByWorkflow(WATCH_WORKFLOW_ID).some((s) => hasActiveRun(s.id))) {
      return { ok: false, error: "上一次守望还在跑 —— 等它结束,或在运行历史里看进度" };
    }

    const doc = getWorkflow(WATCH_WORKFLOW_ID);
    if (doc === null) {
      return { ok: false, error: "内置模板「长任务守望」不见了 —— 到工作流库把它恢复一下" };
    }

    // 把这一次的配置写进模板。三个节点 id 找不到 = 图被改得不认得了(节点被删),
    // 下面 `present` 那一关会说清楚。
    const command = args.command?.trim() ?? "";
    const message = args.message?.trim() ?? "";
    let changed = false;
    const nodes = doc.nodes.map((node) => {
      if (node.id === WATCH_TRIGGER_NODE_ID) {
        const params = { ...node.params };
        let touched = false;
        if (params[NODE_TRIGGER_PROJECT_PARAM_KEY] !== project.id) {
          params[NODE_TRIGGER_PROJECT_PARAM_KEY] = project.id;
          touched = true;
        }
        const task = params[NODE_TRIGGER_TASK_PARAM_KEY];
        if (typeof task !== "string" || task.trim().length === 0) {
          // 存盘那一关要求它非空 —— 不能把一句空话存进去。
          params[NODE_TRIGGER_TASK_PARAM_KEY] = WATCH_DEFAULT_TASK;
          touched = true;
        }
        if (touched) {
          changed = true;
          return { ...node, params };
        }
        return node;
      }
      if (node.id === WATCH_COMMAND_NODE_ID && command.length > 0) {
        changed = true;
        return { ...node, params: { ...node.params, [NODE_COMMAND_PARAM_KEY]: command } };
      }
      if (node.id === WATCH_SAY_NODE_ID && message.length > 0) {
        changed = true;
        return { ...node, params: { ...node.params, [NODE_PROMPT_PARAM_KEY]: message } };
      }
      return node;
    });
    const present = (id: string): boolean => nodes.some((n) => n.id === id);
    if (!present(WATCH_TRIGGER_NODE_ID) || !present(WATCH_COMMAND_NODE_ID) || !present(WATCH_SAY_NODE_ID)) {
      return {
        ok: false,
        error: "模板「长任务守望」缺了起跑要用的节点(触发器 / 跑命令 / 回话)—— 到工作流库把它恢复一下",
      };
    }
    if (changed) {
      const saved = await saveWorkflow({ ...doc, nodes });
      if (!saved.ok) return { ok: false, error: saved.error };
    }

    const triggerNode = nodes.find((n) => n.id === WATCH_TRIGGER_NODE_ID);
    const taskRaw = triggerNode?.params[NODE_TRIGGER_TASK_PARAM_KEY];
    const task =
      typeof taskRaw === "string" && taskRaw.trim().length > 0 ? taskRaw.trim() : WATCH_DEFAULT_TASK;
    return this.fire(
      {
        workflowId: WATCH_WORKFLOW_ID,
        workflowName: doc.name,
        nodeId: WATCH_TRIGGER_NODE_ID,
        title: (triggerNode?.title ?? "").trim() || "守望入口",
        spec: { kind: "manual" },
        projectId: project.id,
        cwd: project.path,
        task,
        // 守望模板的参数袋照实带上(它**就在图上**)。守望这条路的 `disarmed` 是写死的
        // false —— 点在按钮上的那一下不看「启用」开关(见
        // `NODE_TRIGGER_ENABLED_PARAM_KEY`),但事实里那条记录仍该照模板说真话:
        // 模板上的开关关着,它就不会自动响。
        params: triggerNode?.params ?? {},
        disarmed: false,
      },
      { kind: "manual" },
      { originSessionId: origin.id, manual: true },
    );
  }

  /**
   * 这条会话上有没有**正在跑的守望**(面板据此提示"上一次还在跑",D3)。
   *
   * 在守望的全部项目会话中检查发起会话与活跃状态。不能只取最新一条，
   * 否则新项目的一条空闲会话会遮住旧项目仍在运行的守望。
   */
  activeWatchOf(originSessionId: string): boolean {
    return SessionRepo.listAutomationsByWorkflow(WATCH_WORKFLOW_ID).some(
      (session) => session.parentSessionId === originSessionId && hasActiveRun(session.id),
    );
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
    return this.withSelfTriggerStatus(this.facts.ofWorkflow(workflowId));
  }

  /** 全部触发器事实 —— 「所有自动化」那个列表视角用的。 */
  statusAll(): AutomationTriggerFacts[] {
    return this.withSelfTriggerStatus(this.facts.all());
  }

  /** A persisted pause must be visible after reload/restart, before another event arrives. */
  private withSelfTriggerStatus(rows: AutomationTriggerFacts[]): AutomationTriggerFacts[] {
    const reasons = new Map<string, string | null>();
    return rows.map((row) => {
      if (row.kind !== "event") return row;
      if (!reasons.has(row.workflowId)) reasons.set(row.workflowId, this.selfTriggerBlockReason(row.workflowId));
      const reason = reasons.get(row.workflowId);
      return reason ? { ...row, lastError: reason } : row;
    });
  }

  /* ────────────────────────── 起一次运行 ────────────────────────── */

  /** 攒着的那一格(同一个触发器同时只留一个计时器 —— 见 `rearm`)。 */
  private pendingOf(trigger: LoadedTrigger): PendingFire {
    const key = triggerKey(trigger);
    const existing = this.pendingFires.get(key);
    if (existing !== undefined) return existing;
    const fresh: PendingFire = { trigger, timer: null, files: [] };
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
      if (!this.started || trigger === undefined || trigger.disarmed) return;
      const payload =
        trigger.spec.kind === "file"
          // **载荷按 flush 这一刻现拼,并丢掉此刻已经不在了的那些**(见 `existingFilesOf`)。
          // 攒着的那几秒里文件可能又被删掉 —— 事件到达时判过一次,这里再判一次,管的是
          // 那一段。`pending.files` 本身**不动**:留着它,下一次 flush 时那些路径要是又
          // 回来了(重命名来回、编辑器"写临时文件再改名"那种)就还在。
          ? ({ kind: "file", files: existingFilesOf(pending.files) } as const)
          : (pending.event ?? { kind: "manual" });
      this.fire(trigger, payload, { selfOrigin: pending.selfOrigin === true, externalEvent: pending.externalEvent,
        eventChain: pending.eventChain, externalChain: pending.externalChain });
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
      eventChain?: readonly string[]; externalChain?: readonly string[] },
  ): AutomationRunResult {
    try {
      // An old debounced event may fire while a new workflow revision reloads.
      const current = getWorkflow(trigger.workflowId);
      if (current === null) return this.skip(trigger, "这份自动化已被删除");
      const reviewError = workflowReviewError(current);
      if (reviewError !== null) return this.skip(trigger, reviewError);
      // **关掉的只挡自动那三条路,不挡手动。** 用户正盯着「立刻运行一次」那个按钮,
      // 点了就是"我现在要它跑" —— 被一个他在别的页面上设过的开关挡回去,只会让人
      // 以为坏了(见 `NODE_TRIGGER_ENABLED_PARAM_KEY`)。
      //
      // 不写成"手动那条路绕开 fire"是因为其余每一条判定(项目在不在、上一次还在不在跑)
      // 手动这条路**都要**。所以挡的是这里,不是调用方。
      if (trigger.disarmed && opts?.manual !== true) {
        return { ok: true };
      }
      let selfOrigin = opts?.manual !== true && opts?.selfOrigin === true;
      let eventChain = opts?.eventChain;
      if (selfOrigin) {
        // Recheck at dispatch: another trigger may have spent the last unit
        // after this batch was accepted into the debounce window.
        const reason = this.selfTriggerBlockReason(trigger.workflowId);
        if (reason !== null) {
          if (opts?.externalEvent?.kind !== "event") return this.skip(trigger, reason);
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
        return this.skip(trigger, `项目不在了(${trigger.projectId})—— 这条自动化没有工作目录`);
      }
      const cwd = project?.path ?? process.cwd();
      // Check ALL project sessions before creating/rebinding one. A newer idle
      // session must not hide an older active run or let us rewrite its origin.
      // Never overlap runs. Data-bearing triggers retain ONE coalesced next
      // batch; schedule/status events keep the existing skip policy (no cron
      // catch-up or replay storm). An explicit manual click still reports busy.
      if (SessionRepo.listAutomationsByWorkflow(trigger.workflowId).some((s) => hasActiveRun(s.id))) {
        if (opts?.manual !== true && (payload.kind === "file" ||
            (payload.kind === "event" && (payload.items?.length ?? 0) > 0))) {
          const pending = this.pendingOf(trigger);
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
            pending.files = [...new Set([...pending.files, ...payload.files])];
          } else {
            for (const item of payload.items ?? []) {
              pending.event = mergeEventPayload(pending.event, payload.event,
                { toolName: payload.toolName, subjects: payload.subjects }, item);
            }
          }
          // Reuse the same lifecycle as debounce: disable, project changes,
          // deletion, cancellation and dispose all clear the pending batch.
          this.rearm(pending, 1_000);
          return { ok: true };
        }
        return this.skip(trigger, "上一次还在跑,这一次触发已跳过");
      }

      const session = this.sessionOf(trigger, project?.id ?? "", opts?.originSessionId);
      const payloadText = describeTriggerPayload(payload);
      const prompt = `${trigger.task}\n\n${payloadText}`;
      // 运行时可能还没绑(应用刚起来,或者这条自动化是新建的)—— `bindSession` 幂等。
      runtimeManager.bindSession(session);
      // Reserve synchronously BEFORE dispatch. Busy/rejected/manual-validation
      // failures do not reset or spend the budget; failed provider starts may
      // conservatively spend a unit. A synchronous settings error prevents self
      // dispatch; crash durability still follows SettingRepo's persistence policy.
      if (opts?.manual === true) {
        SettingRepo.set(SELF_TRIGGER_COUNT_PREFIX + trigger.workflowId, "0");
      } else if (selfOrigin) {
        SettingRepo.set(SELF_TRIGGER_COUNT_PREFIX + trigger.workflowId,
          String(this.selfTriggerCount(trigger.workflowId) + 1));
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
          payload: payloadFactsOf(payload) as unknown as Record<string, unknown>,
        },
      }).catch((err) => {
        log.warn(`[automation] 运行失败:${(err as Error).message}`);
        // 起跑之后才失败的,`lastFire` 已经记了;这里补上「为什么没跑成」。
        this.facts.recordBlocked(triggerSeedOf(trigger), `运行失败:${(err as Error).message}`, Date.now());
      });
      return { ok: true };
    } catch (err) {
      // 见文件头不变量 ①:从这里冒出去炸的是**事件流**(这条路是从 `subscribe` / 计时器进来的)。
      log.warn(`[automation] 起运行失败:${(err as Error).message}`);
      this.facts.recordBlocked(triggerSeedOf(trigger), (err as Error).message, Date.now());
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
    const existing = SessionRepo.findAutomationByWorkflow(trigger.workflowId, projectId);
    if (existing !== undefined) {
      const parentSessionId = originSessionId ?? null;
      if (existing.parentSessionId !== parentSessionId) {
        SessionRepo.setParentSessionId(existing.id, parentSessionId);
        return { ...existing, parentSessionId };
      }
      return existing;
    }
    const now = Date.now();
    if (projectId === SYSTEM_AUTOMATION_PROJECT_ID) {
      // 项目为空的事件触发器是合法的(内置「导入后下载/下载后转录」就是这样),
      // 但 sessions.project_id 是 NOT NULL + 外键。以前建会话填 "" 会在这里
      // FOREIGN KEY constraint failed,图明明响着却永远跑不起来。
      // 专用行只满足 FK;ProjectRepo.list / listPaths 会隐藏它,不把宿主 cwd
      // 变成用户可浏览的项目根,也不拿别人的项目给无人值守的自动化用。
      if (ProjectRepo.get(SYSTEM_AUTOMATION_PROJECT_ID) === undefined) {
        ProjectRepo.create({
          id: SYSTEM_AUTOMATION_PROJECT_ID,
          name: "后台自动化(系统)",
          path: process.cwd(),
          archived: true,
          group: null,
          sortOrder: 0,
          pinnedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    const session: Session = {
      id: uid("sess_"),
      projectId,
      providerId: DEFAULT_PROVIDER_ID,
      claudeSessionId: null,
      kind: "automation",
      // **null 不是偷懒**:后台自动化属于**工作流**,不属于任何一个对话(见 `Session.kind`)。
      // 守望起跑是唯一的例外 —— 它由某条对话发起,发起人记在这儿(D3)。
      parentSessionId: originSessionId ?? null,
      nodeId: null,
      // 它不进任何列表,标题纯粹是给排查用的(日志、运行历史那一栏)。
      title: `自动化:${trigger.workflowName}`,
      status: "idle",
      model: "default",
      effort: "default",
      // ️ **最保守的那个值。** 这一条只对「对话节点」有影响(它跑在**这个**会话上):
      // 那种节点会把指令当成用户消息发出去,权限模式没有别的地方能覆盖(节点自己的
      // 能力位只作用于它自己的节点会话)。`plan` = 写一律弹审批,而无人值守时审批
      // **自动按拒绝落地**(见 `RuntimeManager.autoDeclineIfUnattended`)—— 也就是
      // D11 的 fail-closed。真正干活的步骤各自开自己的节点会话,按自己的能力位定权限,
      // 不受这里影响。
      permissionMode: "plan",
      workflowId: trigger.workflowId,
      customModelId: null,
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
