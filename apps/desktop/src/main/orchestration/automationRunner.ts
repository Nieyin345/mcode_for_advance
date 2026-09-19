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
 * | 定时 | 一个**全局 30 秒只读 ticker**(`unref`),把全部定时触发器的 cron 求一遍 | 应用没开就不触发;错过的时间点**不补跑**(D13);同一分钟只跑一次(见 `onTick`) |
 * | 文件变化 | 每个**项目目录只 `fs.watch(dir, {recursive:true})` 一次**,多个触发器共享(同 `lib/walkCache.ts`) | 事件先等 `WATCH_SETTLE_MS` 再按各自的合并窗口收口;目录不存在要**记日志**,不静默 |
 * | 事件发生时 | 复用既有事件流 + `HOOK_EVENT_OF` + `createEventSubjects()` | **不忽略来自本自动化自己会话的事件**(见下) |
 *
 * ## 事实状态(AUTO-09)
 *
 * 每条触发器「挂没挂好 / 最近一次跑 / 最近一次为什么没跑成」记在 `automationStatus.ts`
 * 的 `AutomationFacts` 里,`statusOf` / `statusAll` 是它的读口。挂载侧跟着 reload 重建,
 * 运行侧只增不改 —— 界面那一栏的事实来源是它,不是从运行史再猜一遍:一条挂不上、从来
 * 没跑过的自动化,运行史是空的,但这里说得出为什么。
 *
 * ## 为什么忽略自己的事件是**错的**
 *
 * 事件触发器落在 `runtimeManager.subscribe` 上,而自动化自己跑起来的那些节点会话也在
 * 同一条流上 —— 直觉会说"得把自家的排除掉,不然自激"。但那恰恰挡掉了一种合理用法:
 * 「上一轮跑完之后再跑一次」(拿 `turn.done` 当节拍器)。而真正的自激由 **D12 重入保护**
 * 挡着:上一次还在跑(`hasActiveRun`)时这一次触发**跳过**。所以这里**不看来源会话**,
 * 免得后来的人以为那是漏了。
 *
 * ## 后台会话:一条自动化一个(D10)
 *
 * 运行时落在一条专用的隐藏会话(`kind: "automation"`,按 `workflowId` 找、复用不重建)
 * 里。这样**运行存档天然分得开**(`workflow_runs` 本来就按会话索引),不需要新表新列;
 * 而那条会话的流水不进任何界面(`RuntimeManager` 按会话种类拦住了),运行历史是用户
 * 事后唯一读得到的东西。
 */

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { cronMatches } from "@contracts/cron";
import { HOOK_EVENT_OF, matchesAnyGlob, matchesGlobList, type HookEvent } from "@contracts/hook";
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
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { uid } from "@main/utils.js";
import { describeTriggerPayload, payloadFactsOf, type TriggerPayload } from "./automationPayload.js";
import {
  AutomationFacts,
  automationTriggerKey as triggerKey,
  shouldFireThisMinute,
  triggerSeedOf,
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
  /** 定时那一类**这一分钟跑过没有**(见 `onTick`)。 */
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
    for (const [key, pending] of this.pendingFires) {
      if (!this.isLoaded(pending.trigger)) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        this.pendingFires.delete(key);
      }
    }
    for (const key of [...this.lastMinute.keys()]) {
      if (!key.startsWith(`${workflowId}:`)) continue;
      const still = triggers.some((t) => triggerKey(t) === key);
      if (!still) this.lastMinute.delete(key);
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
      const check = parseTriggerSpec(manifest, node.params);
      if (!check.ok) {
        log.warn(`[automation] ${where}跳过:${check.error}`);
        this.facts.recordSetup(seed, false, check.error);
        continue;
      }
      const projectId = node.params[NODE_TRIGGER_PROJECT_PARAM_KEY];
      const task = node.params[NODE_TRIGGER_TASK_PARAM_KEY];
      if (typeof projectId !== "string" || typeof task !== "string") continue; // `parseTriggerSpec` 已经查过,这里只为收窄类型
      const project = ProjectRepo.get(projectId);
      if (project === undefined) {
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
        cwd: project.path,
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
    const wanted = watcherDirsOf(this.all());
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
      if (trigger.spec.kind !== "schedule") continue;
      if (!cronMatches(trigger.spec.cron, now)) continue;
      const key = triggerKey(trigger);
      // **同一分钟只跑一次**(30 秒一跳会看两次)。不去重的话 `*/1 * * * *` 一分钟两次。
      if (!shouldFireThisMinute(this.lastMinute.get(key), minute)) continue;
      this.lastMinute.set(key, minute);
      this.fire(trigger, { kind: "schedule", at: now.getTime() });
    }
  }

  /** 文件变化:`fs.watch` 那一路。`filename` 可能是 null(平台差异)。 */
  private onFsChange(dir: string, filename: string | null): void {
    // `filename` 给不出时用目录本身去比:那能匹配 `**` 这类规则;匹配不上具体的
    // `*.md` 也不冤 —— 平台没说改的是哪个文件,而"整个目录里有东西动了"是它给的全部。
    const abs = filename === null ? dir : join(dir, filename);
    for (const trigger of this.all()) {
      if (trigger.spec.kind !== "file" || trigger.cwd !== dir) continue;
      // 绝对路径与**相对这个触发器项目目录**的路径都试一遍(同 `fileSubjects` 的理由:
      // 用户写下的是 `src/*.ts` 还是 `*.ts`,两种都有)。
      const subjects = fileSubjects([abs], trigger.cwd);
      if (!trigger.spec.globs.some((glob) => subjects.some((s) => matchesGlobList(glob, s)))) continue;
      const pending = this.pendingOf(trigger);
      if (!pending.files.includes(abs)) pending.files.push(abs);
      this.rearm(pending, WATCH_SETTLE_MS + trigger.spec.debounceMs);
    }
  }

  /** 事件流那一路。 */
  private onEvent(e: RuntimeEvent): void {
    const event = HOOK_EVENT_OF[e.type];
    if (event === null) return;
    // 与钩子同一条判据:"对话节点"跑完的那条 `turn.done` 是**图内部的一步**,用户那一轮
    // 还没结束(见 `RuntimeManager.holdTurnEnd`)。不挡的话,一张十步的图会把一条
    // `turn.done` 触发器叫起来十次。
    if (e.type === "turn.done" && runtimeManager.isTurnEndHeld(e.sessionId)) return;

    // ⚠️ **一次事件只取一次事实。** `factsOf()` 是**有状态**的:`tool.result` 那个事件
    // 本身不带工具名,靠前面那条 `tool.use` 记下来的小表回查,而**回查即消费**
    // (见 `eventSubjects.ts`)。早先这里在循环里对每条触发器各调一次 `of()`,于是第一个
    // 触发器就把工具名取走了,后面那些拿到的是空 —— 两条 `tool.result` 触发器盯着同一个
    // 工具时,只有排在前面那条会响,而且是**安静地**不响。
    //
    // 事实取一次;主语是纯的,按每条触发器自己的 cwd 各算一遍(路径主语要看 cwd)。
    const facts = this.subjects.factsOf(e);

    for (const trigger of this.all()) {
      if (trigger.spec.kind !== "event" || !trigger.spec.events.includes(event)) continue;
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
      const pending = this.pendingOf(trigger);
      pending.event = {
        kind: "event",
        event,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(subjects !== undefined ? { subjects } : {}),
      };
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

    const active = SessionRepo.findAutomationByWorkflow(WATCH_WORKFLOW_ID);
    if (active !== undefined && hasActiveRun(active.id)) {
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
   * 按 `parent_session_id` 反查(只有守望起跑会在自动化会话上写发起会话),活跃与否
   * 是**内存里**的事(`hasActiveRun`),存储层只负责"哪条是它的"。判断带上了
   * `workflowId`:万一将来有别的自动化也记发起会话,这条查询不该把它们算进来。
   */
  activeWatchOf(originSessionId: string): boolean {
    const session = SessionRepo.findAutomationByOrigin(originSessionId);
    return (
      session !== undefined && session.workflowId === WATCH_WORKFLOW_ID && hasActiveRun(session.id)
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
    return this.facts.ofWorkflow(workflowId);
  }

  /** 全部触发器事实 —— 「所有自动化」那个列表视角用的。 */
  statusAll(): AutomationTriggerFacts[] {
    return this.facts.all();
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
      const payload =
        pending.trigger.spec.kind === "file"
          ? ({ kind: "file", files: [...pending.files] } as const)
          : (pending.event ?? { kind: "manual" });
      this.fire(pending.trigger, payload);
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
    opts?: { originSessionId?: string; manual?: boolean },
  ): AutomationRunResult {
    try {
      // **关掉的只挡自动那三条路,不挡手动。** 用户正盯着「立刻运行一次」那个按钮,
      // 点了就是"我现在要它跑" —— 被一个他在别的页面上设过的开关挡回去,只会让人
      // 以为坏了(见 `NODE_TRIGGER_ENABLED_PARAM_KEY`)。
      //
      // 不写成"手动那条路绕开 fire"是因为其余每一条判定(项目在不在、上一次还在不在跑)
      // 手动这条路**都要**。所以挡的是这里,不是调用方。
      if (trigger.disarmed && opts?.manual !== true) {
        return { ok: true };
      }
      // 项目**每次现读**:建会话时用的是它,而用户完全可能把项目移走。
      const project = ProjectRepo.get(trigger.projectId);
      if (project === undefined) {
        return this.skip(trigger, `项目不在了(${trigger.projectId})—— 这条自动化没有工作目录`);
      }
      const session = this.sessionOf(trigger, project.id, opts?.originSessionId);
      // **重入保护(D12):上一次还在跑就跳过这一次。** 排队会让"文件改了十次"变成
      // 十次运行,而界面上「上次运行:进行中」已经把这件事说清楚了。
      if (hasActiveRun(session.id)) {
        return this.skip(trigger, "上一次还在跑,这一次触发已跳过");
      }

      const payloadText = describeTriggerPayload(payload);
      const prompt = `${trigger.task}\n\n${payloadText}`;
      // 运行时可能还没绑(应用刚起来,或者这条自动化是新建的)—— `bindSession` 幂等。
      runtimeManager.bindSession(session);
      // **起跑即记**(AUTO-09):这是「最近一次什么时候跑的」的那一笔。守望起跑那条
      // ad-hoc 路径没有经过 buildTriggers 的登记,这一笔顺带就是它的登记。
      this.facts.recordFired(triggerSeedOf(trigger), Date.now());
      log.info(
        `[automation] 「${trigger.workflowName}」/「${trigger.title}」起了一次运行(${payload.kind})`,
      );
      // **不 await**(同 `runner.startWorkflowRun` 的约定):一次运行可能好几分钟。
      void startWorkflowRun({
        session,
        cwd: project.path,
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

  private skip(trigger: LoadedTrigger, reason: string): AutomationRunResult {    log.info(`[automation] 「${trigger.workflowName}」/「${trigger.title}」这一次没跑:${reason}`);
    // 「该跑而没跑成」也要让界面看见(AUTO-09):重入跳过尤其如此 —— 界面上只写
    // 「上次运行:进行中」,而这里的原因是用户问「我改了文件它怎么没跑」的答案。
    this.facts.recordBlocked(triggerSeedOf(trigger), reason, Date.now());
    return { ok: false, error: reason };
  }

  /**
   * 这条自动化的后台会话。**一条一个,复用不重建**(D10)。
   *
   * 归属靠 `workflowId` 认(`SessionRepo.findAutomationByWorkflow`),所以界面上改了多少
   * 次图都还是同一个会话 —— 运行历史因此是**这条自动化**的历史,而不是"某一次运行"的。
   *
   * `originSessionId`(守望起跑才有):复用时发起会话换了就**落库再返回新值** ——
   * 运行路径读的是手里这一份,不回头查表;新建时直接带上。别的触发路不传,
   * 保持"没有发起人"。
   */
  private sessionOf(trigger: LoadedTrigger, projectId: string, originSessionId?: string): Session {
    const existing = SessionRepo.findAutomationByWorkflow(trigger.workflowId);
    if (existing !== undefined) {
      if (originSessionId !== undefined && existing.parentSessionId !== originSessionId) {
        SessionRepo.setParentSessionId(existing.id, originSessionId);
        return { ...existing, parentSessionId: originSessionId };
      }
      return existing;
    }
    const now = Date.now();
    const session: Session = {
      id: uid("sess_"),
      projectId,
      providerId: DEFAULT_PROVIDER_ID,
      claudeSessionId: null,
      kind: "automation",
      // **null 不是偷懒**:后台自动化属于**工作流**,不属于任何一个对话(见 `Session.kind`)。
      // 守望起跑是唯一的例外 —— 它由某条对话发起,发起人记在这儿(D3)。
      parentSessionId: originSessionId ?? null,
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

  private isLoaded(trigger: LoadedTrigger): boolean {
    const list = this.entries.get(trigger.workflowId);
    return list !== undefined && list.some((t) => t.nodeId === trigger.nodeId);
  }
}

/** 单例。在 `index.ts` 里随其它 manager 一起 start / dispose。 */
export const automationRunner = new AutomationRunner();