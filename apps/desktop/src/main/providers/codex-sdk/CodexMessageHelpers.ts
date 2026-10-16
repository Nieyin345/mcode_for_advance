/**
 * `CodexMessageAdapter` 的**纯工具与载荷类型**（从 `CodexMessageAdapter.ts` 拆出）。
 *
 * 用量相减、计划文本转待办、结果字符串化、变更种类、图片 mime 表与 DataURL 解析、
 * 子代理状态映射与转录块追加、生成图片解析，以及 app-server 的载荷类型 `ThreadItem`。
 * 全是纯函数/类型，只捕获 ECMAScript 内建对象，对适配器类零引用。
 * **纯搬迁，声明逐字节一致。**
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SubagentSnapshot, TranscriptBlock } from "@contracts/runtime";
import type { CodexUsage } from "./codexTokenUsage.js";

export function subtractUsage(a: CodexUsage, b: CodexUsage | null): CodexUsage {
  const d = (x: number | undefined, y: number | undefined): number => Math.max(0, (x ?? 0) - (y ?? 0));
  return {
    inputTokens: d(a.inputTokens, b?.inputTokens),
    cachedInputTokens: d(a.cachedInputTokens, b?.cachedInputTokens),
    outputTokens: d(a.outputTokens, b?.outputTokens),
    reasoningOutputTokens: d(a.reasoningOutputTokens, b?.reasoningOutputTokens),
  };
}

/** "Plan text" (markdown checkbox lines) → todo rows (PlanThreadItem path). */
export function parsePlanTextTodos(text: string): Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority: "medium" }> {
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
export function stringifyResult(v: unknown): string {
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
export function changeKind(kind: unknown): string {
  if (kind && typeof kind === "object") {
    const t = (kind as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return typeof kind === "string" ? kind : "update";
}

export const IMAGE_MIME_BY_EXT: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** data URL (data:image/png;base64,...) → inline image payload, or null when
 *  the URL isn't a base64 image data URL we can render. */
export function parseDataUrlImage(
  url: string,
): { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" } | null {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url.trim());
  if (!m) return null;
  return { mimeType: `image/${m[1]}` as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: m[2].replace(/[\r\n]/g, "") };
}

/** Result strings below this length are treated as status text, not image
 *  data — real base64 payloads are kilobytes at minimum. */
export const BASE64_MIN_LENGTH = 1024;

/** Roster descriptions are one-liners — keep prompts/paths from bloat. */
export const SUBAGENT_DESC_MAX = 120;

export function truncateDesc(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > SUBAGENT_DESC_MAX ? t.slice(0, SUBAGENT_DESC_MAX) + "…" : t;
}

/** CollabAgentStatus → SubagentSnapshot.status. shutdown = closed cleanly by
 *  closeAgent (a normal end); notFound = the agent vanished (failure). */
export function mapCollabStatus(s: string | undefined): SubagentSnapshot["status"] {
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
export function collabResultText(item: Extract<ThreadItem, { type: "collabAgentToolCall" }>): string {
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
export function appendSubagentBlock(blocks: TranscriptBlock[], item: ThreadItem, completed: boolean): TranscriptBlock[] {
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
export function resolveGeneratedImage(
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
