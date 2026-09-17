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
 *    每一个事件时同步执行 —— 从这里抛出去,炸的是整个回合。所以整个 `onEvent` 包在
 *    try/catch 里,并且**不 await**:钩子跑多久都不该让对话卡住。
 * 2. **同一条钩子同时只跑一个进程。** 一个挂在 `tool.use` 上的钩子,一轮里会被触发
 *    几十次;每次都起一个进程的话,一个慢脚本能瞬间攒出几十个进程。正在跑的那条再来
 *    事件就记一条 `skipped`,不另起进程。
 * 3. **结果只进环,不进对话流。** 理由见 `@contracts/hook` 的 `HookRun`。
 *
 * ## 钩子定义每次事件都重新看一遍文件
 *
 * 用户可以直接改 `hooks.json`(那是把它放成文件的意义),所以缓存的失效靠**文件
 * 时间戳**:每次事件 `statSync` 一次(微秒级),变了才重新读。不这么做的话,手改的
 * 钩子要重启应用才生效 —— 而"改了没反应"是最难查的一类问题。
 */
import { statSync } from "node:fs";
import type { RuntimeEvent } from "@contracts/runtime";
import {
  HOOK_EVENT_OF,
  matchesHook,
  type HookPayload,
  type HookRun,
  type HookSpec,
} from "@contracts/hook";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { uid } from "@main/utils.js";
import { createEventSubjects } from "./eventSubjects.js";
import { runHookCommand } from "./runCommand.js";
import { hooksFilePath, readHooks } from "./store.js";

/** 执行记录最多留这么多条(新的在前)。超了丢最旧的 —— 这是**排错用的窗口**,不是账本。 */
const RUN_RING = 50;

class HookRunner {
  private started = false;
  /** 缓存的钩子定义 + 它对应的文件时间戳(`null` = 文件当时不存在)。 */
  private cache: { hooks: HookSpec[]; stamp: number | null } = { hooks: [], stamp: null };
  /** 正在跑的那些钩子 id。见文件头第 2 条不变量。 */
  private running = new Set<string>();
  private runs: HookRun[] = [];
  /** 事件→匹配主语(`tool.result` 要回查工具名,所以它**有状态**)。与自动化触发器
   *  共用一份逻辑,各持一个实例 —— 见 `eventSubjects.ts`。 */
  private subjects = createEventSubjects();

  start(): void {
    if (this.started) return;
    this.started = true;
    runtimeManager.subscribe((e) => {
      // **同步回调里只做分发**:真正的活全在 async 里,而且不 await(不变量 1)。
      try {
        void this.onEvent(e);
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
      cwd: process.cwd(),
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
    Object.assign(record, await runHookCommand(spec, payload), {
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

    // **先看有没有钩子**:一条都没有的话,后面那些数据库查询全免了。绝大多数事件走的
    // 就是这条路(用户通常只有一两条钩子,而 `tool.use` 一轮能来几十次)。
    const all = this.hooksNow();
    if (all.length === 0) return;

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
    const hooks = all.filter((spec) => matchesHook(spec, event, subjects));
    if (hooks.length === 0) return;

    const payload: HookPayload = {
      event,
      at: Date.now(),
      session,
      cwd,
      ...(toolName !== undefined ? { toolName } : {}),
      data: e,
    };

    for (const spec of hooks) {
      await this.runOne(spec, payload).catch((err) => {
        // 走到这儿说明 `runOne` 自己炸了。**不能让它冒出去**(不变量 1)。
        log.warn(`[hooks] ${spec.name} 执行失败:${(err as Error).message}`);
      });
    }
  }

  private async runOne(spec: HookSpec, payload: HookPayload): Promise<void> {
    const runId = uid("hrun_");
    const startedAt = Date.now();
    const record: HookRun = {
      runId,
      hookId: spec.id,
      hookName: spec.name,
      event: payload.event,
      sessionId: payload.session.id,
      sessionKind: payload.session.kind,
      startedAt,
      status: "running",
    };
    this.runs.unshift(record);
    if (this.runs.length > RUN_RING) this.runs.length = RUN_RING;

    if (this.running.has(spec.id)) {
      // 见文件头第 2 条。**记一条而不是悄悄丢掉**:用户看到的"我的钩子没跑"要能在这里
      // 找到答案 —— 它是因为上一条还在跑。
      record.status = "skipped";
      record.durationMs = 0;
      record.error = "上一条还在跑(同一条钩子同时只跑一个进程)";
      return;
    }

    this.running.add(spec.id);
    try {
      Object.assign(record, await runHookCommand(spec, payload));
    } finally {
      record.durationMs = Date.now() - startedAt;
      this.running.delete(spec.id);
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
      /* 读不到就退回宿主目录 */
    }
    return process.cwd();
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
