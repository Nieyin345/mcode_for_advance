/**
 * 长期任务（LongTask）—— 让一个目标被**连续多轮**地真正执行到完成。
 *
 * ## 解决什么问题
 * 普通对话一轮就结束:模型答一段话(常常只有"理论/计划")就停了。长期任务在
 * **宿主侧**加一圈循环:第一轮由用户发起,之后每个回合结束(`turn.done`)时检查
 * 模型有没有宣布完成 —— 没宣布就**自动开下一轮**让它继续干活,直到:
 *  - 模型输出 {@link TASK_DONE_MARKER}(目标达成,它自己验证过);
 *  - 模型输出 {@link TASK_BLOCKED_MARKER_PREFIX}(外部条件卡死,需要用户介入);
 *  - 用户主动停止(点停止按钮 = interrupt,任务随即终止,**不**自动续轮);
 *  - 轮数耗尽(`maxIterations`,防失控)。
 *
 * ## 与工具通路的关系
 * 完全解耦。循环只调 `RuntimeManager.sendTurn`,每一轮内部用什么引擎、引擎怎么
 * 调工具(本地 CLI 内建工具 / bridge / 扩展),是那条链自己的事。
 *
 * ## 完成判定的协议
 * 靠模型在回复末尾输出机器可读标记(见 {@link parseTaskOutcome}),提示词在
 * {@link taskProtocolPreamble} / {@link taskContinuationPrompt} 里随目标注入。
 * 没有标记 = 未完成(继续)。误判的代价被 maxIterations 与用户停止兜住。
 */
import { z } from "zod";

/** 任务完成标记。模型在回复**最后一行**单独输出,表示目标已达成且验证过。 */
export const TASK_DONE_MARKER = "[[TASK_DONE]]";

/** 任务卡死标记的前缀。完整形如 `[[TASK_BLOCKED: 原因]]`。 */
export const TASK_BLOCKED_MARKER_PREFIX = "[[TASK_BLOCKED";

/** 默认轮数上限 —— 一轮里引擎自己的 agentic loop 可以跑很多步,20 轮已经是很长的任务。 */
export const DEFAULT_LONG_TASK_MAX_ITERATIONS = 20;

/** 任务状态。
 *  - `running` 循环进行中(两轮之间的空档也算 running);
 *  - `done` 模型宣布完成;
 *  - `blocked` 模型宣布卡死(或回合因错误收场)—— 等用户处理;
 *  - `stopped` 用户停止;
 *  - `maxed` 轮数耗尽。 */
export type LongTaskStatus = "running" | "done" | "blocked" | "stopped" | "maxed";

/** 一条长期任务。落库(`long_tasks` 表)并随 `longtask.update` 事件广播。 */
export interface LongTask {
  id: string;
  sessionId: string;
  projectId: string;
  /** 用户提出的目标(原话)。 */
  goal: string;
  status: LongTaskStatus;
  /** 已消耗的轮数(含用户发起的第一轮)。 */
  iterations: number;
  maxIterations: number;
  /** 最近一次状态变化的短说明(完成/卡死原因/停止者),给状态条显示。 */
  note: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** 渲染端收到的那份任务状态(RuntimeEvent 载荷)。 */
export interface LongTaskUpdateEvent {
  type: "longtask.update";
  sessionId: string;
  task: LongTask;
}

/* ────────────────────────── IPC 输入 ────────────────────────── */

export const LongTaskStartSchema = z.object({
  sessionId: z.string().min(1),
  /** 目标(用户在输入框里打的那句话,原样)。trim 后才验长度 —— 全空白的
   *  "目标"挂上去只会得到一个空任务,必须挡在入口。 */
  goal: z.string().trim().min(1),
  maxIterations: z.number().int().min(1).max(200).optional(),
});
export type LongTaskStartInput = z.infer<typeof LongTaskStartSchema>;

export const LongTaskStopSchema = z.object({ sessionId: z.string().min(1) });
export type LongTaskStopInput = z.infer<typeof LongTaskStopSchema>;

/** 会话当前任务的读口(渲染端启动/重连时拉一次)。 */
export const LongTaskGetSchema = z.object({ sessionId: z.string().min(1) });
export type LongTaskGetInput = z.infer<typeof LongTaskGetSchema>;

/* ────────────────────────── 协议提示词 ────────────────────────── */

/**
 * 第一轮随目标一起发出的协议说明。**附加在用户目标之后**,不替换用户的原话 ——
 * 引擎看到的完整 prompt = `目标\n\n这份协议`。
 */
export function taskProtocolPreamble(goal: string): string {
  return [
    goal.trim(),
    "",
    "──",
    "【长期任务协议】上面这句是你的工作目标,系统会驱动你连续多个回合把它做完。",
    "像真正的执行者那样干活:调用工具实际操作(读写文件、跑命令、检索、下载…),边做边验证,不要只给理论、计划或\"你可以这样做\"式的说明。",
    "规则:",
    "1. 每个回合都实际推进:用工具完成下一步,验证结果,再决定再下一步。",
    "2. 用任务清单工具(TodoWrite/TaskUpdate)维护步骤与进度,跨回合可见,续轮时先对照它。",
    "3. 目标**完全达成且你亲自验证过结果**时:在回复的最后一行单独输出 [[TASK_DONE]](之后不再输出别的)。",
    "4. 被外部条件卡死(缺凭据/权限/访问不到的依赖),必须用户介入才能继续时:在最后一行输出 [[TASK_BLOCKED: 一句话原因]]。",
    "5. 没有输出上述标记时,回合结束后系统会自动开下一轮让你继续 —— 这是预期行为,不要重复已完成的工作,从断点接着干。",
  ].join("\n");
}

/**
 * 续轮提示。由宿主在每个未完成的回合结束后自动发出。
 */
export function taskContinuationPrompt(
  goal: string,
  iterations: number,
  maxIterations: number,
): string {
  return [
    `【长期任务 · 自动续轮】第 ${iterations + 1}/${maxIterations} 轮。目标:${goal.trim()}`,
    "上一回合已结束,但你没有输出 [[TASK_DONE]],任务还没完成。",
    "对照你的任务清单从断点继续:调用工具实际操作推进下一步并验证,不要复述计划、不要总结已完成的内容。",
    `剩余自动续轮次数:${maxIterations - iterations}。若目标已完全达成并验证过,在回复最后一行输出 [[TASK_DONE]];若被外部条件卡死,输出 [[TASK_BLOCKED: 原因]]。`,
  ].join("\n");
}

/* ────────────────────────── 终局判定(纯函数,smoke 直测) ────────────────────────── */

/** 一轮结束后对"任务是否该停"的判定结果。 */
export type TaskOutcome =
  | { outcome: "done" }
  | { outcome: "blocked"; reason: string }
  | { outcome: "running" };

/**
 * 从回合的最终文本里解析终局标记。
 *
 * 取**最后一次**出现(模型可能在过程里举例提到过标记本身;真正作数的是它最后说的)。
 * 两个标记都出现时 blocked 优先 —— 卡死是更保守的结论,宁可停下来让人看。
 */
export function parseTaskOutcome(finalText: string): TaskOutcome {
  const text = finalText ?? "";
  const blocked = text.lastIndexOf(TASK_BLOCKED_MARKER_PREFIX);
  if (blocked >= 0) {
    const close = text.indexOf("]]", blocked);
    const raw = close > blocked ? text.slice(blocked + TASK_BLOCKED_MARKER_PREFIX.length, close) : "";
    const reason = raw.replace(/^[:：\s]+/, "").trim() || "模型没有说明原因";
    return { outcome: "blocked", reason };
  }
  if (text.lastIndexOf(TASK_DONE_MARKER) >= 0) return { outcome: "done" };
  return { outcome: "running" };
}
