/**
 * Codex app-server notification → RuntimeEvent normalization engine.
 *
 * Wire facts calibrated live against codex 0.153.4 (protocol v2):
 *   - `turn/start` RESPONDS IMMEDIATELY with `{turn: {id, status:"inProgress"}}`
 *     — turn completion is notification-driven (`turn/completed` carries the
 *     final Turn with status completed|interrupted|failed).
 *   - Failures arrive as the `error` notification `{error, willRetry}` (an
 *     intermediate error with willRetry=true is followed by an internal
 *     retry — turn.done must NOT fire on it).
 *   - Item payloads are camelCase (`aggregatedOutput` / `exitCode` / …);
 *     statuses are inProgress|completed|failed(declined).
 *   - ALL item/* delta notifications carry a REQUIRED `threadId` (schema v2:
 *     AgentMessageDelta / ReasoningTextDelta / ReasoningSummaryTextDelta) —
 *     subagent threads stream their deltas over the same connection, so the
 *     delta handlers MUST route on it: main thread → chat events, subagent
 *     thread → that agent's side-panel transcript. Emitting a subagent delta
 *     as main-thread text lands it AFTER the main thread's last tool call,
 *     where the renderer's process/reply split classifies it as final reply
 *     content (the "process data shown as the answer" bug).
 *   - Reasoning streams via `item/reasoning/textDelta` +
 *     `item/reasoning/summaryTextDelta`; agent messages via
 *     `item/agentMessage/delta`. Third-party Responses gateways may ALSO
 *     inline reasoning in the message text as `<think>…</think>` tags — the
 *     main-thread agentMessage path runs every delta through the shared
 *     ThinkTagSplitter (same treatment as the claude bridge) so tagged
 *     content routes to thinking blocks instead of the literal-tag reply.
 *   - Native plan tracking (`turn/plan/updated` steps) maps onto our
 *     todo.update; PlanThreadItem is codex's todo analogue.
 *   - Token usage arrives on `thread/tokenUsage/updated`
 *     `{tokenUsage: {last, total, modelContextWindow}}` — `last` is the
 *     final request's context size (the honest occupancy read),
 *     `modelContextWindow` the model's real window when known.
 *   - Image items: `imageGeneration` {result(b64), savedPath, revisedPrompt,
 *     status, failure} renders as a synthetic tool card + inline image via
 *     `browser.image`; `imageView` {path} (view_image tool) as a path card.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ThinkTagSplitter, type ThinkSegment } from "@main/lib/thinkTagSplitter.js";
import type {
  RuntimeEvent,
  TurnDoneReason,
  ContextUsageEvent,
  SubagentSnapshot,
  TranscriptBlock,
  SubagentUpdateEvent,
} from "@contracts/runtime";
import type { ProviderContext } from "@contracts/provider";
import type { NotificationFrame } from "./CodexAppServerClient.js";
import type { CodexFileSnapshot } from "./CodexFileSnapshot.js";
import { buildCodexTokenSnapshot, type CodexUsage } from "./codexTokenUsage.js";

export class CodexMessageAdapter {
  /** Set when the user interrupts; late notifications are dropped. */
  private aborted = false;
  private turnEnded = false;
  /** Resolved when the turn reaches a terminal state (drives the provider's
   *  done promise — turn/start returns before the turn completes). */
  private turnDonePromise: Promise<TurnDoneReason> | null = null;
  private turnDoneReason: TurnDoneReason | null = null;
  private pendingThreadNotifications: NotificationFrame[] = [];
  private turnDoneResolve: ((reason: TurnDoneReason) => void) | null = null;
  /** Terminal error text for the current turn (surfaced once). */
  private lastUsage: CodexUsage | null = null;
  private modelContextWindow: number | null = null;
  /** Occupancy fallback when the server never reports modelContextWindow —
   *  the user-configured per-model context window (or undefined to use the
   *  token-snapshot's static default). */
  private readonly contextWindowFallback: number | undefined;
  /** Per-item thinking message ids (text vs summary channels). */
  private reasoningTextIds = new Map<string, string>();
  private reasoningSummaryIds = new Map<string, string>();
  /** Per-item ThinkTagSplitters for the MAIN thread's agentMessage stream —
   *  third-party Responses gateways inline `<think>…</think>` in the message
   *  text; the splitter routes tagged content to thinking blocks so the raw
   *  tags never render as reply text. Keyed by itemId. */
  private agentSplitters = new Map<string, ThinkTagSplitter>();
  /** itemId → 累计的主线程 agentMessage 文本（think 分流后的 text 段）。
   *  Map 按插入序排列，{@link getFinalTurnText} 取最后一条 —— 即最终回复；
   *  前面的条目是工具调用之间的旁白，不参与结构化输出校验。 */
  private agentTexts = new Map<string, string>();
  /** 结构化输出守卫的延迟收尾开关（见 {@link setDeferTurnDone}）。 */
  private deferTurnDone = false;
  /** turn.done 是否已真正发出（finishTurn 直发与 flushDeferredTurnDone 共用
   *  这一道闸，保证任何路径下恰好一次）。 */
  private turnDoneEmitted = false;
  /** itemId → dedicated message id for the thinking channel the splitter
   *  carved out of that agent message (thinking events need their own id;
   *  text keeps the itemId). */
  private agentThinkIds = new Map<string, string>();
  /** Main-thread itemIds that streamed at least one TEXT segment — guards the
   *  `item/completed` fallback that materializes item.text for transports
   *  that skip deltas entirely. */
  private agentTextSeen = new Set<string>();
  /** Subagent threads with a pending (throttled) transcript flush. */
  private transcriptFlushPending = new Set<string>();
  private transcriptFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Image items (imageGeneration / imageView) whose synthetic tool-use card
   *  has been emitted — item/started may be skipped for them, so the
   *  completed handler re-checks before emitting image + result. */
  private imageItemsSeen = new Set<string>();
  /** Live subagent roster (the capsule), keyed by subagent thread id. Codex
   *  has no task_started/task_updated edges — subagent status arrives via
   *  collabAgentToolCall items (spawnAgent/wait/… with per-agent agentsStates)
   *  and subAgentActivity edges (started/interacted/interrupted/completed).
   *  Each change emits a consolidated `subagent.update` (REPLACE semantics,
   *  mirroring the Claude adapter's flushSubagents). */
  private subagents = new Map<string, SubagentSnapshot>();
  /** The main thread's id (set by the provider once thread/start or
   *  thread/resume resolves). Item notifications carry threadId — anything
   *  not matching the main thread is a subagent thread's live activity and
   *  routes to the transcript path instead of the chat stream. */
  private mainThreadId: string | null = null;
  /** Latest cumulative turn diff per thread (main thread keyed by its id, or
   *  "" before the id is known). Subagent threads write in the same cwd and
   *  get their own `turn/diff/updated`; the snapshot receives the main
   *  thread's diff first, then each subagent's — never one overwriting another. */
  private turnDiffs = new Map<string, string>();
  /** Main-thread thread-cumulative usage just before this turn's first
   *  request (`total - last` of the first update) and the latest total —
   *  their difference is what THIS turn processed across all its requests. */
  private turnBaseTotal: CodexUsage | null = null;
  private latestTotal: CodexUsage | null = null;
  /** Active model ("providerId/modelId") for ContextSnapshot.model. Set by
   *  the provider at construction (the usage notification has no model). */
  private readonly modelId?: string;
  /** Per-subagent live transcripts, keyed by subagent thread id. Fed by two
   *  sources: live item notifications for the subagent's thread (primary) and
   *  a thread/read reconciliation (bootstrap fallback — fires only while the
   *  live path has produced nothing for that thread). */
  private transcripts = new Map<string, TranscriptBlock[]>();
  /** Subagent threads that produced at least one live transcript item —
   *  disables the thread/read fallback for them (live owns the data). */
  private liveTranscriptThreads = new Set<string>();
  /** Dedupes processed subagent item edges (id × started/completed). */
  private transcriptEdgesSeen = new Set<string>();

  constructor(
    private readonly ctx: ProviderContext,
    private readonly sessionId: string,
    private readonly snapshots: CodexFileSnapshot,
    contextWindowFallback?: number,
    /** Bootstrap fetcher for a subagent thread's items (thread/read). Used
     *  only while the live notification path has emitted nothing for the
     *  thread — see handleSubAgentActivity. */
    private readonly readSubagentItems?: (threadId: string) => Promise<ThreadItem[]>,
    /** Active model ("providerId/modelId"). The codex tokenUsage notification
     *  carries no model id, so the provider hands it in here — it becomes
     *  ContextSnapshot.model, which the context ring and the usage-stats
     *  per-model buckets read. Mirrors Claude/Pi, which set it from their own
     *  usage messages. */
    modelId?: string,
  ) {
    this.contextWindowFallback = contextWindowFallback;
    this.modelId = modelId;
  }

  setMainThreadId(id: string): void {
    this.mainThreadId = id;
    const pending = this.pendingThreadNotifications;
    this.pendingThreadNotifications = [];
    for (const frame of pending) this.handleNotification(frame);
  }

  /** True when a thread-scoped notification belongs to a subagent thread.
   *  Absent threadId → main (legacy frames); scoped frames wait for identity. */
  private isForeignThread(p: Record<string, unknown>): boolean {
    const threadId = typeof p.threadId === "string" ? p.threadId : null;
    return !!(threadId && this.mainThreadId && threadId !== this.mainThreadId);
  }

  /**
   * 结构化输出守卫：延迟 turn.done。设置后 finishTurn 只做清扫 + resolve
   * waitTurnDone，不再直接发 turn.done —— 提供方在轮末校验最终文本、可能追加
   * 一轮纠错（{@link beginCorrectiveTurn} 重挂轮生命周期），最后用
   * {@link flushDeferredTurnDone} 收尾。未设置时行为与原来完全一致。
   */
  setDeferTurnDone(): void {
    this.deferTurnDone = true;
  }

  /** 主线程最终回复文本（最后一条产出过 text 的 agentMessage item）。 */
  getFinalTurnText(): string {
    let text = "";
    for (const t of this.agentTexts.values()) text = t;
    return text;
  }

  /** 纠错轮前重挂轮生命周期：turn/started → turn/completed 这一套通知还会
   *  再来一轮，turnEnded / waitTurnDone 要复位才能再等一次。文本按 itemId
   *  累计，新 item 自然追加，无需清空。 */
  beginCorrectiveTurn(): void {
    // A replaced turn must not leave existing observers pending forever.
    this.turnDoneResolve?.("interrupted");
    this.turnEnded = false;
    this.turnDoneResolve = null;
    this.turnDonePromise = null;
    this.turnDoneReason = null;
  }

  /** 延迟收尾：发出 turn.done（恰好一次）。非延迟模式（普通轮）下 turn.done
   *  已由 finishTurn 直发，这里是无害的空操作。 */
  flushDeferredTurnDone(reason: TurnDoneReason): void {
    if (!this.deferTurnDone) return;
    if (this.turnDoneEmitted) return;
    this.emit({ type: "turn.done", sessionId: this.sessionId, reason });
    this.turnDoneEmitted = true;
  }

  markAborted(): void {
    this.aborted = true;
  }

  /** Resolves with the turn's end reason when the turn reaches a terminal
   *  state. Never rejects — transport failures surface through the provider's
   *  request-promise rejection instead. */
  waitTurnDone(): Promise<TurnDoneReason> {
    if (this.turnEnded) return Promise.resolve(this.turnDoneReason ?? "end_turn");
    this.turnDonePromise ??= new Promise<TurnDoneReason>((resolve) => {
      this.turnDoneResolve = resolve;
    });
    return this.turnDonePromise;
  }

  handleNotification(frame: NotificationFrame): void {
    const p = (frame.params ?? {}) as Record<string, unknown>;
    // thread/start may deliver scoped notifications before its response gives
    // the provider our thread ID. Route only after identity is established.
    if (!this.mainThreadId && typeof p.threadId === "string") {
      if (this.aborted) return;
      if (this.pendingThreadNotifications.length >= 1024) {
        this.pendingThreadNotifications = [];
        this.emit({ type: "error", sessionId: this.sessionId,
          message: "Codex 线程初始化通知超过上限,已中止本轮", code: "CODEX_TURN_FAILED" });
        this.aborted = true;
        this.finalizeError();
      } else {
        this.pendingThreadNotifications.push(frame);
      }
      return;
    }
    switch (frame.method) {
      case "item/agentMessage/delta": {
        if (this.aborted) return;
        const delta = p.delta as string | undefined;
        const itemId = p.itemId as string | undefined;
        const threadId = typeof p.threadId === "string" ? p.threadId : null;
        if (!delta || !itemId) break;
        // Delta notifications carry a REQUIRED threadId (schema v2) — a
        // subagent thread's stream must NEVER feed the main chat: landing
        // after the main thread's last tool, the renderer would classify it
        // as final-reply text. Route it to that agent's side-panel transcript.
        if (threadId && this.mainThreadId && threadId !== this.mainThreadId) {
          this.appendSubagentDelta(threadId, "text", delta);
          break;
        }
        // Main thread: split `<think>`-inlined reasoning (third-party
        // Responses gateways) before emitting.
        const splitter = this.agentSplitters.get(itemId) ?? new ThinkTagSplitter();
        this.agentSplitters.set(itemId, splitter);
        this.emitAgentSegments(itemId, splitter.push(delta));
        break;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        if (this.aborted) return;
        const delta = p.delta as string | undefined;
        const itemId = p.itemId as string | undefined;
        if (!delta || !itemId) return;
        const threadId = typeof p.threadId === "string" ? p.threadId : null;
        if (threadId && this.mainThreadId && threadId !== this.mainThreadId) {
          this.appendSubagentDelta(threadId, "thinking", delta);
          return;
        }
        const map = frame.method === "item/reasoning/textDelta" ? this.reasoningTextIds : this.reasoningSummaryIds;
        let messageId = map.get(itemId);
        if (!messageId) {
          messageId = randomUUID();
          map.set(itemId, messageId);
        }
        this.emit({ type: "thinking", sessionId: this.sessionId, messageId, text: delta });
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = p.item as ThreadItem | undefined;
        // Item notifications carry threadId: main-thread items feed the chat
        // stream; subagent-thread items feed that agent's side-panel
        // transcript. Unknown main thread (early notification) → main path.
        const threadId = typeof p.threadId === "string" ? p.threadId : null;
        if (item && threadId && this.mainThreadId && threadId !== this.mainThreadId) {
          if (!this.aborted) this.handleSubagentThreadItem(threadId, item, frame.method === "item/completed");
          break;
        }
        this.handleItem(item, frame.method === "item/completed");
        break;
      }
      case "turn/plan/updated": {
        // A subagent's plan must not replace the main agent's todo card.
        if (this.isForeignThread(p)) break;
        // Native plan steps → our todo card. status: pending|inProgress|completed.
        const steps = p.plan as Array<{ step?: string; status?: string }> | undefined;
        if (Array.isArray(steps)) {
          this.emit({
            type: "todo.update",
            sessionId: this.sessionId,
            todos: steps.map((s) => ({
              content: s.step ?? "",
              status: s.status === "completed" ? "completed" : s.status === "inProgress" ? "in_progress" : "pending",
              priority: "medium" as const,
            })),
          });
        }
        break;
      }
      case "item/plan/delta":
        // Plan text streaming — the structured turn/plan/updated carries the
        // authoritative steps; the raw text stream adds nothing to our UI.
        break;
      case "turn/diff/updated": {
        const diff = p.diff as string | undefined;
        if (typeof diff === "string") {
          const key = this.isForeignThread(p) ? (p.threadId as string) : (this.mainThreadId ?? "");
          this.turnDiffs.set(key, diff);
          const mainKey = this.mainThreadId ?? "";
          const ordered = [
            this.turnDiffs.get(mainKey) ?? "",
            ...[...this.turnDiffs].filter(([k]) => k !== mainKey).map(([, d]) => d),
          ].filter((d) => d.length > 0);
          // Each diff starts with its own `diff --git` header; keep them on
          // separate lines without injecting blank (context) lines.
          this.snapshots.setTurnDiff(ordered.map((d) => (d.endsWith("\n") ? d : `${d}\n`)).join(""));
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        // A subagent thread's usage is not the main context's occupancy and
        // must not overwrite it.
        if (this.isForeignThread(p)) break;
        const tu = p.tokenUsage as
          | {
              last?: CodexUsage & { totalTokens?: number };
              total?: CodexUsage & { totalTokens?: number };
              modelContextWindow?: number | null;
            }
          | undefined;
        if (tu?.last) this.lastUsage = tu.last;
        if (tu?.total) {
          if (!this.turnBaseTotal) this.turnBaseTotal = subtractUsage(tu.total, tu.last ?? null);
          this.latestTotal = tu.total;
        }
        if (typeof tu?.modelContextWindow === "number" && tu.modelContextWindow > 0) {
          this.modelContextWindow = tu.modelContextWindow;
        }
        // **回合中途也发一次快照。** 以前只在 turn/completed 发,而轮预算
        // (`RuntimeManager.enforceBudget` 读的是最近一次快照的 totalProcessedTokens / costUsd)
        // 因此要到回合结束才看得见用量 —— 失控的 Codex 回合永远来不及止损。
        // 这条通知是每次模型请求结束发一次(不是逐 token),频率不高。
        this.emitUsageSnapshot();
        break;
      }
      case "error": {
        // {error: {message, ...}, willRetry} — intermediate (retrying) vs
        // terminal. Terminal errors also flip turn/completed.status to
        // "failed", which drives turn.done; here we surface the message.
        // A subagent's failure is not the main turn's failure — log it only
        // (its own collab/wait items carry the status to the roster).
        if (this.isForeignThread(p)) {
          const subErr = p.error as { message?: string } | undefined;
          this.ctx.log.warn(`codex: subagent thread ${String(p.threadId)} error: ${subErr?.message ?? "unknown"}`);
          break;
        }
        const willRetry = p.willRetry === true;
        const err = p.error as { message?: string } | undefined;
        if (!willRetry && err?.message) {
          this.emit({ type: "error", sessionId: this.sessionId, message: err.message, code: "CODEX_TURN_FAILED" });
        } else {
          this.ctx.log.info(`codex: retryable turn error: ${err?.message ?? "unknown"}`);
        }
        break;
      }
      case "warning": {
        const message = p.message as string | undefined;
        if (message) this.ctx.log.warn(`codex: ${message}`);
        break;
      }
      case "turn/completed": {
        // ⚠️ Subagent threads complete their own turns on this same
        // connection. Treating one as ours ended the main turn early — the
        // provider then disposed the app-server mid-turn, killing the main
        // agent and every other subagent.
        if (this.isForeignThread(p)) break;
        const turn = p.turn as { id?: string; status?: string } | undefined;
        const status = turn?.status ?? "completed";
        this.emitUsageSnapshot();
        const reason: TurnDoneReason =
          status === "failed" ? "error" : status === "interrupted" ? "interrupted" : "end_turn";
        this.finishTurn(reason);
        break;
      }
      // thread/started, turn/started, thread/status/changed, item/* output
      // deltas (command output streams — the completed item carries the
      // aggregated output), serverRequest/resolved, model/*, account/*, …
      // are silently ignored (forward compatible).
      default:
        break;
    }
  }

  /* ── item handling ── */

  private handleItem(item: ThreadItem | undefined, completed: boolean): void {
    if (!item || this.aborted) return;
    switch (item.type) {
      case "agentMessage":
        if (completed) {
          // Flush any held-back partial `<think>` tag bytes from the splitter,
          // then finalize. No splitter and no streamed text = the transport
          // skipped deltas entirely — materialize the item's full text (via a
          // fresh splitter so tagged reasoning still routes correctly) or the
          // reply would silently render empty.
          const splitter = this.agentSplitters.get(item.id);
          if (splitter) {
            this.emitAgentSegments(item.id, splitter.flush());
            this.agentSplitters.delete(item.id);
          } else if (!this.agentTextSeen.has(item.id) && typeof item.text === "string" && item.text.length > 0) {
            const sp = new ThinkTagSplitter();
            this.emitAgentSegments(item.id, [...sp.push(item.text), ...sp.flush()]);
          }
          this.emit({ type: "message.complete", sessionId: this.sessionId, messageId: item.id });
        }
        break;
      case "reasoning":
        // Full-text fallback for transports that skip deltas; completed
        // reasoning items may carry summary[] — join as one block.
        if (completed && Array.isArray(item.summary) && item.summary.length > 0 && !this.reasoningSummaryIds.has(item.id)) {
          const messageId = randomUUID();
          this.reasoningSummaryIds.set(item.id, messageId);
          this.emit({
            type: "thinking",
            sessionId: this.sessionId,
            messageId,
            text: item.summary.filter((s) => typeof s === "string").join("\n"),
          });
        }
        break;
      case "commandExecution":
        if (!completed) {
          this.emitToolUse(item.id, "Bash", { command: item.command ?? "", ...(item.cwd ? { cwd: item.cwd } : {}) });
        } else {
          const failed = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: failed,
            content: item.aggregatedOutput ?? "",
          });
        }
        break;
      case "mcpToolCall":
        if (!completed) {
          this.emitToolUse(item.id, `mcp__${item.server ?? "unknown"}__${item.tool ?? "unknown"}`, {});
        } else {
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: item.status === "failed" || item.error != null,
            content: item.error != null
              ? stringifyResult(item.error)
              : stringifyResult(item.result),
          });
        }
        break;
      case "webSearch":
        if (!completed) {
          this.emitToolUse(item.id, "WebSearch", { query: item.query ?? "" });
        } else {
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: false,
            content: item.query ?? "",
          });
        }
        break;
      case "fileChange":
        if (!completed) {
          this.emitToolUse(item.id, "file_change", {
            changes: (item.changes ?? []).map((c) => ({ path: c.path, kind: changeKind(c.kind) })),
          });
        } else {
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: item.status === "failed" || item.status === "declined",
            content: (item.changes ?? []).map((c) => ({ path: c.path, kind: changeKind(c.kind) })),
          });
        }
        break;
      case "imageGeneration":
        this.handleImageGeneration(item, completed);
        break;
      case "imageView":
        // Model viewed a local image (codex view_image tool). Lightweight
        // card with the path only — viewed ≠ generated, and the same file
        // may already be visible elsewhere in the conversation.
        if (!completed) {
          this.imageItemsSeen.add(item.id);
          this.emitToolUse(item.id, "view_image", { path: item.path ?? "" });
        } else {
          this.ensureImageCard(item.id, "view_image", { path: item.path ?? "" });
          this.emit({
            type: "tool.result",
            sessionId: this.sessionId,
            toolCallId: item.id,
            isError: false,
            content: item.path ?? "",
          });
        }
        break;
      case "dynamicToolCall":
        // Mcode's host-side tools (ask_user_question / plan / browser_*).
        // Rendered as a regular tool card so dynamic tool usage is visible
        // and auditable like Claude/Pi tool calls — and so the inline-image
        // path has a card to attach to (browser_screenshot's browser.image
        // event is keyed by callId; the card from item/started covers the
        // item.id spelling, the store dedupes when both coincide).
        if (!completed) {
          this.emitToolUse(item.id, item.tool ?? "dynamic_tool", item.arguments ?? {});
        } else {
          this.emitDynamicToolResult(item);
        }
        break;
      case "collabAgentToolCall":
        this.handleCollabToolCall(item, completed);
        break;
      case "subAgentActivity":
        this.handleSubAgentActivity(item);
        break;
      case "plan":
        if (completed && typeof item.text === "string" && item.text.trim()) {
          // PlanThreadItem fallback when turn/plan/updated never fired.
          this.emit({
            type: "todo.update",
            sessionId: this.sessionId,
            todos: parsePlanTextTodos(item.text),
          });
        }
        break;
      case "error":
        this.emit({
          type: "error",
          sessionId: this.sessionId,
          message: (item as { message?: string }).message ?? "codex item error",
          code: "CODEX_ITEM_ERROR",
        });
        break;
      // userMessage (input echo), sleep, review markers, context_compaction
      // — ignored.
      default:
        break;
    }
  }

  /** Codex-native image generation (schema-calibrated 0.153.4): item shape is
   *  {result: string, status, revisedPrompt?, savedPath?, failure?}. The
   *  generated image is attached inline via the shared `browser.image` path
   *  (store splices it right after the synthetic tool-use card); the card's
   *  result text carries the revised prompt / failure. Reads are synchronous
   *  to keep emission order intact inside the notification pump. */
  private handleImageGeneration(
    item: Extract<ThreadItem, { type: "imageGeneration" }>,
    completed: boolean,
  ): void {
    if (!completed) {
      this.imageItemsSeen.add(item.id);
      this.emitToolUse(item.id, "image_generation", item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {});
      return;
    }
    this.ensureImageCard(item.id, "image_generation", item.revisedPrompt ? { revisedPrompt: item.revisedPrompt } : {});
    const failure = item.failure;
    if (failure) {
      this.emit({
        type: "tool.result",
        sessionId: this.sessionId,
        toolCallId: item.id,
        isError: true,
        content:
          failure.type === "usageLimitExceeded"
            ? `图片生成用量超限(额度 ${failure.limitId ?? "未知"})`
            : `图片生成失败(${failure.type ?? item.status ?? "未知"})`,
      });
      return;
    }
    const img = resolveGeneratedImage(item);
    if (img) {
      this.emit({
        type: "browser.image",
        sessionId: this.sessionId,
        toolCallId: item.id,
        data: img.data,
        mimeType: img.mimeType,
      });
    }
    this.emit({
      type: "tool.result",
      sessionId: this.sessionId,
      toolCallId: item.id,
      isError: !img,
      content:
        item.revisedPrompt ??
        (img ? item.status ?? "" : typeof item.result === "string" && item.result.length <= 200 ? item.result : item.status ?? ""),
    });
  }

  /** Emit the synthetic tool-use card for an image item if `item/started`
   *  never carried it (the card must exist before image/result can attach). */
  private ensureImageCard(id: string, toolName: string, input: unknown): void {
    if (this.imageItemsSeen.has(id)) return;
    this.imageItemsSeen.add(id);
    this.emitToolUse(id, toolName, input);
  }

  /** dynamicToolCall completed → tool.result. Text contentItems join into
   *  the result text; inputImage contentItems (e.g. browser_screenshot's
   *  round-tripped image) emit as `browser.image` keyed by the item id so
   *  the store splices them inline under this card. */
  private emitDynamicToolResult(
    item: Extract<ThreadItem, { type: "dynamicToolCall" }>,
  ): void {
    const items = Array.isArray(item.contentItems) ? item.contentItems : [];
    const texts: string[] = [];
    for (const ci of items) {
      const obj = (ci ?? {}) as { type?: string; text?: unknown; imageUrl?: unknown };
      if (obj.type === "inputImage" && typeof obj.imageUrl === "string") {
        const img = parseDataUrlImage(obj.imageUrl);
        if (img) {
          this.emit({
            type: "browser.image",
            sessionId: this.sessionId,
            toolCallId: item.id,
            data: img.data,
            mimeType: img.mimeType,
          });
        }
      } else if (typeof obj.text === "string") {
        texts.push(obj.text);
      }
    }
    this.emit({
      type: "tool.result",
      sessionId: this.sessionId,
      toolCallId: item.id,
      isError: item.success === false || item.status === "failed",
      content: texts.join("\n"),
    });
  }

  private emitToolUse(toolCallId: string, toolName: string, input: unknown): void {
    this.emit({
      type: "tool.use",
      sessionId: this.sessionId,
      toolCallId,
      toolName,
      input,
      requiresApproval: false,
    });
  }

  /** Emit one batch of ThinkTagSplitter output for a MAIN-thread agent
   *  message: text segments → text.delta under the item id, thinking segments
   *  → a thinking event under a per-item dedicated id. */
  private emitAgentSegments(itemId: string, segs: ThinkSegment[]): void {
    for (const seg of segs) {
      if (seg.kind === "thinking") {
        let messageId = this.agentThinkIds.get(itemId);
        if (!messageId) {
          messageId = randomUUID();
          this.agentThinkIds.set(itemId, messageId);
        }
        this.emit({ type: "thinking", sessionId: this.sessionId, messageId, text: seg.text });
      } else {
        this.agentTextSeen.add(itemId);
        // 结构化输出守卫要读最终回复 —— 按 itemId 累计，getFinalTurnText
        // 取最后一条。
        this.agentTexts.set(itemId, (this.agentTexts.get(itemId) ?? "") + seg.text);
        this.emit({ type: "text.delta", sessionId: this.sessionId, messageId: itemId, text: seg.text });
      }
    }
  }

  /* ── subagent roster (the top-right capsule) ──
   *  Codex's collab model: the main agent invokes collab tools (spawnAgent /
   *  sendInput / wait / closeAgent / …) which appear as collabAgentToolCall
   *  items; per-agent status lives in agentsStates keyed by thread id.
   *  subAgentActivity items are independent lifecycle edges (also fired for
   *  system-internal subagents like review/compact). Roster rule: statuses
   *  only UPGRADE running → terminal (completed/failed/killed) — a later
   *  item/started carrying a stale agentsStates must not resurrect a
   *  finished agent. */

  private handleCollabToolCall(
    item: Extract<ThreadItem, { type: "collabAgentToolCall" }>,
    completed: boolean,
  ): void {
    const toolName = item.tool ?? "collab_agent";
    const input = {
      ...(item.prompt ? { prompt: item.prompt } : {}),
      ...(item.receiverThreadIds?.length ? { agents: item.receiverThreadIds } : {}),
    };
    // The chat card: a collab tool call is a main-agent tool invocation (the
    // Task-tool analogue) — without it spawning a subagent is invisible in
    // the conversation.
    if (!completed) {
      this.emitToolUse(item.id, toolName, input);
    } else {
      this.emit({
        type: "tool.result",
        sessionId: this.sessionId,
        toolCallId: item.id,
        isError: item.status === "failed" || item.status === "interrupted",
        content: collabResultText(item),
      });
    }
    // Roster: every receiver thread is a subagent (collab tools only target
    // subagents). spawnAgent's receivers are freshly spawned; other tools
    // touch existing agents — synthesize an entry if we never saw the spawn.
    let changed = false;
    for (const tid of item.receiverThreadIds ?? []) {
      const existing = this.subagents.get(tid);
      if (existing) {
        // Backfill the tool-use correlation id on entries synthesized from
        // activity edges before the collab call was seen — the side-panel
        // transcript is keyed by it; without it the row has no data source.
        if (!existing.toolUseId) {
          this.subagents.set(tid, { ...existing, toolUseId: item.id });
          changed = true;
        }
        continue;
      }
      this.subagents.set(tid, {
        taskId: tid,
        toolUseId: item.id,
        description: truncateDesc(item.prompt ?? toolName),
        status: "running",
      });
      changed = true;
    }
    changed = this.applyAgentStates(item.agentsStates ?? undefined, item.prompt ?? toolName) || changed;
    if (changed) this.flushSubagents();
  }

  private handleSubAgentActivity(
    item: Extract<ThreadItem, { type: "subAgentActivity" }>,
  ): void {
    const tid = item.agentThreadId ?? item.id;
    const kind = item.kind ?? "started";
    let changed = false;
    const cur = this.subagents.get(tid);
    if (kind === "started" || kind === "interacted") {
      if (!cur) {
        this.subagents.set(tid, {
          taskId: tid,
          description: truncateDesc(item.agentPath ?? "subagent"),
          status: "running",
        });
        changed = true;
      } else if (cur.status === "running" && kind === "interacted" && item.agentPath && cur.description !== item.agentPath) {
        // Refresh the description with the (richer) agent path when idle.
        this.subagents.set(tid, { ...cur, description: truncateDesc(item.agentPath) });
        changed = true;
      }
      // Transcript bootstrap: while the live item-notification path has
      // produced nothing for this thread, pull its items via thread/read on
      // each activity edge (best-effort). Once live items flow, the live path
      // owns the transcript and the fallback stands down.
      if (cur?.toolUseId || this.subagents.get(tid)?.toolUseId) {
        if (!this.liveTranscriptThreads.has(tid)) this.rebuildTranscriptFromRead(tid);
      }
    } else if (cur) {
      // interrupted | completed — terminal edges.
      const status: SubagentSnapshot["status"] = kind === "interrupted" ? "killed" : "completed";
      if (cur.status === "running") {
        this.subagents.set(tid, { ...cur, status, endedAt: Date.now() });
        changed = true;
      }
    }
    if (changed) this.flushSubagents();
  }

  /* ── subagent transcripts (the side-panel viewer) ── */

  /** A live item notification belonging to a subagent thread (threadId !=
   *  main thread). Appends/updates the transcript blocks and re-emits the
   *  consolidated `subagent.transcript` (REPLACE semantics, keyed by the
   *  roster entry's toolUseId — the renderer's lookup key). Only agents with
   *  a toolUseId get transcripts: without one the side panel has no row to
   *  attach the data to. */
  private handleSubagentThreadItem(threadId: string, item: ThreadItem, completed: boolean): void {
    const roster = this.subagents.get(threadId);
    if (!roster?.toolUseId) return;
    const edgeKey = `${threadId}:${item.id}:${completed ? "c" : "s"}`;
    if (this.transcriptEdgesSeen.has(edgeKey)) return;
    this.transcriptEdgesSeen.add(edgeKey);
    const blocks = this.transcripts.get(threadId) ?? [];
    const next = appendSubagentBlock(blocks, item, completed);
    if (next === blocks) return;
    this.liveTranscriptThreads.add(threadId);
    this.transcripts.set(threadId, next);
    this.flushSubagentTranscript(threadId);
  }

  /** Live delta for a SUBAGENT thread's agentMessage / reasoning stream.
   *  Appends into the transcript's last same-kind block (the side panel is
   *  message-level, not per-token) and marks the live path as owning the
   *  thread (disables the thread/read bootstrap). Flushes are throttled —
   *  deltas arrive at token frequency, and each flush re-emits the whole
   *  transcript (REPLACE semantics) through IPC. Threads without a roster
   *  entry carrying a toolUseId are dropped: the side panel has no row for
   *  them, and leaking their text into the main chat is exactly the bug this
   *  routing exists to prevent. */
  private appendSubagentDelta(threadId: string, kind: "text" | "thinking", delta: string): void {
    const roster = this.subagents.get(threadId);
    if (!roster?.toolUseId) return;
    const blocks = [...(this.transcripts.get(threadId) ?? [])];
    const last = blocks[blocks.length - 1];
    if (last && "text" in last && last.kind === kind) {
      blocks[blocks.length - 1] = { kind, text: last.text + delta };
    } else {
      blocks.push({ kind, text: delta });
    }
    this.liveTranscriptThreads.add(threadId);
    this.transcripts.set(threadId, blocks);
    this.queueSubagentTranscriptFlush(threadId);
  }

  /** Coalesce subagent-delta transcript flushes to one per ~120ms per pump —
   *  a single shared trailing timer covers all dirty threads. Drained
   *  synchronously in finishTurn so the last partial block lands before
   *  turn.done. */
  private queueSubagentTranscriptFlush(threadId: string): void {
    this.transcriptFlushPending.add(threadId);
    if (this.transcriptFlushTimer !== null) return;
    this.transcriptFlushTimer = setTimeout(() => {
      this.transcriptFlushTimer = null;
      const ids = [...this.transcriptFlushPending];
      this.transcriptFlushPending.clear();
      for (const id of ids) this.flushSubagentTranscript(id);
    }, 120);
  }

  /** thread/read bootstrap: fetch the subagent thread's items and rebuild the
   *  transcript from rollout history. Fire-and-forget; silently stands down
   *  when the live path has already produced data or the turn is over. */  private rebuildTranscriptFromRead(threadId: string): void {
    const fetch = this.readSubagentItems;
    if (!fetch) return;
    void fetch(threadId)
      .then((items) => {
        if (this.aborted || this.turnEnded) return;
        if (this.liveTranscriptThreads.has(threadId)) return;
        if (!Array.isArray(items) || items.length === 0) return;
        let blocks: TranscriptBlock[] = [];
        for (const it of items) blocks = appendSubagentBlock(blocks, it, true);
        if (blocks.length === 0 || blocks === this.transcripts.get(threadId)) return;
        this.transcripts.set(threadId, blocks);
        this.flushSubagentTranscript(threadId);
      })
      .catch(() => {
        /* thread/read unavailable for this thread — live path may still feed */
      });
  }

  private flushSubagentTranscript(threadId: string): void {
    const roster = this.subagents.get(threadId);
    const blocks = this.transcripts.get(threadId);
    if (!roster?.toolUseId || !blocks || blocks.length === 0) return;
    this.emit({
      type: "subagent.transcript",
      sessionId: this.sessionId,
      parentToolUseId: roster.toolUseId,
      blocks,
    });
  }

  /** Apply a collabAgentToolCall's agentsStates map to the roster. Returns
   *  whether anything changed. Never downgrades a terminal status back to
   *  running. */
  private applyAgentStates(
    states: Record<string, { status?: string; message?: string | null }> | undefined,
    fallbackDesc: string,
  ): boolean {
    if (!states) return false;
    let changed = false;
    for (const [tid, st] of Object.entries(states)) {
      const status = mapCollabStatus(st?.status);
      const cur = this.subagents.get(tid);
      if (!cur) {
        if (st?.status === "pendingInit" || st?.status === "running") {
          this.subagents.set(tid, {
            taskId: tid,
            description: truncateDesc(st.message ?? fallbackDesc),
            status: "running",
            summary: st.message ?? undefined,
          });
          changed = true;
        }
        // A state map mentioning an agent we never saw at a terminal status —
        // skip; the subAgentActivity edges will introduce it if relevant.
        continue;
      }
      if (cur.status !== "running") continue; // terminal is sticky
      if (status !== "running") {
        this.subagents.set(tid, {
          ...cur,
          status,
          endedAt: Date.now(),
          summary: st?.message ?? cur.summary,
        });
        changed = true;
      } else if (st?.message && st.message !== cur.summary) {
        this.subagents.set(tid, { ...cur, summary: st.message });
        changed = true;
      }
    }
    return changed;
  }

  /** Emit the current subagent roster as a single `subagent.update` event
   *  (REPLACE semantics — same contract as the Claude adapter). */
  private flushSubagents(): void {
    this.emit({
      type: "subagent.update",
      sessionId: this.sessionId,
      agents: Array.from(this.subagents.values()),
    } satisfies SubagentUpdateEvent);
  }

  /** Turn end: nothing may stay "running" — a stale running entry keeps the
   *  composer's busy gate locked (sessionStore counts running subagents as
   *  work in progress). The per-turn app-server dies with the turn, so any
   *  agent still marked running is gone: completed on a normal end, killed on
   *  abort. Mirrors the Claude adapter's stream-end sweep. */
  private closeRunningSubagents(): void {
    let changed = false;
    for (const [id, s] of this.subagents) {
      if (s.status === "running") {
        this.subagents.set(id, {
          ...s,
          status: this.aborted ? "killed" : "completed",
          endedAt: s.endedAt ?? Date.now(),
        });
        changed = true;
      }
    }
    if (changed) this.flushSubagents();
  }

  /* ── turn lifecycle ── */

  private finishTurn(reason: TurnDoneReason): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    this.turnDoneReason = reason;
    // Drain any throttled subagent-delta flushes NOW — the last partial block
    // must land before turn.done freezes the turn's view.
    if (this.transcriptFlushTimer !== null) {
      clearTimeout(this.transcriptFlushTimer);
      this.transcriptFlushTimer = null;
    }
    const pendingFlush = [...this.transcriptFlushPending];
    this.transcriptFlushPending.clear();
    for (const id of pendingFlush) this.flushSubagentTranscript(id);
    // Roster sweep BEFORE turn.done — the renderer's busy gate reads running
    // subagents when processing the turn end.
    this.closeRunningSubagents();
    // 结构化输出守卫（deferTurnDone）模式下 turn.done 由提供方在轮末校验后经
    // flushDeferredTurnDone 发出；普通模式维持原行为直发。
    if (!this.deferTurnDone) {
      if (!this.turnDoneEmitted) {
        this.emit({ type: "turn.done", sessionId: this.sessionId, reason });
        this.turnDoneEmitted = true;
      }
    }
    this.turnDoneResolve?.(reason);
    this.turnDoneResolve = null;
  }

  /** Transport-level abort finalization (process died / user interrupted
   *  before turn/completed). Emits turn.done exactly once. */
  finalizeAborted(): void {
    this.finishTurn("interrupted");
  }

  finalizeError(): void {
    this.finishTurn("error");
  }

  /** End-of-turn finalization (the Claude/Pi flushFinal analogue): freeze
   *  the diff-fed file snapshot and emit `turn.files`. Called by the
   *  provider on success, abort, AND error — writes that already landed
   *  must always surface on the card. */
  async flushFinal(): Promise<void> {
    const files = await this.snapshots.freeze();
    if (files.length > 0) {
      this.emit({ type: "turn.files", sessionId: this.sessionId, files });
    }
  }

  get hasTurnEnded(): boolean {
    return this.turnEnded;
  }

  private emitUsageSnapshot(): void {
    const turnUsage =
      this.turnBaseTotal && this.latestTotal ? subtractUsage(this.latestTotal, this.turnBaseTotal) : null;
    const snapshot = buildCodexTokenSnapshot(
      this.lastUsage,
      this.modelContextWindow ?? this.contextWindowFallback,
      turnUsage,
      this.modelId,
    );
    if (!snapshot) return;
    this.emit({ type: "token-usage.updated", sessionId: this.sessionId, snapshot });
  }

  private emit(e: RuntimeEvent): void {
    this.ctx.emit(e);
  }
}

/** Field-wise `a - b` of two usage counters, clamped at 0 (b null → a). */
function subtractUsage(a: CodexUsage, b: CodexUsage | null): CodexUsage {
  const d = (x: number | undefined, y: number | undefined): number => Math.max(0, (x ?? 0) - (y ?? 0));
  return {
    inputTokens: d(a.inputTokens, b?.inputTokens),
    cachedInputTokens: d(a.cachedInputTokens, b?.cachedInputTokens),
    outputTokens: d(a.outputTokens, b?.outputTokens),
    reasoningOutputTokens: d(a.reasoningOutputTokens, b?.reasoningOutputTokens),
  };
}

/** "Plan text" (markdown checkbox lines) → todo rows (PlanThreadItem path). */
function parsePlanTextTodos(text: string): Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority: "medium" }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s*\[.\]/.test(l) || /^[-*]\s/.test(l))
    .map((l) => {
      const checked = /\[x\]/i.test(l);
      const content = l.replace(/^[-*]\s*\[.\]\s*/, "").replace(/^[-*]\s*/, "");
      return { content, status: checked ? ("completed" as const) : ("pending" as const), priority: "medium" as const };
    });
}

/** MCP tool result/error → display text. Objects/arrays stringify COMPACTLY
 *  (a raw `String()` would render "[object Object]"; pretty-printed JSON
 *  mostly wasted the card preview's truncation budget on indentation);
 *  strings and primitives pass through; null/undefined collapse to "". */
function stringifyResult(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** PatchChangeKind tagged-union → simple string for the card input. */
function changeKind(kind: unknown): string {
  if (kind && typeof kind === "object") {
    const t = (kind as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return typeof kind === "string" ? kind : "update";
}

const IMAGE_MIME_BY_EXT: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** data URL (data:image/png;base64,...) → inline image payload, or null when
 *  the URL isn't a base64 image data URL we can render. */
function parseDataUrlImage(
  url: string,
): { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" } | null {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url.trim());
  if (!m) return null;
  return { mimeType: `image/${m[1]}` as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: m[2].replace(/[\r\n]/g, "") };
}

/** Result strings below this length are treated as status text, not image
 *  data — real base64 payloads are kilobytes at minimum. */
const BASE64_MIN_LENGTH = 1024;

/** Roster descriptions are one-liners — keep prompts/paths from bloat. */
const SUBAGENT_DESC_MAX = 120;

function truncateDesc(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > SUBAGENT_DESC_MAX ? t.slice(0, SUBAGENT_DESC_MAX) + "…" : t;
}

/** CollabAgentStatus → SubagentSnapshot.status. shutdown = closed cleanly by
 *  closeAgent (a normal end); notFound = the agent vanished (failure). */
function mapCollabStatus(s: string | undefined): SubagentSnapshot["status"] {
  switch (s) {
    case "completed":
    case "shutdown":
      return "completed";
    case "errored":
    case "notFound":
      return "failed";
    case "interrupted":
      return "killed";
    default: // pendingInit / running / undefined
      return "running";
  }
}

/** collabAgentToolCall completed → card result text: per-agent outcome lines,
 *  falling back to the call status when the map is empty. */
function collabResultText(item: Extract<ThreadItem, { type: "collabAgentToolCall" }>): string {
  const states = item.agentsStates ?? {};
  const lines = Object.entries(states).map(([tid, st]) => {
    const short = tid.length > 12 ? tid.slice(0, 12) + "…" : tid;
    const msg = st?.message ? ` — ${truncateDesc(st.message)}` : "";
    return `${short}: ${st?.status ?? "unknown"}${msg}`;
  });
  if (lines.length > 0) return lines.join("\n");
  return item.status ?? "completed";
}

/** One subagent thread item → transcript blocks (message-level granularity —
 *  the viewer is a read-only "check what it's doing" surface, not a live
 *  editor). Returns the SAME array reference when nothing changed so callers
 *  can skip flushes. `completed=true` folds rollout-fetched items (start
 *  edges never appear in history; tool calls land done/error directly). */
function appendSubagentBlock(blocks: TranscriptBlock[], item: ThreadItem, completed: boolean): TranscriptBlock[] {
  switch (item.type) {
    case "agentMessage": {
      if (!completed || !item.text?.trim()) return blocks;
      // Identical-text guard: a thread/read rebuild followed by a live
      // completed delivery of the same message must not duplicate it.
      if (blocks.some((b) => b.kind === "text" && b.text === item.text)) return blocks;
      return [...blocks, { kind: "text", text: item.text }];
    }
    case "reasoning": {
      if (!completed || !Array.isArray(item.summary) || item.summary.length === 0) return blocks;
      const text = item.summary.filter((s) => typeof s === "string").join("\n");
      if (!text.trim() || blocks.some((b) => b.kind === "thinking" && b.text === text)) return blocks;
      return [...blocks, { kind: "thinking", text }];
    }
    case "commandExecution":
    case "mcpToolCall": {
      const idx = blocks.findIndex((b) => b.kind === "tool_use" && b.toolCallId === item.id);
      const failed =
        item.status === "failed" ||
        (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0);
      const status: "running" | "done" | "error" = completed ? (failed ? "error" : "done") : "running";
      if (idx < 0) {
        // Rollout-folded items have no prior started edge — append at their
        // final status directly.
        const toolName =
          item.type === "commandExecution" ? "Bash" : `mcp__${item.server ?? "unknown"}__${item.tool ?? "unknown"}`;
        const input = item.type === "commandExecution" ? { command: item.command ?? "" } : {};
        return [...blocks, { kind: "tool_use", toolCallId: item.id, toolName, input, status }];
      }
      const cur = blocks[idx];
      if (cur.kind !== "tool_use" || cur.status === status) return blocks;
      const next = [...blocks];
      next[idx] = { ...cur, status };
      return next;
    }
    default:
      return blocks;
  }
}

/** imageGeneration item → inline image (base64 + mime). Prefers savedPath
 *  (exact bytes + true mime); falls back to the `result` string when it
 *  looks like base64 image data. Returns null when neither yields an image
 *  (the card then surfaces the status text as a failed result). */
function resolveGeneratedImage(
  item: Extract<ThreadItem, { type: "imageGeneration" }>,
): { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" } | null {
  if (item.savedPath) {
    try {
      const data = readFileSync(item.savedPath);
      const ext = item.savedPath.slice(item.savedPath.lastIndexOf(".")).toLowerCase();
      return { data: data.toString("base64"), mimeType: IMAGE_MIME_BY_EXT[ext] ?? "image/png" };
    } catch {
      // savedPath unreadable (deleted between generation and display) —
      // fall through to the result-string heuristic.
    }
  }
  const result = item.result;
  if (typeof result === "string" && result.length >= BASE64_MIN_LENGTH && /^[A-Za-z0-9+/=\r\n]+$/.test(result)) {
    return { data: result.replace(/[\r\n]/g, ""), mimeType: "image/png" };
  }
  return null;
}

/* ── app-server payload shapes (calibrated against 0.153.4 live + schema) ── */

export type ThreadItem =
  | { type: "agentMessage"; id: string; text?: string }
  | { type: "reasoning"; id: string; content?: unknown[]; summary?: unknown[] }
  | { type: "commandExecution"; id: string; command?: string; aggregatedOutput?: string | null; exitCode?: number | null; status?: string; cwd?: string | null }
  | { type: "fileChange"; id: string; changes?: Array<{ path: string; kind?: unknown; diff?: string }>; status?: string }
  | { type: "mcpToolCall"; id: string; server?: string; tool?: string; result?: unknown; error?: unknown; status?: string }
  | { type: "webSearch"; id: string; query?: string }
  | { type: "plan"; id: string; text?: string }
  | { type: "userMessage"; id: string }
  | { type: "error"; id: string; message?: string }
  | {
      type: "dynamicToolCall";
      id: string;
      tool?: string;
      namespace?: string | null;
      status?: string;
      success?: boolean | null;
      arguments?: unknown;
      /** Response contentItems echoed back by the server — inputText for
       *  text results, inputImage (data URL) for e.g. browser_screenshot. */
      contentItems?: Array<{ type?: string; text?: unknown; imageUrl?: unknown } | unknown> | null;
    }
  | {
      type: "imageGeneration";
      id: string;
      /** Base64 image data per the schema — used as fallback when savedPath
       *  is absent (OpenAI image_generation_call carries b64 here). */
      result?: string;
      status?: string;
      revisedPrompt?: string | null;
      savedPath?: string | null;
      failure?: { type?: string; limitId?: string; resetsAt?: number | null } | null;
    }
  | { type: "imageView"; id: string; path?: string }
  | {
      type: "collabAgentToolCall";
      id: string;
      /** spawnAgent | sendInput | wait | closeAgent | … (CollabAgentTool). */
      tool?: string;
      status?: string;
      senderThreadId?: string;
      /** Receiving subagent thread ids — on spawnAgent these are the newly
       *  spawned agents. */
      receiverThreadIds?: string[];
      prompt?: string | null;
      model?: string | null;
      /** Last-known per-agent status, keyed by thread id (CollabAgentState). */
      agentsStates?: Record<string, { status?: string; message?: string | null }> | null;
    }
  | {
      type: "subAgentActivity";
      id: string;
      agentPath?: string;
      agentThreadId?: string;
      /** started | interacted | interrupted | completed (SubAgentActivityKind). */
      kind?: string;
    };

export const newCodexRequestId = randomUUID;
