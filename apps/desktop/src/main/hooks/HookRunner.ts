/**
 * 钩子的执行者 —— 监听事件流,匹配,记下结果。
 *
 * 「怎么跑一条命令」在 `runCommand.ts` 里(起进程、超时、收输出)。分开是因为那一半
 * 需要真起进程才验得了,而这一半需要活的会话和事件流 —— 混在一个文件里,两半都测不成。
 *
 * ## 为什么挂在 `runtimeManager.subscribe` 上
 *
 * 那是**所有事件的唯一出口**(三个提供方、工作流节点的隐藏会话,全都经过它)。挂在
 * 那里意味着钩子天然对"每一次对话 + 每一个工作流节点 + 将来的自动化"都生效,而不需要
 * 每加一种运行方式就再接一遍。这也是钩子由宿主跑而不是交给 CLI 的理由之一
 * (见 `@contracts/hook` 的文件头)。
 *
 * ## 三条不变量
 *
 * 1. **绝不把异常抛回事件流。** 这里是 `subscribe` 的回调,而它在 RuntimeManager 发
 *    每一个事件时同步执行 —— 从这里抛出去,炸的是整个回合。同步异常由 try/catch
 *    截住,异步拒绝由 Promise.catch 截住,并且**不 await**:钩子跑多久都不该让对话卡住。
 * 2. **同一条钩子的并发由交付策略定,默认仍是一个进程。** 一个挂在 `tool.use` 上的
 *    钩子,一轮里会被触发几十次;每次都起一个进程的话,一个慢脚本能瞬间攒出几十个进程。
 *    所以并发上限默认 1(见 `@contracts/hook` 的 `DEFAULT_DELIVERY_POLICY`),到上限
 *    的再来事件按**声明的策略**处置(BEST_EFFORT / AT_MOST_ONCE 明确丢,COALESCE 攒
 *    一次合并),**不是悄悄丢掉** —— 每一次决定都记一条 `skipped`(带原因)并进计数。
 * 3. **结果只进环,不进对话流。** 理由见 `@contracts/hook` 的 `HookRun`。跳过/丢/合并
 *    的**计数**另有一份不会被环顶掉的账(见 `DeliveryCounts`)。
 *
 * ## 钩子定义每次事件都重新看一遍文件
 *
 * 用户可以直接改 `hooks.json`(那是把它放成文件的意义),所以缓存的失效靠**文件
 * 时间戳**:每次事件 `statSync` 一次(微秒级),变了才重新读。不这么做的话,手改的
 * 钩子要重启应用才生效 —— 而"改了没反应"是最难查的一类问题。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { RuntimeEvent } from "@contracts/runtime";
import {
  HOOK_EVENT_OF,
  coalesceWindowMs,
  decideDelivery,
  decideRetry,
  matchesHook,
  resolveDeliveryPolicy,
  type DeliveryPolicy,
  type HookPayload,
  type HookRun,
  type HookSpec,
} from "@contracts/hook";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { HookRunRepo, ProjectRepo, SessionRepo, type HookRunRow } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { uid } from "@main/utils.js";
import { createEventSubjects } from "./eventSubjects.js";
import { decidePluginHookExecution, recordHostHookRun } from "./hostHookGrants.js";
import type { HostHookSource } from "@contracts/hostHookGrant";
import { pluginHookSpecsFrom, type EnabledPluginHookDeclaration, type PluginHookSpecEntry } from "./pluginHooks.js";
import { runHookCommand } from "./runCommand.js";
import { hooksFilePath, readHooks } from "./store.js";

/** 执行记录最多留这么多条(新的在前)。超了丢最旧的 —— 这是**排错用的窗口**,不是账本。 */
const RUN_RING = 50;

/** 【MC-061】插件候选的缓存时长(ms)。见 {@link HookRunner.pluginCache} —— 只缓存
 *  「有哪些候选」,判定每条事件现算,所以撤权/过期即时生效,不被它拖后。 */
const PLUGIN_CACHE_TTL_MS = 1000;

/**
 * 【ARC-007】一次交付决定的计数。跳过/丢/合并/不支持各多少次 —— 它们是**可观测事实**:
 * "我的钩子到底跑了没有、为什么没跑"要能从这里数出来,而不是从 50 条会被顶掉的环里猜。
 */
export interface DeliveryCounts {
  /** 真的起了进程的次数。 */
  accepted: number;
  /** 到了并发上限、这一次明确没跑(BEST_EFFORT / AT_MOST_ONCE)。 */
  dropped: number;
  /** 并进了待跑的合并批次(COALESCE),**不等于丢了** —— 后面会兑现一次。 */
  coalesced: number;
  /** 声明的策略本版实现不了(DURABLE_AT_LEAST_ONCE),明确报出来而不是假装跑过。 */
  unsupported: number;
  /** 【retryBudget】失败的 hook 在预算内被**再试一次**的次数。可数 = 可断言"重试真的发生了"。 */
  retried: number;
  /** 【MC-061】插件 hook 被**宿主授权**挡下、没有执行的次数(默认拒绝的账)。插件 hook
   *  在拿到有效 HostHookGrant 之前**一律不跑**,而那件事必须**数得出来** —— 否则"我的插件
   *  钩子为什么不响"只能从会被顶掉的 50 条环里猜(见 {@link DeliveryCounts} 的整体理由)。 */
  denied: number;
  /**
   * 【MC-061 执行预算】插件 hook 因**授权执行次数用尽**(`usedRuns >= maxRuns`)没有执行的
   * 次数。与 `denied` **分开数**:「没授过信」和「授过、用完了」是两件不同的事实,混成一个
   * 数会把用户往"我明明点过授权"那个方向带偏(面板据此说"次数已用尽,需重新授权")。
   */
  budgetExhausted: number;
}

function emptyCounts(): DeliveryCounts {
  return { accepted: 0, dropped: 0, coalesced: 0, unsupported: 0, retried: 0, denied: 0, budgetExhausted: 0 };
}

/**
 * 【ARC-007】把**声明的交付策略**里那两个"盖过钩子自身"的字段拍平成一份**跑起来用**的 spec。
 *
 * `timeoutMs` 与 `outputLimit` 是**同一层**的覆盖(策略更粗、`HookSpec` 更细),从前只有
 * `timeoutMs` 接了线。一次把两个都摊平,喂给 `runHookCommand` 的就是**同一个来源** ——
 * 否则策略字段会只在某一条路上生效、另一条(重试 / 试跑)退回钩子自己那个值。
 */
function effectiveSpec(spec: HookSpec, policy: DeliveryPolicy): HookSpec {
  if (policy.timeoutMs === undefined && policy.outputLimit === undefined) return spec;
  return {
    ...spec,
    ...(policy.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
    ...(policy.outputLimit !== undefined ? { outputLimit: policy.outputLimit } : {}),
  };
}

class HookRunner {
  private started = false;
  /** 缓存的钩子定义 + 它对应的文件时间戳(`null` = 文件当时不存在)。 */
  private cache: { hooks: HookSpec[]; stamp: number | null } = { hooks: [], stamp: null };
  /** 每条钩子**正在跑**的进程数。见文件头第 2 条不变量与 `deliveryPolicy.maxConcurrency`。 */
  private inFlight = new Map<string, number>();
  /** 【ARC-007】`COALESCE` 策略下**攒着待跑**的那一批(每条钩子至多一格)。 */
  private coalescePending = new Map<string, HookPayload>();
  /**
   * 【debounceMs】`COALESCE` 的**去抖窗口计时器**(每条钩子至多一个)。窗口内每来一条
   * 就把计时器推到 `windowMs` 之后(尾去抖),到期兑现 {@link coalescePending} 那一格。
   * 省略 `debounceMs`(零窗口)时**不开**计时器 —— 那条路即时交付,与今天一致。
   */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 【ARC-007】交付决定的计数(按 hookId)。见 {@link DeliveryCounts}。 */
  private deliveryCounts = new Map<string, DeliveryCounts>();
  private runs: HookRun[] = [];
  /** 事件→匹配主语(`tool.result` 要回查工具名,所以它**有状态**)。与自动化触发器
   *  共用一份逻辑,各持一个实例 —— 见 `eventSubjects.ts`。 */
  private subjects = createEventSubjects();
  /**
   * 【MC-061】插件携带的 hook 声明从哪来 —— 宿主在装配点(见 `main/index.ts`)把它接成
   * 当前启用插件的真读法(见 `pluginManager.enabledPluginHookDeclarations`)。
   *
   * **不接 = 没有插件候选 = v1 行为**(插件 hooks 永不执行)。这既是行为兼容的默认,
   * 也是本模块能无头直测的接缝:脚本给它喂一份固定声明,就能验「判定真的驱动物理行为」,
   * 而不必真去装一个插件。入参是会话的工作目录(插件有项目级开关,得按项目算)。
   */
  private pluginHookSource: ((projectPath: string) => readonly EnabledPluginHookDeclaration[]) | null = null;
  /**
   * 【MC-061】插件候选的**短 TTL 缓存**(按 cwd)。插件声明只在**装 / 卸 / 启 / 停**时
   * 才变 —— 而 `tool.use` 一轮能来几十次,每条事件都重扫插件根(读设置表 + `readdir` +
   * 逐清单 JSON 解析)是白烧。窗口取 1 秒:既挡掉一轮里的重复扫描,又让面板上的启停
   * 在用户点完的下一条事件上生效(与 v1「改动下一回合生效」同一条纪律,只会更早)。
   */
  private pluginCache = new Map<string, { at: number; entries: PluginHookSpecEntry[] }>();

  /**
   * 【MC-061 复审修复】从 hook id → 它绑定的**插件来源身份**。`onEvent` 匹配到插件候选时记下,
   * {@link deliver} **真正 spawn 前**据此**复验**授权 —— 补上独立复审点名的 E2 时间窗口:
   * 从前 `runOne` 会把工作延后到去抖窗口 / `coalescePending`,`deliver` 在 spawn 前**不再复验**,
   * 于是「事件排队 → 用户撤权/停用 → 旧候选仍执行」。现在授权是**每次真正起进程前现算**的,
   * 撤权/过期即时生效,不给排队留窗口。用户手写的钩子不在表里 → 不受此闸。
   */
  private pluginSources = new Map<string, HostHookSource>();

  /**
   * 【MC-061】审计落盘的**出口** —— 一条插件 hook 执行记录的持久去处。默认是 `HookRunRepo`
   * (写 `hook_runs` 表,见 store/repositories.ts);可注入替身做无头断言,置 `null` 则不落盘。
   *
   * 与 {@link pluginHookSource} 同一姿势:本模块不直接 import electron/sql 那一侧的写入口做
   * 会抛的事 —— 落库失败也**绝不**冒到事件流(见文件头不变量 1)。
   */
  private hookRunSink: ((row: HookRunRow) => void) | null = (row) => HookRunRepo.record(row);

  /** 【MC-061】接上审计落盘出口(装配点 / 无头脚本用)。见 {@link hookRunSink}。 */
  setHookRunSink(sink: ((row: HookRunRow) => void) | null): void {
    this.hookRunSink = sink;
  }

  /** 【MC-061】接上插件 hook 声明的来源(宿主装配点调一次)。见 {@link pluginHookSource}。 */
  setPluginHookSource(
    source: (projectPath: string) => readonly EnabledPluginHookDeclaration[],
  ): void {
    this.pluginHookSource = source;
    this.pluginCache.clear();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    runtimeManager.subscribe((e) => {
      // **同步回调里只做分发**:真正的活全在 async 里,而且不 await(不变量 1)。
      try {
        void this.onEvent(e).catch((err: unknown) => {
          // A synchronous try/catch cannot catch an async rejection (including
          // failures in hooksNow/subjects before runOne's own catch).
          log.warn(`[hooks] 异步分发失败:${err instanceof Error ? err.message : String(err)}`);
        });
      } catch (err) {
        log.warn(`[hooks] 分发失败:${(err as Error).message}`);
      }
    });
    log.info("HookRunner started");
  }

  /** 最近的执行记录(新的在前)。 */
  listRuns(): HookRun[] {
    return this.runs;
  }

  /**
   * 【ARC-007】交付决定的**计数**(按 hookId 一条)。`undefined` = 这条钩子还没被交付过。
   *
   * 环(`listRuns`)只有 50 条、会被顶掉,所以"跳过了多少次"在环里数不出来 —— 那才是
   * "我的钩子为什么没跑"最需要的一个数。这里是**累加的、不会被环顶掉**的那一份。
   */
  deliveryCountsOf(hookId: string): DeliveryCounts | undefined {
    const c = this.deliveryCounts.get(hookId);
    return c === undefined ? undefined : { ...c };
  }

  /** 所有钩子的交付计数(按 hookId),副本。给设置页 / 断言用。 */
  allDeliveryCounts(): Record<string, DeliveryCounts> {
    const out: Record<string, DeliveryCounts> = {};
    for (const [id, c] of this.deliveryCounts) out[id] = { ...c };
    return out;
  }

  private bumpCount(hookId: string, field: keyof DeliveryCounts): void {
    const c = this.deliveryCounts.get(hookId) ?? emptyCounts();
    c[field] += 1;
    this.deliveryCounts.set(hookId, c);
  }

  /**
   * 拿一条钩子试跑一次 —— 设置页上那个「试跑」按钮。
   *
   * **不看 `enabled`**:试跑正是为了在打开它之前看看会发生什么。用一个**假载荷**
   * (没有真会话),所以它**不进执行记录环** —— 那个环的语义是"真的发生过什么"。
   */
  async test(spec: HookSpec): Promise<HookRun> {
    const sample = toolMatcherSampleOf(spec);
    const payload: HookPayload = {
      event: spec.event,
      at: Date.now(),
      session: { id: "(试跑)", kind: "chat", title: "试跑", projectId: "" },
      // 不用 `process.cwd()`:打包后的应用里那是 `/`(macOS 从访达启动)或安装目录,
      // 钩子里写的相对路径(`python scripts/x.py`)试跑必挂,真跑(项目目录)却好好的。
      cwd: homedir(),
      ...(sample !== undefined ? { toolName: sample } : {}),
      data: { type: spec.event, sessionId: "(试跑)", note: "这是设置页的试跑,不是真实事件" },
    };
    const startedAt = Date.now();
    const record: HookRun = {
      runId: uid("hrun_"),
      hookId: spec.id,
      hookName: spec.name,
      event: spec.event,
      sessionId: payload.session.id,
      sessionKind: "chat",
      startedAt,
      status: "running",
    };
    Object.assign(record, await runHookCommand(effectiveSpec(spec, resolveDeliveryPolicy(spec)), payload), {
      durationMs: Date.now() - startedAt,
    });
    return record;
  }

  /* ── 内部 ── */

  private async onEvent(e: RuntimeEvent): Promise<void> {
    const event = HOOK_EVENT_OF[e.type];
    if (event === null) return;

    // 「对话节点」跑在主对话那个会话上(`runner.kind === "conversation"`),所以它跑完
    // 那一条 `turn.done` 的会话看着就是用户自己的对话 —— 但它只是**图内部的一步**,
    // 用户那一轮还没结束(图可能还有五步没跑)。调度器把整张图的收口扣住了
    // (见 `RuntimeManager.holdTurnEnd`),这里照着那条判据挡一下,否则一条 `turn.done`
    // 钩子会被一张十步的图触发十次。
    if (e.type === "turn.done" && runtimeManager.isTurnEndHeld(e.sessionId)) return;

    // 用户手写的钩子(见 `hooks.json`)。**先看有没有**:一条都没有、也接不上插件候选的话,
    // 后面那些查询全免了。绝大多数事件走的就是这条路(用户通常只有一两条钩子,而
    // `tool.use` 一轮能来几十次)。没接插件来源时这一句是常量空表(见 `pluginHookSource`)。
    const authored = this.hooksNow();
    const hasPluginSource = this.pluginHookSource !== null;
    if (authored.length === 0 && !hasPluginSource) return;

    // 合成哨兵 "(system)" 放行(统一资料库的 `library.item.imported`):它**不属于
    // 任何会话**(见 `@contracts/runtime` 的 `LibraryItemImportedEvent`),查不到会话
    // 不是"会话没了"。给一条壳载荷 —— cwd 退回宿主目录,与试跑那条假载荷同一待遇。
    const session =
      e.sessionId === "(system)"
        ? { id: "(system)", kind: "chat" as const, title: "资料库", projectId: "" }
        : this.sessionFacts(e.sessionId);
    if (session === null) return; // 会话已经没了(删了 / 是别的进程留下的)——
    const cwd = this.cwdOf(session.projectId, e.sessionId);
    const { toolName, subjects } = this.subjects.of(e, cwd);

    const authoredHits = authored.filter((spec) => matchesHook(spec, event, subjects));
    // 【MC-061】插件候选:先按事件/主语匹配,**再逐条走授权判定** —— 判定的唯一落点。
    // 不 `granted` 的**明确记一条 skipped(带原因)+ denied 计数**,不静默丢掉(仓库硬规矩 3)。
    const pluginHits: Array<{ spec: HookSpec; source: HostHookSource; allowed: boolean; reason: string; exhausted: boolean }> = [];
    for (const entry of this.pluginEntriesNow(cwd)) {
      if (!matchesHook(entry.spec, event, subjects)) continue;
      const decision = decidePluginHookExecution(entry.source, event, Date.now());
      // 【MC-061 复审修复】记下这条候选的来源身份 —— `deliver` 真正起进程前要**复验**授权。
      // 覆盖 `pluginSources` 里的旧值(命令/版本变了 → 新来源,旧授权本就作废)。
      this.pluginSources.set(entry.spec.id, entry.source);
      pluginHits.push(
        decision.decide === "allowed"
          ? { spec: entry.spec, source: entry.source, allowed: true, reason: "", exhausted: false }
          : {
              spec: entry.spec,
              source: entry.source,
              allowed: false,
              reason: decision.reason,
              // 【MC-061 执行预算】「用尽」与「未授信」分开记(见 DeliveryCounts.budgetExhausted)。
              exhausted: decision.decide === "exhausted",
            },
      );
    }
    if (authoredHits.length === 0 && pluginHits.length === 0) return;

    const payload: HookPayload = {
      event,
      at: Date.now(),
      session,
      cwd,
      ...(toolName !== undefined ? { toolName } : {}),
      data: e,
    };

    // 【MC-061】被授权挡下的插件 hook:**记 skipped + denied/budgetExhausted 计数**。这是
    // "我的插件钩子为什么不响"的**唯一**可数出口(环只留 50 条、会被顶掉)。
    for (const hit of pluginHits) {
      if (hit.allowed) continue;
      this.pushRun(hit.spec, payload, "skipped", hit.reason);
      this.bumpCount(hit.spec.id, hit.exhausted ? "budgetExhausted" : "denied");
    }

    const toRun = [...authoredHits, ...pluginHits.filter((h) => h.allowed).map((h) => h.spec)];
    for (const spec of toRun) {
      await this.runOne(spec, payload).catch((err) => {
        // 走到这儿说明 `runOne` 自己炸了。**不能让它冒出去**(不变量 1)。
        log.warn(`[hooks] ${spec.name} 执行失败:${(err as Error).message}`);
      });
    }
  }

  /**
   * 【MC-061】当前的插件 hook 候选(声明 → 候选)。**没接来源 = 空表 = v1 行为**。
   *
   * 插件有项目级开关,按会话工作目录 `cwd` 算(与 provider 投递同一把尺子)。读盘失败
   * **不抛进事件流**(见文件头不变量 1):插件子系统坏了,用户手写的钩子照跑。结果按
   * {@link pluginCache} 的 TTL 挡掉一轮里的重复扫描 —— **注意缓存的是候选本身,不是判定**:
   * 授权是否有效每条事件都现算(`decidePluginHookExecution`),所以撤权/过期**即时**生效,
   * 不会被这个 1 秒窗口拖后。
   */
  private pluginEntriesNow(cwd: string): PluginHookSpecEntry[] {
    if (this.pluginHookSource === null) return [];
    const now = Date.now();
    const cached = this.pluginCache.get(cwd);
    if (cached !== undefined && now - cached.at < PLUGIN_CACHE_TTL_MS) return cached.entries;
    let entries: PluginHookSpecEntry[];
    try {
      entries = pluginHookSpecsFrom(this.pluginHookSource(cwd));
    } catch (err) {
      log.warn(`[hooks] 读插件 hook 声明失败:${(err as Error).message}`);
      entries = [];
    }
    // 有界:cwd 通常就几个(项目数),但仍给个上界防止异常情况下无限增长。
    if (this.pluginCache.size > 64 && !this.pluginCache.has(cwd)) this.pluginCache.clear();
    this.pluginCache.set(cwd, { at: now, entries });
    return entries;
  }

  private async runOne(spec: HookSpec, payload: HookPayload): Promise<void> {
    const policy = resolveDeliveryPolicy(spec);
    const windowMs = coalesceWindowMs(policy);
    // 【debounceMs】**去抖窗口**:`COALESCE` 声明了 `debounceMs > 0` 时,不到窗口末尾**不**
    // 立即起进程 —— 这一条先攒着,窗口(尾去抖,新事件重置)到期才兑现一次合并运行。
    // 这正是把「忙时攒一次」的**零窗口**补成**真窗口**:空闲时连续来的事件不再每条各起一个
    // 进程。⚠️ 只是**一个计时器决定何时兑现**,不是轮询、不新增并发(见 ARC-007「不要做」)。
    // `windowMs === 0`(省略 / 非 COALESCE)走下面即时交付 = **今天的行为**。
    if (windowMs > 0) {
      this.armCoalesceWindow(spec, windowMs, payload);
      return;
    }
    await this.deliver(spec, payload);
  }

  /**
   * 【debounceMs】攒下这一条并(重)起窗口计时器 —— 尾去抖:窗口内每来一条就**把计时器
   * 推到 `windowMs` 之后**,所以窗口是从**最后一次触发**起算的。到期时把攒着的那一批
   * **兑现成一次运行**(走 {@link deliver},而不是再回窗口 —— 否则会自锁)。
   *
   * 每钩子至多一个计时器 + 一格待办(与「忙时攒一次」共用同一格 `coalescePending`)。
   */
  private armCoalesceWindow(spec: HookSpec, windowMs: number, payload: HookPayload): void {
    this.coalescePending.set(spec.id, payload);
    this.bumpCount(spec.id, "coalesced");
    this.pushRun(spec, payload, "skipped", `进入 ${windowMs}ms 去抖窗口,窗口末尾合并兑现`);
    const existing = this.debounceTimers.get(spec.id);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(spec.id);
      const pending = this.coalescePending.get(spec.id);
      if (pending === undefined) return;
      this.coalescePending.delete(spec.id);
      // **不 await**:兑现是另起一次,别让计时器回调卡在那儿。
      void this.deliver(spec, pending).catch((err: unknown) => {
        log.warn(`[hooks] ${spec.name} 去抖批次执行失败:${(err as Error).message}`);
      });
    }, windowMs);
    this.debounceTimers.set(spec.id, timer);
  }

  /**
   * **真正交付一次**(去抖窗口与「忙时攒一次」都收口到这里)。策略的**决定**是纯函数
   * (见 `@contracts/hook` 的 `decideDelivery`),这里只负责把决定落到进程与记录上。
   */
  private async deliver(spec: HookSpec, payload: HookPayload): Promise<void> {
    const policy = resolveDeliveryPolicy(spec);

    // 【MC-061 复审修复】**真正 spawn 前复验插件 hook 的授权** —— 补 E2 时间窗口:
    // `runOne` 可能把工作延后到去抖窗口 / `coalescePending`,从匹配到真正起进程之间用户
    // 可能**撤权 / 过期 / 禁用插件**。事件到达时判过一次不够;起进程这一刻必须**再判一次**,
    // 否则「排队 → 撤权 → 旧候选仍执行」。判据仍是唯一那一个 `decidePluginHookExecution`。
    // 用户手写的钩子不在 `pluginSources` 里 → 不受此闸(它们本来就没有插件授权一说)。
    const pluginSource = this.pluginSources.get(spec.id);
    if (pluginSource !== undefined) {
      const now = Date.now();
      const decision = decidePluginHookExecution(pluginSource, spec.event, now);
      if (decision.decide !== "allowed") {
        this.pushRun(spec, payload, "skipped", decision.reason);
        // 【MC-061 执行预算】用尽与未授信分开数(见 DeliveryCounts.budgetExhausted)。
        this.bumpCount(spec.id, decision.decide === "exhausted" ? "budgetExhausted" : "denied");
        log.info(`[hooks] 「${spec.name}」起进程前复验未通过,不执行:${decision.reason}`);
        return;
      }
    }

    // 在跑的进程数 + 是否已有待合并项 —— 都是 `decideDelivery` 的判据。
    const decision = decideDelivery(policy, {
      inFlight: this.inFlight.get(spec.id) ?? 0,
      coalescePending: this.coalescePending.has(spec.id),
    });

    if (decision.action === "unsupported") {
      // ARC-007:本版实现不了 `DURABLE_AT_LEAST_ONCE`(没有持久领取的账本,也没有消费方
      // 幂等键的位置)。**明确报出来**,不假装已经持久化 —— 假装的话,出事时用户会以为待办
      // 还在。记一条 `skipped`(带原因)+ 计数,环里与计数器上都看得见。
      this.pushRun(spec, payload, "skipped", decision.reason);
      this.bumpCount(spec.id, "unsupported");
      log.warn(`[hooks] 「${spec.name}」的交付策略不支持:${decision.reason}`);
      return;
    }

    if (decision.action === "coalesce") {
      // 把这一条**攒起来**(每条钩子至多一格)。它不算丢:等在跑的那一次收口时会兑现一批。
      this.coalescePending.set(spec.id, payload);
      this.pushRun(spec, payload, "skipped", decision.reason);
      this.bumpCount(spec.id, "coalesced");
      return;
    }

    if (decision.action === "drop") {
      // 明确丢。记一条带原因的 `skipped`(旧行为:见文件头第 2 条)+ 计数。
      this.pushRun(spec, payload, "skipped", decision.reason);
      this.bumpCount(spec.id, "dropped");
      return;
    }

    // accept —— 真的起进程。策略声明了 `retryBudget` 时,**失败**(退非零)就在**同一个
    // `inFlight` 槽位内**再试一次,直到预算用尽才落终态。⚠️ 重试**不是**"再来一条事件"
    // —— 它是"同一条没跑成,再跑一遍",所以**绝不**并发 spawn(那正是"对每条事件直接并发
    // spawn"那条禁止项的形状)。超时 / 起不来**不**重试(见 `@contracts/hook` 的 `decideRetry`)。
    this.inFlight.set(spec.id, (this.inFlight.get(spec.id) ?? 0) + 1);
    // 生效的覆盖:策略的 `timeoutMs` / `outputLimit` 盖过钩子自己声明的(那是更细的一层)。
    const effective = effectiveSpec(spec, policy);
    const budget = policy.retryBudget ?? 1;
    try {
      let attempts = 0;
      for (;;) {
        attempts += 1;
        // 【MC-061 执行预算】插件 hook 的**真执行**逐次记账 —— 该来源那份授权 `usedRuns` +1,
        // 用尽后下一条事件判 `exhausted`(见 `recordHostHookRun` / `decideHostHookExecution`)。
        // 只在**起进程前**那一刻记(与上面的复验同一个时间点):判定放行 → 记一笔 → 起进程。
        // 记账找不到可用授权时**不记**(`false`)—— 少记一笔只会让预算更保守,绝不反向放宽。
        if (pluginSource !== undefined && !recordHostHookRun(pluginSource, Date.now())) {
          // 走到这儿说明复验放行、但记账瞬间那份授权已不覆盖/仍无余额 —— 极窄的竞态窗口。
          // 不静默起进程:记一条带原因的 skipped,让"为什么没跑"在环里看得到(不变量 3)。
          this.pushRun(spec, payload, "skipped", "执行次数预算已用尽,未起进程");
          this.bumpCount(spec.id, "budgetExhausted");
          log.info(`[hooks] 「${spec.name}」记账时已无可用授权(预算用尽 / 撤权),不执行`);
          break;
        }
        // 每一次真起进程都算一次 accepted(重试也是真起了一个进程)。放在记账之后:accepted
        // 的口径是"真的起了进程",而预算用尽那次**没起**进程。
        this.bumpCount(spec.id, "accepted");
        const record = this.pushRun(spec, payload, "running");
        const result = await runHookCommand(effective, payload);
        Object.assign(record, result, { durationMs: Date.now() - record.startedAt });
        // 【MC-061】收口了 —— 用**同一个 runId** 把终态(ok/failed/timeout)+ 退出码 / 耗时 /
        // 原因覆盖进审计行(同一行 upsert,不是新建一行)。这样"这一条跑成没有"只有一个答案。
        this.auditRun(spec, payload, record);
        const decision = decideRetry({ attempts, retryBudget: budget, failed: result.status === "failed" });
        if (!decision.retry) break;
        // 重试这件事本身**要可观测**:计数 + 一行日志。不静默地又跑一遍 —— 否则"它跑了几次"
        // 只能在环里数 `failed` 的条数猜,而环会被顶掉。
        this.bumpCount(spec.id, "retried");
        log.info(`[hooks] 「${spec.name}」${decision.reason}`);
      }
    } finally {
      const left = (this.inFlight.get(spec.id) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(spec.id);
      else this.inFlight.set(spec.id, left);
      // 这一条跑完了(含重试)—— 若 `COALESCE` 攒着一批,此刻把它兑现成一次运行(把有界的
      // 合并真正跑出来)。**不 await**:兑现是另起一次,别让 current 的收口等它。走 `deliver`
      // 而不是 `runOne`:这一批**已经过了窗口判据**(零窗口的"忙时攒一次",或去抖窗口到期后
      // 因并发满而再次攒下),再回窗口只会平白多等一个窗口。
      const pending = this.coalescePending.get(spec.id);
      if (pending !== undefined) {
        this.coalescePending.delete(spec.id);
        void this.deliver(spec, pending).catch((err: unknown) => {
          log.warn(`[hooks] ${spec.name} 合并批次执行失败:${(err as Error).message}`);
        });
      }
    }
  }

  /**
   * 往环里塞一条执行记录,返回它(调用方接着 `Object.assign` 真结果)。新的在前,超过
   * {@link RUN_RING} 丢最旧的 —— 这是**排错用的窗口**,不是账本(账本语义见
   * {@link DeliveryCounts})。
   */
  private pushRun(
    spec: HookSpec,
    payload: HookPayload,
    status: HookRun["status"],
    error?: string,
  ): HookRun {
    const record: HookRun = {
      runId: uid("hrun_"),
      hookId: spec.id,
      hookName: spec.name,
      event: payload.event,
      sessionId: payload.session.id,
      sessionKind: payload.session.kind,
      startedAt: Date.now(),
      status,
      ...(error !== undefined ? { durationMs: 0, error } : {}),
    };
    this.runs.unshift(record);
    if (this.runs.length > RUN_RING) this.runs.length = RUN_RING;
    // 【MC-061】插件 hook 的执行**落成持久审计行** —— 建的这一条记录(不论 running /
    // skipped)第一次落库;`deliver` 收口时会**用同一个 runId 再落一次**把终态覆盖上去。
    // 用户手写的钩子不在 `pluginSources` 里 → 不落(理由见 HookRunRow 的文件头)。
    this.auditRun(spec, payload, record);
    return record;
  }

  /**
   * 【MC-061】把一条记录写进 `hook_runs` 审计表 —— **只对插件 hook**(带来源身份的)。
   *
   * 用户手写的钩子直接返回:它没有"哪份授权放行"这回事,逐条落库是写放大换不到审计价值
   * (见 `HookRunRow` 的文件头)。落库**绝不**冒到事件流(不变量 1):sink 抛错只留一行
   * 日志 —— 审计是**旁路**,它坏了,钩子照跑、对话照走。
   */
  private auditRun(spec: HookSpec, payload: HookPayload, record: HookRun): void {
    const source = this.pluginSources.get(spec.id);
    if (source === undefined) return; // 用户手写的钩子不落库
    if (this.hookRunSink === null) return; // 显式关掉(无头脚本)
    const row: HookRunRow = {
      runId: record.runId,
      hookId: spec.id,
      pluginId: source.pluginId,
      pluginVersion: source.version ?? null,
      nativeEvent: source.nativeEvent,
      commandDigest: source.commandDigest,
      matcherDigest: source.matcherDigest ?? null,
      event: payload.event,
      sessionId: payload.session.id,
      sessionKind: payload.session.kind,
      status: record.status,
      exitCode: record.exitCode ?? null,
      durationMs: record.durationMs ?? null,
      error: record.error ?? null,
      startedAt: record.startedAt,
    };
    try {
      this.hookRunSink(row);
    } catch (err) {
      log.warn(`[hooks] 审计落盘失败(${spec.name}):${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 最近的钩子定义。见文件头"每次事件都重新看一遍文件"。 */
  private hooksNow(): HookSpec[] {
    const file = hooksFilePath();
    let stamp: number | null = null;
    try {
      stamp = statSync(file).mtimeMs;
    } catch {
      stamp = null; // 文件不在 = 一条钩子都没有(正常状态)
    }
    if (stamp !== this.cache.stamp) {
      const { hooks, problems } = readHooks();
      this.cache = { hooks, stamp };
      for (const problem of problems) log.warn(`[hooks] ${problem.where}:${problem.error}`);
    }
    return this.cache.hooks;
  }

  private sessionFacts(
    sessionId: string,
  ): HookPayload["session"] | null {
    try {
      const session = SessionRepo.get(sessionId);
      if (!session) return null;
      return {
        id: session.id,
        kind: session.kind,
        title: session.title,
        projectId: session.projectId,
      };
    } catch {
      return null;
    }
  }

  private cwdOf(projectId: string, sessionId: string): string {
    try {
      // 会话的工作树优先 —— 和真正跑这一轮时用的目录一致(见 `ipc/claude.ts`)。
      const session = SessionRepo.get(sessionId);
      if (session?.worktreePath) return session.worktreePath;
      const project = ProjectRepo.get(projectId);
      if (project) return project.path;
    } catch {
      /* 读不到就退回用户主目录 */
    }
    // 不用 `process.cwd()` —— 理由见 `test()`。
    return homedir();
  }
}

/* ────────────────────────── 纯工具 ────────────────────────── */

/** 试跑时给 `matcher` 编一个能匹配上的工具名 —— 只写 `Edit,Write` 的钩子,试跑要是
 *  因为"没有工具名"而不匹配,那个按钮就没有意义了。 */
function toolMatcherSampleOf(spec: HookSpec): string | undefined {
  const first = spec.matcher
    ?.split(",")
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  if (first === undefined) return "Sample";
  // 通配符本身不是名字,拿它当样例会误导(用户看到 `mcp__*` 被当成工具名)。
  return first.includes("*") || first.includes("?") ? "Sample" : first;
}

/** 单例。在 `index.ts` 里随其它 manager 一起 start。 */
export const hookRunner = new HookRunner();
