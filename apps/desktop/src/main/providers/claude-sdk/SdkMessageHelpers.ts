/**
 * `SdkMessageAdapter` 的**信封类型与纯工具**（从 `SdkMessageAdapter.ts` 拆出）。
 *
 * 三样互相独立、对主文件零依赖的东西：
 *  1. SDK 信封接口 —— 只留这个适配器真正要转发的字段（`TaskStartedEnvelope` 等 5 个）；
 *  2. 无状态的纯函数 / 常量 —— `readStr` / `isExcludedTask` / `safeJsonParse` /
 *     `findJsonEnd` / `isQuestionPayload`；
 *  3. `SentinelScanner` —— 从流式文本里切出哨兵 JSON 的独立扫描器。
 *
 * 本文件**不 import 任何东西**（它们是叶子）；被搬的名字加了 `export ` 供主文件取用，
 * 只在 SentinelScanner 内部自用的 `ASK_BEGIN` / `ASK_END` / `findJsonEnd` /
 * `isQuestionPayload` 保持私有。**纯搬迁，声明体逐字节一致。**
 */
/** Minimal envelope for SDKTaskStartedMessage. The full SDK type is rich
 *  (uuid, session_id, workflow_name, prompt, …); we only forward the bits
 *  the renderer needs. Avoids pulling a large union into this file. */
export interface TaskStartedEnvelope {
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  /** CLI-internal task kind. Verified against the bundled binary (2.1.x):
   *  `local_agent` = Task-tool subagent, `local_bash` = background/foreground
   *  bash command tracked as a task, `local_workflow` = script workflow,
   *  `remote_agent` = remote agent. The capsule is a *subagent* roster, so
   *  non-agent kinds are excluded (see NON_AGENT_TASK_TYPES). */
  task_type?: string;
  /** SDK flag: when true the parent agent does not block on this task and it
   *  may continue running after the parent turn's stream ends. */
  is_backgrounded?: boolean;
  /**
   * **主代理交给这个任务的原话**（用户点开一行时最想看的东西）。
   * 只有 Task-tool 子代理会带它；bash 任务不带（它的"原话"就是那行命令，
   * 在 `description` 里）。落进 `SubagentSnapshot.prompt`。
   */
  prompt?: string;
}

/** Minimal envelope for SDKTaskNotificationMessage — 任务**收场**的通知。
 *  与上面两个 envelope 同理：只留这个文件真正要用的几项。 */
export interface TaskNotificationEnvelope {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id?: string;
  /** SDK 的三态。`stopped` = 用户/宿主主动停掉，我们映射成 `killed`。 */
  status: "completed" | "failed" | "stopped";
  /** bash 任务的输出文件（绝对路径）。子代理没有这一项。 */
  output_file?: string;
  summary?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
}

export interface TaskProgressEnvelope {
  type: "system";
  subtype: "task_progress";
  task_id: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  last_tool_name?: string;
  summary?: string;
}

export interface TaskUpdatedEnvelope {
  type: "system";
  subtype: "task_updated";
  task_id: string;
  patch?: {
    status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
}

/** Envelope for the SDK's `api_retry` system message — emitted when an API
 *  request fails with a retryable error (rate_limit / overloaded / server_error
 *  / connection timeout) and the SDK's built-in retry loop will retry after
 *  `retry_delay_ms`. The claude binary retries API errors internally; this
 *  message is the visibility signal. Full shape in sdk.d.ts SDKAPIRetryMessage;
 *  we forward only what we log. */
export interface ApiRetryEnvelope {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
}

/* ─── helpers ─── */

export function readStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 哪些 `task_type` **不进**任务列表。
 *
 * ⚠️ **`local_bash` 在 2026-10-11 从这张名单里拿掉了**：它从前和 `local_workflow` 一起
 * 被排除，理由是"它们会在子代理胶囊里显示成假子代理"（那时唯一的消费者是聊天流的
 * 活动胶囊，那里确实只该有模型分身）。现在右栏「任务列表」页是它的正主 —— 用户要求
 * 那一页和 cc 桌面端一样**同时列 Agent 和 Bash 两类**，所以放它进来。
 *
 * `local_workflow` 仍然排除：那是 cc 内部跑脚本工作流用的，与 mcode 自己的「工作流节点」
 * 是两回事，混进来会和那一组重复。
 *
 * 认不出的 / 缺 `task_type` 的**保持可见**（老 CLI 不发这个字段，将来的新种类也不该
 * 因为"我还没认识它"就从界面上消失）。
 */
export function isExcludedTask(taskType: string | undefined): boolean {
  return taskType === "local_workflow";
}

/** How long the turn-end snapshot (emitTurnEndSnapshot) waits for the
 *  `getContextUsage()` control channel (path B) before falling back to
 *  path C. First-party CLI answers arrive in milliseconds; third-party
 *  gateways have been observed answering after 17-36s with garbage values
 *  (the plausibility gate discards them anyway) — waiting that long only
 *  stalls the snapshot publish. 3s cleanly separates the two. */
export const CONTEXT_USAGE_PATH_B_TIMEOUT_MS = 3_000;

/** Grace period between the settle condition flipping and the stdin-hold
 *  release (see maybeSettle) — covers the CLI's session-state finalization
 *  lag after the last background-agent edge. */
export const SETTLE_GRACE_MS = 1_500;

/** Trailing punctuation that never legitimately ends a COMPLETE final reply:
 *  (full/half-width) colon, comma, enumeration comma, semicolon. When the
 *  turn's LAST assistant message is text-only and ends on one of these, the
 *  model announced a continuation that never arrived — see the
 *  "unfinished-text" branch of maybeEmitTurnIncomplete. */
export const UNFINISHED_TRAILING_RE = /[：:，,、；;]$/;

export function safeJsonParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/* ─── AskUserQuestion sentinel fallback ───────────────────────────────
 * When the environment lacks a native AskUserQuestion tool, we inject a
 * system prompt (see ClaudeAgentSdkProvider) teaching the model to emit
 * sentinel-delimited JSON. This scanner intercepts it from text deltas.
 *
 * This is a simplified copy of the original QuestionSentinelScanner from
 * the legacy ClaudeRuntime. When AskUserQuestion tool is available
 * (capabilities.supportsAskUserQuestion), this scanner is not created.
 */

const ASK_BEGIN = "<<<ASK_USER_QUESTION>>>";
const ASK_END = "<<<END_ASK_USER_QUESTION>>>";

/** Extract balanced JSON end position, or 0 if incomplete. */
function findJsonEnd(buf: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i++) {
    const ch = buf[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { depth++; continue; }
    if (ch === "}") { depth--; if (depth === 0) return i + 1; continue; }
  }
  return 0;
}

/** Quick check: does this JSON parse as a question payload? */
function isQuestionPayload(json: string): boolean {
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return false;
    const questions = (obj as { questions?: unknown }).questions;
    if (Array.isArray(questions)) return questions.length > 0;
    if (questions && typeof questions === "object") {
      return Array.isArray((questions as { item?: unknown }).item);
    }
    return false;
  } catch {
    return false;
  }
}

export class SentinelScanner {
  private buf = "";
  private flushed = 0;
  private completedQuestions: string[] = [];

  push(chunk: string): string {
    this.buf += chunk;
    let safe = "";

    while (true) {
      const remaining = this.buf.slice(this.flushed);
      if (!remaining) break;

      const beginIdx = remaining.indexOf(ASK_BEGIN);
      if (beginIdx >= 0) {
        safe += remaining.slice(0, beginIdx);
        this.flushed += beginIdx;
        const afterBegin = this.buf.slice(this.flushed);
        const endRel = afterBegin.indexOf(ASK_END);
        if (endRel >= 0) {
          const json = this.buf.slice(this.flushed + ASK_BEGIN.length, this.flushed + endRel).trim();
          if (json) this.completedQuestions.push(json);
          this.flushed += endRel + ASK_END.length;
          continue;
        }
        break;
      }

      // Bare JSON fallback (only at message start)
      const bareIdx = remaining.search(/\{\s*"questions"\s*:/);
      if (bareIdx >= 0 && /^\s*$/.test(remaining.slice(0, bareIdx))) {
        safe += remaining.slice(0, bareIdx);
        const jsonStart = this.flushed + bareIdx;
        const jsonEnd = findJsonEnd(this.buf, jsonStart);
        if (jsonEnd > jsonStart) {
          const json = this.buf.slice(jsonStart, jsonEnd).trim();
          if (isQuestionPayload(json)) {
            this.completedQuestions.push(json);
            this.flushed = jsonEnd;
            continue;
          }
        }
        this.flushed += bareIdx;
        break;
      }

      const withhold = ASK_BEGIN.length - 1;
      const tail = remaining.length > withhold ? remaining.slice(0, remaining.length - withhold) : "";
      safe += tail;
      this.flushed += tail.length;
      break;
    }
    return safe;
  }

  takeQuestions(): string[] {
    const q = this.completedQuestions;
    this.completedQuestions = [];
    return q;
  }

  flush(): string {
    const remaining = this.buf.slice(this.flushed);
    this.flushed = this.buf.length;
    return remaining;
  }
}
