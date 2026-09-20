/**
 * RuntimeManager — per-session turn lifecycle, now provider-agnostic.
 *
 * Replaces the old ClaudeRuntime-based implementation. Instead of `new ClaudeRuntime()`,
 * it resolves a provider from the registry and constructs a ProviderContext that bridges
 * events to the renderer and async approval/user-input requests via ApprovalBridge.
 */
import { sendToRenderer } from "@main/window.js";
import { IPC, TURN_BUDGET_SETTING_KEY, RUNTIME_FALLBACK_MODELS_SETTING_KEY } from "@contracts/ipc";
import type { RuntimeEvent, PermissionMode, ContextSnapshot, TurnUsageRecord, TurnFileEntry, UserMessageEvent, UpstreamIssueEvent, TranscriptBlock, SubagentSnapshot } from "@contracts/runtime";
import type { Session } from "@contracts/session";
import type { ProviderContext, TurnHandle, StartTurnRequest, UserInputAnswers, PlanApprovalDecision } from "@contracts/provider";
import { providerRegistry } from "@main/providers/registry.js";
import { SessionRepo, ProjectRepo, SettingRepo } from "@main/store/repositories.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { ApprovalBridge } from "./ApprovalBridge.js";
import { foldTranscript } from "./nodeTranscript.js";
import { getFileSnapshot, dropFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { restoreFiles } from "@main/lib/fileSnapshot.js";
import { BridgeRegistry } from "@main/providers/bridge/bridgeRegistry.js";
import { mobileEventBus } from "@main/mobile/MobileEventBus.js";
import { invalidateUsageStats } from "@main/lib/usageStats.js";
import { log } from "@main/lib/logger.js";
import { backflowPrompt, clearBackflow, peekBackflow } from "@main/lib/pendingBackflow.js";
import { resolveAgentPrompt, resolveWorkflowPrompt } from "@main/orchestration/prompt.js";
// 只借类型 —— `import type` 整条会被编译掉,那条链(工具表 → repositories → db →
// electron)不会因此被拉进任何无头 smoke。
import type { WebToolGate } from "@main/mcp/webToolHost.js";

interface SessionRuntime {
  /** The TurnHandle for the currently running turn, if any. */
  handle?: TurnHandle;
  /** The claude/provider session id captured from the system/init message. */
  providerSessionId: string | null;
  /** ProviderContext (long-lived for the session). */
  ctx: ProviderContext;
  /** Cwd of the most recent (or current) turn. Stashed so rewindTurn
   *  can resolve snapshot paths without having to ask the provider
   *  (the TurnHandle interface doesn't expose it). */
  lastCwd: string | null;
  /** Wall-clock ms when the current turn started (Date.now()). Used to
   *  compute `durationMs` in the per-turn usage history. */
  turnStartedAt: number;
  /** Set at `turn.done` with the turn's endedAt/durationMs; consumed by the
   *  next `token-usage.updated` (the turn-end context snapshot, which the
   *  adapter fires asynchronously OFF the turn's critical path, so it lands
   *  after turn.done) to append the per-turn usage-history record with the
   *  turn's final throughput/cost data. Flushed at the next sendTurn if no
   *  snapshot ever arrives (all-zero usage turn / abort before result). */
  pendingTurnEnd?: { endedAt: number; durationMs: number };
  /** Latest context snapshot emitted by the adapter (tracked from
   *  `token-usage.updated` events). Read at `turn.done` to build the
   *  per-turn usage history entry. */
  lastContextSnapshot?: ContextSnapshot;
  /** Last-known totalTokens per subagent taskId, from the REPLACE rosters in
   *  `subagent.update`. The adapter clamps gateway-noise collapses, so each
   *  agent's value is monotonic — per-turn consumption is the sum of positive
   *  deltas against this map. A background subagent that outlives its
   *  spawning turn accrues later growth to whichever turn is settling then. */
  subagentTokensByTask: Map<string, number>;
  /** Merged subagent transcripts, keyed by the spawning Task tool_use id.
   *  Updated (per key) from `subagent.transcript` events and persisted whole
   *  after each update. ACCUMULATES ACROSS TURNS — the side-panel subagent
   *  viewer is a review surface, entries live for the session's lifetime
   *  (replayed to the renderer at each turn start; see sendTurn). */
  subagentTranscripts: Map<string, TranscriptBlock[]>;
  /** Latest subagent roster (REPLACE snapshots from `subagent.update`).
   *  Accumulated across turns the same way as subagentTranscripts — a new
   *  turn's adapter starts with EMPTY state, so without this carry-over its
   *  first roster flush would REPLACE the renderer's/DB's history away. */
  lastSubagents: SubagentSnapshot[];
  /** Subagent token growth observed since the last usage-history record
   *  settled (i.e. during the current turn). Copied into the record as
   *  `subagentTokens` and reset by settlePendingTurnEnd. */
  turnSubagentTokens: number;
  /** Per-turn usage history for this session. Hydrated from the persisted
   *  session row at bind; appended at each `turn.done` and written back. */
  usageHistory: TurnUsageRecord[];
  /** 1-based turn counter, incremented at each sendTurn. Used to tag browser
   *  screenshots with a per-turn directory (`turn-<N>`). In-memory only —
   *  restarts restart the count, matching the per-session runtime lifetime. */
  turnCount: number;
  /** When the session's config uses the OpenAI protocol, this holds the
   *  customModelId whose bridge we acquired (paired with a release on
   *  dispose). Undefined for anthropic-protocol / no-custom-model sessions. */
  bridgeConfigId?: string;
  /** The bridge handle when this session has acquired an OpenAI bridge. We
   *  keep it to read its localUrl when rewriting the apiConfig each turn, and
   *  to know the bridge is alive. Released in dispose(). */
  bridgeHandle?: { localUrl: string };
  /** Unsubscribe for the bridge status subscription below. The bridge is
   *  SHARED across sessions (one server per config), so its retry statuses
   *  fan out to every subscriber; we attribute them to this session as
   *  `upstream.issue` events (the renderer gates the hint on the session's
   *  running state, so a retry that belongs to another session's request is
   *  harmless noise). Paired with acquire/release above. */
  bridgeStatusUnsubscribe?: () => void;
  /** 轮预算（sendTurn 从 `runtime.turnBudget` 偏好解析，坏 JSON / 关闭 /
   *  全空 → undefined）。HOST 侧强制：超限 emit `turn.notice(budget_limit)`
   *  并沿用户点停同一条路 interrupt。 */
  budget?: { maxTurns?: number; maxUsd?: number; maxTotalTokens?: number };
  /** 本轮已观察到的 assistant 轮数（`message.complete` 计数）。每轮 sendTurn
   *  归零 —— ContextSnapshot 的 tokens/usd 本身就是按轮累计的，直接比对；
   *  轮数没有快照可读，只能在这里自己数。 */
  budgetTurns: number;
  /** 本轮已观察到的花费（USD，来自最新 `token-usage.updated` 快照）。 */
  budgetUsd: number;
  /** 本轮已观察到的累计处理 token（同上）。 */
  budgetTokens: number;
  /** 本轮预算闸是否已触发。防重入：interrupt 之后的收尾事件（残留的
   *  message.complete / 最后一帧 usage 快照）不得二次触发。S4 回退链也读它
   *  —— 预算停不算模型失败，不能换模型重试。 */
  budgetFired: boolean;
  /** S4 失败回退链的**剩余**部分（chat-only 会话才解析；custom 网关会话为
   *  空 —— 链里的全局模型 id 对第三方配置没有意义）。turn.done reason="error"
   *  时 shift 出下一个换模型重发；每轮 sendTurn 重新解析（回退重试的那轮
   *  除外 —— 见 fallbackRetryModel，否则 shift 会被重置成完整链无限重试）。 */
  fallbackModels: string[];
  /** 回退重试的下一个模型。emit 闭包 shift 后经它递进 sendTurn；sendTurn
   *  消费掉（置回 undefined）并据此跳过本轮回退链的重新解析。 */
  fallbackRetryModel?: string;
  /** 回退重发用的最小输入快照（sendTurn 每轮刷新）。**不含 userMessage**
   *  —— 重试不得再回显用户气泡；prompt 用的是 req 里拼好的最终形态
   *  （backflow 已在首轮消费，重发时 peek 为空、原样通过）。 */
  lastTurnInput?: {
    prompt: string;
    cwd: string;
    skills?: string[];
    mcpServerNames?: string[];
    pluginNames?: string[];
    images?: { data: string; mimeType: string }[];
  };
}

// 轮预算 / 回退链的解析与三判纯函数已拆到 `@main/lib/turnPolicy.js`
// （无依赖、可被 budget-guard-smoke 直测），这里只留消费侧。
import { budgetViolations, parseFallbackModels, parseTurnBudget } from "@main/lib/turnPolicy.js";

const approvalBridge = new ApprovalBridge();

/**
 * Re-address an event to another session. **Only the three interactive kinds are
 * retargeted** — those are the ones a human has to answer, so they must surface
 * where the human is looking (the conversation). Everything else (text / tool /
 * usage / turn.done) stays on the session that produced it: that is the node's
 * own transcript, and moving it would put the node's private stream into the
 * parent's message list.
 *
 * Typed as a `switch` rather than a set-membership test so the compiler checks
 * the spread against each variant, and so adding a variant to the union forces a
 * decision here instead of silently falling through.
 */
/**
 * Stamp the turn-end wall-clock ONCE so both consumers can agree: the usage
 * record filed by the emit closure (keyed by this timestamp) and the renderer
 * (which adopts it as `turnMeta.endedAt`). The renderer uses the match to show
 * the turn's token count, and two independent `Date.now()` calls would never be
 * equal.
 */
function stampTurnEnd(rawEvent: RuntimeEvent): RuntimeEvent {
  return rawEvent.type === "turn.done" && rawEvent.endedAt === undefined
    ? { ...rawEvent, endedAt: Date.now() }
    : rawEvent;
}

function retargetEvent(e: RuntimeEvent, sessionId: string): RuntimeEvent {
  switch (e.type) {
    case "approval.request":
    case "question.ask":
    case "plan.approval_request":
      return { ...e, sessionId };
    default:
      return e;
  }
}

/** 一条**隐藏**会话的种类 —— 它的流水不上界面(node 与自动化后台会话)。
 *
 *  两处判据不同,别混:这里是"**不上界面**";而"要不要折成一份节点过程"仍然是
 *  `kind === "node"` 那一处自己的事(自动化会话没有对应的面板,也就没有那一折)。 */
function isHiddenSessionKind(kind: Session["kind"]): boolean {
  return kind === "node" || kind === "automation";
}

/** How long the turn.done handler waits before settling a stashed pending
 *  turn-end record with whatever snapshot is known. Must exceed the adapter's
 *  path-B control-channel race (CONTEXT_USAGE_PATH_B_TIMEOUT_MS = 3s) so an
 *  imminent REAL turn-end snapshot settles via the token-usage.updated branch
 *  first; the timer only backfills when no snapshot ever comes. */
const TURN_END_SETTLE_GRACE_MS = 4_000;

/** 同时在内存里留着的「节点过程」份数上限(见 `evictNodeTranscripts`)。64 是个手感值:
 *  一张十来步的图跑几轮都装得下,同时又把"开一整天自动化"那种场景兜住了。 */
const NODE_TRANSCRIPT_LIMIT = 64;

class RuntimeManager {
  private sessions = new Map<string, SessionRuntime>();
  /**
   * 每个**工作流节点**跑出来的过程,按节点会话 id 索引(见 `nodeTranscript.ts`)。
   *
   * 刻意挂在管理器上、而不是某个会话的 `SessionRuntime` 里:节点会话的运行时**跑完就被
   * dispose**(见 `orchestration/runner.ts` 的收尾),而用户恰恰是**跑完之后**才想回头
   * 看它干了什么 —— 挂在会话状态上的话,想看的那个时刻它刚好没了。
   *
   * 容量有上限(见 {@link NODE_TRANSCRIPT_LIMIT}),只在进程里活着,**不落盘**。
   */
  private nodeTranscripts = new Map<string, TranscriptBlock[]>();
  /** Host-side event consumers (see {@link subscribe}). */
  private subscribers = new Set<(e: RuntimeEvent) => void>();
  /** nodeSessionId → parentSessionId, for interactive-event redirection
   *  (see {@link setInteractiveProxy}). */
  private interactiveProxy = new Map<string, string>();
  /** sessionId → 挂起计数。**只有"对话节点跑在主对话里"这一种情况会用到** ——
   *  见 {@link holdTurnEnd}。计数而不是布尔:同一段代码理论上可以嵌套着进来,
   *  用布尔的话里层先解除就把外层的挂起一起抹掉了。 */
  private heldTurnEnds = new Map<string, number>();
  /** sessionId → 扣住文字推送的计数(见 {@link holdTurnText})。和上面那张分开,是因为
   *  两者的判据完全不同:一个扣的是"这一轮结束了",一个扣的是"这一轮正在说什么"。 */
  private heldTurnTexts = new Map<string, number>();

  /**
   * 把这一轮面向界面的 `turn.done` **扣住不发**,返回解除用的函数(幂等)。
   *
   * ## 谁需要这个
   *
   * 「对话节点」(`runner.kind === "conversation"`)是**代替用户在主对话里说一句话**,
   * 它跑在主对话那个会话上(见 `orchestration/runner.ts`)。它的流水——文本、工具、
   * 回复——都**该**出现在聊天框里,所以那些事件照常推。
   *
   * 唯独 `turn.done` 不行:那一条在界面上表达的是"**用户这一轮**结束了"——渲染端收到
   * 它就停掉"正在运行"、弹一句「回合完成」、把输入框解禁、并把这轮的消息落库。而一
   * 张图可能还有五步没跑。放它过去,现象是图跑到一半界面就说"跑完了"。
   *
   * 整张图真正的收口由调度器在最后补一条(见 `orchestration/runner.ts` 收尾那一段),
   * 那一处**不经过这里**。
   *
   * ## 扣住的只是"发给界面",不是"发生过的账"
   *
   * 落盘(用量记录、会话快照)、订阅者(调度器要拿这一步的产出,钩子/通知也都挂在上面)
   * 一律照旧。判断"这一条要不要再通知一次"的消费者自己问
   * {@link isTurnEndHeld} —— 现在有两处:**通知**(不然图跑到一半弹「回合完成」)和
   * **钩子**(同一个道理)。
   */
  holdTurnEnd(sessionId: string): () => void {
    this.heldTurnEnds.set(sessionId, (this.heldTurnEnds.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.heldTurnEnds.get(sessionId) ?? 1) - 1;
      if (left > 0) this.heldTurnEnds.set(sessionId, left);
      else this.heldTurnEnds.delete(sessionId);
    };
  }

  /** 这一轮是不是被 {@link holdTurnEnd} 扣住了(见那里的说明)。 */
  isTurnEndHeld(sessionId: string): boolean {
    return (this.heldTurnEnds.get(sessionId) ?? 0) > 0;
  }

  /**
   * 把这一轮**流式推给界面的文字**先扣住不发,返回解除用的函数(幂等,可嵌套)。
   *
   * ## 谁需要这个
   *
   * 「对话节点」声明过产出变量时,它那一轮交出来的是一段**结构化的东西**(见
   * `@contracts/outputConstraint`)。逐字推给界面的话,用户会在聊天框里看着一段花括号
   * 滚出来 —— 而那正是他明确说过不想看到的。
   *
   * 所以这一轮的文字先扣住,跑完之后由调度器解成一张读得懂的清单、一次性发出去
   * (见 `orchestration/runner.ts` 的 `runInConversation`)。**扣住的只是"发给界面"**:
   * 订阅者照收(调度器正是靠它攒产出),落盘照旧 —— 和 `holdTurnEnd` 同一条规矩。
   *
   * ## 只扣文字,不扣工具
   *
   * `tool.use` / `tool.result` 照常推:那一段是"它正在干什么",看得见是好事,而且它不
   * 会因为产出是 JSON 而变得不可读。
   */
  holdTurnText(sessionId: string): () => void {
    this.heldTurnTexts.set(sessionId, (this.heldTurnTexts.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.heldTurnTexts.get(sessionId) ?? 1) - 1;
      if (left > 0) this.heldTurnTexts.set(sessionId, left);
      else this.heldTurnTexts.delete(sessionId);
    };
  }

  /** 这一轮的文字是不是被 {@link holdTurnText} 扣住了。 */
  isTurnTextHeld(sessionId: string): boolean {
    return (this.heldTurnTexts.get(sessionId) ?? 0) > 0;
  }

  /**
   * 这一条事件要不要**先扣住、不推给界面** —— 见 {@link holdTurnEnd} 与
   * {@link holdTurnText}。
   *
   * 两处判据放在一起,是因为它们改的是同一个地方(推给界面那一步),而分了家之后最容易
   * 出的事是"新加一种扣法,只在一个分支里生效"。
   */
  private isHeldFromClients(sessionId: string, e: RuntimeEvent): boolean {
    if (e.type === "turn.done") return this.isTurnEndHeld(sessionId);
    // `message.complete` 不扣:渲染端根本不处理它(它只喂 `nodeTranscript` 那本账),
    // 放过去不会让那段 JSON 露出来。
    if (e.type === "text.delta" || e.type === "thinking") return this.isTurnTextHeld(sessionId);
    return false;
  }

  /**
   * 某个节点会话这一轮**干了什么**(折好的过程块)。
   *
   * 「并回主对话」选「过程和结果都并」时要它(见 `@contracts/nodeType` 的
   * `NODE_RETURN_PARAM_KEY`)。取不到就返回空数组 —— 那几种情况都是正常的:节点压根没跑
   * (skipped / cancelled)、或者它已经老到被容量上限裁掉了(见 `evictNodeTranscripts`)。
   */
  transcriptOf(nodeSessionId: string): readonly TranscriptBlock[] {
    return this.nodeTranscripts.get(nodeSessionId) ?? [];
  }

  /**
   * **某个会话这一轮花了多少。** 工作流那一步跑完时,卡片要靠它显示这一步的开销
   * (见 `@contracts/runtime` 的 `WorkflowNodeResultEvent.usage`)。
   *
   * ## 为什么可能要等一会儿才有数
   *
   * 用量**不是**在 `turn.done` 那一刻落库的:那个回合的最终快照(含花费)是适配器在
   * `turn.done` **之后**异步推上来的,由 `settlePendingTurnEnd` 结算(见那里的注释)。
   * 所以这一步刚跑完就问,常常**还没有** —— 调用方要能接受 `undefined` 并在随后再问一次。
   *
   * 取**最后一条**:一个节点会话正常只跑一轮(它的寿命就是这一步),但真跑了两轮的话,
   * 用户想看的显然是"这一步一共花了多少",而那更接近最后一条而不是第一条。多轮的情况
   * 极少,不值得为它把契约做成数组。
   */
  usageOf(sessionId: string): TurnUsageRecord | undefined {
    const rt = this.sessions.get(sessionId);
    const history = rt?.usageHistory;
    return history === undefined || history.length === 0
      ? undefined
      : history[history.length - 1];
  }

  /**
   * Send an event to a session **from outside its provider turn**.
   *
   * Reaches exactly the same consumers as a provider event — renderer, mobile
   * bus, every subscriber (so the NotificationManager still sees it) — but
   * skips the per-session `emit` closure, which only exists for a session that
   * actually ran a turn.
   *
   * The workflow scheduler needs this to close a graph run: the conversation
   * never ran a provider turn, so there is no closure to borrow, yet its
   * `turn.done` is what unblocks the composer, persists the turn's messages and
   * tells the other clients (and the OS) that the turn ended. Emitting it with
   * the bare `broadcastRuntimeEvent` helper instead would silently skip the
   * observer — a finished graph run would never notify.
   */
  emitExternal(event: RuntimeEvent): void {
    const e = stampTurnEnd(event);
    this.fanOutToClients(e);
    this.notifySubscribers(e);
  }

  /**
   * Echo a user message to every client (phone ⇄ desktop).
   *
   * Shared by both send paths on purpose: a normal turn echoes inside
   * {@link sendTurn}, and a graph run — which has no provider turn — echoes from
   * the scheduler. Without it, sending from the phone leaves the desktop showing
   * a column of result cards with no question above them.
   */
  echoUserMessage(
    sessionId: string,
    userMessage: { id: string; createdAt: number; blocks: unknown[]; editedMessageId?: string },
  ): void {
    this.emitExternal({
      type: "user.message",
      sessionId,
      messageId: userMessage.id,
      createdAt: userMessage.createdAt,
      blocks: userMessage.blocks,
      // Edit marker: receiving clients truncate their stale tail at this
      // message before appending (see store ingestEvent).
      ...(userMessage.editedMessageId ? { editedMessageId: userMessage.editedMessageId } : {}),
    } satisfies UserMessageEvent);
  }

  /** 渲染端 + 手机。**界面消费的那一路** —— 节点会话自己的流水不走这里。 */
  private fanOutToClients(e: RuntimeEvent): void {
    sendToRenderer(IPC.CLAUDE_EVENT, { channel: IPC.CLAUDE_EVENT, sessionId: e.sessionId, event: e });
    // Fan out to mobile clients over SSE. Same fire-and-forget contract — a
    // thrown subscriber is swallowed inside broadcast(). No subscribers ⇒
    // cheap no-op, so this is safe even when the mobile feature is unused.
    try {
      mobileEventBus.broadcast(e);
    } catch (err) {
      log.error(`mobile event bus error: ${(err as Error).message}`);
    }
  }

  /**
   * 把一个节点会话的事件折进它的过程里,该推的时候推到**父对话**上。
   *
   * 收件人是父会话而不是节点自己:节点会话在界面上没有面板(它连列表都不进),那张卡片
   * 长在父对话的消息流里 —— 和 `workflow.node.result` 的做法一致。
   */
  private publishNodeTranscript(session: Session, e: RuntimeEvent): void {
    const prev = this.nodeTranscripts.get(session.id);
    const folded = foldTranscript(prev ?? [], e);
    if (!folded) return;
    if (folded.blocks !== prev) {
      this.nodeTranscripts.set(session.id, folded.blocks);
      this.evictNodeTranscripts();
    }
    if (!folded.broadcast) return;
    this.fanOutToClients({
      type: "workflow.node.transcript",
      sessionId: session.parentSessionId ?? session.id,
      nodeSessionId: session.id,
      blocks: folded.blocks,
    });
  }

  /**
   * 把活着的节点过程裁到上限。
   *
   * **必须裁**:这东西不落盘、进程活多久它活多久,而一张图跑一次就多一批 —— 用户开着
   * 应用跑一整天自动化就是几十上百份。丢的是**最早见过的**那个(Map 的插入序),它的
   * 卡片多半早已滚出屏幕,而"最近几步"才是回头看时想要的。
   */
  private evictNodeTranscripts(): void {
    while (this.nodeTranscripts.size > NODE_TRANSCRIPT_LIMIT) {
      const oldest = this.nodeTranscripts.keys().next();
      if (oldest.done === true) return;
      this.nodeTranscripts.delete(oldest.value);
    }
  }

  /**
   * **无人值守的自动化:要人拍板的三类事件一律按"拒绝"落地**(fail-closed)。
   *
   * ## 为什么必须有个兜底
   *
   * 审批和提问都是**挂起等一个人**的:提问那一边是个 Deferred,不落地就永不 resolve
   * —— 那一轮永远不收尾,这次运行永远停在"进行中"(而重入保护会因此把**以后每一次**
   * 触发都跳过,这条自动化从此再也不跑)。所以不是"拒绝了不好看",是不落地就废。
   *
   * 为什么是**拒绝**而不是放行:放行等于无人看管地写盘、联网、运行命令。用户没有
   * 在场表示同意,那就只能按"不同意"算 —— 与 elicitation 那条既有做法一致。
   *
   * ## 为什么排到事件流后面(`setTimeout(0)`)
   *
   * 落地走的是 `resolveApproval` / `dismissUserInput`,它们会**广播**一条
   * `request.resolved`(见 `notifyRequestResolved`)。在这里同步调的话,那条"已解决"
   * 会**插在这一条"请求"还没发完的时候**发出去 —— 订阅者(以及将来任何读这条流的人)
   * 看到的是"先解决、后请求",顺序反了。排到下一个宏任务,它就落在这一条之后。
   *
   * 理由会进运行历史(用户事后能看见"这一步被人拍板的要求挡住了,系统按拒绝处理"),
   * 这是这套机制**唯一**能让人发现"我的自动化缺了一个人在场"的地方。
   *
   * ⚠️ **判据是事件的"去处",不是 `session.kind`** —— 调用点已经按去处判过了(见
   * `bindSession` 里那段):自动化运行里的节点会话也会走到这里,因为调度器把节点会话的
   * 交互事件代给了**发起它的那条会话**(自动化会话)。
   */
  private declineUnattended(e: RuntimeEvent): void {
    if (
      e.type !== "approval.request" &&
      e.type !== "question.ask" &&
      e.type !== "plan.approval_request"
    ) {
      return;
    }
    const reason = "无人值守的自动化:这一步要人拍板,已按拒绝处理";
    // 三类的 requestId 分开取:`question.ask` 那份是**可选**的(哨兵兜底那条路没有
    // Deferred 可落地,见 `QuestionAskEvent`),没有就什么都不做。
    const approvalId = e.type === "approval.request" ? e.requestId : undefined;
    const planId = e.type === "plan.approval_request" ? e.requestId : undefined;
    const questionId = e.type === "question.ask" ? e.requestId : undefined;
    setTimeout(() => {
      if (approvalId !== undefined) this.resolveApproval(approvalId, false, reason);
      else if (planId !== undefined) {
        this.resolvePlanApproval(planId, { approved: false, reason });
      } else if (questionId !== undefined) {
        // **dismiss 而不是"随便给个答案"**:它就是"没人回答"的正式表态,provider 会把它
        // 变成一次 deny / 工具错误,而那一轮**继续**往下走(不会静默卡住)。
        this.dismissUserInput(questionId);
      }
    }, 0);
  }

  /** host 侧的消费者(通知、工作流调度器)。**每个事件都要走** —— 包括节点会话
   *  自己的:调度器正是靠它收集每个节点的最终输出(见 `orchestration/runner.ts`)。
   *  火忘式:一个订阅者抛错不该把事件流带下去。 */
  private notifySubscribers(e: RuntimeEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch (err) {
        log.error(`event subscriber error: ${(err as Error).message}`);
      }
    }
  }
  /** Subscribe to every event. The NotificationManager is one subscriber (it
   *  decides whether an OS notification is warranted); the workflow scheduler is
   *  another, and only while a graph run is in flight (it needs each node's final
   *  text, which lives nowhere else in the main process: messages are persisted
   *  by the renderer). Returns the unsubscribe function. */
  subscribe(fn: (e: RuntimeEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Make this session's **interactive** events surface under another session.
   *
   * Workflow nodes are hidden sub-sessions, so a node's `AskUserQuestion` would
   * otherwise pop up somewhere the user cannot see. Re-addressing just the event
   * is enough to fix that: the *answer* needs no redirection at all, because
   * `ApprovalBridge` keys pending requests by `requestId` and only reports the
   * owning sessionId back for the cross-client close event (which
   * {@link notifyRequestResolved} then re-addresses the same way).
   *
   * Persistence is unaffected: `emit` files capsule state under the closure-bound
   * session id, so a node's tokens/todos land on the node's own row.
   */
  setInteractiveProxy(sessionId: string, parentSessionId: string | null): void {
    if (parentSessionId) this.interactiveProxy.set(sessionId, parentSessionId);
    else this.interactiveProxy.delete(sessionId);
  }

  private routeOf(sessionId: string): string {
    return this.interactiveProxy.get(sessionId) ?? sessionId;
  }

  /** 一条事件改道到的那个会话**是什么种类**(见 `emit` 里那段"判据是去处")。
   *
   *  只在"真的改道过"时才被调用,所以这一次读库落在**交互事件**上(一轮里几次),
   *  不在 `text.delta` 那种热路径上 —— 后者 `e === stamped`、直接用 `session.kind`。
   *  读不到(会话已经没了)就退回发起者自己的种类:谁发的就按谁的规矩办。 */
  private destinationKindOf(sessionId: string, fallback: Session): Session["kind"] {
    try {
      return SessionRepo.get(sessionId)?.kind ?? fallback.kind;
    } catch {
      return fallback.kind;
    }
  }

  /** Create or reuse the runtime state for a GUI session. Idempotent. */
  bindSession(session: Session): void {
    if (this.sessions.has(session.id)) return;

    const emit = (rawEvent: RuntimeEvent) => {
      const stamped = stampTurnEnd(rawEvent);
      // 节点会话的**交互**事件代父对话提问 —— 没有代理时 `routeOf` 原样返回自己,
      // 所以这句对普通会话是恒等的(见 `setInteractiveProxy` / `retargetEvent`)。
      const routed = this.routeOf(session.id);
      const e: RuntimeEvent = retargetEvent(stamped, routed);
      // 工作流节点是**隐藏会话**:它自己的流水(text / tool / turn.done / usage)没有
      // 任何界面消费 —— 推给渲染端只会变成幻影消息、点不掉的未读和"N 个回合完成"
      // 的提示(见 `orchestration/runner.ts`)。所以**只有被改写过的交互事件**才发往
      // 客户端。**落盘(下面那串 if)与订阅者照旧** —— 前者用会话自己的 id,后者是
      // host 侧的消费者,调度器正是靠它收集节点的输出。
      //
      // **自动化的后台会话同理**(它也是一条隐藏会话):它没有父对话可代问,于是
      // `e === stamped` 恒成立、整条流水都会被推出去 —— 那是错的。二者在这里是同一条
      // 规矩:**隐藏的会话,流水不上界面**。
      //
      // ⚠️ **判据是事件的"去处",不是 `session.kind`。** 去处 = 被改道到的那个会话
      // (只有交互事件会改道),没改道时就是自己。这一条对**自动化运行里的节点会话**
      // 是必须的:它的交互事件代的是**发起它的那条自动化会话**(见 `runner.ts` 的
      // `setInteractiveProxy`),而它和自动化会话本身是同一条规矩 —— 看 `session.kind`
      // 的话那一步的审批会挂在一个没人看得见的地方,而它**不落地就永不收尾**(那一轮
      // 收不了场 → 重入保护随后把以后每一次触发都跳过 → 这条自动化从此再也不跑)。
      const destinationKind = e === stamped ? session.kind : this.destinationKindOf(routed, session);
      if (destinationKind === "automation") {
        // 没人看得见,也没人能拍板 —— 与"隐藏会话的流水不上界面"是同一件事的两面。
        this.declineUnattended(e);
      } else if (!isHiddenSessionKind(destinationKind) || e !== stamped) {
        // ……但「对话节点」跑在**主对话**上(见 `runner.kind === "conversation"`),
        // 它的流水该看得见 —— 那正是它存在的意义,所以上面那条对它是恒等的,文本和
        // 工具事件照常推。它唯独有两类要扣住:回合的收口(`holdTurnEnd`)和它正在说的话
        // (`holdTurnText`)。
        if (!this.isHeldFromClients(session.id, e)) this.fanOutToClients(e);
      }
      // ……但"这一步到底干了什么"不能就这么没了。节点会话是**隐藏**的,`kinds==="node"`
      // 让它连自己的对话面板都没有,所以那一步搜了什么、跑了哪些工具、在哪儿绕了路,
      // 用户一概看不见(他报的原话是「能看见子代理在干嘛」)。折成一份只读的过程,走
      // **子代理那条一模一样的通道**发出去 —— 按 id 索引、不进消息流,所以上面那条
      // "幻影消息 / 点不掉的未读"的顾虑不受影响(见 `nodeTranscript.ts`)。
      if (session.kind === "node") this.publishNodeTranscript(session, e);
      // Persist capsule state so the top-right status pill reloads on
      // session reopen. Each event type → one Repo call, fire-and-forget.
      // contextSnapshot / todos / subagents / planDraft are all JSON blobs.
      if (e.type === "token-usage.updated") {
        try {
          SessionRepo.updateSnapshot(session.id, e.snapshot);
        } catch (err) {
          log.error(`failed to persist context snapshot: ${(err as Error).message}`);
        }
        // Track the latest snapshot; if a turn just ended, its deferred
        // usage-history record settles now (the adapter fires the turn-end
        // snapshot asynchronously, AFTER turn.done — see pendingTurnEnd).
        const rt = this.sessions.get(session.id);
        if (rt) {
          rt.lastContextSnapshot = e.snapshot;
          this.settlePendingTurnEnd(session.id, rt);
          // 轮预算：tokens/usd 直接读快照 —— ContextSnapshot 本身就是按轮
          // 累计的，turn.done 后的收尾快照也走这里（此时闸已触发，空操作）。
          rt.budgetTokens = e.snapshot.totalProcessedTokens;
          rt.budgetUsd = e.snapshot.costUsd ?? rt.budgetUsd;
          this.enforceBudget(session.id, rt);
        }
      } else if (e.type === "message.complete") {
        // 轮预算：assistant 轮计数（三引擎的 message.complete 均只在主 agent
        // 的 assistant 消息上发，作 maxTurns 的近似）。不落盘 —— 只是本轮的
        // 计数器，下一轮 sendTurn 归零。
        const rt = this.sessions.get(session.id);
        if (rt) {
          rt.budgetTurns++;
          this.enforceBudget(session.id, rt);
        }
      } else if (e.type === "turn.done") {
        // Persist the per-turn token/cost history. The turn's FINAL snapshot
        // (throughput/cost from result.usage) is published asynchronously by
        // the adapter after turn.done — it must never delay turn.done, as
        // slow gateway control channels used to stall it for tens of seconds.
        // So: stash the timings here, append the record when the turn-end
        // snapshot lands (settlePendingTurnEnd above), and let the next
        // sendTurn flush it with the last-known snapshot if none ever does.
        const rt = this.sessions.get(session.id);
        if (rt && rt.turnStartedAt > 0) {
          // Reuse the event's stamped instant (NOT a fresh Date.now()) so the
          // usage record's endedAt is exactly the value the renderer stored on
          // turnMeta — that equality is how the receipt finds this turn's
          // tokens.
          const endedAt = e.endedAt ?? Date.now();
          rt.pendingTurnEnd = {
            endedAt,
            durationMs: Math.max(0, endedAt - rt.turnStartedAt),
          };
          // Ordering, as observed in production (usage history silently lost on
          // single-turn sessions): the adapter emits the turn-end snapshot from
          // handleResult BEFORE flushFinal's turn.done, so this stash used to
          // sit forever — the earlier token-usage.updated found nothing pending,
          // and single-turn sessions (side chats) had no next sendTurn to
          // backfill. Two settle paths now cover both orders:
          //  - the snapshot already landed → settle on a short grace timer
          //    (path C publishes synchronously; only a slow path-B control
          //    request lands later, ≤ its 3s race). Waiting the grace out lets
          //    an imminent REAL snapshot win via the branch below instead of
          //    freezing a stale mid-turn path-A value into the record.
          //  - the snapshot truly never arrives → the same timer backfills with
          //    the last-known snapshot rather than dropping the turn entirely.
          setTimeout(() => {
            try {
              this.settlePendingTurnEnd(session.id, rt);
            } catch {
              /* settle already logs its own persistence errors */
            }
          }, TURN_END_SETTLE_GRACE_MS).unref();
        }
        // S4 失败回退链：模型失败（reason="error"）且还有链可换 → 换下一个
        // 模型原样重发。预算停（budgetFired）不算模型失败；用户主动停走
        // "interrupted"，天然不进这里。链在 sendTurn 侧每轮重置、失败逐跳
        // 消耗，天然有界。回退只在 chat 会话解析出非空链（sendTurn 已过滤
        // 节点 / 工作流 / custom 网关）。
        if (rt && e.reason === "error" && !rt.budgetFired && rt.fallbackModels.length > 0 && rt.lastTurnInput) {
          const nextModel = rt.fallbackModels.shift() as string;
          const from = session.model !== "default" ? session.model : "默认模型";
          log.warn(`turn failed on ${from}; falling back to ${nextModel} (${rt.fallbackModels.length} left in chain)`);
          rt.ctx.emit({
            type: "turn.notice",
            sessionId: session.id,
            kind: "fallback",
            message: `模型 ${from} 本回合失败，自动改用 ${nextModel} 重试`,
          });
          const retryInput = rt.lastTurnInput;
          rt.fallbackRetryModel = nextModel;
          // 下一跳事件循环再发：让 turn.done 的落盘链路先走完，也别在 emit
          // 调用栈里递归 sendTurn（那会让嵌套事件和持久化交错）。
          setTimeout(() => {
            void this.sendTurn(session, retryInput).catch((err) => {
              log.error(`fallback resend failed: ${(err as Error).message}`);
            });
          }, 0).unref();
        }
      } else if (e.type === "todo.update") {
        try {
          SessionRepo.updateTodos(session.id, e.todos);
        } catch (err) {
          log.error(`failed to persist todos: ${(err as Error).message}`);
        }
      } else if (e.type === "subagent.update") {
        try {
          SessionRepo.updateSubagents(session.id, e.agents);
        } catch (err) {
          log.error(`failed to persist subagents: ${(err as Error).message}`);
        }
        const rt = this.sessions.get(session.id);
        if (rt) {
          // Carry the roster across turns (a fresh adapter starts empty —
          // see sendTurn's replay).
          rt.lastSubagents = e.agents;
          // Attribute each agent's token growth to the turn that is currently
          // settling (see subagentTokensByTask). Values are monotonic per agent
          // (adapter-clamped), so positive deltas are the agent's real burn;
          // a decrease never arrives but is defensively ignored anyway.
          for (const a of e.agents) {
            const tok = typeof a.totalTokens === "number" && a.totalTokens > 0 ? a.totalTokens : 0;
            const prev = rt.subagentTokensByTask.get(a.taskId) ?? 0;
            if (tok > prev) {
              rt.turnSubagentTokens += tok - prev;
              rt.subagentTokensByTask.set(a.taskId, tok);
            }
          }
        }
      } else if (e.type === "subagent.transcript") {
        // Merge the per-agent replace-semantics array into the turn's map and
        // persist the whole map. Event rate is message-level (a few per tool
        // call), and persist() is coalesced — cheap enough to write through
        // every time, which keeps the DB row recoverable even if the app dies
        // mid-turn.
        const rt = this.sessions.get(session.id);
        if (rt) {
          rt.subagentTranscripts.set(e.parentToolUseId, e.blocks);
          try {
            SessionRepo.updateSubagentTranscripts(
              session.id,
              Object.fromEntries(rt.subagentTranscripts),
            );
          } catch (err) {
            log.error(`failed to persist subagent transcripts: ${(err as Error).message}`);
          }
        }
      } else if (e.type === "plan.update") {
        try {
          SessionRepo.updatePlanDraft(session.id, { plan: e.plan, phase: e.phase });
        } catch (err) {
          log.error(`failed to persist plan draft: ${(err as Error).message}`);
        }
      } else if (e.type === "turn.files") {
        // Persist the per-turn modified-files snapshot so the "本轮修改" card
        // survives a session reopen. The payload already carries adds/dels/before
        // (computed in FileSnapshot.freeze), so we store it verbatim.
        try {
          SessionRepo.updateTurnFiles(session.id, e.files);
        } catch (err) {
          log.error(`failed to persist turn files: ${(err as Error).message}`);
        }
      } else if (e.type === "turn.rewound") {
        // A rewind voids the rewound turn's edits. Clear the persisted
        // latest-turn snapshot ONLY when the rewound card IS the latest
        // turn (its path set matches the persisted turn_files) — otherwise
        // (historical rewind) the latest turn's data must stay intact, or
        // it would vanish from a session reopen after a historical rewind.
        try {
          const persisted = SessionRepo.get(session.id)?.turnFiles ?? null;
          const matchesLatest =
            persisted !== null &&
            persisted.length === e.targetFiles.length &&
            new Set(e.targetFiles).size === e.targetFiles.length &&
            persisted.every((f) => e.targetFiles.includes(f.filePath));
          if (matchesLatest) {
            SessionRepo.updateTurnFiles(session.id, null);
          }
        } catch (err) {
          log.error(`failed to clear turn files after rewind: ${(err as Error).message}`);
        }
      }
      // Notify the host-side consumers (NotificationManager, and the workflow
      // scheduler while a run is in flight) after the renderer push + persistence.
      this.notifySubscribers(e);
    };

    const onProviderSessionId = (id: string) => {
      const rt = this.sessions.get(session.id);
      if (!rt) return;
      if (rt.providerSessionId === id) return;
      rt.providerSessionId = id;
      try {
        SessionRepo.updateClaudeSessionId(session.id, id);
      } catch (err) {
        log.error(`failed to persist provider session id: ${(err as Error).message}`);
      }
    };

    const ctx: ProviderContext = {
      emit,
      onProviderSessionId,
      log,
      requestApproval: approvalBridge.makeApprovalHandler(session.id, emit),
      requestUserInput: approvalBridge.makeUserInputHandler(session.id, emit),
      requestPlanApproval: approvalBridge.makePlanApprovalHandler(session.id, emit),
      // Expose the per-session always-allow set + current permission mode so
      // the provider's canUseTool can short-circuit without prompting the
      // renderer. Both read the live bridge state, so a mid-turn mode flip
      // (setPermissionMode) is visible to the next tool call immediately.
      isToolAlwaysAllowed: (toolName: string) => approvalBridge.isAlwaysAllowed(session.id, toolName),
      getPermissionMode: () => approvalBridge.getPermissionMode(session.id),
    };
    // Seed the session's permission mode so canUseTool sees the right value
    // from the first tool call (subsequent flips via setPermissionMode update it).
    approvalBridge.setPermissionMode(session.id, session.permissionMode);

    this.sessions.set(session.id, {
      providerSessionId: session.claudeSessionId,
      ctx,
      lastCwd: null,
      turnStartedAt: 0,
      usageHistory: session.usageHistory ?? [],
      turnCount: 0,
      subagentTokensByTask: new Map(),
      turnSubagentTokens: 0,
      // Rehydrate the session-scoped subagent state from the persisted row so
      // sendTurn's cross-turn replay works after ANY rebind — app restart,
      // dispose-on-archive → unarchive, etc. Without this, a fresh bind's
      // empty map means the new turn's first adapter flush would REPLACE the
      // renderer's/DB's accumulated roster away (the replay exists precisely
      // to prevent that, so it must have data to replay).
      subagentTranscripts: new Map(Object.entries(session.subagentTranscripts ?? {})),
      lastSubagents: session.subagents ?? [],
      budgetTurns: 0,
      budgetUsd: 0,
      budgetTokens: 0,
      budgetFired: false,
      fallbackModels: [],
    });
  }

  /** IDs of every session with a currently running turn. Used by the mobile
   *  SSE endpoint to publish a running-state snapshot on (re)connect, so a
   *  phone that missed `turn.done` while backgrounded can self-correct its
   *  client-side running state. */
  runningSessionIds(): string[] {
    const ids: string[] = [];
    for (const [id, rt] of this.sessions) {
      if (rt.handle?.isRunning()) ids.push(id);
    }
    return ids;
  }

  /** Append the deferred per-turn usage-history record (stashed by the
   *  turn.done handler in `pendingTurnEnd`) using the latest context
   *  snapshot. No-op when nothing is pending; skips silently when no
   *  snapshot ever arrived (nothing meaningful to record). */
  private settlePendingTurnEnd(sessionId: string, rt: SessionRuntime): void {
    const pending = rt.pendingTurnEnd;
    if (!pending) return;
    rt.pendingTurnEnd = undefined;
    const snap = rt.lastContextSnapshot;
    // Consume this turn's subagent token growth no matter which settle path
    // fired (snapshot arrival / grace timer / next-turn flush) — even when no
    // snapshot means no record is written, the turn is over and the next
    // turn's growth must start from zero.
    const subagentTokens = rt.turnSubagentTokens;
    rt.turnSubagentTokens = 0;
    if (!snap) return;
    try {
      const record: TurnUsageRecord = {
        endedAt: pending.endedAt,
        durationMs: pending.durationMs,
        totalProcessedTokens: snap.totalProcessedTokens,
        outputTokens: snap.outputTokens,
        cacheReadTokens: snap.cacheReadTokens ?? 0,
        cacheCreationTokens: snap.cacheCreationTokens ?? 0,
        costUsd: snap.costUsd,
        subagentTokens: subagentTokens > 0 ? subagentTokens : undefined,
        usedTokens: snap.usedTokens,
        model: snap.model,
      };
      rt.usageHistory = [...rt.usageHistory, record];
      SessionRepo.updateUsageHistory(sessionId, rt.usageHistory);
      invalidateUsageStats();
    } catch (err) {
      log.error(`failed to persist usage history: ${(err as Error).message}`);
    }
  }

  /** Send a user message to the provider and stream events back. */
  async sendTurn(
    session: Session,
    input: {
      prompt: string;
      cwd: string;
      skills?: string[];
      /** MCP 服务器 / 插件的允许清单 —— 空/缺席 = 不限制。和 `skills` 是同一套读法,
       *  见 `StartTurnRequest` 上那两段。图型工作流的节点按自己的参数填这两个;
       *  普通对话不填(它本来就该看得见用户装的全部东西)。 */
      mcpServerNames?: string[];
      pluginNames?: string[];
      images?: { data: string; mimeType: string }[];
      /** The originating client's user message (id / createdAt / display
       *  blocks). Echoed to every client as a `user.message` RuntimeEvent so
       *  a prompt typed on one device (phone ⇄ PC) renders on the others in
       *  real time; the originator dedupes by id (it appended optimistically
       *  at send). Absent for callers that predate the field — no echo.
       *  `editedMessageId`, when set, marks this as an EDIT and lets the other
       *  clients truncate their own stale tail at that message. */
      userMessage?: {
        id: string;
        createdAt: number;
        blocks: unknown[];
        editedMessageId?: string;
      };
    },
  ): Promise<TurnHandle | null> {
    const rt = this.sessions.get(session.id);
    if (!rt) {
      log.warn(`sendTurn: no runtime bound for session ${session.id}`);
      return null;
    }
    if (rt.handle?.isRunning()) {
      log.warn(`sendTurn: session ${session.id} already running, ignoring`);
      return null;
    }

    const provider = providerRegistry.resolve(session.providerId);

    // A previous turn that ended without any turn-end snapshot (all-zero
    // usage / abort before result) left its usage-history record pending —
    // flush it with the last-known snapshot before this turn starts.
    this.settlePendingTurnEnd(session.id, rt);

    // Record turn start time for per-turn usage history persistence.
    rt.turnStartedAt = Date.now();
    // 轮预算：每轮重新解析偏好（改设置立即生效，无需重启），计数器归零、
    // 防重入闸复位。
    rt.budget = parseTurnBudget(SettingRepo.get(TURN_BUDGET_SETTING_KEY));
    rt.budgetTurns = 0;
    rt.budgetUsd = 0;
    rt.budgetTokens = 0;
    rt.budgetFired = false;
    // S4 失败回退链：仅普通对话启用（节点/工作流禁用，避开 holdTurnEnd 与
    // 调度器纠缠；custom 网关会话也不做 —— 链里的全局模型 id 对第三方配置
    // 没有意义）。回退重试的那轮**不**重新解析 —— 否则 shift 掉的链会被
    // 重置成完整链，同一个模型无限重试。
    const isFallbackRetry = rt.fallbackRetryModel !== undefined;
    if (!isFallbackRetry) {
      rt.fallbackModels =
        session.kind !== "node" && !session.workflowId && !session.customModelId
          ? parseFallbackModels(SettingRepo.get(RUNTIME_FALLBACK_MODELS_SETTING_KEY))
          : [];
    }
    // 1-based turn counter for per-turn artifacts (browser screenshot dirs).
    rt.turnCount++;

    // Reset the per-turn file snapshot before the new turn. This is
    // what makes "rewind last turn" work correctly across consecutive
    // turns: turn N's snapshot is taken from the state at the *start*
    // of turn N (i.e. end of turn N-1), which is what the user
    // expects when clicking 撤销本轮. Without the clear, turn N-1's
    // files would still be in the snapshot and rewind would partially
    // undo turn N-1 instead of fully undoing turn N.
    //
    // DROP the registry entry instead of clear()-ing it in place: an
    // INTERRUPTED previous turn's adapter is still unwinding toward its
    // flushFinal() (ac.abort() resolves the interrupt IPC long before the
    // SDK generator actually rejects), and that adapter holds this
    // session's snapshot instance. An in-place clear() here would (a)
    // empty its records before freeze() runs — the aborted turn's
    // "本轮修改" card is lost — and (b) leave freeze()'s `frozen=true`
    // flag stuck on the SHARED instance, so every recordPre() of this
    // new turn is silently dropped and the new turn's card is lost too
    // (2026-09-04 bug report: both turns' cards missing after
    // interrupt-then-send). Replacing the instance lets the old
    // adapter's late freeze() work on its own (stale) records while
    // this turn starts from a virgin snapshot.
    dropFileSnapshot(session.id);

    // Subagent history is SESSION-scoped, not turn-scoped: replay the
    // accumulated roster + transcripts so the fresh turn's adapter (which
    // starts with EMPTY state) can't REPLACE them away with its first
    // flush — the capsule and the side-panel viewer keep showing earlier
    // turns' subagents, running ones first, until the session is deleted.
    if (rt.lastSubagents.length > 0) {
      rt.ctx.emit({
        type: "subagent.update",
        sessionId: session.id,
        agents: rt.lastSubagents,
      });
    }
    for (const [parentToolUseId, blocks] of rt.subagentTranscripts) {
      rt.ctx.emit({
        type: "subagent.transcript",
        sessionId: session.id,
        parentToolUseId,
        blocks,
      });
    }

    // If the session is bound to a custom-model config, decrypt its
    // credentials (main-process only) and pass them through to the provider
    // so the turn runs against the user's endpoint. `session.model` carries
    // the selected model id (e.g. "deepseek-v4-pro"); resolveApiConfig
    // validates it against the config's model list (falling back to the first
    // entry if it's been removed). Cleartext lives only in this request
    // object for the duration of the turn.
    let apiConfig: StartTurnRequest["apiConfig"];
    // The model id to pass to the SDK `model` option. For a custom config we
    // deliberately leave this undefined: buildCustomEnv pins
    // ANTHROPIC_MODEL from the selected model (with the `[1m]` suffix when it
    // declares 1M context). The binary reads ANTHROPIC_MODEL as its native
    // model-override channel, so passing --model too would just risk
    // disagreeing with the env var.
    // For the built-in path it's the session's model unless "default" —
    // or the fallback chain's next model when this is a failure retry
    // (consumed here; a fresh user-sent turn re-parses the chain instead).
    let modelForReq: string | undefined = isFallbackRetry
      ? rt.fallbackRetryModel
      : session.model !== "default"
        ? session.model
        : undefined;
    rt.fallbackRetryModel = undefined;
    if (session.customModelId) {
      const cfg = CustomModelStore.resolveApiConfig(session.customModelId, session.model);
      if (!cfg) {
        log.warn(`sendTurn: custom model ${session.customModelId} not found, token undecryptable, or no model configured; falling back to default endpoint`);
      } else {
        // OpenAI-protocol endpoints need an in-process bridge that impersonates
        // Anthropic /v1/messages. We rewrite the apiConfig to point at the
        // local bridge, so the rest of the pipeline (buildCustomEnv, the binary)
        // is completely unaware anything special is happening — it just sees an
        // Anthropic-compatible endpoint on localhost. The bridge is shared
        // across sessions via the registry (keyed by config id, ref-counted).
        // `web` 与 `openai` 一样要走本地 bridge —— 区别只在 bridge 的"上游"是什么
        // （HTTP 端点 vs 内嵌浏览器里的网页，见 bridge/webUpstream.ts）。
        if (cfg.protocol === "openai" || cfg.protocol === "web") {
          // Release any bridge we're holding for a DIFFERENT config (the user
          // may have switched custom models mid-session), then acquire for the
          // current one. We hold exactly one bridge per session; same-config
          // repeats across turns reuse the existing handle without bumping the
          // ref count again.
          if (rt.bridgeConfigId && rt.bridgeConfigId !== session.customModelId) {
            rt.bridgeStatusUnsubscribe?.();
            rt.bridgeStatusUnsubscribe = undefined;
            BridgeRegistry.release(rt.bridgeConfigId);
            rt.bridgeConfigId = undefined;
            rt.bridgeHandle = undefined;
          }
          if (!rt.bridgeConfigId) {
            const handle = await BridgeRegistry.acquire(session.customModelId, cfg);
            rt.bridgeConfigId = session.customModelId;
            rt.bridgeHandle = { localUrl: handle.localUrl };
            // Surface transient upstream-transport retries (connect timeout /
            // reset / refused) to this session's UI. Without it, a 10s+ retry
            // loop mid-turn looks like an unexplained hang — the final failure
            // does reach the user (502 → API-error card), but the WAITING
            // doesn't. kind:"ok" after a successful retry clears the hint.
            rt.bridgeStatusUnsubscribe = handle.onStatus((s) => {
              rt.ctx.emit({
                type: "upstream.issue",
                sessionId: session.id,
                kind: s.kind,
                cause: s.cause,
                attempt: s.attempt,
                attempts: s.attempts,
              } satisfies UpstreamIssueEvent);
            });
          }
          // rt.bridgeHandle is now guaranteed set (we just ensured it above);
          // bind to a local so TS keeps it narrowed through the rewrite below.
          const localUrl = rt.bridgeHandle?.localUrl;
          // Rewrite the apiConfig to point at the local bridge so the rest of
          // the pipeline (buildCustomEnv, the binary) is completely unaware —
          // it just sees an Anthropic-compatible endpoint on localhost.
          // `authToken` 一并补上占位串：本地 bridge 不校验凭据（只绑 127.0.0.1，
          // 见 bridgeServer），但 Claude Code 手里一份凭据都没有时会直接以
          // 「Not logged in · Please run /login」拒绝这一轮 —— 而网页端模型恰恰
          // 没有 token（身份在浏览器那个分区的登录 cookie 里，secretStore 对 web
          // 免除了 token 要求，见那里 `isWebProtocol` 分支）。openai 协议有真
          // token，走到这里原样保留。
          apiConfig = {
            ...cfg,
            baseUrl: localUrl ?? cfg.baseUrl,
            authToken: cfg.authToken || "mcode-local-bridge",
          };
        } else {
          apiConfig = cfg;
        }
        modelForReq = undefined; // env pins ANTHROPIC_MODEL via buildCustomEnv
      }
    }

    // Cross-client user-message echo — emitted BEFORE the provider turn
    // starts so the bubble lands on other clients ahead of the first
    // assistant event. Shared with the scheduler's graph path (which has no
    // provider turn to echo from).
    if (input.userMessage) {
      this.echoUserMessage(session.id, input.userMessage);
    }

    // 这一轮要追加的工作流片段。**解析放在 host** —— 提供方只负责 append 一段字符串,
    // 见 `main/orchestration/prompt.ts`。
    const workflowPrompt = resolveWorkflowPrompt(session.workflowId);
    if (workflowPrompt) {
      // 每轮一行,让"工作流到底有没有送到模型"从日志就能回答,不用调试器。
      // (这行过去在提供方里,因为那儿的 `req` 还带着 id;搬过来之后 id 只有这里知道。)
      log.info(`workflow active: ${session.workflowId}`);
    }

    // 「这个对话是谁」—— 建会话时从代理档案抄下来的角色提示词,**每轮都带**。
    //
    // 每轮而不是只在第一轮,是这条路与**节点**那边最关键的一处不同:节点是一个步骤
    // (指令只在入口发一次),而对话是一个**持续的身份** —— 只拼第一轮的话,它第二轮就
    // 不知道自己是谁了,而用户看到的是"它怎么忘了"。
    //
    // 读的是**会话行上那份快照**,不是现读档案:改了档案不该影响已经开出去的对话
    // (理由与代价写在 `main/lib/sessionAgentProfile.ts` 的文件头)。所以这里没有"档案
    // 读不到"的分支 —— 内容早就在行里了。
    const agentPrompt = resolveAgentPrompt(session.agentProfile);
    if (agentPrompt) {
      log.info(`agent profile active: ${session.agentProfile?.name ?? session.agentProfile?.id ?? "?"}`);
    }

    // **「并回主对话」的内容在这里带进去**(见 `@contracts/nodeType` 的
    // `NODE_RETURN_PARAM_KEY` 与 `lib/pendingBackflow.ts`)。
    //
    // 为什么是这里:主对话的上下文在**提供方那边**(CLI 自己的会话记录,靠 `resume` 续),
    // 主进程没有往里面插一条的接口 —— 唯一能保证被看见的地方就是**下一次发出去的提示词**。
    // 放在 `sendTurn` 而不是各个调用点上,是因为调用点有三个(桌面 IPC、手机 RPC、工作流
    // 里那个对话节点),漏一个的表现是"手机端发的消息看不到图的结果"。
    //
    // **只看不取**(`peek`):回合真的起来了才清(见下面 `clearBackflow`)—— 先在发之前
    // take 的话,回合没起成那一段就永久丢了,而用户只会发现助手"没记住刚才那些产出"。
    const backflow = backflowPrompt(peekBackflow(session.id));

    const req: StartTurnRequest = {
      sessionId: session.id,
      prompt: backflow.length > 0 ? `${backflow}\n\n${input.prompt}` : input.prompt,
      cwd: input.cwd,
      model: modelForReq,
      effort: session.effort !== "default" ? session.effort : undefined,
      permissionMode: session.permissionMode !== "default" ? session.permissionMode : undefined,
      // 工作流的提示词已经在上面的 `resolveWorkflowPrompt` 里拼好了;提供方拿到的
      // 就是一段字符串,不再自己查表(那套查表原先只有 claude-sdk 实现,Pi / Codex
      // 拿不到工作流)。
      workflowPrompt,
      // 角色提示词(代理档案那份快照)。**与 prompt 分开传**:提供方那边是 append 到
      // 系统提示词上的,不是拼在用户这句话前面 —— 拼在 prompt 里的话模型会把它当成
      // "用户这一轮说的话",而它其实是"你是谁"。
      agentPrompt,
      resumeProviderSessionId: rt.providerSessionId,
      apiConfig,
      skills: input.skills,
      // 工作流节点收窄这一轮能看见的东西(见 `NodeRunInput`)。普通对话这两项是
      // undefined = 不限制。
      mcpServerNames: input.mcpServerNames,
      pluginNames: input.pluginNames,
      // User-attached images (base64 content blocks) — forwarded verbatim to
      // the provider; each adapter maps them onto its SDK's image shape.
      images: input.images,
      // Seed the adapter with the persisted todo list so that incremental
      // TaskUpdate(taskId=N) calls in this turn can resolve against tasks
      // created in earlier turns (the adapter is recreated fresh each turn).
      initialTodos: session.todos ?? undefined,
      // Tag the turn for per-turn artifacts (browser screenshot dirs).
      turnNumber: rt.turnCount,
      // 轮预算：host 侧统一强制（三引擎一致）；Claude native 的
      // maxTurns / maxBudgetUsd 在 provider 里照着传，算双保险。
      budget: rt.budget,
      // 失败回退链的剩余部分（Claude native 的 Options.fallbackModel 双保险；
      // host 侧 turn.done error 的重发是主路径）。空链不传。
      fallbackModels: rt.fallbackModels.length > 0 ? rt.fallbackModels : undefined,
    };

    const handle = await provider.startTurn(req, rt.ctx);
    // 回合起来了,那一段背景才算真的送到了 —— 见上面 `peekBackflow` 那段注释。
    if (handle !== null && backflow.length > 0) clearBackflow(session.id);
    // 回退重发的输入快照：req 里的最终形态（prompt 已拼好 backflow / 工作流
    // 片段）。回合失败要原样重发，就从这里取。
    if (handle !== null) {
      rt.lastTurnInput = {
        prompt: req.prompt,
        cwd: req.cwd,
        skills: req.skills,
        mcpServerNames: req.mcpServerNames,
        pluginNames: req.pluginNames,
        images: req.images,
      };
    }
    rt.handle = handle;
    // Remember the cwd for the rewind path (see rewindTurn below).
    rt.lastCwd = input.cwd;

    // Run in background; errors are caught inside the provider's done loop.
    handle.done.catch((err) => {
      log.error(`turn failed: ${(err as Error).message}`);
    });
    // 返回 handle:调用方通常不管(它只关心"turn 起来了"),但工作流调度器要等这个
    // 节点跑完才发下游 —— `handle.done` 是"这一轮结束了"的唯一信号。
    return handle;
  }

  /**
   * 轮预算强制。三判齐全（开了预算 / 闸未触发 / 回合还在跑）才动作：置位
   * `budgetFired`（防收尾事件的残留快照二次触发）→ 发 `turn.notice` → 沿
   * 用户点停的同一条路 interrupt。放在 host 而不是各 provider：三个引擎
   * 只有 Claude 有 native 的 maxTurns/maxBudgetUsd，token 上限更是谁都没有
   * —— host 侧统一强制是唯一能三引擎一致的落点。
   */
  private enforceBudget(sessionId: string, rt: SessionRuntime): void {
    const budget = rt.budget;
    if (!budget || rt.budgetFired || !rt.handle?.isRunning()) return;
    // 三判的纯判定在 turnPolicy.budgetViolations（可直测）；这里只管副作用：
    // 置防重入闸 → 发通知 → 沿用户点停同一条路 interrupt。
    const reasons = budgetViolations(budget, rt.budgetTurns, rt.budgetUsd, rt.budgetTokens);
    if (reasons.length === 0) return;
    rt.budgetFired = true;
    log.warn(`turn budget reached for ${sessionId}: ${reasons.join(", ")}`);
    rt.ctx.emit({
      type: "turn.notice",
      sessionId,
      kind: "budget_limit",
      message: `已达到本轮预算上限（${reasons.join("、")}），正在停止当前回合`,
    });
    try {
      rt.handle.interrupt();
    } catch (err) {
      log.error(`budget interrupt failed: ${(err as Error).message}`);
    }
  }

  interrupt(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt?.handle) return;
    rt.handle.interrupt();
  }

  /**
   * 往**正在跑的那一轮**里塞一句话(生成过程中插话)。返回"收下了没有"。
   *
   * 三种"没收下"都要如实返回 `false`,因为调用方(IPC → 渲染端)据此**兜回普通的发送**:
   *
   *  - 这个对话压根没在跑;
   *  - 这一轮的引擎不支持插话(`supportsInject`,比如 Pi / Codex);
   *  - 引擎那边说这一轮刚好收尾了(`TurnHandle.inject` 的说明)。
   *
   * 一声不响地丢掉是最坏的一种:用户打了字、按了回车,界面上什么也没发生,而他会以为
   * 那句话已经说了。
   */
  injectMessage(sessionId: string, text: string): boolean {
    const rt = this.sessions.get(sessionId);
    const handle = rt?.handle;
    if (!handle?.inject || !handle.isRunning()) return false;
    return handle.inject(text);
  }

  dispose(sessionId: string): void {
    const rt = this.sessions.get(sessionId);
    if (!rt) return;
    try {
      rt.handle?.interrupt();
    } catch {
      /* ignore */
    }
    approvalBridge.rejectAll(sessionId);
    // 代理关系随运行时一起消失 —— 留着的话,后来复用的同一个 id 会莫名其妙地把
    // 交互事件报到别的对话去。
    this.interactiveProxy.delete(sessionId);
    // Release any OpenAI bridge this session was holding, so the ref count
    // drops and the shared server can shut down when no session needs it.
    if (rt.bridgeConfigId) {
      rt.bridgeStatusUnsubscribe?.();
      rt.bridgeStatusUnsubscribe = undefined;
      BridgeRegistry.release(rt.bridgeConfigId);
      rt.bridgeConfigId = undefined;
      rt.bridgeHandle = undefined;
    }
    // Drop the snapshot too — keep memory bounded as sessions come
    // and go. The registry holds onto the per-session FileSnapshot
    // for the lifetime of the app otherwise.
    dropFileSnapshot(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Dispose every session runtime bound to a project. Called BEFORE a
   *  project hard-delete: the SQL cascade removes the session rows, so this
   *  is the last chance to look up which runtimes to release (otherwise each
   *  cascaded session leaks its transcripts/usage history/snapshot exactly
   *  like a never-disposed session). */
  disposeProject(projectId: string): void {
    // ⚠️ 用 `listIdsByProject`,**不要**用 `idsByProject` —— 那两个是同一条 SQL
    // (`SELECT id FROM sessions WHERE project_id = ?`)、同一个用途,是两份实现。
    // `listIdsByProject` 是本仓库本来的写法(走 `stmt.step()`/`getAsObject()`,
    // 和这个文件里其它几十处一致);`idsByProject` 是上游后加的,它调的
    // `stmt.all(...)` 在 sql.js 的 `Statement` 上**不存在** —— 类型检查一直红着,
    // 只是没人跑到。仓库硬规矩第 2 条:共享实现只有一份。
    for (const id of SessionRepo.listIdsByProject(projectId)) {
      this.dispose(id);
    }
  }

  /** Rewind a turn for a session: restore the given `files` to their
   *  pre-turn state, then emit a `turn.rewound` event so the renderer
   *  can update its "本轮文件" card. Returns the list of paths actually
   *  restored (failed paths are logged in main but not surfaced).
   *
   *  The caller passes the explicit entries to restore — this works for
   *  the latest turn (entries from the live snapshot), ANY historical
   *  turn (entries persisted on the message), and a session reopened
   *  after restart (entries rehydrated from the DB). None of these
   *  cases depend on the in-memory FileSnapshot being present.
   *
   *  `targetFiles` (the requested path set) is forwarded on the event so
   *  the renderer can locate the exact card and mark it `rewound: true`
   *  in place — for BOTH latest-turn and historical rewinds. The card is
   *  never removed: it stays in the stream as a visible trace that the
   *  user rolled this turn back. */
  async rewindTurn(sessionId: string, files: TurnFileEntry[], targetFiles: string[]): Promise<string[]> {
    const rt = this.sessions.get(sessionId);
    // Resolve the cwd: prefer the live runtime's lastCwd (set on the first
    // sendTurn). When that's missing - the common case for the "会话重开后
    // 仍可撤回" feature, where the user reopens a session and immediately
    // clicks 撤销本轮 WITHOUT sending a new turn first - fall back to the
    // session row's project path. This is what makes the DB-driven rewind
    // path actually work: restoreFiles only needs cwd + entries, never the
    // in-memory FileSnapshot.
    const cwd =
      rt?.lastCwd ??
      (() => {
        const session = SessionRepo.get(sessionId);
        const project = session ? ProjectRepo.get(session.projectId) : undefined;
        return project?.path ?? null;
      })();
    if (!cwd) {
      log.warn(`rewindTurn: cwd not available for session ${sessionId} (no runtime, no project?)`);
      return [];
    }
    const restored = await restoreFiles(cwd, files);
    // After a successful restore, drop the in-memory snapshot ONLY when
    // the rewind targeted exactly its contents (i.e. the latest live
    // turn). `hasPaths` is the authoritative check: the live snapshot
    // holds exactly the LATEST turn's files, so a path-set match means
    // this was the live rewind; anything else is a historical/DB-driven
    // rewind and the snapshot must be left untouched (the next sendTurn
    // clears it anyway). When `rt` is absent (reopened session) the
    // snapshot is empty, so hasPaths can't match.
    const snapshot = getFileSnapshot(sessionId);
    if (rt && restored.length > 0 && snapshot.hasPaths(files.map((f) => f.filePath))) {
      snapshot.clear();
    }
    // Notify the renderer (and any other listeners) so the UI can mark
    // the matching "本轮文件" card as rewound. `targetFiles` (the
    // requested path set, before any failure dropped entries) is ALWAYS
    // forwarded so the renderer can locate the exact card to mark in
    // place — the card stays in the stream as the rewind trace.
    sendToRenderer(IPC.CLAUDE_EVENT, {
      channel: IPC.CLAUDE_EVENT,
      sessionId,
      event: {
        type: "turn.rewound",
        sessionId,
        files: restored,
        targetFiles,
      } satisfies RuntimeEvent,
    });
    return restored;
  }

  /** Resolve an approval request from the renderer. On success, broadcast the
   *  cross-client `request.resolved` sync event so every OTHER client closes
   *  its copy of the approval dialog (the Deferred resolves exactly once). */
  resolveApproval(requestId: string, allow: boolean, reason?: string, always?: boolean): boolean {
    const sessionId = approvalBridge.resolveApproval(requestId, { allow, reason }, always);
    if (!sessionId) return false;
    this.notifyRequestResolved(sessionId, requestId, "approval");
    return true;
  }

  /** Update a session's permission mode mid-turn. The bridge records it and
   *  canUseTool reads the live value on every subsequent tool call, so the
   *  change takes effect immediately for approvals (the SDK's own
   *  `permissionMode` option can't be hot-swapped, but our host-side gate can). */
  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    approvalBridge.setPermissionMode(sessionId, mode);
  }

  /**
   * 网页端工具调用的闸门句柄 —— 浏览器里的扩展调 `/mcp` 时,由 `webToolHost` 来要。
   *
   * 它把**同一个** `approvalBridge` 的三个面按会话封起来:当前权限模式、「始终允许」
   * 的记录、以及"弹一张卡并等用户点"。于是网页那条通路弹的就是界面上的审批卡,权限
   * 模式与「始终允许」也**跟着 mcode 的设置走**(用户的原话:"这个决策和 mcode 的设置
   * 一样啊")。
   *
   * 事件用 `rt.ctx.emit`(而不是 `emitExternal`)是有意的:那条闭包带着**改道**与
   * **无人值守兜底**(`setInteractiveProxy` / `declineUnattended`)。网页版模型完全
   * 可能跑在工作流的节点里,那时审批该代父对话问、或者在没有人在场时按拒绝落地 ——
   * 绕开它就会挂在那儿等一个永远不会来的人。
   *
   * 会话还没跑过回合时(扩展在 mcode 重启后仍然连着,工具调用先到)现绑一次:
   * 闸门的两个状态挂在 `SessionRuntime` 那一份上,不绑就没有落点。库里查不到就是
   * 真没了 —— 给 null,让宿主去回绝(它不会在没有闸门的情况下放行)。
   */
  /**
   * 会话 id → 工作目录(agent_* 网页工具的相对路径基准,以及首轮环境块里报给网页
   * 模型的那个 cwd)。解析顺序与 `rewindTurn` 同款:先活着的运行时在第一回合里记下的
   * `lastCwd`(跟着 cd 走),回话没跑过就落到会话所属项目的路径;都没有给 null ——
   * 调用方(agent 工具 / webUpstream 的环境块)各自决定"相对路径报错"或"跳过注入"。
   */
  cwdFor(sessionId: string): string | null {
    let rt = this.sessions.get(sessionId);
    if (!rt) {
      const session = SessionRepo.get(sessionId);
      if (!session) return null;
      this.bindSession(session);
      rt = this.sessions.get(sessionId);
    }
    if (rt?.lastCwd) return rt.lastCwd;
    const project = ProjectRepo.get(SessionRepo.get(sessionId)?.projectId ?? "");
    return project?.path ?? null;
  }

  webToolGate(sessionId: string): WebToolGate | null {
    let rt = this.sessions.get(sessionId);
    if (!rt) {
      const session = SessionRepo.get(sessionId);
      if (!session) return null;
      this.bindSession(session);
      rt = this.sessions.get(sessionId);
      if (!rt) return null;
    }
    const emit = rt.ctx.emit;
    return {
      permissionMode: () => approvalBridge.getPermissionMode(sessionId),
      isAlwaysAllowed: (toolName) => approvalBridge.isAlwaysAllowed(sessionId, toolName),
      requestApproval: approvalBridge.makeApprovalHandler(sessionId, emit),
    };
  }

  /** Resolve a user-input request (AskUserQuestion answer). On success,
   *  broadcasts `request.resolved{kind:"question"}` so other clients close
   *  their copy of the question card. */
  resolveUserInput(requestId: string, answers: UserInputAnswers): boolean {
    const sessionId = approvalBridge.resolveUserInput(requestId, answers);
    if (!sessionId) return false;
    this.notifyRequestResolved(sessionId, requestId, "question");
    return true;
  }

  /** Resolve a pending AskUserQuestion Deferred as DISMISSED (user closed the
   *  question card) so the model's turn continues instead of blocking. Also
   *  broadcasts the cross-client close event. */
  dismissUserInput(requestId: string): boolean {
    const sessionId = approvalBridge.dismissUserInput(requestId);
    if (!sessionId) return false;
    this.notifyRequestResolved(sessionId, requestId, "question");
    return true;
  }

  /** Resolve a plan-approval request (ExitPlanMode approve/reject). On
   *  success, broadcasts `request.resolved{kind:"plan"}` so other clients
   *  close their copy of the plan-approval sheet. */
  resolvePlanApproval(requestId: string, decision: PlanApprovalDecision): boolean {
    const sessionId = approvalBridge.resolvePlanApproval(requestId, decision);
    if (!sessionId) return false;
    this.notifyRequestResolved(sessionId, requestId, "plan");
    return true;
  }

  /** Broadcast a pending-request resolution to every client. Public so the
   *  legacy sentinel question path (which has no Deferred to resolve) can
   *  still tell other clients to close their question cards. */
  notifyRequestResolved(
    sessionId: string,
    requestId: string,
    kind: "approval" | "question" | "plan",
  ): void {
    // 走代理:节点代父对话问的问题,关闭事件也得报到父对话去,否则那边的问题卡
    // 收不掉(节点自己那边本来就没有卡片)。
    // ⚠️ **走 `emitExternal`,不能走 `broadcastRuntimeEvent`。** 两者对界面是一回事
    // (都 `fanOutToClients` —— 别的客户端照旧收到"这张卡可以关了"),但只有
    // `emitExternal` 会 `notifySubscribers`,而钩子(`HookRunner`)与自动化的
    // 「事件发生时」触发器**正是挂在订阅上**的。
    //
    // 这里踩过:该函数早先直接调 `broadcastRuntimeEvent`,于是 `request.resolved`
    // 作为一个**在设置里列得出来、配了提示语**的钩子事件,挂上去永远不响 ——
    // 而"挂上了却不响"正是仓库规矩第 3 条要禁的那种坏东西。同款还有
    // `workflow.node.result`(见 `orchestration/runner.ts` 里那条注释)。
    //
    // 三个订阅者都不处理它(通知 / 长任务 / 调度器各自只认自己关心的那几种),
    // 所以改这一处不会顺带弹出别的东西。
    this.emitExternal({
      type: "request.resolved",
      sessionId: this.routeOf(sessionId),
      requestId,
      kind,
    });
  }
}

export const runtimeManager = new RuntimeManager();
