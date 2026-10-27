import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { truncateFileName, attachmentBadge } from "../../src/renderer/components/chat/AttachmentTile.js";
import { sourceHas } from "../lib/sourceText.js";

const read = (s: string) => readFileSync(resolve("src/renderer/components/chat/" + s), "utf8");
const tile = read("AttachmentTile.tsx");
const approval = read("ApprovalPrompt.tsx");
const question = read("QuestionPrompt.tsx");
const plan = read("PlanApprovalPrompt.tsx");
const chatPane = read("ChatPane.tsx");
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
  sourceHas(approval, "const isDangerousTool = toolName.startsWith(APP_DANGER_APPROVAL_PREFIX)") &&
  sourceHas(approval, "const allowAlways = !isDangerousTool"));
/* 【UI 重建 2026-10-27】审批卡的强调方式变了，断言跟着改**意图**而不是字面量。
 *
 * 旧形态：普通卡用 `border-accent/40` + 一圈 accent 阴影，危险卡换成 danger。
 * 新形态（`089085ec`，更接近 Claude）：**普通卡用中性边** `border-edge-input`，
 * **只有危险操作才染 danger**（`border-danger/50` + 图标 + 标题 + 队列徽标）。
 *
 * 为什么新形态更好：审批卡出现得很频繁，每张都带强调色会让「危险」失去区分度。
 * 断言因此钉三件事：
 *  1. 普通卡**不**用 accent 染边（否则强调色贬值）；
 *  2. 危险卡**确实**用 danger 染（边 + 图标 + 标题）；
 *  3. 队列徽标在危险时也染 danger（同一套语义，不只染一半）。 */
ck("Approval: pending card stays neutral; dangerous actions are the only ones marked danger",
  // 普通卡：中性边，不染 accent。
  sourceHas(approval, 'isDangerousTool ? "border-danger/50" : "border-edge-input"') &&
  // 危险卡：边 + 图标 + 标题三处都染 danger（形状一致、只换颜色）。
  sourceHas(approval, 'isDangerousTool ? "text-danger" : "text-accent"') &&
  sourceHas(approval, 'isDangerousTool ? "text-danger" : "text-content"') &&
  // 队列徽标：危险时同样染 danger，不出现「边红了徽标没红」的半套。
  sourceHas(approval, 'isDangerousTool ? "border-danger/50 bg-danger/10 text-danger" : "border-accent/30 bg-accent/10 text-accent"') &&
  // 负控：不许退回「普通卡也染 accent 边」的旧形态。
  !sourceHas(approval, 'isDangerousTool ? "border-danger/50" : "border-accent/40"'));
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
ck("Plan approval: request-scoped 500ms arming blocks fast click/Enter while reject remains immediate",
  sourceHas(plan, "const primaryArmed = useApprovalArming(requestId ?? sessionId)") &&
  sourceHas(plan, "if (!promptActive || !primaryArmed) return;") &&
  sourceHas(plan, "const primaryDisabled = !primaryArmed ||") &&
  sourceHas(plan, 'data-cds="PlanApprovalPrimary"') &&
  sourceHas(plan, "const handleReject = () => {\n    if (!promptActive) return;\n    onReject("));
ck("Plan approval: ChatPane passes the actual request id so a replacement request re-arms",
  sourceHas(chatPane, "requestId={pendingPlanApproval.requestId}") &&
  sourceHas(plan, "useApprovalArming(requestId ?? sessionId)"));

ck("Negative: removing visual focus from selectable answers breaks regression check",
  !sourceHas(question.replaceAll("focus-visible:outline-offset-2 focus-visible:outline-accent", ""),
    "focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Negative: losing the explicit risk approval gate breaks guard predicate",
  !sourceHas(approval.replaceAll("APP_DANGER_APPROVAL_PREFIX", "unsafeOverride"), "APP_DANGER_APPROVAL_PREFIX"));
console.log("arc005-prompt-card-polish-smoke: " + (total-bad) + "/" + total);
if(bad) process.exitCode=1;
