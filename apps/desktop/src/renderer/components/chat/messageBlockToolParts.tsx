/**
 * `MessageBlocks.tsx` 尾部的**工具卡助手**（从 `MessageBlocks.tsx` 拆出）。
 *
 * 一整套「工具调用怎么画成一张卡」的纯件：共用的图标表（`TOOL_ICON_MAP` / `ToolIcon`）、
 * 标题与摘要（`summarize` / `tr` / `resultPreview` / `truncateResult` / `safeStringify`）、
 * 时间与行数格式（`fmtClock` / `fmtDuration` / `countContentLines`）、以及从工具入参里
 * 取路径与判型（`isEditInput` / `isWriteInput` / `pathField` / `extractToolFilePath` /
 * `isImageBlock`）。
 *
 * 它们与 `MessageBlocks.tsx` 里那些组件只靠 props 往来：这层是"工具箱"，
 * 不持有会话状态、也不渲染整条消息。**纯搬迁，函数体逐字节一致。**
 *
 * ⚠️ `toolSummary` **不在这里** —— 它从 `./activityShared.js` 来，`MessageBlocks.tsx`
 * 尾部那对 `import` + `export` 是**再导出**（放那里是为了避开循环依赖），原地没动。
 */
import { countLines } from "@renderer/lib/lineDiff.js";
import { safeStringify } from "./toolInputSerialize.js";
export { safeStringify };
import { useState, useMemo, type ComponentType } from "react";
import {
  IconFileSearch,
  IconFilePlus,
  IconReplace,
  IconNotebook,
  IconTerminal,
  IconSearch,
  IconListCheck,
  IconClipboard,
  IconHelpCircle,
  IconWorldSearch,
  IconWorldWww,
  IconAlertTriangle,
  PiRobot,
  IconRobot,
} from "@renderer/lib/icons.js";
import { cn } from "@renderer/lib/cn.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { translate, useI18n, type MessageId } from "@renderer/lib/i18n/index.js";

export function summarize(text: string): string {
  const t = text.trim();
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

/** Line count for the Write card's "N 行" badge when there is no pre-turn
 *  snapshot to diff against. Thin wrapper over the shared {@link countLines}
 *  (lib/lineDiff.ts) so this badge, the adjacent +N/-M diff, and every other
 *  "N 行" in the app all agree that a final `\n` is a terminator, not a
 *  phantom empty line. */
export function countContentLines(content: string): number {
  return countLines(content);
}

/** Format a wall-clock ms timestamp as HH:MM:SS (local time). Mirrors the
 *  same-named helper in ChatPane — duplicated here so TurnPanel is
 *  self-contained (ChatPane will stop rendering TurnStatRow above the
 *  panel, so the formatting ownership moves into the panel header). */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a duration (ms) compactly: <1s → "<1s", <60s → "12.3s",
 *  <60m → "1m 23s", else → "1h 05m". Mirrors ChatPane's helper. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}

/** Resolve a left-glyph icon for a tool-use block by its name. Unknown names
 *  (incl. MCP `mcp__*` tools) fall back to the generic robot (`IconRobot`).
 *
 *  Mapping rationale:
 *   - Read / Glob   -> file-search (looking up files by path or pattern)
 *   - Write         -> file-plus  (creating / overwriting a file)
 *   - Edit          -> replace    (string-replace edit)
 *   - MultiEdit     -> replace    (batched string-replace edits)
 *   - NotebookEdit  -> notebook   (Jupyter notebook edit)
 *   - Bash / shell  -> terminal   (command shell)
 *   - Grep          -> search     (content search)
 *   - TodoWrite et al -> list-check (task list)
 *   - Task          -> robot      (subagent spawn)
 *   - WebSearch     -> world-search
 *   - WebFetch      -> world      (fetch a URL)
 *   - AskUserQuestion -> help-circle
 *   - Enter/ExitPlanMode -> clipboard (matches the plan card glyph)
 *   - default       -> robot      (generic agent) */
const TOOL_ICON_MAP: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  Read: IconFileSearch,
  Glob: IconFileSearch,
  Write: IconFilePlus,
  Edit: IconReplace,
  MultiEdit: IconReplace,
  NotebookEdit: IconNotebook,
  Bash: IconTerminal,
  PowerShell: IconTerminal,
  Grep: IconSearch,
  TodoWrite: IconListCheck,
  TaskCreate: IconListCheck,
  TaskUpdate: IconListCheck,
  Task: PiRobot,
  WebSearch: IconWorldSearch,
  WebFetch: IconWorldWww,
  AskUserQuestion: IconHelpCircle,
  EnterPlanMode: IconClipboard,
  ExitPlanMode: IconClipboard,
  // Pi (lowercase) aliases — Pi's tool names are lowercase (read/grep/bash/…);
  // map them to the same glyphs as their Claude equivalents so pi tool cards
  // get semantic icons instead of falling back to the generic tools glyph.
  read: IconFileSearch,
  find: IconFileSearch, // Pi's glob equivalent
  ls: IconFileSearch,
  bash: IconTerminal,
  grep: IconSearch,
  edit: IconReplace,
  write: IconFilePlus,
};

/** The left-side glyph of an action card. Sized 13 to sit between the 12px
 *  status icon and the label without dominating the row. Exported so the
 *  current-operation ticker (CurrentOpTicker) can reuse the same
 *  icon mapping instead of duplicating it. */
export function ToolIcon({ name, className }: { name: string; className?: string }) {
  const Icon = TOOL_ICON_MAP[name] ?? IconRobot;
  return <Icon size={13} className={cn("shrink-0", className)} />;
}

/** Locale-aware text for module-level helper functions (no hook access).
 *  Reads the current locale at call time — these helpers run during render of
 *  components subscribed via useI18n, so a locale flip re-renders them with
 *  fresh strings. */
export function tr(key: MessageId): string {
  return translate(useSessionStore.getState().locale, key);
}

export function truncateResult(v: unknown): string {
  const s = safeStringify(v);
  return s.length > 2000 ? s.slice(0, 2000) + "\n…" + tr("chatStream.truncatedSuffix") : s;
}

/**
 * Like truncateResult, but strips image content blocks (which carry raw base64
 * that would flood the card as thousands of chars of JSON). When a screenshot
 * was captured, the image itself renders as an inline `kind:"image"` block next
 * to the card; here we only need a short textual stand-in so the Result panel
 * stays readable. Handles both MCP (`{type:"image",data,mimeType}`) and
 * Anthropic (`{type:"image",source:{...}}`) image shapes.
 */
export function isImageBlock(b: unknown): boolean {
  return !!b && typeof b === "object" && (b as { type?: string }).type === "image";
}
export function resultPreview(v: unknown): string {
  // Normalize: Pi forwards the AgentToolResult wrapper { content: [...], details }
  // as the tool result; unwrap to the content array so the image-stripping below
  // works uniformly for both Pi and Claude.
  const blocks = Array.isArray(v)
    ? v
    : v && typeof v === "object" && Array.isArray((v as { content?: unknown }).content)
      ? (v as { content: unknown[] }).content
      : null;
  if (blocks) {
    const filtered = blocks.filter((b) => !isImageBlock(b));
    if (filtered.length !== blocks.length) {
      // Had at least one image — render the remaining text blocks, plus a
      // marker so the user knows a screenshot was elided (rendered above).
      const texts = filtered
        .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
        .map((b) => (b as { text?: string }).text ?? "");
      return texts.length > 0 ? truncateResult(texts.join("\n")) + "\n" + tr("chatStream.imageRenderedAbove") : tr("chatStream.imageRenderedAbove");
    }
    // No image: stringify the (possibly unwrapped) content array for display.
    return truncateResult(blocks);
  }
  return truncateResult(v);
}

/* ─── type guards ───
 * Edit and Write have well-known input shapes from the Claude Agent SDK
 * (verified against docs/claude-stream-json.md). We narrow the generic
 * `unknown` Block input here so EditToolCard/WriteToolCard can render
 * structured content instead of falling back to the JSON dump. */

/** Edit tool input: { file_path, old_string, new_string }. */
export function isEditInput(
  i: unknown,
): i is { file_path: string; old_string: string; new_string: string } {
  if (!i || typeof i !== "object") return false;
  const o = i as Record<string, unknown>;
  return (
    typeof o.file_path === "string" &&
    typeof o.old_string === "string" &&
    typeof o.new_string === "string"
  );
}

/** Write tool input: { file_path, content }. */
export function isWriteInput(i: unknown): i is { file_path: string; content: string } {
  if (!i || typeof i !== "object") return false;
  const o = i as Record<string, unknown>;
  return typeof o.file_path === "string" && typeof o.content === "string";
}

/** Pull a single-file path out of a tool input, accepting either Claude's
 *  `file_path` or Pi's `path` field (Pi's read/write/edit use `path`). Used by
 *  extractToolFilePath to decide whether the card's summary line should
 *  render as a clickable file link. */
export function pathField(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.path === "string") return o.path;
  return null;
}

/** Extract a `file_path` from a tool's input when the tool is one that
 *  operates on a single file (Read / Write / Edit). Returns null for tools
 *  whose summary is not a path (Bash, Grep, Glob, etc.) so GenericToolCard
 *  renders their plain-text summary instead of a link. Reuses the Edit/Write
 *  type guards and adds a plain Read fallback. Accepts both Claude
 *  (capitalized) and Pi (lowercase) tool names. */
export function extractToolFilePath(toolName: string, input: unknown): string | null {
  // Claude (Edit/Write are narrowed first so the structured cards get the
  // exact field; Read falls through to the lenient pathField).
  if (toolName === "Edit" && isEditInput(input)) return input.file_path;
  if (toolName === "Write" && isWriteInput(input)) return input.file_path;
  if (toolName === "Read") return pathField(input);
  // Pi (lowercase). Pi's edit input is { path, edits:[…] } and write is
  // { path, content } — both carry `path`, so the lenient pathField covers
  // them without needing pi-specific type guards.
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return pathField(input);
  }
  return null;
}
