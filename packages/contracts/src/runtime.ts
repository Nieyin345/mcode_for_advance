/**
 * Runtime events — the normalized stream of activity emitted by a provider
 * (claude.exe via stream-json). These are the lingua franca the renderer
 * renders; the ClaudeAdapter translates raw NDJSON into these.
 */

import type { Session } from "./session.js";
import type { ModuleWorkflowExecutionInput } from "./moduleCapability.js";
import type { NodeReturnMode, NodeTypeManifest } from "./nodeType.js";
import type { WorkflowNode } from "./workflow.js";
import type { NodeArtifact, NodeExecutionRecord, NodeOutcomeStatus } from "./nodeType.js";
export type { NodeArtifact, NodeExecutionRecord } from "./nodeType.js";

/**
 * Normalized input crossing the scheduler/executor boundary. The scheduler
 * resolves graph semantics before an executor sees this object; executors do
 * not inspect WorkflowNode.params directly.
 */
export interface WorkflowDataContext {
  userInput: string;
  upstreamText: string;
  upstreamOutputs: Record<string, Record<string, unknown>>;
  upstreamArtifacts: NodeArtifact[];
  /**
   * 这一次运行**由哪个触发器起**的载荷事实(平面键值,键来自
   * `main/orchestration/automationPayload.ts` 的 `payloadFactsOf`:kind / at / files /
   * event / toolName / subjects)。自动化执行器把它放进 `entry.payload`,宿主在构建
   * `NodeRunInput` 时递到这里,节点侧的 `{{trigger.<key>}}` 只认这里面的键。
   * 手动跑一张图没有触发器 —— 缺席就是没有。
   */
  trigger?: Record<string, unknown>;
}

export interface NodeRunInput {
  prompt: string;
  data: WorkflowDataContext;
  skills: string[];
  mcpServerNames: string[];
  pluginNames: string[];
  returnMode: NodeReturnMode;
  /**
   * **这一段提示词要不要在目标对话里当成"用户说的一句话"回声出去。**
   *
   * 缺省 `true` —— 那是「对话节点」的定义:它的指令**就是**一句用户会说的话
   * (见 `@contracts/nodeType` 里 `CONVERSATION_INSTRUCTION_HELP`),所以聊天框里
   * 该看得见它。
   *
   * 入口节点(主代理)是**唯一**一个给 `false` 的:它跑在主对话里(跑法与对话节点
   * 相同),但那一段 `prompt` 是**代码拼的脚手架** —— 流程位置、用户的请求、上游
   * 产出、产出要求,一大段用户没打过的字。原样贴进聊天框,他看到的是一屏莫名其妙
   * 的话。而用户真正的原话由 `startWorkflowRun` 回声过了(跨客户端同步、编辑标记、
   * 本机乐观追加的去重都挂在那一台上,见 `RuntimeManager.echoUserMessage`),所以
   * 这里不再回声,聊天框里正好一条。
   */
  echoUserMessage?: boolean;
  providerId?: string;
  /** Validated module parameters plus a host-created identity for ONE dispatch.
   * cwd comes from WorkflowExecutionContext, never from these parameters.
   * Preserve requestId on transport retries; replace it for an explicit rerun. */
  moduleCall?: ModuleWorkflowExecutionInput;
  command?: { command: string; timeoutMs: number; input?: unknown };
  code?: {
    code: string;
    language: "python" | "node" | "shell" | "powershell";
    input?: unknown;
    timeoutMs: number;
  };
}

/**
 * ## Runtime state / persistence contract(PAR-B 边界)
 *
 * 一次 workflow 运行的**身份层级**——三个 id 各管一层,谁也不能替谁:
 *
 * ```text
 * WorkflowRunIdentity      sessionId ⊇ runId        一次图执行
 * WorkflowNodeRunIdentity  sessionId ⊇ runId ⊇ nodeId  这次执行里的一个节点
 * ```
 *
 * - `sessionId`:**对话**。节点事件永远发在父对话的 sessionId 上(隐藏节点会话的 id
 *   走 `nodeSessionId` / transcript 通道,不属于这层身份)。
 * - `runId`:一次图执行的 id,**续跑沿用旧 id** —— 卡片按它认领。
 * - `nodeId`:图上的局部记号,同一张图跑两次 id 相同 —— 所以单说 nodeId 分不清
 *   两次运行,"哪一步"永远要 `runId + nodeId` 一起说。
 *
 * **各自负责什么**(职责表,防止同一件事存两份真相):
 *
 * | 结构 | 负责 | 不负责 |
 * |---|---|---|
 * | `RunState`(scheduler) | 流程事实:record / rounds / picks / outcomes / awaiting / entry | 不含展示用的副本 |
 * | `NodeOutcome`(nodeType) | 单节点定案:status / summary / outputs / artifacts / execution | 不含事件流、不含产物内容 |
 * | `RunSnapshot`(runStore) | **可恢复的最小事实集合** + 版本信封(version/capturedAt) | 不重复存 NodeOutcome 以外的东西 |
 * | `WorkflowRunStatus`(store) | 运行生命周期:running/interrupted/success/failed/cancelled | 不在快照里再存一份 |
 *
 * **artifact 是引用不是状态**:`NodeArtifact` 只携带 `uri` 等定位信息,字节留在外部;
 * 任何持久化结构都不存产物内容。
 */
export interface WorkflowRunIdentity {
  runId: string;
  sessionId: string;
}

export interface WorkflowNodeRunIdentity extends WorkflowRunIdentity {
  nodeId: string;
}

/**
 * 快照信封版本。**编码随快照写入,读取必须接受没有这个字段的旧存档**(向后兼容)。
 * 只在"读不回来会炸"的形状变化时递增;拒绝未来版本的是读方(`runStore.decodeSnapshot`)。
 */
export const WORKFLOW_RUN_SNAPSHOT_VERSION = 1 as const;

/** 一个节点执行的完整身份(执行元数据、事件、进度都按它寻址)。 */
export interface WorkflowExecutionMetadata extends WorkflowNodeRunIdentity {}

/** The host-computed context supplied to a node executor. */
export interface WorkflowExecutionContext {
  node: WorkflowNode;
  manifest: NodeTypeManifest;
  input: NodeRunInput;
  cwd: string;
  metadata: WorkflowExecutionMetadata;
}


/**
 * Permission modes are open strings so each provider can declare its own set
 * via `ProviderCapabilities.permissionModes`. Claude's values are kept as
 * semantic constants below for backward compatibility and for the claude-sdk
 * provider's own use. The renderer's composer reads the supported modes from
 * the active provider's capabilities, not from this union.
 *
 * Claude's 6 modes (default / acceptEdits / plan / bypassPermissions / dontAsk
 * / auto) are preserved verbatim; `dontAsk` and `auto` are not exposed in the
 * UI but round-trip safely through the contract. Other providers may declare
 * entirely different mode strings (or none at all).
 */
export type PermissionMode = string;

/** Claude's canonical permission modes, in the order the UI presents them. */
export const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;

/**
 * 内置工作流的 id —— 输入框那个选择器里的固定几项。
 *
 * 与权限模式 / 思考档位不同,这几个**不是提供方声明的**:集合由应用定死,对每个提供方
 * 含义相同。选择器从这里渲染;host 把选中的 id 变成一段系统提示词(见
 * `main/orchestration/prompt.ts`),提供方只负责把那段字符串追加进去。
 *
 * ⚠️ **这份列表只有这一处。** `main/orchestration/builtins.ts` 用它打底生成内置工作流,
 * 不再自己维护一份 —— 两份列表迟早会漂移,而漂移的表现是"选择器里选得到,却查不到
 * 对应的工作流"。
 *
 * ⚠️ 会话上那个字段(`WorkflowIdSchema`)是**开放字符串**,不是这个联合类型:用户可以
 * 自建工作流(`wf_` 前缀)。这个联合类型只用来约束"内置的那几个"。
 */
export const BUILTIN_WORKFLOW_IDS = ["default", "search", "read", "write", "review", "code"] as const;
export type BuiltinWorkflowId = (typeof BUILTIN_WORKFLOW_IDS)[number];

/**
 * Effort / thinking levels are open strings so each provider can declare its
 * own set via `ProviderCapabilities.thinkingLevels`. Claude's values are kept
 * as semantic constants below for backward compatibility. Pi SDK uses a
 * superset that adds "off" and "minimal".
 *
 * "default" is a universal sentinel meaning "let the provider pick / don't
 * pass the option". Higher effort ≈ more thinking/reasoning.
 */
export type EffortLevel = string;

/** Claude's canonical effort levels (verified on 2.1.186). */
export const CLAUDE_EFFORT_LEVELS = [
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Pi SDK's thinking levels (superset of Claude's, adds off/minimal). */
export const PI_THINKING_LEVELS = [
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Lifecycle of a single session. */
export type SessionStatus =
  | "idle"
  | "running"
  | "approving"
  | "done"
  | "errored"
  | "interrupted";

/** A text delta (streaming token) from the assistant. */
export interface TextDeltaEvent {
  type: "text.delta";
  sessionId: string;
  messageId: string;
  text: string;
}

/** A complete assistant message boundary. */
export interface MessageCompleteEvent {
  type: "message.complete";
  sessionId: string;
  messageId: string;
}

/** A thinking/reasoning block (claude extended thinking). */
export interface ThinkingEvent {
  type: "thinking";
  sessionId: string;
  messageId: string;
  text: string;
}

/** A tool was invoked by the agent. */
export interface ToolUseEvent {
  type: "tool.use";
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Raw tool input as JSON (e.g. { command, path, ... }). */
  input: unknown;
  /** True if this tool call requires user approval before executing. */
  requiresApproval: boolean;
  /** Optional: the assistant message this tool belongs to. Claude's tool_use
   *  blocks arrive inside the full assistant message, so the store naturally
   *  appends them to the same message as the narration text. Pi's
   *  `tool_execution_start` event, by contrast, is detached from the message
   *  stream — the adapter forwards the target messageId here so the tool
   *  block lands on the same message as its narration text (keeping the
   *  process/reply timeline intact instead of piling every tool onto the
   *  turn's opener). Provider-optional: claude omits it. */
  messageId?: string;
}

/** A tool finished and returned a result. */
export interface ToolResultEvent {
  type: "tool.result";
  sessionId: string;
  toolCallId: string;
  /** Whether the tool errored. */
  isError: boolean;
  /** Raw result content (string or structured). */
  content: unknown;
}

/** The agent is requesting permission to run a tool (awaiting user decision). */
export interface ApprovalRequestEvent {
  type: "approval.request";
  sessionId: string;
  requestId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Human-readable description of what the tool will do. */
  description?: string;
}

/** A todo/task update (claude's TodoWrite tool output). */
export interface TodoUpdateEvent {
  type: "todo.update";
  sessionId: string;
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority: "high" | "medium" | "low";
  }>;
}

/**
 * Context-window token usage, normalized by the provider adapter before
 * emission. The provider (claude-sdk adapter) extracts raw usage fields from
 * SDK messages, runs the shared math in `claudeTokenUsage.ts`, and emits this
 * event carrying an already-display-ready `ContextSnapshot`. Downstream
 * (renderer) is provider-neutral — it only stores and renders the snapshot.
 *
 * Three emission points mirror Synara's design (docs/claude-context-usage-
 * tracking.md §2): path A (per assistant response, mid-turn read) and path C
 * (turn-end merged). Path B (the Agent SDK control channel for live window
 * queries) is not exposed by the SDK's stream-json surface — `usedPercent` /
 * `warning` degrade to `usedTokens/maxTokens` (doc §7.2).
 */

/** Top-level occupancy warning level for the context ring. */
export type ContextWarning = "ok" | "near-window" | "critical";

/** Granular warning kinds (doc §5), computed each emit and folded into the
 *  snapshot. Empty when nothing is amiss. */
export type ContextWarningKind =
  | "uncached-ingestion"
  | "near-window"
  | "large-prompt";

/** A ready-to-render snapshot of context-window state. Built by the adapter
 *  from raw SDK usage fields; all math (pct / warning / clamps) is already
 *  applied. */
export interface ContextSnapshot {
  /** Tokens currently occupying the context window:
   *  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
   *  clamped to `maxTokens`. Cache reads bill at a reduced rate but occupy
   *  the window at full weight (doc §3). */
  usedTokens: number;
  /** Cumulative tokens processed across this turn
   *  (`input + output + cache_read + cache_creation`). May exceed maxTokens. */
  totalProcessedTokens: number;
  /** Context-window ceiling. Prefer SDK-reported (`modelUsage[model].
   *  contextWindow`); fall back to model-name heuristic; never downgrade
   *  (doc §4). */
  maxTokens: number;
  /** Output tokens from the last completed turn. */
  outputTokens: number;
  /** Tokens read from the prompt cache (reduced billing rate). */
  cacheReadTokens?: number;
  /** Tokens used to create new cache entries (higher write rate). */
  cacheCreationTokens?: number;
  /** Estimated USD cost for this turn, if known. Includes subagent activity. */
  costUsd?: number;
  /** Active model identifier (from SDK result message). */
  model?: string;
  /** Context occupancy as a percentage [0, 100], clamped. */
  pct: number;
  /** Derived warning level (>=90 critical / >=70 near-window / else ok). */
  warning: ContextWarning;
  /** Granular doc-§5 warnings triggered this turn (uncached-ingestion /
   *  near-window / large-prompt). */
  warnings: ContextWarningKind[];
}

/** Emitted by the provider adapter whenever a new token-usage snapshot is
 *  available (per-assistant-response mid-turn and at turn end). The renderer
 *  replaces its latest snapshot with `e.snapshot`. */
export interface ContextUsageEvent {
  type: "token-usage.updated";
  sessionId: string;
  snapshot: ContextSnapshot;
}

/** One entry in the per-session turn-usage history. Appended at turn-end
 *  from the latest {@link ContextSnapshot} + timing metadata. Persisted to
 *  the sessions table so the history survives app restart. */
export interface TurnUsageRecord {
  /** Wall-clock ms when the turn finalized (turnMeta.endedAt). */
  endedAt: number;
  /** Duration of the turn in ms (endedAt - startedAt). */
  durationMs: number;
  /** Tokens processed this turn (input + output + cache). */
  totalProcessedTokens: number;
  /** Output tokens this turn. */
  outputTokens: number;
  /** Tokens read from cache this turn (0 if none). */
  cacheReadTokens: number;
  /** Tokens written to cache this turn (0 if none). */
  cacheCreationTokens: number;
  /** Estimated USD cost this turn, if known.
   *  @see {@link ContextSnapshot.costUsd} — includes subagent activity. */
  costUsd?: number;
  /** Tokens attributed to Task-tool subagents this turn: the CLI's per-agent
   *  occupancy+output proxy, summed as positive deltas of each agent's
   *  (monotonic) `totalTokens`. Deliberately NOT folded into
   *  totalProcessedTokens (which covers the main loop only) — the two have
   *  different semantics, and costUsd already includes subagents on the CLI
   *  side. Undefined/0 = no subagent activity this turn. */
  subagentTokens?: number;
  /** Window occupancy AFTER this turn (cumulative context size). */
  usedTokens: number;
  /** Active model for this turn, if known. */
  model?: string;
}

/** Session-level error. */
export interface ErrorEvent {
  type: "error";
  sessionId: string;
  message: string;
  /** Raw error code/string from claude, if any. */
  code?: string;
}

/** The turn has fully completed. */
export type TurnDoneReason = "end_turn" | "max_tokens" | "tool_use" | "interrupted" | "error";
export interface TurnDoneEvent {
  type: "turn.done";
  sessionId: string;
  reason: TurnDoneReason;
  /** Main-process wall-clock ms at which the turn ended. Stamped by
   *  RuntimeManager (the single event exit) and adopted by the renderer as
   *  `turnMeta.endedAt`, so BOTH sides record the same instant.
   *
   *  Why it must be shared: the turn's usage record (SessionRepo
   *  updateUsageHistory) is filed under this same timestamp. The renderer
   *  correlates the two to show a turn's token count, and separate
   *  Date.now() calls in two processes would never match. Both processes read
   *  the same system clock, so mixing it with renderer-side send timestamps
   *  (durations) is safe.
   *
   *  Optional for backward compatibility with older/other clients. */
  endedAt?: number;
}

/**
 * A host-side advisory card shown in the chat transcript — informational,
 * NOT a turn terminator. Emitted by RuntimeManager for lifecycle events the
 * user should see inline (budget cap reached before interrupting, automatic
 * model fallback, structured-output validation failing). The turn itself
 * still ends via the normal turn.done (reason="interrupted"/"error").
 *
 * foldTranscript must ignore this type (it is UI-only, not part of the
 * workflow node's process transcript).
 */
export interface TurnNoticeEvent {
  type: "turn.notice";
  sessionId: string;
  kind: "budget_limit" | "fallback" | "structured_invalid";
  /** Human-readable, already-localized message for the inline card. */
  message: string;
}

/**
 * The turn ended with a "success" result but the stream shows the model never
 * finished its work — the classic third-party-gateway failure where the model
 * channel returns an empty completion that the CLI silently accepts as a
 * normal end-of-turn. Emitted by the adapter right BEFORE turn.done so the
 * renderer can flag the turn (warning card + toast) instead of showing a
 * misleading "回合完成".
 *
 * Three shapes:
 *  - `dangling-tools` — main-agent tool_use blocks were still unanswered when
 *    the stream closed (the model was mid-tool-flow; its next response after
 *    the last tool_result came back empty).
 *  - `empty-response` — the turn produced no assistant text at all.
 *  - `unfinished-text` — the final assistant message was text-only but ends
 *    with continuation punctuation (colon / comma / …) or an unclosed ```
 *    fence: the model narrated its next step and the announced tool call
 *    never arrived (observed 2026-09-02 on a bridge that flattens every
 *    finish_reason to end_turn, so the CLI had no "still working" signal).
 *
 * NOT emitted for user interrupts (dangling tools are expected there) or
 * error-subtype results (the `error` event already surfaces those).
 */
export interface TurnIncompleteEvent {
  type: "turn.incomplete";
  sessionId: string;
  kind: "dangling-tools" | "empty-response" | "unfinished-text";
  /** Main-agent tool calls that never received a tool_result
   *  (kind "dangling-tools"; empty for "empty-response"). Names are for
   *  display, ids for correlation with the chat stream's tool cards. */
  pendingToolCalls: Array<{ toolCallId: string; toolName: string }>;
}

/**
 * One file touched by a turn. Shared shape across the `turn.files` event
 * payload, the persisted `Session.turnFiles` column, and the renderer's
 * `turnFilesBySession` bucket — defined once here so the three never drift.
 *
 * - `filePath`: absolute (cwd-resolved by main).
 * - `kind`: "created" = file did not exist before the turn (rewind unlinks);
 *   "modified" = it existed (rewind writes `before` back).
 * - `adds` / `dels`: line-level change tallies computed by `FileSnapshot.freeze`
 *   (LCS over `before` vs the on-disk post-turn content). The folded card shows
 *   these directly without computing a full diff; `0` for unreadable/binary.
 * - `before`: the file's pre-turn content (the empty string for created files).
 *   Crosses IPC so the renderer can compute a full line diff on demand by
 *   reading the current on-disk content and diffing against this.
 */
export interface TurnFileEntry {
  filePath: string;
  kind: TurnFileKind;
  adds: number;
  dels: number;
  before: string;
}

/** Whether a turn-touched file existed before the turn. */
export type TurnFileKind = "modified" | "created";

/**
 * Emitted at the end of a turn listing the files Edit/Write touched in
 * that turn. Renderer uses this to render the "本轮文件" card with the
 * per-file diff and a rewind button.
 *
 * `kind: "created"` means the file did not exist before the turn —
 * rewinding will unlink it. `kind: "modified"` means it existed —
 * rewinding will write the original content back.
 */
export interface TurnFilesEvent {
  type: "turn.files";
  sessionId: string;
  files: TurnFileEntry[];
}

/** Emitted by main after a renderer-initiated rewind completes. The
 *  renderer marks the matching `turn-files` card `rewound: true` in
 *  place — the card is NEVER removed, so the conversation stream keeps
 *  a visible trace that the user rolled this turn back (mirroring SDK
 *  checkpoint semantics where file rollback never rolls back the
 *  conversation itself).
 *
 *  The renderer uses `targetFiles` to locate the card (path-set match),
 *  and clears the latest-turn bucket (`turnFilesBySession`) only when
 *  the matched card is the live one. */
export interface TurnRewoundEvent {
  type: "turn.rewound";
  sessionId: string;
  /** Paths that were successfully restored (subset of the requested
   *  files; failed paths are logged in main but not surfaced here
   *  beyond the implicit "not in this list"). */
  files: string[];
  /** The ORIGINAL set of paths the rewind targeted (before any were
   *  dropped due to failure). Always present — the renderer matches the
   *  `turn-files` block by this path set to mark it `rewound`. */
  targetFiles: string[];
}

/**
 * The agent is asking the user a question via the AskUserQuestion tool. claude
 * emits a tool_use carrying a structured question list. NOTE: this tool's
 * availability depends on model/version/config (verified absent on 2.1.218 +
 * proxy + MiniMax; present on 2.1.186). The GUI parses it defensively so the
 * UI works whenever the tool does surface. In non-interactive mode claude
 * auto-cancels the result, so the user's answer is sent as the next message.
 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}
export interface AskUserQuestionItem {
  header: string;
  question: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}
export interface AskUserQuestionEvent {
  type: "question.ask";
  sessionId: string;
  /** Opaque id for correlating an answer back (used by the approval bridge).
   * Absent when the question is surfaced from sentinel-scanner fallback. */
  requestId?: string;
  questions: AskUserQuestionItem[];
}

/**
 * The session's effective permission mode changed mid-turn. Emitted when the
 * model invokes EnterPlanMode / ExitPlanMode tools (source: "model"), so the
 * UI (composer chip + status bar) can sync to what the SDK is actually doing.
 * The GUI's session.permissionMode (persisted) is the *startup* mode; this
 * event reports the *current* runtime mode, which may differ after a model
 * initiated transition into or out of plan mode.
 */
export interface ModeChangeEvent {
  type: "mode.change";
  sessionId: string;
  mode: PermissionMode;
  /** Who triggered the change. "model" = a plan-mode tool call; "user" = the
   * host flipping the composer chip (reserved for future use). */
  source: "model" | "user";
}

/**
 * The model has drafted a plan in plan mode and is calling ExitPlanMode to
 * request user approval before executing. The plan text comes from the tool's
 * `input.plan` field (the SDK forwards it through canUseTool). The user's
 * decision is returned via the `claude:respondPlanApproval` IPC channel,
 * keyed by `requestId`, which resolves the provider's pending Deferred and
 * either allows (exits plan mode) or denies (stays in plan mode) the tool.
 */
export interface PlanApprovalRequestEvent {
  type: "plan.approval_request";
  sessionId: string;
  requestId: string;
  /** The ExitPlanMode tool_use id, for correlation with the tool card. */
  toolCallId: string;
  /** The plan text the model is proposing (Markdown). */
  plan: string;
}

/**
 * Plan draft update — emitted whenever the current plan-mode draft changes.
 * Used by the activity capsule to preview the plan in real time, independent
 * of the final `plan.approval_request` event (which only fires once, at
 * ExitPlanMode time).
 *
 * Lifecycle:
 *   - `phase: "drafting"` — model is still composing the plan; `plan` holds
 *     whatever text has been written so far. Emitted on EnterPlanMode and on
 *     subsequent text deltas within plan mode (the host may refine the
 *     preview live).
 *   - `phase: "ready"` — model has called ExitPlanMode; `plan` is the final
 *     submitted plan. Capsules show a "等待批准" badge and the user can open
 *     the plan for review.
 *   - `phase: "cleared"` — plan mode has ended (approved, rejected, or
 *     interrupted). `plan` is empty. The capsule drops the Plan section.
 */
export interface PlanUpdateEvent {
  type: "plan.update";
  sessionId: string;
  plan: string;
  phase: "drafting" | "ready" | "cleared";
}

/**
 * Per-subagent status snapshot. The SDK sends `task_started`, `task_progress`,
 * `task_updated` edge events; the adapter maintains a map keyed by `taskId`
 * and emits a single consolidated `subagent.update` after each change (REPLACE
 * semantics, mirroring the SDK's own level-signal guidance). The renderer
 * renders the full array — no client-side merging required.
 */
export interface SubagentSnapshot {
  /** SDK-provided task id (string). */
  taskId: string;
  /** Originating Task tool_use id, for correlation with the chat stream. */
  toolUseId?: string;
  /** Human description (SDK task_started.description or Task tool_use input). */
  description: string;
  /** Subagent type label (e.g. "general-purpose", "code-reviewer"). */
  subagentType?: string;
  /** Lifecycle status. `running` is the steady state until task_updated. */
  status: "running" | "completed" | "failed" | "killed";
  /** Cumulative token estimate (task_progress.usage.total_tokens). */
  totalTokens?: number;
  /** Cumulative tool-call count (task_progress.usage.tool_uses). */
  toolUses?: number;
  /** Elapsed milliseconds (task_progress.usage.duration_ms). */
  durationMs?: number;
  /** Most-recent tool name the subagent invoked. */
  lastToolName?: string;
  /** SDK-supplied progress summary (task_progress.summary). */
  summary?: string;
  /** Wall-clock end time (task_updated.patch.end_time). */
  endedAt?: number;
  /** Error message (task_updated.patch.error), if status=failed. */
  error?: string;
  /** True when the SDK launched this task as backgrounded (the parent agent
   *  does NOT block on it). Set from task_started/task_updated patch's
   *  `is_backgrounded`. Backgrounded tasks outlive the parent turn's stream in
   *  the CLI; the adapter avoids force-completing them at turn end so the
   *  renderer can keep the "busy" signal alive while they remain running. */
  isBackgrounded?: boolean;
}

/**
 * Consolidated subagent roster update. Always carries the full current
 * roster — the host should replace, not merge. Empty array means "no
 * subagents active or recently completed".
 */
export interface SubagentUpdateEvent {
  type: "subagent.update";
  sessionId: string;
  agents: SubagentSnapshot[];
}

/**
 * One rendered block of a **read-only transcript** — somebody else's
 * conversation that the user only watches.
 *
 * 两个地方用它,形状一模一样,所以只有这一个类型:
 *
 *  - **子代理**(Claude 的 Task / Codex 的 thread):由各自的适配器从转发过来的
 *    子消息折出来(`providers/<某家>/…MessageAdapter.ts`);
 *  - **工作流节点**:一个节点是一个独立的隐藏会话,它的流水由宿主
 *    (`claude/RuntimeManager.ts`)折出来 —— 折法在 `claude/nodeTranscript.ts`,
 *    是纯函数,所以无头脚本喂得进。
 *
 * Field names and shapes deliberately mirror the renderer store's `Block` union
 * (text / thinking / tool_use members) so the transcript can feed
 * `MessageBlocks` directly — only the members a sub-agent can produce are
 * modeled. NOT persisted: the transcript is process-lifetime data.
 */
export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_use";
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** "running" until the tool_result lands (status done/error). */
      status: "running" | "done" | "error";
      result?: unknown;
    };

/**
 * Replace-semantics transcript for ONE subagent, keyed by the Task
 * tool_use id that spawned it (== `SubagentSnapshot.toolUseId`, ==
 * `parent_tool_use_id` on forwarded subagent messages). Emitted after every
 * forwarded subagent assistant/user message is folded in — message-level
 * granularity (no char streaming), which matches the subagent viewer's
 * read-only "check what it's doing" purpose.
 */
export interface SubagentTranscriptEvent {
  type: "subagent.transcript";
  sessionId: string;
  /** The originating Task tool_use id. */
  parentToolUseId: string;
  /** The full transcript so far (replace, not append). */
  blocks: TranscriptBlock[];
}

/**
 * Replace-semantics transcript for ONE workflow node, keyed by the hidden
 * node session that ran it.
 *
 * ## 为什么要有它
 *
 * 节点是**隐藏会话**(`kind: "node"`),它的流水刻意不发往客户端 —— 推过去会变成
 * 幻影消息和点不掉的未读(见 `RuntimeManager.emit` 那段注释)。于是"这一步到底干了
 * 什么"对用户是完全不可见的:卡片上只有一个最终结论,它搜了什么、跑了哪些工具、
 * 在哪一步绕了远路,一概看不到。用户的原话是「能看见子代理在干嘛」。
 *
 * 所以走**和子代理完全一样的那条路**:不发进消息流,而是另开一条按 id 索引的通道,
 * 由 `MessageBlocks` 只读地渲染(见 `TranscriptBlock`)。这样既不污染对话的配对规则
 * (`turn.done` ↔ 用量结算挂在最后那条 assistant 消息上),又让每一步的过程可查。
 *
 * **粒度是"消息级",不是逐字流。** 与 `SubagentTranscriptEvent` 同一个取舍:它是
 * 替换语义(每次带全量),逐字广播会让总字节数变成 O(n²),而这个通道的用途是"看它
 * 干了什么",不是"看它正在打哪个字"。所以整段文本在 `message.complete` 时一次出现,
 * 而工具调用是**一发生就出现**(那才是用户想实时看的部分)。
 *
 * ⚠️ **不落盘。** 进程生命周期数据,重启即失 —— 落盘是另一件事(要连"保留多久、
 * 跑过几十次的图怎么办"一起想)。
 */
export interface WorkflowNodeTranscriptEvent {
  type: "workflow.node.transcript";
  /** 父对话的 sessionId,和 `WorkflowNodeResultEvent` 一样。 */
  sessionId: string;
  /** 跑这一步的那个隐藏会话(`kind: "node"`)的 id。 */
  nodeSessionId: string;
  /** 到目前为止的完整过程(替换语义,不是追加)。 */
  blocks: TranscriptBlock[];
}

/** Emitted when a context compaction completes (manual `/compact` or auto).
 *  Carries the token counts before/after so the renderer can show a summary
 *  card in the message stream telling the user what happened. */
export interface CompactResultEvent {
  type: "compact.result";
  sessionId: string;
  /** What triggered the compaction. */
  trigger: "manual" | "auto";
  /** Token count before compaction. */
  preTokens: number;
  /** Token count after compaction (may be absent if the SDK didn't report it). */
  postTokens?: number;
  /** How long the compaction took, in ms (may be absent). */
  durationMs?: number;
}

/**
 * 一个节点**被排上了**(进入待派发,还没开始跑)。与 `workflow.node.progress` /
 * `workflow.node.result` 同一条事件流、同一个 sessionId(父对话)。
 *
 * ## 为什么它只有身份、没有内容
 *
 * progress 是"跑的过程",result 是"跑完了",两者都到了执行之后;而监控/看板
 * (排了几个、并发几个)要的是**派发那一刻**的事实 —— 哪怕这一步一秒就跑完,它也
 * 曾"被排上"。所以只带 id 三件套,不带任何结果性的东西。
 */
export interface WorkflowNodeQueuedEvent {
  type: "workflow.node.queued";
  /** 父对话的 sessionId,和 `WorkflowNodeResultEvent` 一样。 */
  sessionId: string;
  /** 这张图的 id(设置 → 工作流里的那份),监控按它分组。 */
  workflowId: string;
  /** 哪一次运行。见 `WorkflowNodeResultEvent.runId`。 */
  runId: string;
  /** 被排上的节点。 */
  nodeId: string;
}

export interface WorkflowNodeProgressEvent {
  type: "workflow.node.progress";
  sessionId: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  title: string;
  percent?: number;
  message?: string;
  phase?: string;
}

/** One step of a workflow graph settled. Emitted by the host scheduler
 *  (`main/orchestration/`) onto the **parent conversation's** sessionId, so the
 *  renderer shows a card in the message stream.
 *
 *  Deliberately NOT a fabricated assistant message: the node's own turn lives on
 *  its own hidden session (`kind: "node"`), and pretending its output were an
 *  assistant reply in the parent would corrupt `turn.done` ↔ usage pairing.
 *  Same precedent as `plan.update` / `compact.result` — an event that becomes a
 *  card. */
export interface WorkflowNodeResultEvent {
  type: "workflow.node.result";
  /** The CONVERSATION session, not the node's. */
  sessionId: string;
  /** Which run this belongs to. One user message = one run; a later message
   *  starts a new one, so the card can be read in order even if node ids repeat. */
  runId: string;
  /** 这是这个节点在第几轮跑出来的(**1 起**)。第 1 轮不带,第 2 轮起带上。
   *
   *  ## 为什么只在回头的时候带
   *
   *  一张环回的图(写稿 → 审稿 → 回去改)绕三圈就会产出三张同一个节点的卡,每张都
   *  带一大段产出 —— 对话被刷得看不见流程走到哪了。渲染端要靠一个**轮次**才认得出
   *  "这是同一格又跑了一遍",从而把上一张**换掉**而不是再插一张。第 1 轮不带,是因为
   *  没有环的图(绝大多数)永远是第 1 轮:字段不占地方,老行为一个字不改。
   *
   *  ## 为什么它跟 `runId` 一起用
   *
   *  轮次是**每次运行自己数的**(见 `RunState.rounds`),跨运行会从 1 重新开始。卡片
   *  认卡用的是 `runId + nodeId`,两者配得上 —— 否则上一次运行留下的卡会被这一次
   *  改掉。
   */
  round?: number;
  /** 跑这一步的那个**隐藏节点会话**(`kind: "node"`)的 id。
   *
   *  卡片靠它去 `workflow.node.transcript` 那条通道里取"这一步的过程"(见
   *  `WorkflowNodeTranscriptEvent`)。带上它而不是让渲染端拿 `nodeId` 去猜:节点 id 是
   *  图里的局部记号,同一张图跑两次是同一个 id,而**会话 id 每次都是新的** —— 猜的话
   *  第二次运行会看到第一次的过程。
   *
   *  **可缺席**:`skipped`(上游失败所以没跑)和 `cancelled`(还没轮到就被叫停)的节点
   *  根本没建过会话,也就没有过程可看。那种情况下卡片不该摆一个点开是空的入口。 */
  nodeSessionId?: string;
  /** 收场那一刻这一步的**过程快照**(同 `WorkflowNodeTranscriptEvent.blocks`)。
   *
   *  ## 为什么结果事件要再带一份过程
   *
   *  过程本来走的是另一条通道(按 `nodeSessionId` 索引的替换语义),渲染端自己拼得
   *  出来。但那个通道是**进程生命周期**的:主进程那边有容量上限、渲染端重开一次就是
   *  空的。而卡片是**落盘**的 —— 会话重开之后用户点开那张卡,看到他的是"过程已经不在
   *  内存里了",可那一步明明是他昨天跑的。
   *
   *  所以收场这一刻**拷一份进卡片**。这是一份冗余,换来的是"跑完的每一步都还查得到
   *  它干了什么"。
   *
   *  ⚠️ **可缺席**:没跑过的节点(skipped / cancelled)没有会话、也就没有过程;过程
   *  为空时同样不带。消费方**不能**把缺席读成"过程是空的"。
   */
  transcript?: TranscriptBlock[];
  /** The graph node's id / type / title, straight off `WorkflowNode`. */
  nodeId: string;
  nodeType: string;
  title: string;
  /** Actual engine/model used by an isolated model node. Missing for nodes that
   * never ran or execute through a non-provider executor. */
  providerId?: string;
  model?: string;
  status: NodeOutcomeStatus;
  /** What the node produced. Also what gets fed to its downstream nodes. */
  summary: string;
  /** 这一步**要模型交**的产出变量名(`outputVars` 那张表的名字列 + 模型选的分支必交的
   *  「出路」;没声明就是缺席)。
   *
   *  卡片靠它决定"这段产出是给人读的,还是给下游取值的"。声明过的那一步,产出**就是
   *  一个对象**(见 `@contracts/outputConstraint` 的 `describeOutputVars`),原文摊给
   *  用户看正好是用户明确说过不要的那件事("别让我看见 JSON")。
   *
   *  ⚠️ **这不是"下游能引用的一切"。** 清单声明的 `outputs`(命令节点的 `exitCode` /
   *  `stdout`、三个模型类型的 `summary`)是**运行时**填的、或者根本住在 `outcome` 的
   *  外层 —— 它们不在产出对象里,算进来会让 `checkOutput` 判"少一样"、卡片退回原文。
   *  要那份宽的名单(`referenceableOutputsOf`)的地方是「插入变量」菜单,不是这里。
   *
   *  ⚠️ **传名字,不传值。** 值就在 `summary` 里,渲染端用 `checkOutput`(同一份契约、
   *  同一个解析器)自己提出来的就是**下游拿到的那一份** —— 传值等于把同一份内容在
   *  库里存两遍,而变量值可能就是一篇文档。 */
  outputKeys?: string[];
  /** Present when the node did not succeed. */
  error?: string;
  execution?: NodeExecutionRecord;
  /** Stable references to files, directories, or external data produced by this node. */
  artifacts?: NodeArtifact[];
  /**
   * 这次运行由触发器起时的**载荷事实**(即 `data.trigger` 那一份,见
   * `WorkflowDataContext.trigger`)。只有带着触发器载荷起跑的运行才有 —— 结果卡
   * 靠它说清"这一步是被什么触发的",不必去运行史里猜。
   */
  input?: { trigger?: Record<string, unknown> };
  /**
   * **这一步花了多少。** 缺席 = 不知道(引擎没报、或者这一步压根没跑)。
   *
   * 只有 token 数与花费 —— 那两样是用户唯一看得懂、也唯一能拿去做决定的。**不搬整份
   * `TurnUsageRecord`**(它还有 `usedTokens` / `durationMs` 之类给上下文仪表盘用的
   * 字段),那些卡片上一个都不显示,搬过来只是把契约摊大。
   *
   * ⚠️ `costUsd` 可缺席**不等于 0**:有些第三方端点不报花费(`usageStats.ts` 那边
   * 同一件事)。渲染端要显示 `—` 而不是 `$0.00` —— 那会让人以为这一步免费。
   */
  usage?: {
    /** 这一步处理的全部 token(输入 + 缓存读 + 缓存写 + 输出)。 */
    totalTokens: number;
    outputTokens: number;
    costUsd?: number;
  };
}

/**
 * **给已经画出来的那张步骤卡补上花费。**
 *
 * ## 为什么不能重发一条 `workflow.node.result`
 *
 * 那个事件是**"插入一张卡"**的意思(渲染端 `appendTurnCardBlock`),再发一条同样的会
 * 在对话里出现**两张**卡片 —— 用户看到的是"同一步做了两次"。结果卡本来就没有"原地更新"
 * 这条路(它描述的是"事情发生完了",一次性的事实)。
 *
 * ## 所以为什么需要它
 *
 * 用量**不是**在节点收场那一刻就有的:那个回合的最终快照(含花费)是适配器在
 * `turn.done` **之后**异步推上来的,再由 `settlePendingTurnEnd` 结算落库。而计算花费
 * 又必须等那个回合收场(否则拿到的是半截数)。两件事的先后逼出了一条"稍后再补"的通道。
 *
 * ## 渲染端怎么用它
 *
 * 按 `runId + nodeId` 找到那张卡,**只改 `usage` 那一项**。找不到(卡片被折了、被容量
 * 裁了、用户切走了)就**静静地什么都不做** —— 补花费是附加的,它不该凭空造一张卡出来。
 *
 * 缺席 `usage`(补的时候还是没数)= 不发这个事件,卡片上就一直不显示花费那一行。
 */
export interface WorkflowNodeUsageEvent {
  type: "workflow.node.usage";
  /** 父对话的 sessionId。 */
  sessionId: string;
  runId: string;
  nodeId: string;
  /** 和结果事件里那个 `usage` 同一个形状。**这里一定存在**(没数就不发这条事件)。 */
  usage: {
    totalTokens: number;
    outputTokens: number;
    costUsd?: number;
  };
}

/**
 * 一个**分支节点**在等用户选一条路(`mcode.branch`,见 `@contracts/nodeType` 的
 * `runner.kind`)。
 *
 * ## 它是"挂起",不是"跑完了"
 *
 * 调度器跑到分支节点就**停下等** —— 同一个 `runWorkflow` 调用还活着,只是没有节点在
 * 跑。所以这个事件发出之后,那次运行既不是成功也不是失败,而是"等你说"。用户答了
 * (走 `workflow:choose` IPC),调度器接着往下跑,**不需要重新跑整张图**。
 *
 * ⚠️ 这一点决定了卡片要长什么样:它不能是一个"跑完了"的结果卡,得是一个**还活着的**
 * 交互卡 —— 按钮点完之前,这次运行没有结束。
 *
 * ## 发**两次**(选之前、选之后)
 *
 * - 不带 `chosen`:在等。卡片摆按钮。
 * - 带 `chosen`:已经选了。卡片只显示结果。
 *
 * 第二次是**另一台设备**要的那一份:手机上的卡片得知道"这边已经选过了",而不是继续
 * 摆一个点了没反应的按钮(同 `RequestResolvedEvent` 解决的那件事)。
 */
export interface WorkflowNodeChoiceEvent {
  type: "workflow.node.choice";
  /** 父对话的 sessionId,和 `WorkflowNodeResultEvent` 一样。 */
  sessionId: string;
  /** 哪一次运行。见 `WorkflowNodeResultEvent.runId`。 */
  runId: string;
  /** 分支节点的 id 与标题,直接来自 `WorkflowNode`。 */
  nodeId: string;
  nodeType: string;
  title: string;
  /**
   * **这是第几轮问。** 从 1 开始。
   *
   * 只有 `1` 以外的值才有意义,而它必要的原因是**回头**(见 `@contracts/workflow` 的
   * 「回头」):同一个分支在同一次运行里会被问很多次,而渲染端要靠 `runId + nodeId`
   * 认出"这是同一张卡、把内容换掉"。没有这个数字的话,第二轮那张会把**第一轮那张**
   * 替掉 —— 用户看到一个早就点过的卡片忽然变了个样子,而他第一轮点的是什么就此消失。
   */
  attempt: number;
  /** 待选的出路 —— **就是这个分支节点的出边**(见 `WorkflowEdgeSchema`)。 */
  options: WorkflowChoiceOption[];
  /**
   * **这一次问是节点上那个「运行前先问我」来的,不是边上的岔路。**
   *
   * 两者的载荷形状几乎一样(都是几个选项 + 一句可选的补充),但界面该长得不一样:
   * 岔路是聊天流里的一张卡,这一种要弹在屏幕正中间(见 `AskChoiceDialog`)。所以要有
   * 一个明确的判别字段。
   *
   * ⚠️ **不能拿 `nodeType` 来判。** 节点类型是插件可扩展的,第三方完全可以带一个自己的
   * 类型、行为却是"先问再跑";反过来,将来也可能有别的内置类型开这个开关。这里说的是
   * "代码打算怎么处理它",不是"它是谁"。
   */
  ask?: boolean;
  /** 已经选过的那一条(边的 id)。缺席 = 还在等。 */
  chosen?: string;
  /** 用户在选择时临时写的那句话(和 `chosen` 一起来)。 */
  comment?: string;
}

/** 分支节点上的一条出路。`id` 是**边**的 id —— 选择按它回来。 */
export interface WorkflowChoiceOption {
  id: string;
  /** 选项名。边上的 `label`,没填就用目标节点的标题。 */
  label: string;
  /** 选了这一项之后给下一步的说明(边上的 `note`)。 */
  note?: string;
  /** 这条出路通向哪一步的标题 —— 按钮下面显示"→ 写作③"用。 */
  next: string;
  /**
   * **这一项要一个输入框**,值是框里的提示语。没有就是不要框。
   *
   * 只有「运行前先问我」那四个选项会带它(见 `@contracts/nodeType` 的 `ASK_CHOICES`):
   * "用这一步的指令"要写补充、"重复上一个任务"要说清哪里不对、"退出流程"要说退出后
   * 想干嘛,而"跳过"什么都不用填。边上的岔路**不带** —— 它有一整个 `comment` 输入框
   * 摆在选项下面(见 `WorkflowNodeChoiceEvent.comment`)。
   */
  input?: string;
}

/** An agent tool captured a screenshot (or other image) that should be shown
 *  inline in the conversation. Emitted by Pi's `browser_screenshot` tool via
 *  `ctx.emit`, and by the Codex adapter for native `imageGeneration` items.
 *  Claude's in-process MCP server surfaces images through the normal
 *  tool_result content (parsed by the store). All paths key off
 *  `toolCallId` to attach the image as a block next to the tool_use card. */
export interface BrowserImageEvent {
  type: "browser.image";
  sessionId: string;
  toolCallId: string;
  /** Base64-encoded image bytes (no data: prefix). */
  data: string;
  /** Image MIME type — "image/png" for screenshots; codex-generated images
   *  may also be jpeg/webp/gif. */
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

/**
 * Cross-client session-list sync. `RuntimeManager.emit` only fans out events
 * from INSIDE a turn — a session created, renamed, deleted, archived or pinned
 * from either client (desktop IPC handlers or the mobile RPC) would otherwise
 * never reach the other side, leaving the two session lists diverging until a
 * restart. These events are broadcast over the same two channels (renderer
 * `claude:event` + mobile SSE bus) so every connected client keeps its list
 * in sync.
 *
 * `session.changed` carries a SLIM row: only list-visible fields. The heavy
 * per-session payloads (`turnFiles.before` can hold whole file contents) must
 * not ride a list-sync broadcast. Receivers merge the entry onto an existing
 * row (preserving cached heavy fields) or, for a row they don't have yet,
 * materialize it with nulls for the heavy fields — a freshly-created session
 * has them null anyway.
 */
export type SessionListEntry = Omit<
  Session,
  "contextSnapshot" | "todos" | "subagents" | "planDraft" | "usageHistory" | "turnFiles" | "bookmarks" | "subagentTranscripts"
>;

/** A session row was created or mutated (title / archive / pin / rename …).
 *  The full list-visible row is carried; receivers upsert by id. */
export interface SessionChangedEvent {
  type: "session.changed";
  sessionId: string;
  session: SessionListEntry;
}

/** A session was hard-deleted. Receivers drop the row from every list. */
export interface SessionDeletedEvent {
  type: "session.deleted";
  sessionId: string;
}

/**
 * A repo's git state changed on the host — commit / stage / unstage / push /
 * pull / discard, issued by ANY client (desktop panel or a paired phone).
 * Receivers re-run `git status` / reload the commit history for the matching
 * repoPath, so one client's commit shows up everywhere without a manual
 * refresh. Broadcast through the same two channels as
 * {@link SessionChangedEvent}; `sessionId` is "" (envelope compatibility —
 * see {@link SessionRunningSnapshotEvent}).
 */
export interface GitChangedEvent {
  type: "git.changed";
  sessionId: string;
  /** Absolute path of the repo whose state changed. */
  repoPath: string;
}

/**
 * Cross-client pending-request sync. When one client answers an approval /
 * AskUserQuestion / plan approval, the main-process Deferred resolves exactly
 * once — the OTHER clients (desktop + phones) would keep showing a dialog that
 * can no longer be answered. This event tells every client to close its copy
 * of the dialog for the given requestId. Broadcast through the same two
 * channels as {@link SessionChangedEvent} (renderer `claude:event` + mobile
 * SSE bus), ordered BEFORE the turn continues, so a subsequent request of the
 * same kind can never be confused with the resolved one.
 */
export interface RequestResolvedEvent {
  type: "request.resolved";
  sessionId: string;
  /** The pending request's id — matches the one carried by the originating
   *  approval.request / question.ask / plan.approval_request event. */
  requestId: string;
  /** Which pending-request kind was closed. */
  kind: "approval" | "question" | "plan";
}

/**
 * Authoritative snapshot of which sessions currently have a running turn.
 * Emitted ONLY on the mobile SSE channel, as the first data frame after a
 * (re)connect: the mobile event bus is unbuffered, and a phone that was
 * backgrounded while a turn ran (iOS suspends EventSource) misses the
 * terminal `turn.done` — its client-side `runningBySession` would stay
 * stuck on forever (spinner never stops, slash picker silently disabled).
 * Receiving clients replace their local running-state guesses with this set.
 */
export interface SessionRunningSnapshotEvent {
  type: "session.runningSnapshot";
  /** Not meaningful for a global snapshot; kept for envelope compatibility
   *  (every RuntimeEvent carries a sessionId and the SSE frame mirrors it). */
  sessionId: string;
  /** Every session id that currently has a running turn on the host. */
  running: string[];
  /**
   * 桌面窗口此刻是否开着。开着 = 桌面渲染端经 IPC 无损收到每一个事件,由它
   * **唯一**负责把回合里推出来的消息写回库;手机只读不写 —— 否则 SSE 断过一截的
   * 手机在 turn.done 时会拿缺块的整桶盖掉桌面写好的完整行。关着(macOS 关窗后
   * 主进程还活着、手机照样能发起回合)= 没人写,手机自己写。
   * 可选:老主进程不带这个字段,等同 false(手机沿用旧行为自己写)。
   */
  desktopAttached?: boolean;
}

/**
 * 一个「跟着人走」的设置被某一端改了(键表见 `@contracts/ipc/settingsSync`
 * 的 `SYNCED_SETTING_KEYS`)。主进程在两条写入口(桌面 `setting:set` IPC、手机
 * `setting:set` RPC)写库之后广播。`sessionId` 恒为 ""(信封兼容)。
 *
 * **发起端收不到自己的回声**(见 `main/lib/sessionSync.ts` 的
 * `broadcastSettingChanged`):桌面写的只推手机;手机写的推桌面 + 别的手机,
 * SSE 按 `originDeviceId` 跳过发起的那台。回声会在连续输入时把文本框里的内容
 * 拽回旧值(每敲一个字一次写入,回声晚到一拍)。
 */
export interface SettingChangedEvent {
  type: "setting.changed";
  sessionId: string;
  key: string;
  value: string;
  /** 由哪台配对设备写的;桌面写的不带。只给 SSE 层过滤用。 */
  originDeviceId?: string;
}

/**
 * 项目列表变了(新建 / 删除 / 归档 / 改名 / 置顶 / 分组 / 排序,任一端发起)。
 * 不带行 —— 项目行很轻,接收端直接重拉 `project.list()` 做差异合并(新项目补
 * 会话列表,消失的项目连同它的会话 / 标签一起清掉)。`sessionId` 恒为 ""。
 */
export interface ProjectsChangedEvent {
  type: "projects.changed";
  sessionId: string;
}

/**
 * Cross-client echo of a user prompt. Emitted by the host when ANY client
 * (desktop renderer or a paired phone) sends a turn, so every OTHER client
 * appends the sender's bubble in real time — ahead of the first assistant
 * event of the turn. Without it, a prompt typed on the phone never showed
 * up on the PC until a restart: assistant-side events fan out, but the user
 * message itself lives only in the originator's local store until it is
 * persisted at the turn boundary, and an already-hydrated session never
 * re-fetches. The echo carries the originator's message id / createdAt /
 * display blocks; the originator itself already appended the same id
 * optimistically at send time and ignores the echo by id match. Broadcast
 * through the same two channels as {@link SessionChangedEvent} (renderer
 * `claude:event` + mobile SSE bus).
 */
export interface UserMessageEvent {
  type: "user.message";
  sessionId: string;
  /** The originator's local user-message id (`u_<ts>`). Shared by every
   *  client so the persisted row is identical regardless of which client
   *  writes it first, and so the originator can dedupe the echo. */
  messageId: string;
  /** Wall-clock ms at the originator's send — the ordering key. */
  createdAt: number;
  /** The user message's display blocks (text / image / attachment chips)
   *  exactly as the originator rendered them. Opaque to the contract — the
   *  renderer's Block union lives in the store; receivers cast on ingest,
   *  mirroring how persisted message content is trusted on reload. */
  blocks: unknown[];
  /** Set when this send is an EDIT of an earlier user message: the id of the
   *  message this new bubble replaces. Receiving clients truncate their own
   *  store (and their later persistence) at that message before appending,
   *  so a stale pre-edit tail can't survive on another device. */
  editedMessageId?: string;
}

/**
 * Transient upstream-network issue on the session's model channel. Emitted by
 * the OpenAI-protocol bridge when a request to the real upstream fails with a
 * retryable transport error (connect timeout / reset / refused …) and the
 * bridge's internal retry loop kicks in — the moment where a turn looks hung
 * with no streaming feedback — and again with kind "ok" once a retried
 * request subsequently succeeds. Purely a visibility signal: the retry
 * proceeds regardless, and final failure still reaches the user as the SDK's
 * API-error card (the bridge answers 502 / the upstream status verbatim).
 */
export interface UpstreamIssueEvent {
  type: "upstream.issue";
  sessionId: string;
  kind: "retry" | "ok";
  /** Human-readable transport cause, e.g. "UND_ERR_CONNECT_TIMEOUT: Connect
   *  Timeout Error (…)". Empty for kind "ok". */
  cause: string;
  /** 1-based retry attempt that just failed / attempt count ceiling. */
  attempt: number;
  attempts: number;
}

/**
 * 统一资料库:**一条条目入库成功**。所有导入入口(界面 / MCP 工具的 `addItems`、
 * 本地 PDF 导入 `importPdfFiles`、通用文件导入 `importGenericFiles`)共用这一种事件。
 *
 * ## sessionId 为什么是合成 id "(system)"
 *
 * 导入**不属于任何对话**:它可能来自用户点界面、AI 的 MCP 工具、自动化的后台运行,
 * 甚至是还没开窗口的时候 —— 硬挂到某个会话上会让"这是谁触发的"变成猜谜。但每个
 * `RuntimeEvent` 都要带 sessionId(envelope 兼容,同 `SessionRunningSnapshotEvent` 的
 * 先例),所以给一个**永不与真实会话撞车**的哨兵。桌面渲染端对认不出的类型按未知事件
 * 忽略(没有任何会话叫 "(system)"),它真正的读者是 automation 的「事件发生时」
 * 触发器与钩子(见 `@contracts/hook` 的 `HOOK_EVENT_OF`)。
 */
export interface LibraryItemImportedEvent {
  type: "library.item.imported";
  sessionId: string;
  /** 入库的那条条目。 */
  itemId: string;
  title: string;
  /** 通用文档源路径：attached 为库内相对路径，linked 为来源路径。 */
  filePath?: string;
  /** 若导入时已有 PDF，提供库内相对路径。 */
  pdfPath?: string;
}

/**
 * 统一资料库:**一条条目的 PDF 真下到本地了**。
 *
 * ## 为什么「导入」和「下载完」是两件事
 *
 * 导入只说明"目录里多了这一条",它手上不一定有 PDF —— 下载是随后的一件事(可能要
 * 几十秒、可能要登录态、可能失败重试)。而**想对 PDF 本身做点什么的时机只有下载完
 * 这一个**:转录、抽图表、送进外部 OCR。「导入」那一下文件还不存在,那时动手只会扑空。
 *
 * 早先这条通知是**写死**的:下载线程直接调一个注册进来的函数,而那个函数做的事
 * (本地 pdf.js 抽文本)写在 `main/ipc/library.ts` 里。用户改不了、换不掉,想接自己那套
 * 高质量转录工具也没有入口 —— 只能去动源码。现在它是一个**正式事件**,和导入同一条
 * 通道,于是:钩子听得见、自动化的「事件发生时」触发器听得见,想干什么由用户自己配
 * (内置的「下载完自动转录」那条自动化就是这么搭出来的)。
 *
 * ## 载荷字段为什么只有这几个
 *
 * 全是**能拿去用**的东西:id 能回查整条记录,`pdfPath` 是**库内相对路径**
 * (`papers/ab/cdef….pdf`)—— 绝对路径要消费方自己拼库根,而库根是随数据根变的。
 * 不给绝对路径是有意的:把它写进事件载荷就等于把一台机器的磁盘布局散给钩子脚本,
 * 那些脚本会被分享、会被复制到另一台机器上。
 *
 * ## sessionId 同样是合成哨兵 "(system)"
 *
 * 与 {@link LibraryItemImportedEvent} 同一条理由:下载不属于任何对话(它跑在后台线程
 * 里,可能是应用启动时恢复的队列)。读 `@contracts/hook` 的 `HOOK_EVENT_OF` 那一行。
 */
export interface LibraryItemDownloadedEvent {
  type: "library.item.downloaded";
  sessionId: string;
  /** 下到 PDF 的那条条目。 */
  itemId: string;
  title: string;
  /** PDF 在**库内的相对路径**(`LibraryItem.pdfPath` 的原样)。 */
  pdfPath: string;
  filePath?: string;
}

/**
 * 引擎**自己**报上来的斜杠命令清单（2026-09-21）。
 *
 * ## 为什么要有这个事件
 *
 * 在这之前，输入框里打 `/` 只列得出 `slashCommands.ts` 里**硬编码的四条**
 * （compact / init / browser / sidechat）。而 Claude Code CLI 在每轮的
 * `system/init` 消息里一直带着 `slash_commands` —— 实测 57 条，含 `/usage`
 * `/context` `/model` `/mcp` `/memory` 等等。Mcode 从来没读过这个字段，于是
 * 用户「用不了 claude code 内置的命令」。
 *
 * ## 为什么用事件而不是加一条 RPC
 *
 * 这份清单**不属于**任何一次调用 —— 它是会话启动时引擎自己推过来的（`system/init`
 * 是 CLI 主动发的，不是我们问的）。走 RPC 就得反过来维护一个「清单缓存 + 刷新时机」，
 * 而这个时机会在每次 resume / 重连时错位。顺着事件流走，清单和它所属的会话天然同步。
 *
 * ## 两个数组的分工
 *
 * - `commands` —— 全部命令，进 `/` 菜单。
 * - `terminalCommands` —— 其中「UX 绑在本地终端上」的那几条（CLI 的原话：
 *   `exit`、`statusline` 之类）。SDK 的注释说桌面端**可以**留着，手机端该藏起来。
 *   这里原样带上来，由渲染端决定怎么用 —— 契约层不做取舍。
 */
export interface CommandsAvailableEvent {
  type: "commands.available";
  sessionId: string;
  /** 命令名，不含前导 `/`。顺序照引擎给的顺序（那是它的展示顺序）。 */
  commands: EngineCommandInfo[];
  /** `commands` 的子集，见上。CLI 没标就是空数组。 */
  terminalCommands: string[];
}

/** 引擎报上来的一条斜杠命令。 */
export interface EngineCommandInfo {
  /** 命令名，不含前导 `/`（如 `usage`、`plugin-dev:create-plugin`）。 */
  name: string;
  /**
   * 引擎给的说明。`system/init` 那条路**只有名字没有说明**（实测：它只发
   * `slash_commands: string[]`），要说明得等引擎推 `commands_changed`。
   * 空串 = 还不知道，不是"这个命令没有说明"。
   */
  description: string;
  /** 参数提示，如 `<file>`。没有就是空串。 */
  argumentHint: string;
  /** 别名（`/cost`、`/stats` 都指向 `/usage`）。没有就是空数组。 */
  aliases: string[];
}

/**
 * 引擎执行了一条**本地命令**之后回传的输出（2026-09-21）。
 *
 * 有些斜杠命令不经过模型 —— `/usage`（看用量）、`/context`（看上下文占用）这类
 * 由 CLI 自己就地算完，把结果文本以 `system/local_command_output` 发回来，SDK 的
 * 注释写得很明白：「Displayed as assistant-style text in the transcript」。
 *
 * Mcode 的 dispatch 在此之前把它当**未知 subtype 静默丢弃** —— 于是用户发了
 * `/usage`，那一轮跑完了，界面上却什么都看不见。这条事件就是给它一个落点。
 *
 * 消费端要当**消息正文**渲染（就像模型说了这段话），而不是当通知条 —— 它的内容
 * 是命令的结果本身。
 */
export interface LocalCommandOutputEvent {
  type: "local_command.output";
  sessionId: string;
  /** CLI 给的原文，已含换行。渲染端按纯文本/等宽排版，不要当 Markdown 解析。 */
  content: string;
}

/** The union of all runtime events. */
export type RuntimeEvent =
  | TextDeltaEvent
  | MessageCompleteEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | TodoUpdateEvent
  | AskUserQuestionEvent
  | ModeChangeEvent
  | PlanApprovalRequestEvent
  | PlanUpdateEvent
  | SubagentUpdateEvent
  | SubagentTranscriptEvent
  | WorkflowNodeTranscriptEvent
  | ContextUsageEvent
  | ErrorEvent
  | TurnDoneEvent
  | TurnNoticeEvent
  | TurnIncompleteEvent
  | TurnFilesEvent
  | TurnRewoundEvent
  | CompactResultEvent
  | WorkflowNodeQueuedEvent
  | WorkflowNodeProgressEvent
  | WorkflowNodeResultEvent
  | WorkflowNodeUsageEvent
  | WorkflowNodeChoiceEvent
  | BrowserImageEvent
  | SessionChangedEvent
  | SessionDeletedEvent
  | RequestResolvedEvent
  | SessionRunningSnapshotEvent
  | SettingChangedEvent
  | ProjectsChangedEvent
  | UserMessageEvent
  | UpstreamIssueEvent
  | GitChangedEvent
  | LibraryItemImportedEvent
  | LibraryItemDownloadedEvent
  | CommandsAvailableEvent
  | LocalCommandOutputEvent;
