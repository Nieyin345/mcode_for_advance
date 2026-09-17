/**
 * 一次运行的**存档** —— 把它写下来,重启之后就能接着跑。
 *
 * ## 它解决的是什么
 *
 * 在这之前,一次运行的全部记忆(流程记录、谁跑过、用户在岔路口选了什么)都只活在
 * `runWorkflow` 里那几个 Map 里。**应用一关就没了**,包括一张已经停在岔路口等了半天
 * 的图 —— 那张卡片还留在对话记录里(`messages` 表),按钮还在,但点下去只会得到一句
 * "这条选择已经不适用了"。
 *
 * 有了这一份,点击就能**接回去**:知道停在哪一格、知道前面几步已经做过什么、知道
 * 上次在别的岔路口选过什么(见 `RunState`)。节点会话是回不来的(它们随进程一起没了),
 * 所以**跑到一半的那一步会重跑** —— 这是这一版明说的代价,不是缺陷。
 *
 * ## 什么时候写
 *
 * 只有**状态真的变了**的四个时刻:开跑、某一步定案、停在岔路口、收尾(见
 * `RunPorts.snapshot`)。**不是每来一个 token 一次** —— `persist()` 是重写整个数据库
 * 文件,按 token 写就是按 token 重写整库。
 *
 * ## 为什么这层单独一个文件
 *
 * `scheduler.ts` 是纯的(不碰磁盘),`runner.ts` 是"怎么跑一个节点"。存档是**第三件
 * 事**:把状态变成一行数据库记录、再读回来。挤进任意一边都会让那一边多一个它不该
 * 知道的关注点。
 */
import { log } from "@main/lib/logger.js";
import { WorkflowRunRepo, type WorkflowRunStatus } from "@main/store/repositories.js";
import type { RunState } from "./scheduler.js";

/**
 * 一个对话里保留最近几次运行。
 *
 * 除了"正停着、还能续跑的那一次"以外,别的都只是历史 —— 而历史的价值在**跨重启的
 * 那一次**,不在攒着。留一点余量是为了"续一次、又断一次"这种情况。
 */
const KEEP_RUNS_PER_SESSION = 10;

/**
 * 写进 `workflow_runs.payload` 的那一坨。
 *
 * 四样东西,**缺一样续跑就断**:
 *
 *  - `prompt` —— 用户最初那条消息。它只在**根节点**的提示词里出现,而续跑时点卡片
 *    的那一下手上没有这句话(见 `runner.ts`)。少了它,重跑的根节点不知道要干什么。
 *  - `cwd` —— 那次运行的节点是在哪个目录里跑的。同样"点卡片时手上没有" —— 现场只有
 *    一张卡片,没有项目。而且它是**那次运行**的目录:现在重新按会话算一遍,算出来的
 *    可能已经是另一个地方了(用户改过项目路径、或者工作树被回收了)。
 *  - `state` —— 见 `RunState`。
 *  - `attempts` —— 每个岔路口被问过几次。它决定卡片上那个「第 N 轮」,而续跑时报错
 *    轮次会让**上一轮的卡被改掉**(卡片按 `runId + nodeId + attempt` 认,见
 *    `sessionStore.patchBranchChoiceBlock`)。
 *
 * (`runId` / `workflowId` 不在这里 —— 它们是那张表的列。)
 *
 * 「这次是哪个触发器起的」也在 `state` 里(见 `RunState.entry`)—— 它是这次运行的一部分,
 * 和流程记录同居一处,不必在快照上再开一个字段。
 */
export interface RunSnapshot {
  prompt: string;
  cwd: string;
  state: RunState;
  attempts: [string, number][];
}

/** 把存档写成一行。**编码失败也要落一行**(见 `saveRun`)。 */
function encode(snapshot: RunSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * 把一行读回成存档。**读不回来返回 `null`,不抛。**
 *
 * 存档是**上个版本的进程**写的,而它可能比现在这份代码老。所以这里逐字段验形状,
 * 而不是 `as RunSnapshot` 一把梭 —— 缺了 `state` 的一份存档会让续跑在调度器深处
 * 炸,而那时已经看不出是"存档是旧的"这件事。读不回来就是没得续,用户重新跑一遍
 * 而已,没有任何东西坏掉。
 */
export function decodeSnapshot(raw: string): RunSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RunSnapshot>;
    const state = parsed.state as Partial<RunState> | undefined;
    if (typeof state !== "object" || state === null) return null;
    if (!Array.isArray(state.record) || !Array.isArray(state.outcomes)) return null;
    // **没有 `cwd` 的一份存档不算能续的。** 它是"那次在哪儿跑的",补不出来 ——
    // 按会话现在重算一个,算出来的可能已经是另一个地方了。宁可当过期卡片。
    if (typeof parsed.cwd !== "string" || parsed.cwd.length === 0) return null;
    return {
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      cwd: parsed.cwd,
      state: {
        record: state.record,
        rounds: Array.isArray(state.rounds) ? state.rounds : [],
        picks: Array.isArray(state.picks) ? state.picks : [],
        outcomes: state.outcomes,
        awaiting: (Array.isArray(state.awaiting) ? state.awaiting : []).filter(
          (x): x is string => typeof x === "string",
        ),
        // 「这次是哪个触发器起的」。**缺了就当没有** —— 它是本版新加的,老存档里没有
        // (`RunState.entry` 是可选的);形状不对的也一律丢掉,而不是带进调度器。
        ...(isRunEntry(state.entry) ? { entry: state.entry } : {}),
      },
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
    };
  } catch (err) {
    log.warn(`workflow run snapshot unreadable: ${(err as Error).message}`);
    return null;
  }
}

/** 存档里的 `entry` 只信形状对的那一种(老存档没有这个字段,被手改坏的也可能有)。 */
function isRunEntry(raw: unknown): raw is { nodeId: string; summary: string } {
  if (typeof raw !== "object" || raw === null) return false;
  const { nodeId, summary } = raw as { nodeId?: unknown; summary?: unknown };
  return typeof nodeId === "string" && nodeId.length > 0 && typeof summary === "string";
}

/**
 * 写下这次运行此刻的样子(第一次写就是建行)。
 *
 * **失败只记一行日志,不往上抛。** 存档是"用户下次能接着跑"的保险,而它坏掉不该让
 * **这一次**运行跟着死 —— 那等于为了防丢而先丢。
 */
export function saveRun(args: {
  runId: string;
  sessionId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  snapshot: RunSnapshot;
}): void {
  let payload: string;
  try {
    payload = encode(args.snapshot);
  } catch (err) {
    // 循环引用 / 值不可序列化。**落一行空的也比不落强**:至少那一行存在,
    // `decodeSnapshot` 会认出来它读不回来,而"这次运行存在过"仍然查得到。
    log.warn(`workflow run ${args.runId}: 存档编码失败 ${(err as Error).message}`);
    payload = "";
  }
  try {
    WorkflowRunRepo.save({
      id: args.runId,
      sessionId: args.sessionId,
      workflowId: args.workflowId,
      status: args.status,
      payload,
      awaiting: args.snapshot.state.awaiting,
    });
  } catch (err) {
    log.warn(`workflow run ${args.runId}: 存档写不进去 ${(err as Error).message}`);
  }
}

/** 开跑时清一次旧的。见 {@link KEEP_RUNS_PER_SESSION}。 */
export function pruneRuns(sessionId: string): void {
  try {
    WorkflowRunRepo.pruneSession(sessionId, KEEP_RUNS_PER_SESSION);
  } catch (err) {
    log.warn(`workflow run history prune failed: ${(err as Error).message}`);
  }
}

/** 一次**可以接着跑**的运行:它的存档,以及它是哪一次。 */
export interface ResumableRun {
  runId: string;
  workflowId: string;
  snapshot: RunSnapshot;
}

/**
 * 用户在**一张上一轮留下的岔路口卡片**上点了一下 —— 找那次运行。
 *
 * 判据是 `(会话, 停在这一格的节点)` 且**上次是被中断的**(见
 * `WorkflowRunRepo.resumableFor`)。找不到就是找不到:那张卡片属于一次已经跑完 /
 * 被取消 / 被别人续过的运行,点它是正常会发生的事,该得到一句"已经不适用了"而
 * 不是一个错误框(见 `BranchChoiceCard`)。
 *
 * ⚠️ **存档读不回来时也算找不到。** 那时把它当成"这张卡过期了"是对的 ——
 * 硬着头皮续一份缺胳膊少腿的状态,会让图停在一个没人看得出原因的地方。
 */
export function resumableRun(sessionId: string, nodeId: string): ResumableRun | null {
  let row;
  try {
    row = WorkflowRunRepo.resumableFor(sessionId, nodeId);
  } catch (err) {
    log.warn(`workflow resume lookup failed: ${(err as Error).message}`);
    return null;
  }
  if (row === null) return null;
  const snapshot = decodeSnapshot(row.payload);
  if (snapshot === null) {
    log.warn(`workflow run ${row.id}: 存档读不回来,这张卡片按过期处理`);
    return null;
  }
  return { runId: row.id, workflowId: row.workflowId, snapshot };
}
