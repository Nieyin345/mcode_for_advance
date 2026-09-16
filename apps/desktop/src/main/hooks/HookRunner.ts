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
import { relative } from "node:path";
import type { RuntimeEvent } from "@contracts/runtime";
import {
  matchesHook,
  type HookEvent,
  type HookPayload,
  type HookRun,
  type HookSpec,
} from "@contracts/hook";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { uid } from "@main/utils.js";
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
  /**
   * `toolCallId → 工具名`。**只为了 `tool.result`**:那个事件本身不带工具名(三个
   * 提供方都不带,见 `ToolResultEvent`),而"Write 跑完之后做点什么"是最自然的一种
   * 钩子。用完即删,顺带把内存兜住。
   */
  private toolNames = new Map<string, string>();

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

    const session = this.sessionFacts(e.sessionId);
    if (session === null) return; // 会话已经没了(删了 / 是别的进程留下的)——
    const cwd = this.cwdOf(session.projectId, e.sessionId);
    const { toolName, subjects } = this.subjectOf(e, cwd);
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

  /**
   * 这次事件的**主语**(`matcher` 拿去比的东西)和**工具名**(载荷里的 `toolName`)。
   *
   * 两件事一起做,是因为它们共用一份状态:工具名得先记下来,`tool.result` 那种只带
   * `toolCallId` 的事件才查得到(见 `toolNames`)。
   */
  private subjectOf(
    e: RuntimeEvent,
    cwd: string,
  ): { toolName?: string; subjects?: readonly string[] } {
    switch (e.type) {
      case "tool.use":
      case "approval.request":
        // 记下来给后面的 `tool.result` 用(见 `toolNames` 的注释)。
        this.toolNames.set(e.toolCallId, e.toolName);
        // 上界:异常情况下(结果一直没回来)不让它无限长。
        if (this.toolNames.size > 500) this.toolNames.clear();
        return { toolName: e.toolName, subjects: [e.toolName] };
      case "tool.result": {
        const name = this.toolNames.get(e.toolCallId);
        this.toolNames.delete(e.toolCallId);
        return name === undefined ? {} : { toolName: name, subjects: [name] };
      }
      case "turn.files":
        return { subjects: fileSubjects(e.files.map((f) => f.filePath), cwd) };
      default:
        return {};
    }
  }
}

/* ────────────────────────── 纯工具 ────────────────────────── */

/**
 * 每个 `RuntimeEvent` 对应哪个钩子事件;`null` = **故意不暴露**。
 *
 * 写成 `Record<RuntimeEvent["type"], …>` 而不是 `switch` + `default: null`,是为了让
 * "将来加了一个事件,要不要给它一个钩子"变成**编译期**的问题:`RuntimeEvent` 多一个
 * 成员,这张表就少一行,tsc 当场报错。`switch` 做不到 —— 它会安静地把新事件吞掉,而
 * "这个钩子怎么不响"是最难查的一类问题。
 */
const HOOK_EVENT_OF: Record<RuntimeEvent["type"], HookEvent | null> = {
  "user.message": "user.message",
  "tool.use": "tool.use",
  "tool.result": "tool.result",
  "approval.request": "approval.request",
  "request.resolved": "request.resolved",
  "question.ask": "question.ask",
  "plan.approval_request": "plan.approval_request",
  "todo.update": "todo.update",
  "subagent.update": "subagent.update",
  "turn.files": "turn.files",
  "turn.incomplete": "turn.incomplete",
  "turn.done": "turn.done",
  "compact.result": "compact.result",
  error: "error",
  "upstream.issue": "upstream.issue",
  "workflow.node.result": "workflow.node.result",

  /* ── 还没给,不是不该给 ── */

  // 工作流停在岔路口等用户拍板(`runner.kind === "branch"` 的节点)。
  //
  // 这一条**将来会有**,而且大概是"自动化"那个场景下最该通知的一件事(没人看着的
  // 时候,图停在那儿等一个回答,而外面什么迹象都没有)。现在不给是因为给一个钩子
  // 事件要动四处(契约的 `HOOK_EVENTS`、这张表、`HooksPanel` 的两张标签表、中英各
  // 两条词条),而它属于"自动化"那一摊 —— 放在这次改动里会让这次改动说不清边界。
  //
  // ⚠️ 放在这一段而不是下面那段,是怕后来的人读成"这是刻意不给的"。**它能给**,
  // 只是还没轮到。
  "workflow.node.choice": null,

  /* ── 故意不暴露的(是"不该给",不是"还没来得及给")── */

  // 太频繁:一次对话能来几万条,挂上就是每秒钟起一堆进程。
  "text.delta": null,
  thinking: null,
  "subagent.transcript": null,
  // 给已经画出来的那张步骤卡**补一个花费数字**。它是 `workflow.node.result` 的**后补**
  // (用量要等那个回合结算才有,而卡片是节点收场那一刻就画出来的,见
  // `@contracts/runtime` 的 `WorkflowNodeUsageEvent`)。所以挂钩子这件事它完全搭不上:
  // 要挂的是"这一步跑完了",那一条已经给了 —— 再给一个"后来又知道了它的花费"只会让
  // 同一个节点触发两次,而后一次什么新信息都没有(除了钱)。
  "workflow.node.usage": null,
  // 工作流节点跑的**过程**(工具调用、中间文本),给界面那张卡片看的。
  // 挂钩子的话"这一步做了什么"该走 `workflow.node.result` —— 那是它跑完的那个点,
  // 也是钩子作者真正想接的时刻;过程流本身是一次运行里最吵的东西。
  "workflow.node.transcript": null,
  // 计划草稿在计划模式里每变一次文本就发一次(和 `text.delta` 同级)。要挂就挂
  // `plan.approval_request` —— 那才是"计划写好了"这个有意义的时间点。
  "plan.update": null,
  // 每次 API 调用后都发,纯展示用。
  "token-usage.updated": null,
  // 宿主侧的行内提示卡(预算到顶/模型回退/结构化校验失败),纯 UI 事件。挂钩子没有
  // 意义:预算到顶那条的"回合结束了"时刻走 `turn.done`(reason="interrupted")。
  "turn.notice": null,
  // 渲染层画一张图用的,不是"发生了什么"。
  "browser.image": null,
  // 内部同步信号(客户端之间对齐"哪些会话在跑"),不是事件。
  "session.runningSnapshot": null,
  // 每次改名 / 置顶 / 归档都发,噪音大而钩子做不了什么。
  "session.changed": null,
  // 用户手点的一次回退,而且要紧的信息(哪些文件)在 `turn.files` 里已经有过了。
  "turn.rewound": null,
  // 助手一条消息写完 —— 与 `turn.done` 重叠(多数轮次只有一条消息)。要挂就挂后者。
  "message.complete": null,
  // 纯界面状态(切到计划模式之类)。
  "mode.change": null,
  // 下面两条**没有活着的会话**,而钩子载荷里的 `session` 是必填的:
  // `session.deleted` 的会话已经没了;`git.changed` 压根不属于任何会话(它的
  // `sessionId` 是空串)。硬塞一个空壳会让 `jq .session.id` 拿到 `""`,用户分不清
  // "没有会话"和"会话 id 是空"。要给它们钩子,得先设计"不属于会话的事件"长什么样。
  "session.deleted": null,
  "git.changed": null,
};

/**
 * `turn.files` 的匹配主语:每个文件的**绝对路径**和**相对会话目录的路径**,都换成 `/`。
 *
 * 两份都给,是因为用户脑子里想的是哪种都有 —— `src/*.ts`(相对)和 `*.ts`(哪儿都
 * 算)。只给绝对路径的话前者永远匹配不上(它是 `D:/…/src/a.ts`);只给相对的则拿不到
 * 会话目录之外的文件。两边都试一次最省心,代价只是模式匹配多跑一遍。
 */
function fileSubjects(paths: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const abs = path.replace(/\\/g, "/");
    out.push(abs);
    const rel = relative(cwd, path).replace(/\\/g, "/");
    if (rel.length > 0 && rel !== abs) out.push(rel);
  }
  return out;
}

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
