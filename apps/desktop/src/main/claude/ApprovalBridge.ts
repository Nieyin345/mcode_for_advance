/**
 * Async bridge for tool-approval and user-input requests crossing the main↔renderer
 * boundary. The provider calls `requestApproval` / `requestUserInput` on
 * ProviderContext; those methods store a pending promise and emit an event to the
 * renderer. When the user responds (via the "claude:approve" IPC handler or
 * implicitly via sending an answer as the next user message), the promise resolves
 * and the provider continues.
 */
import type { RuntimeEvent, AskUserQuestionItem, PermissionMode } from "@contracts/runtime";
import { APP_DANGER_APPROVAL_PREFIX } from "@contracts/appControl";
import { insertApproval, type ApprovalOutcome, type ApprovalKind } from "@main/store/approvalSchema.js";
import { log } from "@main/lib/logger.js";
import type {
  ApprovalRequest,
  ProviderApprovalDecision,
  UserInputRequest,
  UserInputDecision,
  UserInputAnswers,
  PlanApprovalRequest,
  PlanApprovalDecision,
} from "@contracts/provider";

interface PendingApproval {
  resolve: (v: ProviderApprovalDecision) => void;
  reject: (e: Error) => void;
  /** Session the approval belongs to — needed so resolveApproval can
   *  record an "always allow" against the right session's tool set. */
  sessionId: string;
  /** Tool name being approved — recorded into alwaysAllowedTools when the
   *  user grants with `always: true`. */
  toolName: string;
  /**
   * 【T109】审批卡上给用户看的第二行说明。
   *
   * **原来这里只有 toolName** —— `req.description` 只用于 emit 事件，结算时拿不到。
   * 而审批历史要回答「上次那个操作我批了没」，光有工具名（`document_view`）不够，
   * 用户记不住那一次是「打开报告.pdf」还是「导出成 docx」。
   *
   * 所以结算时要能拿到它 → **`makeApprovalHandler` 里多存一个字段**。
   * 这是 T109 卡没写的第二个改动点（第一个是写入调用）。
   */
  subject: string;
}

interface PendingUserInput {
  resolve: (v: UserInputDecision) => void;
  reject: (e: Error) => void;
  /** Session the request belongs to — returned by resolve/dismiss so the
   *  caller can broadcast the cross-client `request.resolved` sync event. */
  sessionId: string;
  /** 【T109】第一个问题的文字（截断）—— 历史里「他回答了什么问题」。 */
  subject: string;
}

interface PendingPlanApproval {
  resolve: (v: PlanApprovalDecision) => void;
  reject: (e: Error) => void;
  /** Session the request belongs to — see PendingUserInput. */
  sessionId: string;
  /** 【T109】计划的第一行（截断）—— 历史里「他批准了哪个计划」。 */
  subject: string;
}

/**
 * 【T109】`subject` 的长度上限。
 *
 * 240 字足够认出一条工具调用/问题/计划是什么，又不会让一条记录把列表撑爆。
 * 截断而不是拒绝：历史是附属品，**一条过长的说明不该让这次审批失败**。
 */
const SUBJECT_MAX = 240;
function clipSubject(s: string): string {
  const t = s.trim();
  return t.length <= SUBJECT_MAX ? t : `${t.slice(0, SUBJECT_MAX - 1)}…`;
}

/** 计划可能很长，历史里只要第一行非空文本。 */
function firstLineOf(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return "";
}

export class ApprovalBridge {
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingUserInputs = new Map<string, PendingUserInput>();
  private pendingPlanApprovals = new Map<string, PendingPlanApproval>();
  /** Per-session set of tool names the user granted with "always allow".
   *  canUseTool checks this BEFORE asking the renderer, so a tool approved
   *  once-with-always doesn't prompt again in the same session. Cleared on
   *  dispose. */
  private alwaysAllowedTools = new Map<string, Set<string>>();
  /** Per-session current permission mode. canUseTool reads this on EVERY
   *  tool call so a mode change mid-turn (e.g. user flips to
   *  acceptEdits while a turn is running) takes effect immediately for
   *  subsequent tools — the SDK's own `permissionMode` option is fixed at
   *  query() start and can't be hot-swapped, but our host-side gate can. */
  private permissionModes = new Map<string, PermissionMode>();

  /**
   * 【T109】写一条审批历史。**失败只记日志，绝不向上抛。**
   *
   * 审批是**用户的动作**，历史是**附属品**：一个写不进去的历史不该让用户点不动
   * 按钮、也不该让模型卡在等一个永远不会来的答复上。
   *
   * ## 为什么吞在这里而不是每个调用点各写一个 try
   *
   * 五个出口各写一个 try/catch 迟早会漏一个（这个仓库栽过很多次「共享实现只有一份」
   * 的反面）。**一个私有方法 = 一处纪律。**
   *
   * ⚠️ 但「吞掉」不等于「静默」：失败会 `log.warn` 带上 requestId 与原因，
   * 而且套件里有一条断言专门验「写库抛错时 resolveApproval 仍返回 sessionId」。
   */
  private recordApproval(args: {
    id: string;
    sessionId: string;
    kind: ApprovalKind;
    subject: string;
    decision: ApprovalOutcome;
    always?: boolean;
    detail?: string | null;
  }): void {
    try {
      insertApproval({
        id: args.id,
        sessionId: args.sessionId,
        kind: args.kind,
        subject: args.subject,
        decision: args.decision,
        always: args.always === true,
        decidedAt: Date.now(),
        detail: args.detail ?? null,
      });
    } catch (err) {
      // 附上 requestId 才可能事后把「哪一次没记上」和用户看到的操作对上。
      log.warn(
        `approval history write failed (requestId=${args.id}, kind=${args.kind}, ` +
        `decision=${args.decision}): ${(err as Error).message}`,
      );
    }
  }

  /* ── approval ── */

  /** Create an approval-request handler bound to a specific session's emit. */
  makeApprovalHandler(
    sessionId: string,
    emit: (e: RuntimeEvent) => void,
  ): (req: ApprovalRequest) => Promise<ProviderApprovalDecision> {
    return (req) =>
      new Promise<ProviderApprovalDecision>((resolve, reject) => {
        this.pendingApprovals.set(req.requestId, {
          resolve, reject, sessionId, toolName: req.toolName,
          // 【T109】存下审批卡上的说明，结算时才有「这次批的是什么」可记。
          // `description` 是可选的 —— 没有时就空串，结算处会回落到 toolName。
          subject: clipSubject(req.description ?? ""),
        });
        emit({
          type: "approval.request",
          sessionId,
          requestId: req.requestId,
          toolCallId: req.requestId, // reuse requestId as toolCallId for tracking
          toolName: req.toolName,
          input: req.input,
          description: req.description,
        });
      });
  }

  /** Resolve an approval request (called by ipc/claude.ts CLAUDE_APPROVE handler).
   *  When the user granted with `always: true`, the tool name is recorded in
   *  the session's always-allowed set so subsequent calls skip the prompt.
   *  Returns the owning session's id on success, null when no such request is
   *  pending (already resolved by another client). */
  resolveApproval(requestId: string, decision: ProviderApprovalDecision, always?: boolean): string | null {
    const p = this.pendingApprovals.get(requestId);
    if (!p) return null;
    // mcode-app 的高风险操作**每次都得本人点** —— 就算客户端硬传了 always 也不认、不记。
    const remember = always === true && !p.toolName.startsWith(APP_DANGER_APPROVAL_PREFIX);
    // Surface the "always allow" intent on the decision itself so providers
    // with a server-side session grant (codex acceptForSession) can scope
    // their grant accordingly (one-shot "accept" vs session-wide).
    p.resolve(decision.allow && remember ? { ...decision, persist: true } : decision);
    this.pendingApprovals.delete(requestId);
    // 【T109】出口 1/5：工具审批。
    this.recordApproval({
      id: requestId, sessionId: p.sessionId, kind: "tool",
      subject: p.subject || p.toolName,
      decision: decision.allow ? "allow" : "deny",
      always: remember,
      // 只记「工具名」这一个结构化字段（不是 input 原文 —— 那个会被 redactValue 打码）。
      detail: JSON.stringify({ toolName: p.toolName }),
    });
    // Record "always allow" so canUseTool auto-approves this tool next time.
    if (decision.allow && remember) {
      let set = this.alwaysAllowedTools.get(p.sessionId);
      if (!set) {
        set = new Set();
        this.alwaysAllowedTools.set(p.sessionId, set);
      }
      set.add(p.toolName);
    }
    return p.sessionId;
  }

  /** Has the user granted this tool with "always allow" for this session?
   *  canUseTool checks this before prompting the renderer. */
  isAlwaysAllowed(sessionId: string, toolName: string): boolean {
    return this.alwaysAllowedTools.get(sessionId)?.has(toolName) ?? false;
  }

  /** Set the session's current permission mode. canUseTool reads this on
   *  every call so a mid-turn mode change takes effect immediately. */
  setPermissionMode(sessionId: string, mode: PermissionMode): void {
    // A remembered grant was given under the previous mode. Revoke it when
    // the user changes the policy (especially when switching to read-only).
    if (this.permissionModes.get(sessionId) !== mode) this.alwaysAllowedTools.delete(sessionId);
    this.permissionModes.set(sessionId, mode);
  }

  /** Get the session's current permission mode (latest, even mid-turn). */
  getPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.permissionModes.get(sessionId);
  }

  /* ── user input (AskUserQuestion) ── */

  /** Create a user-input-request handler for a session. */
  makeUserInputHandler(
    sessionId: string,
    emit: (e: RuntimeEvent) => void,
  ): (req: UserInputRequest) => Promise<UserInputDecision> {
    return (req) =>
      new Promise<UserInputDecision>((resolve, reject) => {
        this.pendingUserInputs.set(req.requestId, {
          resolve, reject, sessionId,
          // 【T109】历史里要说清「他回答了什么问题」。
          subject: clipSubject(req.questions[0]?.question ?? ""),
        });
        emit({
          type: "question.ask",
          sessionId,
          questions: req.questions,
          requestId: req.requestId,
        } as RuntimeEvent & { requestId: string });
      });
  }

  /** Resolve a user-input request (called when the user submits answers).
   *  Returns the owning session's id on success, null when already resolved. */
  resolveUserInput(requestId: string, answers: UserInputAnswers): string | null {
    const p = this.pendingUserInputs.get(requestId);
    if (!p) return null;
    p.resolve({ answers });
    this.pendingUserInputs.delete(requestId);
    // 【T109】出口 2/5：用户回答了模型的问题。
    this.recordApproval({
      id: requestId, sessionId: p.sessionId, kind: "question",
      subject: p.subject, decision: "answered",
      // 只记「回答了几个问题」，不记答案内容（答案可能含用户隐私/自由文本）。
      detail: JSON.stringify({ answerCount: Object.keys(answers ?? {}).length }),
    });
    return p.sessionId;
  }

  /** Resolve a user-input request as DISMISSED (the user closed the question
   *  card without answering). The provider's canUseTool / tool execute turns
   *  `dismissed` into a deny / tool error so the model sees the question was
   *  skipped and the SAME turn continues — without this the Deferred would
   *  never resolve and the model would block forever. Returns the owning
   *  session's id on success, null when already resolved. */
  dismissUserInput(requestId: string): string | null {
    const p = this.pendingUserInputs.get(requestId);
    if (!p) return null;
    p.resolve({ answers: {}, dismissed: true });
    this.pendingUserInputs.delete(requestId);
    // 【T109】出口 3/5：用户**关掉了问题卡片没回答**。
    // 「跳过」也是一种决定 —— 记 dismissed 而不是 answered（两者对用户的意思相反）。
    this.recordApproval({
      id: requestId, sessionId: p.sessionId, kind: "question",
      subject: p.subject, decision: "dismissed",
    });
    return p.sessionId;
  }

  /* ── plan approval (ExitPlanMode) ── */

  /** Create a plan-approval-request handler for a session. Mirrors
   * makeUserInputHandler: stores a pending promise and emits
   * plan.approval_request to the renderer. The promise resolves when the user
   * approves/rejects via the claude:respondPlanApproval IPC handler. */
  makePlanApprovalHandler(
    sessionId: string,
    emit: (e: RuntimeEvent) => void,
  ): (req: PlanApprovalRequest) => Promise<PlanApprovalDecision> {
    return (req) =>
      new Promise<PlanApprovalDecision>((resolve, reject) => {
        this.pendingPlanApprovals.set(req.requestId, {
          resolve, reject, sessionId,
          // 【T109】计划可能很长 —— 取第一行非空文本，历史里够认出来是哪个计划。
          subject: clipSubject(firstLineOf(req.plan)),
        });
        emit({
          type: "plan.approval_request",
          sessionId,
          requestId: req.requestId,
          toolCallId: req.toolUseId ?? req.requestId,
          plan: req.plan,
        });
      });
  }

  /** Resolve a plan-approval request (called by ipc/claude.ts
   * CLAUDE_RESPOND_PLAN_APPROVAL handler). Returns the owning session's id on
   * success, null when already resolved. */
  resolvePlanApproval(requestId: string, decision: PlanApprovalDecision): string | null {
    const p = this.pendingPlanApprovals.get(requestId);
    if (!p) return null;
    p.resolve(decision);
    this.pendingPlanApprovals.delete(requestId);
    // 【T109】出口 4/5：批准 / 否掉计划。
    this.recordApproval({
      id: requestId, sessionId: p.sessionId, kind: "plan",
      subject: p.subject, decision: decision.approved ? "approved" : "rejected",
    });
    return p.sessionId;
  }

  /* ── cleanup ── */

  /** Reject pending requests for one session and return their UI routing keys.
   *  Persistent per-session grants and permission mode are intentionally kept. */
  rejectPending(sessionId: string): Array<{ requestId: string; kind: "approval" | "question" | "plan" }> {
    const rejected: Array<{ requestId: string; kind: "approval" | "question" | "plan" }> = [];
    for (const [id, p] of this.pendingApprovals) {
      if (p.sessionId !== sessionId) continue;
      p.reject(new Error("Session cancelled"));
      this.pendingApprovals.delete(id);
      rejected.push({ requestId: id, kind: "approval" });
      // 【T109】出口 5/5：会话取消导致审批失效。
      // ⚠️ 记 `cancelled` **不是** `deny` —— 用户没有拒绝过任何东西。
      // 混成 deny 会让「我拒绝过几次」这个统计是假的。
      this.recordApproval({
        id, sessionId: p.sessionId, kind: "tool",
        subject: p.subject || p.toolName, decision: "cancelled",
      });
    }
    for (const [id, p] of this.pendingUserInputs) {
      if (p.sessionId !== sessionId) continue;
      p.reject(new Error("Session cancelled"));
      this.pendingUserInputs.delete(id);
      rejected.push({ requestId: id, kind: "question" });
      this.recordApproval({
        id, sessionId: p.sessionId, kind: "question",
        subject: p.subject, decision: "cancelled",
      });
    }
    for (const [id, p] of this.pendingPlanApprovals) {
      if (p.sessionId !== sessionId) continue;
      p.reject(new Error("Session cancelled"));
      this.pendingPlanApprovals.delete(id);
      rejected.push({ requestId: id, kind: "plan" });
      this.recordApproval({
        id, sessionId: p.sessionId, kind: "plan",
        subject: p.subject, decision: "cancelled",
      });
    }
    return rejected;
  }

  /** Reject pending requests and drop per-session state (called on dispose). */
  rejectAll(sessionId: string): void {
    this.rejectPending(sessionId);
    // Drop per-session always-allow + mode state so a reused session id
    // (shouldn't happen, but defensive) starts clean.
    this.alwaysAllowedTools.delete(sessionId);
    this.permissionModes.delete(sessionId);
  }
}
