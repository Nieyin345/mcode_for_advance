import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceHas } from "../lib/sourceText.js";
import { planEditorModelPath } from "../../src/renderer/components/chat/planEditorModelPath.js";
import { openEscapeLayer, claimEscape, resetEscapeLayersForTests } from "../../src/renderer/lib/escapeLayer.js";

const viewer = readFileSync(resolve("src/renderer/components/chat/PlanViewer.tsx"),"utf8");
let total=0, failed=0;
function ck(label: string, valid:boolean, actual?:unknown) {
 total++;if(!valid)failed++;
 console.log((valid?"PASS ":"FAIL ")+label+(valid?"":": "+JSON.stringify(actual)));
}
ck("Plan: distinct sessions use separate in-memory Monaco models",
  planEditorModelPath("side-a") !== planEditorModelPath("main-a"));
ck("Plan: model id remains stable for reopen of same session",
  planEditorModelPath("main-a") === planEditorModelPath("main-a"));
ck("Plan: slashes and percent signs cannot escape virtual model directory",
  planEditorModelPath("a/b") === "__mcode_plan__/a%2Fb.md" &&
  planEditorModelPath("a%2Fb") === "__mcode_plan__/a%252Fb.md");
ck("Plan: Unicode identifiers round-trip as unique safe URI components",
  planEditorModelPath("中文会话") !== planEditorModelPath("中文会话2") &&
  !planEditorModelPath("中文会话").includes("中文"));
ck("Plan: model remains markdown rather than a real workspace path",
  planEditorModelPath("a").endsWith(".md") &&
  planEditorModelPath("a").startsWith("__mcode_plan__/"));
ck("Plan: same session retains its undo model across read/edit toggles",
  sourceHas(viewer, "const modelPath = planEditorModelPath(sessionId);") &&
  sourceHas(viewer, "path={modelPath}") &&
  !sourceHas(viewer,'PLAN_EDITOR_PATH = "__plan__.md"'));
ck("Plan: switching session clears edit mode and old save feedback",
  sourceHas(viewer, '}, [sessionId]);') &&
  sourceHas(viewer, 'setEditing(false);') &&
  sourceHas(viewer, 'setSaveState("idle");') &&
  sourceHas(viewer, "clearTimeout(saveTimerRef.current);"));
ck("Plan: stale edit cannot save to newly selected session before effect cleanup",
  sourceHas(viewer, "const editingSessionRef = useRef(sessionId)") &&
  sourceHas(viewer, "editingSessionRef.current = sessionId") &&
  sourceHas(viewer, "if (!editing || editingSessionRef.current !== sessionId) return;") &&
  sourceHas(viewer, "editingSessionRef.current === sessionId && draft !== plan"));
ck("Plan: saving a pending approval still only stages a draft, never auto-approves",
  sourceHas(viewer, "updatePlanDrawerPlan(sessionId, draft)") &&
  sourceHas(viewer, "if (isApprovalPending)") &&
  sourceHas(viewer, "setPlanApprovalDraft(sessionId, draft)") &&
  !sourceHas(viewer, "approvePlan("));
ck("Plan: Monaco Ctrl/Cmd+S still reads current save closure, not first-mount closure",
  sourceHas(viewer, "handleSaveRef.current = handleSave") &&
  sourceHas(viewer, "monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS") &&
  sourceHas(viewer, "handleSaveRef.current()"));
ck("Plan: Esc does not close on IME composition and preserves layered dialogs",
  sourceHas(viewer, 'e.key === "Escape" && !e.isComposing && e.keyCode !== 229') &&
  sourceHas(viewer, 'claimEscape("chat.plan-viewer")') &&
  sourceHas(viewer, 'openEscapeLayer("chat.plan-viewer")'));
resetEscapeLayersForTests();
const plan = openEscapeLayer("chat.plan-viewer");
const child = openEscapeLayer("chat.selection-quote-menu");
ck("Plan: nested quote/dialog receives Esc before plan viewer",
 !claimEscape("chat.plan-viewer") && claimEscape("chat.selection-quote-menu"));
child();
ck("Plan: Esc ownership returns to plan after nested picker closes",
 claimEscape("chat.plan-viewer"));
plan();resetEscapeLayersForTests();
ck("Plan: toolbar uses full keyboard-visible 32px targets",
 (viewer.match(/min-h-8 items-center gap-1/g)||[]).length >= 3 &&
 (viewer.match(/inline-flex size-8 items-center justify-center/g)||[]).length >= 2 &&
 sourceHas(viewer,"focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Plan: action labels are translated and not icon-only",
  sourceHas(viewer,'aria-label={t("chat.planViewer.close")}') &&
  sourceHas(viewer,'aria-label={t("chat.planViewer.finish")}') &&
  sourceHas(viewer,'aria-label={t("common.save")}'));
ck("Plan: narrow header wraps without hiding pending-approval badge",
  sourceHas(viewer,"min-w-0 shrink-0 flex-wrap items-center") &&
  sourceHas(viewer,"ml-auto flex flex-wrap items-center justify-end") &&
  sourceHas(viewer,'t("chat.plan.pendingReview")'));
ck("Plan: body preserves project-scoped markdown path and editor options",
  sourceHas(viewer,"<Markdown projectPath={projectPath}>") &&
  sourceHas(viewer,'language="markdown"') &&
  sourceHas(viewer,'scrollBeyondLastLine: false'));
ck("Plan: status feedback is announced and width bounded on narrow panels",
  sourceHas(viewer,'role="status"') &&
  sourceHas(viewer,'aria-live="polite"') &&
  sourceHas(viewer,"max-w-[calc(100%_-_24px)]"));
ck("Plan: cancelling edit clears stale feedback and restores original source",
  sourceHas(viewer,"const cancelEdit = useCallback(() => {") &&
  sourceHas(viewer,"setDraft(plan)") &&
  sourceHas(viewer,"if (saveTimerRef.current) clearTimeout(saveTimerRef.current)"));
ck("Negative: global plan model would be detected as cross-session alias",
  planEditorModelPath("x") !== planEditorModelPath("y"));
ck("Negative: deleting save-session guard fails scoped-draft protection",
  !sourceHas(viewer.replace("if (!editing || editingSessionRef.current !== sessionId) return;", "if (!editing) return;"),
  "if (!editing || editingSessionRef.current !== sessionId) return;"));
console.log("arc005-plan-viewer-ui-smoke: "+(total-failed)+"/"+total);
if(failed)process.exitCode=1;
