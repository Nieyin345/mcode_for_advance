/** ARC-005 composer attachment menu/subchat picker layout.
 * Pure geometry verified with actual inputs; source checks cover the wiring.
 * No user settings, PTYs, browser/Electron or user database operations. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceHas } from "../lib/sourceText.js";
import { subChatPickerPlacement, subChatErrorPlacement } from "../../src/renderer/components/chat/subChatPickerPlacement.js";

const read = (file: string) => readFileSync(resolve("src/renderer/components/chat", file), "utf8");
const picker = read("NewSubChatPicker.tsx");
const menu = read("AttachMenuButton.tsx");
const toolbar = read("ComposerToolbar.tsx");
const toolbarCss = read("ClaudeComposerToolbar.css");
let count = 0;
let failures = 0;
function ck(name: string, ok: boolean, actual?: unknown) {
  count++;
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (!ok && actual !== undefined ? " — " + JSON.stringify(actual) : ""));
}
const place = (left: number, top: number, bottom: number, vw = 900, vh = 800) =>
  subChatPickerPlacement({left, top, bottom, width:32}, vw, vh);

let at = place(30,550,580);
ck("Subchat picker: standard composer opens above and keeps 320px list", at.top === 222 && at.maxHeight === 320, at);
at = place(30,20,50);
ck("Subchat picker: high trigger opens below with whole panel visible", at.top === 58 && at.maxHeight === 320, at);
at = place(890,550,580);
ck("Subchat picker: right-edge trigger clamps left inside screen", at.left === 592 && at.width === 300, at);
at = place(10,10,30,160,100);
ck("Subchat picker: narrow/short window clamps both dimensions", at.width === 144 && at.maxHeight <= 84 && at.top + at.maxHeight <= 92, at);
at = place(10,37,46,160,80);
ck("Subchat picker: constrained small window chooses available upper region", at.maxHeight === 29 && at.top === 8, at);
at = place(20,18,35,420,48);
ck("Subchat picker: height cap never forces previous hardcoded 48px overflow", at.maxHeight <= 32 && at.top + at.maxHeight <= 40, at);
at = place(20,40,60,10,12);
ck("Subchat picker: zero usable space yields nonnegative dimensions", at.width === 0 && at.maxHeight === 0, at);
ck("Subchat picker: uses pure viewport geometry rather than old 48px minimum",
  sourceHas(picker, "subChatPickerPlacement(anchorRect, window.innerWidth, window.innerHeight)") &&
  !sourceHas(picker, "Math.max(48,"));
ck("Subchat picker: recomputes when native and visual viewport resize",
  sourceHas(picker, 'window.addEventListener("resize", remeasure)') &&
  sourceHas(picker, 'window.visualViewport?.addEventListener("resize", remeasure)') &&
  sourceHas(picker, 'window.removeEventListener("resize", remeasure)'));
ck("Subchat picker: remains live, scoped, and keyboard ready",
  sourceHas(picker, 'role="dialog"') &&
  sourceHas(picker, "aria-busy={loading}") &&
  sourceHas(picker, 'role="alert"') &&
  sourceHas(picker, "const pickOption = (opt: Option) =>") &&
  sourceHas(picker, "onPick({ profile: opt.profile, memory: opt.memory })"));
ck("Subchat picker: three distinct creation options remain",
  sourceHas(picker, 'key: "__blank__"') &&
  sourceHas(picker, 'key: `${p.id}:0`') &&
  sourceHas(picker, 'key: `${p.id}:1`'));
ck("Subchat picker: incomplete profiles are not actionable",
  sourceHas(picker, "isSessionAgentProfile(p)") &&
  sourceHas(picker, "agentProfileInstruction(p).length > 0"));
ck("Subchat picker: Escape respects nested-layer arbitration and IME",
  sourceHas(picker, 'claimEscape("chat.new-subchat-picker")') &&
  sourceHas(picker, "if (e.isComposing || e.keyCode === 229) return;"));

let err = subChatErrorPlacement({left:300,top:260,bottom:290},240,70,900,700);
ck("Attachment error: measured card prefers above trigger",err.left === 300 && err.top === 182,err);
err = subChatErrorPlacement({left:300,top:10,bottom:50},240,70,900,700);
ck("Attachment error: near top falls below instead of drawing offscreen",err.top === 58,err);
err = subChatErrorPlacement({left:850,top:300,bottom:320},240,80,900,700);
ck("Attachment error: near right edge clamps by its actual rendered width",err.left === 652,err);
err = subChatErrorPlacement({left:10,top:12,bottom:24},280,180,160,100);
ck("Attachment error: oversize card retains visible origin and bounded scrolling",err.left === 8 && err.top === 8,err);
ck("Attachment error: card observes its real size and viewport resizing",
  sourceHas(menu, "subChatErrorPlacement(anchor, el.offsetWidth, el.offsetHeight,") &&
  sourceHas(menu, "new ResizeObserver(measure)") &&
  sourceHas(menu, 'window.addEventListener("resize", measure)') &&
  sourceHas(menu, "observer?.disconnect()"));
ck("Attachment error: does not use translateY beyond top edge",
  !sourceHas(menu, 'transform: "translateY(-100%)"') &&
  sourceHas(menu, "max-h-[calc(100vh-16px)]"));
ck("Attachment: synchronous duplicate create guard remains intact",
  sourceHas(menu, "if (subChatCreatePendingRef.current) return") &&
  sourceHas(menu, "subChatCreatePendingRef.current = true") &&
  sourceHas(menu, "subChatCreatePendingRef.current = false"));
ck("Attachment: unmounted menu does not mutate state on async create resolution",
  sourceHas(menu, "mountedRef.current = false") &&
  sourceHas(menu, "if (mountedRef.current) setCreatingSubChat(false)") &&
  sourceHas(menu, "if (session && mountedRef.current) onNewSubChat?."));
ck("Attachment: existing new child conversation parameters and failure alert remain",
  sourceHas(menu, "profile: choice.profile ? { id: choice.profile.id, name: choice.profile.name } : null") &&
  sourceHas(menu, "memory: choice.memory") &&
  sourceHas(menu, 'role="alert"'));
ck("Attachment: menu retains all project-file/image/library/command entry points",
  sourceHas(menu, "onClick={onPickFiles}") &&
  sourceHas(menu, "onClick={onPickImages}") &&
  sourceHas(menu, "onClick={onPickLibraries}") &&
  sourceHas(menu, "onClick={onSlashCommand}"));
ck("Attachment: menu minimum targets and wide-window cap follow composer tokens",
  sourceHas(menu, "min-h-8 w-full") &&
  sourceHas(menu, "max-w-[calc(100vw-24px)]"));
ck("Attachment: popup and rows use Claude-like rounded, compact menu geometry",
  sourceHas(menu, "rounded-xl border border-edge bg-surface p-1.5 shadow-[var(--shadow-popover)]") &&
  sourceHas(menu, "rounded-lg px-2.5 py-1.5 text-left text-xs"));
ck("Composer toolbar: one attach entry preserves full downstream callback plumbing",
  sourceHas(toolbar, "<AttachMenuButton") &&
  sourceHas(toolbar, "onNewSubChat={onNewSubChat}") &&
  sourceHas(toolbar, "onSlashCommand={onSlashCommand}"));
ck("Composer toolbar: Claude parity CSS is imported and scoped to the inline pill",
  sourceHas(toolbar, 'import "./ClaudeComposerToolbar.css";') &&
  sourceHas(toolbarCss, ".composer-minipill.claude-composer-toolbar"));
ck("Composer toolbar: narrow widths retain all four container-query compression tiers",
  sourceHas(toolbarCss, "@container composer-toolbar (width < 576px)") &&
  sourceHas(toolbarCss, "@container composer-toolbar (width < 480px)") &&
  sourceHas(toolbarCss, "@container composer-toolbar (width < 384px)") &&
  sourceHas(toolbarCss, "@container composer-toolbar (width < 320px)") &&
  sourceHas(toolbarCss, "grid-template-columns: 0fr"));
ck("Negative: removing geometry usage from picker fails wiring assertion",
  !sourceHas(picker.replace("subChatPickerPlacement(anchorRect, window.innerWidth, window.innerHeight)", "oldPosition()"), "subChatPickerPlacement(anchorRect, window.innerWidth, window.innerHeight)"));
ck("Negative: removing mounted state fence fails rejection guard",
  !sourceHas(menu.replaceAll("mountedRef.current","staleMounted"), "if (mountedRef.current) setCreatingSubChat(false)"));
console.log("arc005-composer-attachment-layout-smoke: " + (count-failures) + "/" + count);
if(failures) process.exitCode = 1;
