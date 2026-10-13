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
 * 所以中断时仍在执行的步骤可能带未确认副作用,**不可自动重放**:先核对结果,
 * 再由用户重新发起运行。
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
 *
 * ## 持久化边界(这一层负责什么、不负责什么)
 *
 * **身份层级**(contract 见 `@contracts/runtime` 的 `WorkflowRunIdentity`):
 *
 * ```text
 * sessionId(对话) ⊇ runId(一次图执行) ⊇ nodeId(图上的一个节点)
 * ```
 *
 * - `sessionId` 是**对话**;一个对话同时最多跑一张图(`runner.ts` 的 `runs`)。
 * - `runId` 是一次图执行的 id,**续跑沿用旧 id**(卡片按它认)。
 * - `nodeId` 是图里的局部记号,同一张图跑两次 id 相同 —— 所以"哪一步"永远要
 *   `runId + nodeId` 一起说,单说 nodeId 分不清两次运行。
 *
 * **运行生命周期**(存一行,状态在 `workflow_runs.status` 列上):
 *
 * ```text
 * running ──收尾──▶ success / failed / cancelled
 *    │                  ▲
 *    │进程死了          │续跑(沿用 runId)
 *    ▼                  │
 * interrupted ──────────┘
 * ```
 *
 * 节点层面的生命周期(ready → running → settled)归调度器;这里同时记录
 * 派发前同步落盘的在飞标记与定案后的 `NodeOutcome`。
 *
 * **单一真相**:
 *
 * - `workflow_runs.awaiting` 列只是 `RunState.awaiting` 的**可查询投影** —— 两者由
 *   `saveRun` 在同一时刻从同一份状态写出,谁也不许单独改。
 * - run 历史**从同一份快照折出来**(见 `runHistory`),不为展示另存一份。
 * - `NodeOutcome.artifacts` 存的是**引用**(`NodeArtifact.uri`),文件本体留在外部 ——
 *   快照里永远不存产物内容,避免"同一份数据两处真相"。
 */
import { log } from "@main/lib/logger.js";
import { WorkflowRunRepo, type WorkflowRunStatus } from "@main/store/repositories.js";
import { commitNow } from "@main/store/db.js";
import type { CommitResult } from "@contracts/commit";
import type { RunState } from "./scheduler.js";
import { WORKFLOW_RUN_SNAPSHOT_VERSION, type WorkflowRunIdentity } from "@contracts/runtime";
import { NODE_OUTCOME_STATUSES, type NodeOutcome } from "@contracts/nodeType";
import { RetryableOutbox, type OutboxStats, type OutboxFailure } from "@main/store/outbox.js";

/**
 * 一个对话里保留最近几次运行。
 *
 * 除了"正停着、还能续跑的那一次"以外,别的都只是历史 —— 而历史的价值在**跨重启的
 * 那一次**,不在攒着。留一点余量是为了"续一次、又断一次"这种情况。
 */
const KEEP_RUNS_PER_SESSION = 10;

/**
 * 【ARC-005 步②】「**这次运行真的落盘了**」这一个**领域成功信号**的出口。
 *
 * 从前没有任何地方能区分「写进了内存」和「fsync 到了磁盘」—— 调用方只拿到一个布尔,
 * 而"内存已变、磁盘没写"那种态既不算成功也不算没发生。ARC-005 的规矩是:**「运行已提交」
 * 这类成功事件只许在 durable 之后发**,绝不在仅内存应用时发。
 *
 * 所以这一层把成功信号收成一个订阅口:只有 `saveRun` 在 `opts.durable` 且落盘结果
 * **真的 durable**(见 `@contracts/commit` 的 `DURABLE`)时才 notify。非 durable 时
 * **一个信号都不发** —— 这正是本切片要钉住的不变量。
 *
 * ⚠️ 订阅者抛错**不能**把已经落定的提交拖回去(提交是真的、信号只是通知),所以逐个
 * try/catch、只记日志。
 */
export interface RunCommitted {
  runId: string;
  sessionId: string;
  workflowId: string;
  status: WorkflowRunStatus;
}

/**
 * 【ARC-005 切片⑤】订阅者按**稳定 id** 登记 —— 投递账本(见 {@link runCommittedOutbox})
 * 靠这个 id 记住"这条事件已经投给谁了",从而在重投时**跳过已投成的**,绝不把已成功的
 * 再发一遍(与 `@contracts/durableEvent` 的终态纪律同一条)。
 */
const runCommittedListeners = new Map<string, (run: RunCommitted) => void>();
let runCommittedSubscriberSeq = 0;

/**
 * 【ARC-005 切片⑤】「运行已提交」成功信号的**有界、可重试、失败如实登记**投递账本。
 *
 * 从前这里是逐个 `try { listener(run) } catch { log.warn }` —— 一个抛错的订阅者,它那条
 * 领域事件就被那句 warn **吞掉**了:调用方以为"发了",事件其实没到,而没有任何地方记得
 * 「它没到」。现在改走 {@link RetryableOutbox}:有界重试、队列有上限、重试用尽仍投不成的
 * **逐条登记**为失败(不静默丢、不假装成功)。**不落盘** —— 跨重启的持久 outbox 是更大的
 * 重构(台账划在范围外),本切片只保证同进程内的可重试投递。
 *
 * 取目标时**现读** `runCommittedListeners`(订阅者会动态增删,不能构造时定死)。
 */
const runCommittedOutbox = new RetryableOutbox<RunCommitted>({
  capacity: 64,
  retryBudget: 3,
  targets: () =>
    [...runCommittedListeners].map(([id, listener]) => ({ id, deliver: (run: RunCommitted) => listener(run) })),
  identify: (run) => ({
    // 事件身份:同一次运行(同一 runId + 终态 status)是**同一条**领域事件。
    eventId: `run-committed:${run.runId}:${run.status}`,
    triggerKey: `workflow:${run.workflowId}`,
    kind: "run.committed",
  }),
});

/** 订阅「这次运行 durable 提交了」。返回退订函数。 */
export function onRunCommitted(listener: (run: RunCommitted) => void): () => void {
  const id = `sub_${++runCommittedSubscriberSeq}`;
  runCommittedListeners.set(id, listener);
  return () => { runCommittedListeners.delete(id); };
}

/** 投递账本的可查投影(诊断 / 测试):待投、已投成、如实登记的失败、有界丢弃。 */
export function runCommittedOutboxStats(): OutboxStats {
  return runCommittedOutbox.stats();
}

/** 重试用尽仍没投成的那些(诊断 / 测试)。 */
export function runCommittedDeadLetters(): readonly OutboxFailure[] {
  return runCommittedOutbox.deadLetters();
}

/**
 * 发布一条「运行已提交」成功信号 —— 经 {@link runCommittedOutbox} 投递。
 *
 * ⚠️ 门在**调用方**(`saveRun`):只有 `commit.outcome === "DURABLE"` 时才调这里
 * (ARC-009 的判据「数据库 durable 未确认绝不可标记 SUCCEEDED」)。本函数只管投递,
 * 不判断"该不该发"。
 *
 * 订阅者抛错**不能**把已经落定的提交拖回去(提交是真的、信号只是通知),所以投递失败
 * 由账本**有界重试、用尽后如实登记** —— 绝不静默吞掉。
 */
function emitRunCommitted(run: RunCommitted): void {
  runCommittedOutbox.enqueue(run);
}

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
 *
 * ⚠️ `attempts` 与 `state.rounds` **不是同一个东西**,形状像而已:
 *
 * - `attempts` 按岔路口记"**被问过几次**" —— 它只喂界面那张卡的「第 N 轮」
 *   (见 `WorkflowNodeChoiceEvent.attempt`),多了少了都不影响调度;
 * - `state.rounds` 按**每个节点**记"**跑过几轮**" —— 它是流程记录与变量取值的一部分,
 *   少了它回头之后的轮次编号会重头数。
 */
export interface RunSnapshot {
  /** Per-run injection target. Missing in legacy snapshots means no origin. */
  originSessionId?: string | null;
  /** Current persistence envelope version. Legacy rows may omit this field. */
  version?: typeof WORKFLOW_RUN_SNAPSHOT_VERSION;
  /** Wall-clock time at which this snapshot was captured. */
  capturedAt?: number;
  /** Hash of the graph used at run start. Optional only for old history:
   * runner refuses to resume a snapshot without it. */
  workflowRevision?: string;
  /** Nodes dispatched but not yet settled at capture. A crash may leave
   * external writes/commands completed without an outcome; replay is unsafe. */
  inFlightNodeIds?: string[];
  /**
   * ARC-016: what config versions this run ACTUALLY used, for audit.
   * Records references + content hashes only (no profile bodies, no secrets).
   */
  configSnapshot?: RunConfigSnapshot;
  prompt: string;
  cwd: string;
  state: RunState;
  attempts: [string, number][];
}

/** ARC-016: the effective config a run used (references + revisions, not bodies). */
export interface RunConfigSnapshot {
  takenAt: number;
  /** per node: profile assetId -> content hash (null = no profile bound). */
  profiles: Record<string, string | null>;
  skills: string[];
  providerId?: string;
  model?: string;
}

/**
 * 一条**落了盘的完整运行** —— 身份、结局状态与可续快照站在同一行上。run 历史
 * (`runHistory`)与调试排查(RUNTIME-09)都从它读,不为它们各开一种形状。
 *
 * `snapshot` 可为 `null`:存档是**更老的版本**写的或被改坏了,读不回来。这次运行
 * **存在过**这件事仍然是真的 —— 历史里照样列出它,只是没有可续的状态(与
 * `resumableRun` 的"读不回来就当卡过期"是两个场景的两种取舍)。
 */
export interface PersistedWorkflowRun extends WorkflowRunIdentity {
  workflowId: string;
  status: WorkflowRunStatus;
  /** 这次运行什么时候开始的(`saveRun` 第一次写时定下,续跑不改写)。 */
  createdAt: number;
  /** 最后一次落盘的时间。 */
  updatedAt: number;
  snapshot: RunSnapshot | null;
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
 *
 * 兼容性约定:
 *
 * - **没有 `version` 的一律当旧版读**(向后兼容旧存档);带了不认识的版本才拒绝 ——
 *   那是"未来进程"写的,硬读只会炸在更深处。
 * - **容器坏了**(缺 `state` / 缺 `cwd` / 整段不是 JSON)→ 整份 `null`,当过期卡。
 * - **已绑定图版本的存档如果关键状态坏了,整份拒读**。丢一个成功结局
 *   就可能重跑文件写入/命令;丢一个选择也可能唤醒错误支路。旧存档可宽松
 *   读取供历史展示,但没有图版本本来就不能续跑。
 */
export function decodeSnapshot(raw: string): RunSnapshot | null {
  try {
    // **按 unknown 解,不按 RunSnapshot 解** —— 正因为不信任它,才逐字段验形状。
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      capturedAt?: unknown;
      workflowRevision?: unknown;
      originSessionId?: unknown;
      inFlightNodeIds?: unknown;
      configSnapshot?: unknown;
      prompt?: unknown;
      cwd?: unknown;
      attempts?: unknown;
      state?: {
        record?: unknown;
        rounds?: unknown;
        picks?: unknown;
        outcomes?: unknown;
        awaiting?: unknown;
        entry?: unknown;
      };
    };
    if (parsed.version !== undefined && parsed.version !== WORKFLOW_RUN_SNAPSHOT_VERSION) return null;
    // A malformed pin is not an unknown/legacy pin. Never silently drop it.
    if (parsed.workflowRevision !== undefined &&
      (typeof parsed.workflowRevision !== "string" || !/^[0-9a-f]{64}$/.test(parsed.workflowRevision))) return null;
    if (parsed.inFlightNodeIds !== undefined &&
      (!Array.isArray(parsed.inFlightNodeIds) || parsed.inFlightNodeIds.length > 1000 ||
        !parsed.inFlightNodeIds.every((id): id is string => typeof id === "string" && id.length > 0))) return null;
    if (parsed.originSessionId !== undefined && parsed.originSessionId !== null &&
      (typeof parsed.originSessionId !== "string" || parsed.originSessionId.length === 0)) return null;
    const state = parsed.state;
    if (typeof state !== "object" || state === null) return null;
    if (!Array.isArray(state.record) || !Array.isArray(state.outcomes)) return null;
    // **没有 `cwd` 的一份存档不算能续的。** 它是"那次在哪儿跑的",补不出来 ——
    // 按会话现在重算一个,算出来的可能已经是另一个地方了。宁可当过期卡片。
    if (typeof parsed.cwd !== "string" || parsed.cwd.length === 0) return null;
    const record = state.record.filter(isRecordEntry) as RunState["record"];
    const rounds = Array.isArray(state.rounds) ? state.rounds.filter(isCountTuple) : [];
    const picks = Array.isArray(state.picks) ? state.picks.filter(isPickTuple) : [];
    const outcomes = state.outcomes.filter(isOutcomeTuple);
    const awaiting = (Array.isArray(state.awaiting) ? state.awaiting : []).filter(
      (x): x is string => typeof x === "string",
    );
    // A pinned snapshot may be resumed. Dropping a corrupt outcome/pick would
    // silently replay an already executed command or change the chosen path.
    // Older unpinned snapshots remain readable for history only.
    if (parsed.workflowRevision !== undefined && (
      record.length !== state.record.length ||
      outcomes.length !== state.outcomes.length ||
      !Array.isArray(state.rounds) || rounds.length !== state.rounds.length ||
      !Array.isArray(state.picks) || picks.length !== state.picks.length ||
      !Array.isArray(state.awaiting) || awaiting.length !== state.awaiting.length ||
      !Array.isArray(parsed.attempts) || parsed.attempts.filter(isCountTuple).length !== parsed.attempts.length ||
      typeof parsed.prompt !== "string" ||
      (state.entry !== undefined && !isRunEntry(state.entry))
    )) {
      log.warn("workflow run snapshot: 已绑定图版本的状态损坏,拒绝续跑以避免重复副作用");
      return null;
    }
    if (record.length !== state.record.length || outcomes.length !== state.outcomes.length) {
      log.warn("workflow run snapshot: 旧快照存在损坏的 record/outcomes 元素,仅供历史查看,不可安全续跑");
    }
    if (Array.isArray(state.picks) && picks.length !== state.picks.length) {
      log.warn("workflow run snapshot: 旧快照存在损坏的岔路口选择,仅供历史查看,不可安全续跑");
    }
    return {
      version: WORKFLOW_RUN_SNAPSHOT_VERSION,
      capturedAt: typeof parsed.capturedAt === "number" && Number.isFinite(parsed.capturedAt) ? parsed.capturedAt : 0,
      ...(parsed.workflowRevision !== undefined ? { workflowRevision: parsed.workflowRevision as string } : {}),
      ...(parsed.inFlightNodeIds !== undefined ? { inFlightNodeIds: parsed.inFlightNodeIds as string[] } : {}),
      ...(isRunConfigSnapshot(parsed.configSnapshot) ? { configSnapshot: parsed.configSnapshot } : {}),
      ...(parsed.originSessionId !== undefined ? { originSessionId: parsed.originSessionId as string | null } : {}),
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      cwd: parsed.cwd,
      state: {
        record,
        rounds,
        picks,
        outcomes,
        awaiting,
        // 「这次是哪个触发器起的」。**缺了就当没有** —— 它是本版新加的,老存档里没有
        // (`RunState.entry` 是可选的);形状不对的也一律丢掉,而不是带进调度器。
        ...(isRunEntry(state.entry) ? { entry: state.entry } : {}),
      },
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts.filter(isCountTuple) : [],
    };
  } catch (err) {
    log.warn(`workflow run snapshot unreadable: ${(err as Error).message}`);
    return null;
  }
}

/** `[节点 id, 次数]` 形状的元组 —— `rounds` 与 `attempts` 共用同一种判据。 */
/** 【ARC-016】配置快照的形状守卫(读档时用) —— 形状不对就丢掉,不硬塞给审计。 */
function isRunConfigSnapshot(raw: unknown): raw is RunConfigSnapshot {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as { takenAt?: unknown; profiles?: unknown; skills?: unknown };
  if (typeof r.takenAt !== "number" || !Number.isFinite(r.takenAt)) return false;
  if (typeof r.profiles !== "object" || r.profiles === null || Array.isArray(r.profiles)) return false;
  if (!Object.values(r.profiles as Record<string, unknown>).every((v) => v === null || typeof v === "string")) return false;
  if (!Array.isArray(r.skills) || !r.skills.every((s) => typeof s === "string")) return false;
  return true;
}

function isCountTuple(raw: unknown): raw is [string, number] {
  return (
    Array.isArray(raw) &&
    raw.length === 2 &&
    typeof raw[0] === "string" &&
    typeof raw[1] === "number" &&
    Number.isFinite(raw[1])
  );
}

/** `[节点 id, 选择]` 元组:选择至少要有"选了哪条边",没有它这个选择就不成选择。 */
function isPickTuple(raw: unknown): raw is [string, { edgeId: string; comment?: string }] {
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "string") return false;
  const choice = raw[1] as { edgeId?: unknown } | null;
  return typeof choice === "object" && choice !== null && typeof choice.edgeId === "string" && choice.edgeId.length > 0;
}

/** `[节点 id, 结局]` 元组:结局至少要有合法的 status 与 summary,其余字段不验 ——
 *  它们本来就可缺席,而且宽松一点能让旧存档多活几个版本。 */
function isOutcomeTuple(raw: unknown): raw is [string, NodeOutcome] {
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "string") return false;
  const outcome = raw[1] as { status?: unknown; summary?: unknown } | null;
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    typeof outcome.status === "string" &&
    (NODE_OUTCOME_STATUSES as readonly string[]).includes(outcome.status) &&
    typeof outcome.summary === "string"
  );
}

/** 流程记录条目只验到"是个带 kind 的对象"为止 —— 形状归 `schedulerPrompt.ts` 所有,
 *  这里只知道"不是对象/没有 kind 的条目连渲染都过不去"。 */
function isRecordEntry(raw: unknown): raw is { kind: string } & Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) return false;
  return typeof (raw as { kind?: unknown }).kind === "string";
}

/** 存档里的 `entry` 只信形状对的那一种(老存档没有这个字段,被手改坏的也可能有)。 */
function isRunEntry(
  raw: unknown,
): raw is { nodeId: string; summary: string; payload?: Record<string, unknown> } {
  if (typeof raw !== "object" || raw === null) return false;
  const { nodeId, summary } = raw as { nodeId?: unknown; summary?: unknown };
  if (!(typeof nodeId === "string" && nodeId.length > 0 && typeof summary === "string")) return false;
  // `payload`(触发器载荷的事实键值,G3/VAR-06):老存档没有,缺席合法;在的话必须
  // 是个对象。**放宽校验而不是收紧** —— 这里拦得太死,载荷就会在读档时被悄悄丢掉,
  // 续跑之后 `{{trigger.<key>}}` 全部解不出来,还看不出原因。
  const payload = (raw as { payload?: unknown }).payload;
  return payload === undefined || (typeof payload === "object" && payload !== null);
}

/**
 * 写下这次运行此刻的样子(第一次写就是建行)。
 *
 * **失败只记日志,不往上抛;但把是否成功返回给调用方。** 普通进度快照
 * 可以继续尽力写,而节点派发前的在飞标记一旦无法持久化,调用方必须停止
 * 执行,否则重启后会在不知副作用是否发生的情况下重放该节点。
 * `opts.durable` 为真时额外同步替换磁盘数据库;仅完成内存表写入或预约微任务
 * 不能算成功。返回 false 时调用方不得执行新的节点。
 *
 * 【ARC-005 步②】`opts.durable` 时落盘走 {@link commitNow} 的**结构化结果**:只有
 * `DURABLE` 才算成功 —— 才会 `return true` 并发布 {@link onRunCommitted} 成功信号。
 * `APPLIED_NOT_DURABLE`(内存改了、磁盘没写)一律**回滚内存那一行 + 返回 false +
 * 不发任何成功信号**,与旧行为一致地 fail-closed(见 {@link emitRunCommitted})。
 */
export function saveRun(args: {
  runId: string;
  sessionId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  snapshot: RunSnapshot;
}, opts: { durable?: boolean } = {}): boolean {
  // 【MC-053】编码**先于任何仓储写入**完成。从前这里是先 encode、失败就把 `payload`
  // 置成空串**照样写库**("落一行空的也比不落强")—— 那是把"这一次保存失败"记成了
  // "这份运行没有可恢复的存档",结果是**上一次好好的快照被空串覆盖掉**。`decodeSnapshot("")`
  // 必然读不回来,于是"失败返回 false"已经晚了:旧的可恢复存档已经毁在这一句里。
  //
  // 现在:编码失败 → 记一行日志、**直接返回 false,一个字节都不落库**。原来的行
  // (上一次成功的快照)原样留着,重启还能读回来续跑。调用方拿到 false 就知道这次
  // 没写成,该停的停(见 runner 的 in-flight 闸)。
  let payload: string;
  try {
    payload = encode({ ...args.snapshot, version: WORKFLOW_RUN_SNAPSHOT_VERSION, capturedAt: Date.now() });
  } catch (err) {
    log.warn(`workflow run ${args.runId}: 存档编码失败,保留上一次有效快照不动 ${(err as Error).message}`);
    return false;
  }
  // 【MC-053 后半】「**能编码**」不等于「**写得进来**」。JSON.stringify 把 BigInt 之外
  // 的任何东西都能吐出来 —— 一个 `state.record` 被写成字符串、`attempts` 里混进一个
  // 坏元组的快照,编码不会抛(上面那一关放它过去),写库也成功返回 true,可
  // {@link decodeSnapshot} 对刚落盘的这一行返回 **null**:调用方以为"这份运行可续",
  // 重启后却找不到可续快照。第 13 轮独立复查的隔离反例正是这样一份 V3
  // (`{"invalidAccepted":true,"invalidDecodes":false}`)。
  //
  // 判据不能是"再写一套 typeof 检查" —— 那正是台账禁止的补丁:两套 schema 迟早分叉。
  // 这里把**刚落盘的同一段 payload** 交给 {@link decodeSnapshot}(读侧的那唯一一份
  // 强校验)走一趟;它要收不回来,这一份就不是可恢复快照,一个字节都不落库,旧快照留着。
  // 这会认下 decodeSnapshot 认下的**一切**(含老的、无图版本的宽松形状)—— 契约只有一份。
  if (decodeSnapshot(payload) === null) {
    log.warn(
      `workflow run ${args.runId}: 存档结构通不过解码器校验,拒写以保住上一次有效快照`,
    );
    return false;
  }
  // 【MC-053 反例三】写库与落盘**不是原子的**:`WorkflowRunRepo.save` 改的是**内存**里的
  // sql.js 表,`persistNowOrThrow` 才把它 fsync 到磁盘。第 16 轮复查抓住了这一段的窗口:
  // 先 `save`(内存行已被换成新快照)→ `persistNowOrThrow` 抛(磁盘故障)→ 只 `return false`。
  // 结果是**内存里那一行已经变了**(status 成了 success、payload 成了新快照),而磁盘上还是
  // 上一次的 V1 —— 调用方以为"没写成、旧快照留着",可同一进程后续 `resumableRun` 读的是被
  // 污染的内存行,重启后又变回 V1,两处对不上(台账实测 `oldCheckpointMutated=true`)。
  //
  // 修法:**durable 落盘失败要回滚内存那一行**,让"内存 == 磁盘"这条不变量在 saveRun 出口
  // 成立。回滚 = 把先前读到的那一行写回去(没有旧行则删掉这次新建的行);回滚本身**不走
  // durable**(内存回滚不需要再落盘 —— 磁盘没变),用 `WorkflowRunRepo.save` 的普通路径。
  // 回滚也失败(极其罕见)则如实记日志:内存已污染,调用方不能再信本进程的续跑查询。
  let prevRow: ReturnType<typeof WorkflowRunRepo.get> = null;
  try {
    prevRow = WorkflowRunRepo.get(args.runId);
  } catch (err) {
    log.warn(`workflow run ${args.runId}: 读取旧存档失败,落盘失败时将无法回滚 ${(err as Error).message}`);
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
    if (opts.durable) {
      // 【ARC-005 步②】用**结构化**结果而不是"抛不抛" —— 这样才能区分
      // 「内存已应用但磁盘没写」(APPLIED_NOT_DURABLE)与「真的 durable」。
      const commit: CommitResult = commitNow();
      if (commit.outcome !== "DURABLE") {
        // 落盘没成 → 把内存那一行**回滚**到先前状态,保住"内存 == 磁盘"。
        try {
          if (prevRow) {
            WorkflowRunRepo.save({
              id: prevRow.id,
              sessionId: prevRow.sessionId,
              workflowId: prevRow.workflowId,
              status: prevRow.status,
              payload: prevRow.payload,
              awaiting: prevRow.awaiting,
            });
          } else {
            WorkflowRunRepo.remove(args.runId);
          }
        } catch (rollbackErr) {
          log.error(
            `workflow run ${args.runId}: 落盘失败且内存回滚也失败,本进程内存已污染 ` +
              `${(rollbackErr as Error).message}`,
          );
        }
        // **「运行已提交」成功信号一个都不发。** 这正是 ARC-005 要钉住的那条:只有 durable
        // 之后才发。走到这里时磁盘上并没有这一份(APPLIED_NOT_DURABLE 已回滚,或 FAILED 压根
        // 没应用),对外报"提交成功"就是假成功。
        log.warn(`workflow run ${args.runId}: durable 提交未落盘(${commit.outcome}),不发布成功信号 ${commit.reason ?? ""}`);
        return false;
      }
      // 真的 durable 了 —— 现在才发布「运行已提交」这个领域成功信号。
      emitRunCommitted({ runId: args.runId, sessionId: args.sessionId, workflowId: args.workflowId, status: args.status });
    }
    return true;
  } catch (err) {
    log.warn(`workflow run ${args.runId}: 存档写不进去 ${(err as Error).message}`);
    return false;
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

/** 一次**可以从某一步重跑**的运行 —— 存档,以及为什么能重跑。 */
export interface RetryableRun {
  runId: string;
  workflowId: string;
  snapshot: RunSnapshot;
  /**
   * 那一步上次是什么结局。**调用方要它来分清两种重跑**:
   *
   *  - `"failed"` —— 用户在失败卡片上点「再试一次」;
   *  - 别的 —— 用户在图上看中一步,说"从这儿往下走"。
   *
   * 两者后面走的是同一条路(抹掉那一步 + 它的全部后代,再跑一遍),**只有那一句提示
   * 词不一样**:重试要带上用户写的「上次哪里不对」,挑起点不需要。所以这里把结局交出来,
   * 由调用方决定要不要 `note` —— 而不是在这一层替它判断"这次算不算重试"。
   */
  /** Undefined only for an interrupted, journaled step that never settled. */
  outcome: NodeOutcome | undefined;
}

/**
 * 用户在**一步上**点了「从这儿接着跑」—— 找那次运行,并确认它真的能重跑。
 *
 * 与 {@link resumableRun} 并列,判据的**形状也是并列的**:那个认"被中断且停在这格",
 * 这个认"**这一步在存档里**"。
 *
 * ## 三道门,每一道都对应界面上的一种"这张卡不适用了"(全都**不是错误**)
 *
 *  1. **找不到那一行**(或它不属于这个对话)—— 卡片是别人的 / 已被清理;
 *  2. **存档读不回来** —— 同 `resumableRun`:硬续一份缺胳膊少腿的状态,比说一句
 *     "这张卡过期了"糟得多;
 *  3. **既没有结局，也不是 interrupted 存档中的在飞/等待节点** —— 节点必须确实
 *     属于这次运行，不能凭空增加起点。中断节点可能来不及写结局，不伪造一个失败。
 *     本函数只查身份与存档；图修订及副作用安全仍由 runner 按实际清单判断。
 *
 * ## 为什么**不**再要求"那次运行是失败的"、"那一步是失败的"
 *
 * 这两道原先都有,是给「再试一次」那一张卡用的。但用户要的是**从任一步接着往下走**:
 * 一张跑完了的图,他看中中间某一步、想从那儿重来一遍 —— 那正是迭代写作的常规动作。
 * 拦着它的两道门(运行不是 `failed`、那一步不是 `failed`)把这件事表达成了"这张卡
 * 不适用",而它明明适用。
 *
 * ⚠️ **放弃这两道门的代价是"能重跑"不再等于"上次出过错"** —— 调用方要拿
 * {@link RetryableRun.outcome} 自己分辨(见那里的注释)。
 *
 * 「这个对话正有运行在跑」那一道**不在这里** —— 它要查 `runner.ts` 里那张内存地图
 * (`runs`),而这一层不认识它。调用方补(见 `resolveWorkflowRetry`)。
 */
export function retryableRun(sessionId: string, runId: string, nodeId: string): RetryableRun | null {
  let row;
  try {
    row = WorkflowRunRepo.get(runId);
  } catch (err) {
    log.warn(`workflow retry lookup failed: ${(err as Error).message}`);
    return null;
  }
  if (row === null || row.sessionId !== sessionId) return null;
  const snapshot = decodeSnapshot(row.payload);
  if (snapshot === null) {
    log.warn(`workflow run ${row.id}: 存档读不回来,这张卡片按过期处理`);
    return null;
  }
  const outcome = snapshot.state.outcomes.find(([id]) => id === nodeId)?.[1];
  const interruptedStep = row.status === "interrupted" &&
    (snapshot.inFlightNodeIds?.includes(nodeId) === true || snapshot.state.awaiting.includes(nodeId));
  if (outcome === undefined && !interruptedStep) return null;
  return { runId: row.id, workflowId: row.workflowId, snapshot, outcome };
}

/**
 * 某个对话的 **run 历史** —— 一次运行一行,新的在前。
 *
 * ## 为什么它在这里,而不是调用方各自去折
 *
 * 运行状态**只有一份真相**:落盘的快照(`workflow_runs.payload`)。历史展示、自动化
 * 页面、排查日志要的都是"这份快照里有什么",谁自己再存/再解析一份,迟早与这份漂移。
 * 所以折叠成 {@link PersistedWorkflowRun} 的动作只在这一个文件里做 —— 存储层
 * (`WorkflowRunRepo.listForSession`)不认识快照的形状,消费层不需要认识它的编码。
 *
 * ## 读不回来的行**照样列出**
 *
 * 与 {@link resumableRun} 相反:续跑要的是"能接着跑的状态",读不回来就当卡过期;
 * 历史要的是"发生过什么",存档读不回来只能说明它是老版本写的 —— 那次运行**存在过**
 * 仍然是真的,历史里凭空少一行更让人看不懂。此时 `snapshot` 为 `null`。
 */
export function runHistory(sessionId: string, limit: number): PersistedWorkflowRun[] {
  let rows;
  try {
    rows = WorkflowRunRepo.listForSession(sessionId, limit);
  } catch (err) {
    log.warn(`workflow run history read failed: ${(err as Error).message}`);
    return [];
  }
  return rows.map((row) => ({
    runId: row.id,
    sessionId: row.sessionId,
    workflowId: row.workflowId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    snapshot: decodeSnapshot(row.payload),
  }));
}
