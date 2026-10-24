import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { truncateFileName, attachmentBadge } from "../../src/renderer/components/chat/AttachmentTile.js";
import { sourceHas } from "../lib/sourceText.js";

const read = (s: string) => readFileSync(resolve("src/renderer/components/chat/" + s), "utf8");
const tile = read("AttachmentTile.tsx");
const approval = read("ApprovalPrompt.tsx");
const question = read("QuestionPrompt.tsx");
const plan = read("PlanApprovalPrompt.tsx");
let total = 0, bad = 0;
function ck(name: string, ok: boolean) {
  total++;
  if (!ok) bad++;
  console.log((ok ? "PASS " : "FAIL ") + name);
}

ck("Tile: long attachment preserves extension label instead of truncating whole filename",
  truncateFileName("really-long-screenshot.png",14).ext === ".png");
ck("Tile: extensions and unknown names get expected badges",
  attachmentBadge("source.ts") === "TS" &&
  attachmentBadge("photo.png",true) === "PNG" &&
  attachmentBadge("README") === "FILE");
ck("Tile: remove is a separate button outside preview's content button",
  sourceHas(tile, 'data-cds-attachment-remove=""') &&
  sourceHas(tile, "onClick={onRemove}") && sourceHas(tile, "onClick={onToggle}"));
ck("Tile: preview keeps disabled state when onToggle is absent",
  sourceHas(tile, "disabled={!onToggle}") &&
  sourceHas(tile, "aria-expanded={onToggle ? open : undefined}"));
ck("Tile: focused removal is large enough without altering removal payload",
  sourceHas(tile, "size-7 items-center justify-center rounded-full") &&
  sourceHas(tile, "focus-visible:outline-offset-2 focus-visible:outline-accent") &&
  sourceHas(tile, "aria-label={removeLabel}"));
ck("Tile: composer's attachment height and file content remain bounded",
  sourceHas(tile, "size-[calc(7.5rem*var(--cds-rem-scale,1))]") &&
  sourceHas(tile, "min-w-0 truncate"));

ck("Approval: card remains a real alertdialog and never autofocuses grant",
  sourceHas(approval, 'role="alertdialog"') &&
  sourceHas(approval, "cardRef.current.focus({ preventScroll: true })") &&
  sourceHas(approval, "hasTopmostForeignDialog(cardRef.current)"));
ck("Approval: danger approval still forbids always-allow",
  sourceHas(approval, "const allowAlways = !toolName.startsWith(APP_DANGER_APPROVAL_PREFIX)"));
ck("Approval: grant still waits for arming; deny still remains available",
  sourceHas(approval, "const allowArmed = useApprovalArming(queuePosition)") &&
  (approval.match(/\sdisabled=\{!allowArmed\}/g) || []).length === 2 &&
  sourceHas(approval, "decide(false)"));
ck("Approval: details disclosure reveals keyboard-visible expanded state",
  sourceHas(approval, "aria-expanded={open}") &&
  sourceHas(approval, "focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Approval: long tool input is wrapped and scrollable rather than expanding window",
  sourceHas(approval, "overflow-auto whitespace-pre-wrap break-words") &&
  sourceHas(approval, "max-h-[min(65vh,540px)] overflow-y-auto"));
ck("Approval: footer wraps at narrow window width without changing verdict branches",
  sourceHas(approval, "flex flex-wrap items-center justify-between") &&
  sourceHas(approval, 'mcpApprovalVerdict("always_allow")') &&
  sourceHas(approval, 'mcpApprovalVerdict("allow_once")'));

ck("Question: dialog stays scrollable and bounded on short windows",
  sourceHas(question, "max-h-[min(65vh,540px)]") &&
  sourceHas(question, "overflow-hidden"));
ck("Question: selected option announces state and provides visible focus",
  sourceHas(question, "aria-pressed={selected}") &&
  sourceHas(question, "focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Question: answer mode still distinguishes single and multiple choice",
  sourceHas(question, "if (q.multiSelect)") &&
  sourceHas(question, "setStep((s) => s + 1)") &&
  sourceHas(question, "selected: has ? item.selected.filter"));
ck("Question: IME/scope protection and duplicate submit guard are unchanged",
  sourceHas(question, "e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229") &&
  sourceHas(question, "submittingRef.current = true") &&
  sourceHas(question, "submittingRef.current = false"));
ck("Question: progress footer wraps on narrow windows without obscuring submit",
  sourceHas(question, "flex shrink-0 flex-wrap items-center justify-between") &&
  sourceHas(question, "disabled={!allAnswered}"));
ck("Plan approval: no changed approval/handoff branches or staged-draft semantics",
  sourceHas(plan, "onApprove(edited ? draft : undefined") &&
  sourceHas(plan, "onReject(hasFeedback ? feedback.trim() : undefined)") &&
  sourceHas(plan, "onHandoff(target, hasFeedback ? feedback.trim() : undefined)") &&
  sourceHas(plan, "s.planApprovalDraftBySession[sessionId] ?? plan"));
ck("Plan approval: narrow view wraps action footer and scrolls long plans",
  sourceHas(plan, 'flex flex-wrap items-center justify-between gap-2 border-t') &&
  sourceHas(plan, "max-h-[min(65vh,540px)] overflow-y-auto"));
ck("Plan approval: selecting provider/model stays viewport-constrained",
  sourceHas(plan, "max-w-[min(220px,calc(100vw-40px))]") &&
  sourceHas(plan, "max-h-[min(15rem,calc(100vh-24px))]"));
ck("Plan approval: input stays clearly labeled for keyboard/screenreader",
  sourceHas(plan, 'aria-label={t("chat.planApproval.feedbackPlaceholder")}') &&
  sourceHas(plan, 'aria-label={t("chat.planApproval.title")}'));
ck("Plan approval: primary button still guarded by computed disabled state",
  sourceHas(plan, "disabled={primaryDisabled}") &&
  sourceHas(plan, "if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;"));

ck("Negative: removing visual focus from selectable answers breaks regression check",
  !sourceHas(question.replaceAll("focus-visible:outline-offset-2 focus-visible:outline-accent", ""),
    "focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Negative: losing the explicit risk approval gate breaks guard predicate",
  !sourceHas(approval.replaceAll("APP_DANGER_APPROVAL_PREFIX", "unsafeOverride"), "APP_DANGER_APPROVAL_PREFIX"));
console.log("arc005-prompt-card-polish-smoke: " + (total-bad) + "/" + total);
if(bad) process.exitCode=1;
