/**
 * **长期任务循环器** —— 用户一个目标,agent 连续多个回合把它干完。
 *
 * ## 它解决什么
 * 普通对话一轮就收场:模型答一段话(常常只有理论与计划)就停了。这里在
 * `RuntimeManager` 之上加一圈**宿主侧循环**:第一轮由用户在对话里正常发出,
 * 之后每个回合结束(`turn.done`)时检查模型有没有输出完成标记
 * (见 `contracts/src/longTask.ts` 的协议)—— 没有就**自动开下一轮**,让它
 * 从断点接着干,直到完成 / 卡死 / 用户停止 / 轮数耗尽。
 *
 * "真正干活"发生在**每一轮内部**(引擎自己的 agentic loop:读文件、写文件、跑
 * 命令……);循环器的职责是不让它在轮与轮之间停下,并把进度落库、推给界面。
 * 它不关心也不干预工具走哪条通路 —— 与 bridge / 扩展 / MCP 完全解耦。
 *
 * ## 挂法与不变量(同 HookRunner / AutomationRunner)
 * ① 订阅回调里**绝不抛异常**(事件流是别人的主路径);② 一条会话同时只有一条
 * running;③ 任何中间态变化都 `LongTaskRepo` 落库 + `longtask.update` 事件广播,
 * 界面状态条只认事件,不自己猜。
 *
 * ## 第一轮是借来的
 * `start()` **不自己发第一轮** —— 渲染端先正常走 `claude:sendTurn`(用户气泡、
 * 模型覆盖、标题生成这些既有逻辑原样保留),成功后立刻调 `longtask.start` 挂上
 * 循环器。所以循环器是从**第一个 turn.done** 开始接管的;第一轮流出的前几段文本
 * (挂上之前的部分)不在缓冲里,但完成标记在回复**末尾**,不影响判定。
 *
 * ## 停止的语义
 * 用户点停止(正常 interrupt)会让当轮以 `reason: "interrupted"` 收场 —— 那是
 * **人的意志**,循环器把任务标成 stopped,**不**续轮。`longtask.stop` 同理,
 * 顺带 interrupt 正在跑的那一轮(立即生效,而不是等它跑完)。
 */
import {
  DEFAULT_LONG_TASK_MAX_ITERATIONS,
  taskContinuationPrompt,
  parseTaskOutcome,
  type LongTask,
} from "@contracts/longTask";
import type { RuntimeEvent } from "@contracts/runtime";
import { ProjectRepo, SessionRepo, LongTaskRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { log } from "@main/lib/logger.js";

/** 单个回合的文本缓冲上限。完成标记在回复末尾,留尾部 64KB 绰绰有余 ——
 *  不设上限的话一个超长回合会把这段内存一直攒到任务结束。 */
const TEXT_BUF_KEEP = 64 * 1024;

/** 续轮 sendTurn 被拒(会话恰好忙)后的重试节奏。 */
const CONTINUE_RETRY_MS = 2_000;
const CONTINUE_MAX_RETRIES = 3;

/** 挂在一条会话上的活任务:落库行的 id + 这一个回合的文本缓冲。 */
interface ActiveTask {
  id: string;
  /** 当前回合累计的 assistant 文本(text.delta 拼接),turn.done 时做终局判定。 */
  textBuf: string;
  /** 续轮重试计数(见 CONTINUE_MAX_RETRIES)。 */
  continueRetries: number;
  /** 续轮重试的计时器(dispose 时清)。 */
  timer?: ReturnType<typeof setTimeout>;
}

class LongTaskRunner {
  private started = false;
  private unsubscribe: (() => void) | null = null;
  /** 活跃任务:`sessionId → 任务`。一条会话同时只有一条。 */
  private active = new Map<string, ActiveTask>();

  /* ────────────────────────── 启停 ────────────────────────── */

  /** 由 `main/index.ts` 在 `awaitDb()` 之后调用(同 hookRunner / automationRunner)。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    // 不变量 ①:回调里 try/catch 包死,异常只进日志。
    this.unsubscribe = runtimeManager.subscribe((e) => {
      try {
        this.onEvent(e);
      } catch (err) {
        log.warn(`[longtask] 事件处理失败:${(err as Error).message}`);
      }
    });
    log.info("LongTaskRunner started");
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [, entry] of this.active) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    this.active.clear();
    log.info("LongTaskRunner disposed");
  }

  /* ────────────────────────── 对外接口(IPC 调) ────────────────────────── */

  /**
   * 把"刚发出的这一轮"挂成长期任务。调用方(渲染端)先正常 `claude:sendTurn`
   * 发起第一轮,再调这里 —— 见文件头"第一轮是借来的"。
   *
   * 返回 `{ ok, task?, error? }`:任务已在跑、会话不存在、或会话种类不对都是
   * `ok:false`,渲染端把 error 原样提示给用户。
   *
   * 叫 `attach` 不叫 `start`:`start()` 已经是**生命周期**订阅方法(上面那个,
   * 命名对齐 hookRunner / automationRunner),IPC 挂任务这条不能重名。
   */
  attach(input: { sessionId: string; goal: string; maxIterations?: number }): {
    ok: boolean;
    task?: LongTask;
    error?: string;
  } {
    const session = SessionRepo.get(input.sessionId);
    if (!session) return { ok: false, error: "会话不存在,任务没挂上" };
    // 节点/自动化会话由调度器驱动,turn.done 语义不同(holdTurnEnd),不许挂。
    if (session.kind !== "chat" && session.kind !== "side") {
      return { ok: false, error: "只有对话可以挂长期任务" };
    }
    if (this.active.has(session.id)) {
      return { ok: false, error: "这个会话已经有进行中的长期任务 —— 等它结束或先停止" };
    }

    const task = LongTaskRepo.create({
      sessionId: session.id,
      projectId: session.projectId,
      goal: input.goal.trim(),
      maxIterations: input.maxIterations ?? DEFAULT_LONG_TASK_MAX_ITERATIONS,
    });
    this.active.set(session.id, { id: task.id, textBuf: "", continueRetries: 0 });
    this.emit(task);
    log.info(`[longtask] 挂上任务 ${task.id}(目标:${task.goal.slice(0, 60)}…)`);
    return { ok: true, task };
  }

  /**
   * 停止会话的长期任务。**顺带 interrupt 正在跑的那一轮** —— "停止任务"应该立刻
   * 生效,而不是等当轮跑完。之后到来的 `turn.done(interrupted)` 找不到活任务,自然忽略。
   */
  stop(sessionId: string): { ok: boolean; task?: LongTask; error?: string } {
    const entry = this.active.get(sessionId);
    if (!entry) {
      // 没有活任务:可能是重启后想停一条残留的 running 行 —— 顺手把它标掉。
      const stale = LongTaskRepo.latestOf(sessionId);
      if (stale && stale.status === "running") {
        const done = LongTaskRepo.finish(stale.id, "stopped", "停止(任务未在运行)");
        if (done) this.emit(done);
        return { ok: true, task: done ?? undefined };
      }
      return { ok: false, error: "这个会话没有进行中的长期任务" };
    }
    try {
      runtimeManager.interrupt(sessionId);
    } catch (err) {
      log.warn(`[longtask] 停止任务时的 interrupt 失败(回合可能已结束):${(err as Error).message}`);
    }
    const done = LongTaskRepo.finish(entry.id, "stopped", "用户停止");
    this.active.delete(sessionId);
    if (done) this.emit(done);
    log.info(`[longtask] 任务 ${entry.id} 被用户停止`);
    return { ok: true, task: done ?? undefined };
  }

  /** 会话当前任务(渲染端启动/重连时拉一次)。 */
  currentOf(sessionId: string): LongTask | null {
    if (this.active.has(sessionId)) return LongTaskRepo.latestOf(sessionId);
    // 没有活任务时返回最新一条(可能是 done/blocked/stopped 的历史)—— 状态条
    // 据此区分"没有任务"与"最近一条已收场"。
    return LongTaskRepo.latestOf(sessionId);
  }

  /** 这个会话有没有挂在循环器上的活任务(渲染端判断显示"进行中"还是历史)。 */
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /* ────────────────────────── 事件驱动 ────────────────────────── */

  private onEvent(e: RuntimeEvent): void {
    if (e.type === "session.deleted") {
      // 会话没了:任务悄悄收场(没有界面可更新,不 emit)。
      if (this.active.has(e.sessionId)) {
        LongTaskRepo.finish(this.active.get(e.sessionId)!.id, "stopped", "会话已删除");
        this.active.delete(e.sessionId);
      }
      return;
    }
    const entry = this.active.get(e.sessionId);
    if (!entry) return;

    if (e.type === "text.delta") {
      entry.textBuf += e.text;
      if (entry.textBuf.length > TEXT_BUF_KEEP) {
        entry.textBuf = entry.textBuf.slice(-TEXT_BUF_KEEP);
      }
      return;
    }

    if (e.type === "turn.done") {
      // 节点会话被 hold 的 turn.done 不是真正的回合边界;能挂任务的只有 chat/side,
      // 正常不会被 hold。防御一行,同 automationRunner 的判据。
      if (runtimeManager.isTurnEndHeld(e.sessionId)) return;
      void this.onTurnDone(e.sessionId, entry, e.reason);
      return;
    }
  }

  /** 一个回合结束了:计数、判定终局、或续轮。 */
  private async onTurnDone(
    sessionId: string,
    entry: ActiveTask,
    reason: string,
  ): Promise<void> {
    let task = LongTaskRepo.get(entry.id);
    if (!task || task.status !== "running") {
      this.active.delete(sessionId);
      return;
    }
    task = LongTaskRepo.bumpIterations(entry.id);
    if (!task) {
      this.active.delete(sessionId);
      return;
    }
    // 轮次推进立刻广播 —— 状态条上的「第 N/M 轮」就靠这一下动起来(终局路径
    // 自己会 emit;没走到终局的普通续轮只有这里这一播)。
    this.emit(task);

    // 用户打断 = 人的意志,永远不续轮(同文件头"停止的语义")。
    if (reason === "interrupted") {
      const done = LongTaskRepo.finish(entry.id, "stopped", "用户停止");
      this.active.delete(sessionId);
      if (done) this.emit(done);
      return;
    }
    // 回合因错误收场:模型这边没法保证断点状态,标 blocked 等人来。
    if (reason === "error") {
      const done = LongTaskRepo.finish(entry.id, "blocked", "上一回合因错误结束 —— 处理后可在对话里发「继续」");
      this.active.delete(sessionId);
      if (done) this.emit(done);
      return;
    }

    const outcome = parseTaskOutcome(entry.textBuf);
    entry.textBuf = "";

    if (outcome.outcome === "done") {
      const done = LongTaskRepo.finish(entry.id, "done", "模型确认目标达成");
      this.active.delete(sessionId);
      if (done) this.emit(done);
      log.info(`[longtask] 任务 ${entry.id} 完成(共 ${done?.iterations ?? "?"} 轮)`);
      return;
    }
    if (outcome.outcome === "blocked") {
      const done = LongTaskRepo.finish(entry.id, "blocked", `模型报告卡死:${outcome.reason}`);
      this.active.delete(sessionId);
      if (done) this.emit(done);
      log.info(`[longtask] 任务 ${entry.id} 卡死:${outcome.reason}`);
      return;
    }

    // 未完成:轮数耗尽就收,否则续轮。
    if (task.iterations >= task.maxIterations) {
      const done = LongTaskRepo.finish(
        entry.id,
        "maxed",
        `已达 ${task.maxIterations} 轮上限,自动停止 —— 需要的话在对话里继续`,
      );
      this.active.delete(sessionId);
      if (done) this.emit(done);
      return;
    }
    this.sendContinuation(sessionId, entry);
  }

  /**
   * 发出续轮。**发之前把缓冲清空** —— 下一轮的判定只看下一轮的文本。
   *
   * `sendTurn` 返回 null(会话恰好被别的发送占住)时按固定节奏重试几次,
   * 都失败就标 blocked —— 宁可停下来让人看,也不能悄悄丢掉一个任务。
   */
  private sendContinuation(sessionId: string, entry: ActiveTask): void {
    void (async (): Promise<void> => {
      for (;;) {
        const task = LongTaskRepo.get(entry.id);
        // 任务在等待期间被停止/删除,或者循环器已关 —— 直接放弃。
        if (!task || task.status !== "running" || !this.active.has(sessionId)) return;

        const session = SessionRepo.get(sessionId);
        const project = session ? ProjectRepo.get(session.projectId) : undefined;
        if (!session || !project) {
          const done = LongTaskRepo.finish(entry.id, "blocked", "会话或项目不存在了,续轮失败");
          this.active.delete(sessionId);
          if (done) this.emit(done);
          return;
        }

        const prompt = taskContinuationPrompt(task.goal, task.iterations, task.maxIterations);
        // bindSession 幂等(已绑就返回原样):长任务起于应用重启后的旧会话时,
        // 渲染端那条 sendTurn 已经绑过;重复调无害。
        runtimeManager.bindSession(session);
        const handle = await runtimeManager.sendTurn(session, {
          prompt,
          cwd: project.path,
        });
        if (handle !== null) {
          // 起来了:缓冲从头记这一轮。
          entry.textBuf = "";
          entry.continueRetries = 0;
          log.info(`[longtask] 任务 ${entry.id} 续轮(第 ${task.iterations + 1}/${task.maxIterations} 轮)`);
          return;
        }
        entry.continueRetries += 1;
        if (entry.continueRetries >= CONTINUE_MAX_RETRIES) {
          const done = LongTaskRepo.finish(entry.id, "blocked", "会话忙,续轮多次失败 —— 手动发「继续」可接上");
          this.active.delete(sessionId);
          if (done) this.emit(done);
          return;
        }
        // 会话忙:等一拍再试(上面开头那段会重查任务还活着没有)。
        await new Promise<void>((resolve) => {
          entry.timer = setTimeout(resolve, CONTINUE_RETRY_MS);
          entry.timer!.unref();
        });
      }
    })().catch((err: unknown) => {
      // 不变量 ①:这条路从事件流里进来,异常只进日志。
      log.warn(`[longtask] 续轮失败:${(err as Error).message}`);
    });
  }

  /** 广播任务状态(渲染端状态条的唯一事实来源)。 */
  private emit(task: LongTask): void {
    try {
      runtimeManager.emitExternal({ type: "longtask.update", sessionId: task.sessionId, task });
    } catch (err) {
      log.warn(`[longtask] 广播任务状态失败:${(err as Error).message}`);
    }
  }
}

/** 单例。在 `index.ts` 里随其它 runner 一起 start / dispose。 */
export const longTaskRunner = new LongTaskRunner();
