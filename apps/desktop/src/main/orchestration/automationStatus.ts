/**
 * 自动化的**事实状态**(AUTO-09)与几段**纯的生命周期判定**(AUTO-05/06)。
 *
 * ## 为什么单独一个文件
 *
 * 和 `automationPayload.ts` 同一条分法:后台执行器(`automationRunner.ts`)要真起会话、
 * 真开 `fs.watch`、还要拉到 electron 的 `RuntimeManager` —— 混在一起就测不成。这里只放
 * **不碰进程、不碰文件系统**的部分,冒烟可以把每一种生命周期都断言一遍。
 *
 * ## 「事实状态」是什么
 *
 * 界面那一栏(AUTO-09)要回答的四件事:**这条触发器挂上没有**、**没挂上为什么**、
 * **最近一次什么时候跑的**、**最近一次为什么没跑成**。这些问题在运行史里答不全 ——
 * 一条配置写坏、永远不响的自动化,运行史是空的,用户看到的只有"它没反应"(见
 * `automationRunner.buildTriggers` 那段"静默跳过是最坏的写法")。所以跳过与挂载失败也
 * 要落成**可读的状态**,而不只是一行日志。
 *
 * 这里只有**内存**里的事实,不做持久化:重启之后 reload 会重新解一遍配置(挂载侧
 * 事实当场重建),而"最近一次跑"在运行史里本来就有 —— 那是 PAR-B 的持久化边界,不在这里
 * 存第二份真相。
 */
import { isTriggerKind, triggerEnabledOf, type TriggerKind, type TriggerSpec } from "@contracts/nodeType";

/** 一条触发器在后台执行器里的**事实**。 */
export interface AutomationTriggerFacts {
  /** `workflowId:nodeId`(见 {@link automationTriggerKey})。 */
  key: string;
  workflowId: string;
  nodeId: string;
  /** 给界面看的名字(节点标题)。 */
  title: string;
  /** 触发方式。`"unknown"` = 参数里连触发方式都认不出来(多半是清单变了)。 */
  kind: TriggerKind | "unknown";
  /**
   * **用户在图上开着**这条触发器(见 `NODE_TRIGGER_ENABLED_PARAM_KEY`)。
   *
   * 缺席 = 开 —— 老存档里没有这个键,而它们存下来的时候本来就在响。
   */
  enabled?: boolean;
  /**
   * 配置侧:这条触发器现在**自动响不响**。**已经把 {@link enabled} 算进去了** ——
   * 用户关掉的,这里一定是 `false`,哪怕它的目录监听挂得好好的。
   *
   * 这两个字段分开是因为它们答的是两个问题:「是你关的吗」和「它现在响不响」。
   * 合成一个的话界面只能二选一地说 —— 说"已关闭"就藏起了"目录也没挂上",
   * 说"没挂上"又像是应用坏了,而其实是用户自己关的。
   */
  armed: boolean;
  /** `armed: false` 的原因(用户关掉了 / 参数解不开 / 项目不在了 / 目录监听失效)。 */
  detail?: string;
  /** 最近一次**真的起跑**的时刻(ms)。没有 = 它从来没跑过。 */
  lastFireAt?: number;
  /** 最近一次「该跑而没跑成」的原因(上一次还在跑 / 项目不在了 / 起跑失败)。 */
  lastError?: string;
  lastErrorAt?: number;
  /**
   * 定时那一路:应用没开 / 机器睡着的那段时间里,它**本该响却一次都没响**的次数
   * (见 {@link AutomationFacts.recordMissed})。真的跑成一次就清零 —— 这个数说的是
   * 「自上一次成功以来」,不是历史总账。
   */
  missedCount?: number;
  /** 最近一次错过的那个时间点(ms)。 */
  lastMissedAt?: number;
}

/** 登记/更新一条事实所需的最低信息 —— `LoadedTrigger` 天然满足。 */
export interface AutomationFactsSeed {
  workflowId: string;
  nodeId: string;
  title: string;
  kind: TriggerKind | "unknown";
  /** 用户在图上开着这条触发器没有(见 `NODE_TRIGGER_ENABLED_PARAM_KEY`)。 */
  enabled: boolean;
}

/**
 * 用户关掉的那条触发器,事实里那句 `detail`。
 *
 * **只有一个地方写它**(`AutomationFacts.recordSetup`),因为只有一个地方读得对:
 * 挂载登记、目录监听重试成功、监听失效 —— 三条路都会重新登记同一条触发器,各写各的
 * 说法迟早分家,而界面就是拿这一句认「这条是你关的,不是坏了」的。
 */
export const TRIGGER_DISABLED_DETAIL = "已关闭(在触发器节点上打开「启用」才会自动响)";

/**
 * 一条触发器的 key(`workflowId:nodeId`)。**同一个函数**给 pendingFires、lastMinute、
 * facts 用,三处才不会分家。参数收对象 —— 调用点手里都是带这两个字段的记录。
 */
export function automationTriggerKey(trigger: { workflowId: string; nodeId: string }): string {
  return `${trigger.workflowId}:${trigger.nodeId}`;
}

/**
 * 执行器手里的触发器记录(带 `spec`)→ 事实登记的 seed。
 *
 * `kind` 从 `spec.kind` 来;认不出来(清单变了之类)就落 `"unknown"`,不猜。
 *
 * `enabled` **问的是 `params`** —— 记录里那个 `disarmed` 是它的取反,再取回来只是绕一圈。
 * 而且这两处都读同一个键(RUN-VAR 那条规矩):真相是用户在图上填的那个勾。
 */
export function triggerSeedOf(trigger: {
  workflowId: string;
  nodeId: string;
  title: string;
  spec: { kind: unknown };
  params: Record<string, unknown>;
}): AutomationFactsSeed {
  return {
    workflowId: trigger.workflowId,
    nodeId: trigger.nodeId,
    title: trigger.title,
    kind: isTriggerKind(trigger.spec.kind) ? trigger.spec.kind : "unknown",
    enabled: triggerEnabledOf(trigger.params),
  };
}

/**
 * 定时那一路这一分钟还要不要跑。
 *
 * 30 秒一跳的 ticker 会把同一分钟看两次(见 `automationRunner` 的 `TICK_MS`),去重就靠
 * 这一句。抽成纯函数没别的理由 —— 它是「同一分钟只跑一次」的全部规则,冒烟值得直接钉住。
 */
export function shouldFireThisMinute(last: number | undefined, minute: number): boolean {
  return last !== minute;
}

/**
 * 回看多久。理由见 {@link missedMinutesSince}。
 */
export const MISSED_SCAN_LIMIT_MINUTES = 7 * 24 * 60;

/**
 * 应用没开 / 机器睡着的那段时间里,这条定时触发器**本该响几次**。
 *
 * ## 为什么需要它
 *
 * `lastMinute` 那张表只回答「这一分钟跑过没有」(见 {@link shouldFireThisMinute}),
 * 应用没开的那几天它一个字都不会说。**不补跑是刻意的**(见 `automationRunner` 文件头
 * 那张表),但「连错过了都看不见」不是设计,是漏了:用户看到的是「每天九点」安安静静
 * 什么也没发生,而事实表里 `lastFireAt` 停在三天前,没有任何一条记录解释那三天。
 *
 * ## 判据
 *
 * 只数**两头之间**那些分钟:`lastMinute` 那一分钟自己已经跑过,`nowMinute` 这一分钟归
 * `onTick` 管(它马上就会看到)。没有 `lastMinute`(从来没跑过)就**一次都不数** ——
 * 没有基准时凭空说"错过了"只会吓人:一条刚建好的「每天九点」不该在建好那一刻就告诉
 * 用户它错过了三百次。
 *
 * 回看窗口封在 {@link MISSED_SCAN_LIMIT_MINUTES}:一台搁置半年的机器逐分钟扫完是
 * 二十多万次求值 × 每条触发器,而那个数字对人也没有意义 ——「错过 180 次」和
 * 「错过 4000 次」说的是同一件事。超出窗口的只数最近这一段。
 *
 * `matches` 由调用方传进来(`cronMatches` 包一层),这里**不认识 cron** —— 纯函数,
 * 冒烟可以直接钉住"错过几次"这条规则本身。
 */
export function missedMinutesSince(
  lastMinute: number | undefined,
  nowMinute: number,
  matches: (at: Date) => boolean,
): { count: number; lastAt?: number } {
  if (lastMinute === undefined) return { count: 0 };
  const from = Math.max(lastMinute + 1, nowMinute - MISSED_SCAN_LIMIT_MINUTES);
  let count = 0;
  let lastAt: number | undefined;
  for (let minute = from; minute < nowMinute; minute += 1) {
    if (!matches(new Date(minute * 60_000))) continue;
    count += 1;
    lastAt = minute * 60_000;
  }
  return lastAt === undefined ? { count } : { count, lastAt };
}

/** 事件集合签名的分隔符(见下面那段)。写成转义序列 —— 它在编辑器里看不见。 */
const SEP = "\u0000";

/**
 * 触发条件的**签名** —— 用来判断"攒着还没跑出去的那一次"还是不是按**现在**这份配置
 * 攒的。
 *
 * 为什么需要它:文件连着变的时候,`pendingFires` 里会攒着一次还没到点的触发(合并窗口
 * 最长几秒),而用户完全可能在这几秒里改了触发方式并存盘。存盘走 `apply()`,那里只丢掉
 * "触发器没了"的那些 —— 改了 glob / 改了事件名的**没被丢掉**,于是几秒后它按**旧条件**
 * 起一次运行,而旧条件正是用户刚刚改掉的东西。
 *
 * 签名只取**参与判定的那几项**(cron 文本、文件 include/exclude glob 集合、事件集合、matcher、合并窗口),
 * 不掺别的。`manual` 没有参数,所以是常量。
 *
 * 文件 glob 集合用 JSON 数组保留 include/exclude 的边界;事件集合用 `NUL`(下面写成转义
 * 序列,因为那个字符在编辑器里看不见)。不能用逗号:glob 本身就允许逗号(`"a,b"` 是
 * "任意一个"),逗号拼的话 `["a","b"]` 与 `["a,b"]` 会撞成同一个签名 —— 那就成了
 * **漏判**,而漏判的后果正是这个函数要防的那件事。`automation-smoke` 有断言专门盯住。
 */
export function triggerSpecKeyOf(spec: TriggerSpec): string {
  switch (spec.kind) {
    case "manual":
      return "manual";
    case "schedule":
      return `schedule:${spec.cron.text}`;
    case "file":
      // JSON keeps the include/exclude sets and their boundary unambiguous, even
      // when a glob itself contains punctuation used by the old signature format.
      return `file:${JSON.stringify([spec.globs, spec.excludeGlobs, spec.debounceMs])}`;
    case "event":
      return `event:${spec.events.join(SEP)}:${spec.matcher}:${spec.debounceMs}`;
  }
}

/**
 * 现在有哪些目录该开着 `fs.watch`。**只有文件触发器的项目目录**,去重:
 * 两条自动化盯同一个项目、或一条自动化挂两个文件触发器,都只该有一个 watcher。
 */
export function watcherDirsOf(
  triggers: ReadonlyArray<{ spec: { kind: string }; cwd: string }>,
): string[] {
  const out: string[] = [];
  for (const trigger of triggers) {
    if (trigger.spec.kind === "file" && !out.includes(trigger.cwd)) out.push(trigger.cwd);
  }
  return out;
}

/**
 * 这一条事实最后写什么 `detail`。三种情形,一处决定:
 *
 *  - **响着** —— 没有 `detail`。
 *  - **开着却没挂上** —— 调用方给的原因(参数解不开 / 项目不在了 / 目录监听失效)。
 *  - **用户关掉了** —— 永远先说「是你关的」。调用方那侧的原因**附在后面**:用户回头
 *    打开「启用」时会撞上它,提前说出来比到时候再猜强;但绝不能让「项目不在了」把
 *    「是你关的」顶掉 —— 后者才是他现在看到这行的原因。
 */
function setupDetail(enabled: boolean, ready: boolean, detail?: string): string | undefined {
  if (ready && enabled) return undefined;
  if (enabled) return detail;
  if (!ready && detail !== undefined) return `${TRIGGER_DISABLED_DETAIL};另外 —— ${detail}`;
  return TRIGGER_DISABLED_DETAIL;
}

/**
 * 事实表。**只有写它的执行器会碰它** —— 读走 `ofWorkflow` / `all`,写走下面那几个动词。
 *
 * 两条不变量:
 *  - **挂载侧(`armed`/`detail`)跟着 reload 走,运行侧(`lastFire`/`lastError`)跟着运行走**
 *    —— 一次 reload 可以把"挂上了"改成"挂不上",但不许抹掉"它上周跑过"。
 *  - **工作流删了,它的事实跟着走**(`retainWorkflow`) —— 界面上不该留幽灵行。
 */
export class AutomationFacts {
  private entries = new Map<string, AutomationTriggerFacts>();

  /**
   * 登记配置侧状态:挂好了(`armed: true`,不带 `detail`),或为什么挂不上。
   * **保留**运行侧字段 —— 见类头那条不变量。
   *
   * `armed` **在用户关掉时强制是 `false`**(见类头的 `enabled`)—— 调用方只管说
   * "它自己坏没坏",用户那一票在这里合进来。合在这一处,免得四个 `recordSetup` 调用点
   * 各记各的。
   */
  recordSetup(seed: AutomationFactsSeed, ready: boolean, detail?: string): void {
    const key = automationTriggerKey(seed);
    const existing = this.entries.get(key);
    const armed = ready && seed.enabled;
    this.entries.set(key, {
      ...(existing ?? { key, lastFireAt: undefined, lastError: undefined, lastErrorAt: undefined }),
      key,
      workflowId: seed.workflowId,
      nodeId: seed.nodeId,
      title: seed.title,
      kind: seed.kind,
      enabled: seed.enabled,
      armed,
      // 关掉的时候**由 `setupDetail`** 决定那句话,不看调用方传了什么:目录监听那一侧
      // 里外里会报三次(「失效:ENOENT」「失效:EPERM」「挂上了」),而用户关掉的那条
      // 从头到尾就该是同一句「是你关的」。
      detail: setupDetail(seed.enabled, ready, detail),
    });
  }

  /**
   * 真的起跑了一次。
   *
   * `armed` 跟着**用户那一票**走,而不是一律立回 true:手动运行一条关掉的触发器是
   * 允许的(见 `NODE_TRIGGER_ENABLED_PARAM_KEY`),但那不代表它从此会自动响。守望起跑
   * 那条 **ad-hoc** 路径没有经过 `buildTriggers` 的登记,`seed.enabled` 是 true,
   * 这一笔就顺带是它的登记。
   *
   * ⚠️ **运行侧的一笔不许改写挂载侧**(类头那条不变量的另一半)。已经登记过的条目,
   * `armed`/`detail` 照旧:挂载坏着(目录监听失效、参数解不开、项目不在了)的那条,
   * 手动跑一次**不等于它修好了** —— 从前这里把 `armed` 立成 `seed.enabled`、把
   * `detail` 清掉,于是「立刻运行一次」之后界面说它**响着**、失效原因消失,用户等一个
   * 永远不会响的触发器,而"为什么"已经被这笔抹掉了。挂载侧翻回 true 只有一条路:
   * reload 里的 `recordSetup`(监听重试成功走 `markArmed`,也是它)。
   */
  recordFired(seed: AutomationFactsSeed, at: number): void {
    const key = automationTriggerKey(seed);
    const existing = this.entries.get(key);
    this.entries.set(key, {
      ...(existing ?? { detail: undefined, lastError: undefined, lastErrorAt: undefined }),
      key,
      workflowId: seed.workflowId,
      nodeId: seed.nodeId,
      title: seed.title,
      kind: existing?.kind ?? seed.kind,
      enabled: seed.enabled,
      // 没登记过的(ad-hoc)这一笔就是登记:armed 跟用户那一票。登记过的保持挂载侧
      // 原状 —— 用户那一票只能把它**压成** false(关掉的不因手动跑一次而"响着"),
      // 不能把坏着的抬成 true。
      armed: existing === undefined ? seed.enabled : existing.armed && seed.enabled,
      detail: existing === undefined ? undefined : existing.detail,
      lastFireAt: at,
      // **跑成了,"错过"就清零。** 这个数说的是「自上一次成功以来漏了几次」——
      // 留着历史总账只会让界面上挂着一个永远不会消失的红字。
      missedCount: undefined,
      lastMissedAt: undefined,
    });
  }

  /** 该跑而没跑成(重入跳过 / 项目不在了 / 起跑抛错)。挂着没挂上都记 —— 界面问的是
   *  「最近一次为什么没跑成」,不是「挂载有没有问题」。 */
  recordBlocked(seed: AutomationFactsSeed, reason: string, at: number): void {
    const key = automationTriggerKey(seed);
    const existing = this.entries.get(key);
    this.entries.set(key, {
      ...(existing ?? {
        key,
        enabled: seed.enabled,
        armed: false,
        detail: reason,
        kind: seed.kind,
        lastFireAt: undefined,
      }),
      key,
      workflowId: seed.workflowId,
      nodeId: seed.nodeId,
      title: existing?.title ?? seed.title,
      kind: existing?.kind ?? seed.kind,
      enabled: seed.enabled,
      lastError: reason,
      lastErrorAt: at,
    });
  }

  /** reload 之后,这个工作流**还在**的触发器就这些;其余的事实删掉。 */
  /**
   * 定时那一路**错过了几次**(应用没开 / 机器睡着的那段时间,见
   * {@link missedMinutesSince})。
   *
   * ⚠️ **只记账,不补跑** —— 补跑是另一件事,而且是刻意不做的那件。这一笔的全部意义
   * 是让"没跑"看得见。
   *
   * ⚠️ 和 `recordBlocked` 一样,**不碰挂载侧**(`armed`/`detail`):错过不等于它坏了,
   * 恰恰相反 —— 它好好的,只是那几天没人给它通电。累加而不是覆盖:醒一次数一段,
   * 用户看到的该是"这段时间一共漏了几次"。
   */
  recordMissed(seed: AutomationFactsSeed, count: number, at: number): void {
    if (count <= 0) return;
    const key = automationTriggerKey(seed);
    const existing = this.entries.get(key);
    this.entries.set(key, {
      ...(existing ?? {
        key,
        workflowId: seed.workflowId,
        nodeId: seed.nodeId,
        title: seed.title,
        kind: seed.kind,
        enabled: seed.enabled,
        armed: false,
        detail: undefined,
        lastFireAt: undefined,
        lastError: undefined,
        lastErrorAt: undefined,
      }),
      key,
      missedCount: (existing?.missedCount ?? 0) + count,
      lastMissedAt: at,
    });
  }

  /** reload 之后,这个工作流**还在**的触发器就这些;其余的事实删掉。 */
  retainWorkflow(workflowId: string, keys: ReadonlySet<string>): void {
    for (const [key, facts] of this.entries) {
      if (facts.workflowId !== workflowId) continue;
      if (!keys.has(key)) this.entries.delete(key);
    }
  }

  /** 一个工作流的全部触发器事实(挂上的、没挂上的都在),按标题排 —— 界面要稳定的顺序。 */
  ofWorkflow(workflowId: string): AutomationTriggerFacts[] {
    return [...this.entries.values()]
      .filter((facts) => facts.workflowId === workflowId)
      .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  }

  all(): AutomationTriggerFacts[] {
    return [...this.entries.values()].sort(
      (a, b) => a.workflowId.localeCompare(b.workflowId) || a.key.localeCompare(b.key),
    );
  }

  clear(): void {
    this.entries.clear();
  }
}
