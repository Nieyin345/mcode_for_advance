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
import { isTriggerKind, type TriggerKind } from "@contracts/nodeType";

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
  /** 配置侧:这条触发器现在**能不能被触发**。 */
  armed: boolean;
  /** `armed: false` 的原因(参数解不开 / 项目不在了 / 目录监听失效)。 */
  detail?: string;
  /** 最近一次**真的起跑**的时刻(ms)。没有 = 它从来没跑过。 */
  lastFireAt?: number;
  /** 最近一次「该跑而没跑成」的原因(上一次还在跑 / 项目不在了 / 起跑失败)。 */
  lastError?: string;
  lastErrorAt?: number;
}

/** 登记/更新一条事实所需的最低信息 —— `LoadedTrigger` 天然满足。 */
export interface AutomationFactsSeed {
  workflowId: string;
  nodeId: string;
  title: string;
  kind: TriggerKind | "unknown";
}

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
 */
export function triggerSeedOf(trigger: {
  workflowId: string;
  nodeId: string;
  title: string;
  spec: { kind: unknown };
}): AutomationFactsSeed {
  return {
    workflowId: trigger.workflowId,
    nodeId: trigger.nodeId,
    title: trigger.title,
    kind: isTriggerKind(trigger.spec.kind) ? trigger.spec.kind : "unknown",
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
   */
  recordSetup(seed: AutomationFactsSeed, armed: boolean, detail?: string): void {
    const key = automationTriggerKey(seed);
    const existing = this.entries.get(key);
    this.entries.set(key, {
      ...(existing ?? { key, lastFireAt: undefined, lastError: undefined, lastErrorAt: undefined }),
      key,
      workflowId: seed.workflowId,
      nodeId: seed.nodeId,
      title: seed.title,
      kind: seed.kind,
      armed,
      ...(armed || detail === undefined ? { detail: undefined } : { detail }),
    });
  }

  /** 真的起跑了一次。**顺带把 `armed` 立回 true**:能跑就说明它活着(守望起跑那条
   *  ad-hoc 路径没有经过 buildTriggers 的登记,这一笔就是它的登记)。 */
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
      armed: true,
      detail: undefined,
      lastFireAt: at,
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
      lastError: reason,
      lastErrorAt: at,
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
