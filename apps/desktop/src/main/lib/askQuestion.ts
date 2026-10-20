/**
 * Shared AskUserQuestion helpers — provider-neutral logic used by both the
 * Claude and Pi providers.
 *
 * Extracted here so the Pi provider's inline extension can register a native
 * AskUserQuestion tool (via `pi.registerTool`) without depending on the Claude
 * SDK adapter internals. The Claude provider keeps using it in `canUseTool`
 * and the sentinel-text fallback scanner.
 */
import type { AskUserQuestionItem } from "@contracts/runtime";
import type { UserInputAnswers } from "@contracts/provider";

/** Trim a value to a string, tolerating non-string input (defensive parse). */
function readStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Parse questions from tool input or sentinel JSON.
 *
 * Tolerates the SDK's `{ questions: { item: [...] } }` wrapper shape (an XML
 * serialization artifact) as well as a plain array. Invalid entries are
 * dropped; an empty array is returned on any structural problem.
 */
export function parseQuestions(input: unknown): AskUserQuestionItem[] {
  if (!input || typeof input !== "object") return [];
  let arr: unknown[] | null = null;
  try {
    // SDK/plugin objects are not necessarily JSON-decoded plain records:
    // getters and Proxies can throw non-Error values while being inspected.
    const raw = (input as { questions?: unknown }).questions;
    if (Array.isArray(raw)) {
      arr = raw;
    } else if (raw && typeof raw === "object" && "item" in raw) {
      const inner = (raw as Record<string, unknown>).item;
      arr = Array.isArray(inner) ? inner : null;
    }
  } catch {
    return [];
  }
  if (!arr) return [];
  const out: AskUserQuestionItem[] = [];
  let count: number;
  try { count = Math.min(arr.length, 128); }
  catch { return []; }
  for (let index = 0; index < count; index++) {
    // Even array index access may be an SDK/plugin getter that throws.
    let item: unknown;
    try { item = arr[index]; }
    catch { continue; }
    if (!item || typeof item !== "object") continue;
    try {
      const obj = item as Record<string, unknown>;
      const question = readStr(obj.question);
      const header = readStr(obj.header) || question.slice(0, 24);
      const multiSelect = obj.multiSelect === true || obj.multiSelect === "true";
      let optsArr: unknown[] | null = null;
      try {
        const rawOpts = obj.options;
        if (Array.isArray(rawOpts)) {
          optsArr = rawOpts;
        } else if (rawOpts && typeof rawOpts === "object" && "item" in rawOpts) {
          const inner = (rawOpts as Record<string, unknown>).item;
          optsArr = Array.isArray(inner) ? inner : null;
        }
      } catch {
        // A broken options getter should not hide a valid question.
      }
      const options: AskUserQuestionItem["options"] = [];
      try {
        const optionCount = Math.min(optsArr?.length ?? 0, 128);
        for (let optionIndex = 0; optionIndex < optionCount; optionIndex++) {
          try {
            const rawOption = optsArr![optionIndex];
            if (!rawOption || typeof rawOption !== "object") continue;
            const option = rawOption as Record<string, unknown>;
            const label = readStr(option.label);
            if (label) options.push({ label, description: readStr(option.description) || undefined });
          } catch {
            // Drop only this malformed index/option, not the question.
          }
        }
      } catch {
        // An untrustworthy option array cannot remove a valid question.
      }
      if (question) out.push({ header, question, multiSelect, options });
    } catch {
      // An invalid SDK accessor affects only its own question.
    }
  }
  return out;
}

/**
 * Format the user's answers back into a model-facing text result. The model
 * treats the AskUserQuestion tool result as the user's reply, so we surface
 * each question + the chosen option label(s).
 *
 * Unanswered questions are reported as "(no answer)" so the model knows which
 * were skipped (the host returns null for dismissed/unanswered questions).
 */
export function formatAnswersForModel(
  answers: UserInputAnswers,
  questions: AskUserQuestionItem[],
): string {
  const lines: string[] = [];
  for (const q of questions) {
    // Answers are a user-owned map. A question named "constructor" or
    // "toString" must not pick up Object.prototype as a fake user choice.
    let answer: string | null = null;
    try {
      const v = Object.prototype.hasOwnProperty.call(answers, q.question)
        ? answers[q.question]
        : undefined;
      if (typeof v === "string") answer = v;
      else if (Array.isArray(v) && v.every(item => typeof item === "string")) {
        answer = v.join(", ");
      }
    } catch {
      // A malformed renderer answer is not proof of a user choice.
    }
    lines.push(`${q.question}: ${answer ?? "(no answer)"}`);
  }
  return lines.join("\n");
}

/**
 * System prompt teaching the model to use the NATIVE AskUserQuestion tool
 * (Pi provider — the tool is registered by the inline extension). Deliberately
 * does NOT mention the sentinel format: telling the model to "MUST emit this
 * EXACT format" while a native tool exists makes the two behaviors compete.
 */
export const ASK_NATIVE_TOOL_PROMPT = [
  `## 向用户提问`,
  `当需要用户在选项间做选择或补充关键信息时,调用 AskUserQuestion 工具提问,而不是用自由文本罗列问题。`,
  `questions 数组每项:header(≤12 字符短标签)、question(完整问题)、multiSelect(是否可多选)、options(每项含 label + description)。`,
  `调用后停止生成,等待用户回答;不要自问自答。`,
].join("\n");

/**
 * System prompt describing the sentinel-delimited JSON format the model should
 * emit when no native AskUserQuestion tool is available (Claude sentinel-text
 * fallback — injected only when `supportsAskUserQuestion` is false). The Pi
 * provider uses `ASK_NATIVE_TOOL_PROMPT` above instead.
 */
export const ASK_SYSTEM_PROMPT = [
  `When you need to ask the user a question or need them to choose between options, you MUST emit it in this EXACT format and nothing else on those lines:`,
  `<<<ASK_USER_QUESTION>>>`,
  `a single line of JSON with this shape: {"questions":[{"header":"short label","question":"the full question","multiSelect":false,"options":[{"label":"A","description":"why A"},{"label":"B","description":"why B"}]}]}`,
  `<<<END_ASK_USER_QUESTION>>>`,
  `Rules: emit ONLY the JSON between the sentinels (no markdown fences, no extra text on those lines). Use multiSelect:true when multiple choices are allowed. After emitting, STOP and wait for the user's answer — do not answer your own question.`,
].join(" ");
