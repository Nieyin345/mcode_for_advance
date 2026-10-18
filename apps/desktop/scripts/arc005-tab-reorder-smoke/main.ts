import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { keyboardReorderTarget, handleTabReorderKeyDown, type TabReorderKeyEvent } from "../../src/renderer/components/layout/tabKeyboardReorder.js";
let passed = 0, failed = 0;
const source = (p: string) => readFileSync(resolve("src/renderer/components", p), "utf8");
function check(name: string, value: boolean) {
  if (value) { passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name); }
}
const sessions = source("layout/SessionTabs.tsx");
const files = source("ide/OpenTabsBar.tsx");
const unified = source("layout/UnifiedTabsBar.tsx");
const helper = source("layout/tabKeyboardReorder.ts");
check("session tab has keyboard reorder callback", sessions.includes("onKeyboardReorder={(key) =>") && sessions.includes("keyboardReorderTarget(key"));
check("editor tab has keyboard reorder callback", files.includes("onKeyboardReorder={(key) =>") && files.includes("keyboardReorderTarget(key"));
check("unified session group has reorder callback", unified.includes("reorderTab(from, target)") && unified.includes("keyboardReorderTarget(key"));
check("unified editor group has reorder callback", unified.includes("reorderIdeFile(from, target)") && unified.includes("keyboardReorderTarget(key"));
check("session tab exposes alt arrows and position", sessions.includes('aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"') && sessions.includes("aria-posinset={position}") && sessions.includes("aria-setsize={setSize}"));
check("file tab exposes alt arrows and position", files.includes('aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"') && files.includes("aria-posinset={position}") && files.includes("aria-setsize={setSize}"));
check("keyboard handler is shared, not two diverging copies", sessions.includes("handleTabReorderKeyDown(e, onKeyboardReorder)") && files.includes("handleTabReorderKeyDown(e, onKeyboardReorder)"));
check("keyboard never activates or closes tabs", !helper.includes(".click(") && helper.includes("event.stopPropagation()"));
check("modifiers, composing IME and close-button keypress guarded in one place", helper.includes("event.target !== event.currentTarget") && helper.includes("event.nativeEvent.isComposing") && helper.includes("event.ctrlKey") && helper.includes("event.shiftKey") && helper.includes("event.metaKey"));
// E1: exercise the production keyboard target selector with realistic tab-group boundaries.
// The source contract is "one group per caller"; session -> file crossover must
// be impossible even in the unified bar.
check("Alt+Right moves the first tab exactly one step",keyboardReorderTarget("ArrowRight",0,3)===1);
check("Alt+Left moves the last tab exactly one step",keyboardReorderTarget("ArrowLeft",2,3)===1);
check("First tab cannot move left, no wrapping into other tab groups",keyboardReorderTarget("ArrowLeft",0,3)===null);
check("Last tab cannot move right, no wrapping into plan/file groups",keyboardReorderTarget("ArrowRight",2,3)===null);
check("Unknown keys never reorder or close",keyboardReorderTarget("Delete",1,3)===null && keyboardReorderTarget("Enter",1,3)===null);
check("Single tab and empty groups never reorder",keyboardReorderTarget("ArrowRight",0,1)===null && keyboardReorderTarget("ArrowLeft",0,0)===null);
check("Corrupt index and list size fail closed",keyboardReorderTarget("ArrowLeft",-1,5)===null && keyboardReorderTarget("ArrowRight",1,1)===null &&
  keyboardReorderTarget("ArrowRight",1.5,3)===null && keyboardReorderTarget("ArrowRight",0,Number.NaN)===null);
// E1: actual shared production event handler, with a fake focused DOM node.
// This does not mount the whole Electron app; no real file/session is accessed.
let prevented = 0;
let stopped = 0;
let revealed = 0;
let moved: string[] = [];
const tab = { scrollIntoView: () => { revealed++; } } as unknown as HTMLElement;
const eventFor = (patch: Partial<TabReorderKeyEvent> = {}): TabReorderKeyEvent => ({
  key: "ArrowRight", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
  currentTarget: tab, target: tab,
  nativeEvent: { isComposing: false, keyCode: 39 },
  preventDefault: () => { prevented++; },
  stopPropagation: () => { stopped++; },
  ...patch,
});
const prevAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  callback(0);
  return 1;
}) as typeof requestAnimationFrame;
try {
  const callback = (key: string) => { moved.push(key); };
  check("Real handler consumes focused Alt+Right without mouse activation",
    handleTabReorderKeyDown(eventFor(), callback) === true &&
    moved.join() === "ArrowRight" && prevented === 1 && stopped === 1 && revealed === 1);
  const base = moved.length;
  check("Unmodified ArrowRight remains for normal Tab navigation",
    !handleTabReorderKeyDown(eventFor({ altKey: false }), callback) && moved.length === base);
  check("Ctrl/Meta/Shift modified keys are not stolen",
    !handleTabReorderKeyDown(eventFor({ ctrlKey: true }), callback) &&
    !handleTabReorderKeyDown(eventFor({ metaKey: true }), callback) &&
    !handleTabReorderKeyDown(eventFor({ shiftKey: true }), callback) && moved.length === base);
  check("IME composition and legacy keyCode 229 are ignored",
    !handleTabReorderKeyDown(eventFor({ nativeEvent: { isComposing: true, keyCode: 39 } }), callback) &&
    !handleTabReorderKeyDown(eventFor({ nativeEvent: { isComposing: false, keyCode: 229 } }), callback) &&
    moved.length === base);
  check("Nested close button is not mistaken for tab reorder",
    !handleTabReorderKeyDown(eventFor({ target: {} as EventTarget }), callback) && moved.length === base);
  check("Enter, Space and unrelated keys do not reorder or close",
    !handleTabReorderKeyDown(eventFor({ key: "Enter" }), callback) &&
    !handleTabReorderKeyDown(eventFor({ key: " " }), callback) &&
    !handleTabReorderKeyDown(eventFor({ key: "Delete" }), callback) &&
    moved.length === base && prevented === 1 && stopped === 1 && revealed === 1);
} finally {
  if (prevAnimationFrame) globalThis.requestAnimationFrame = prevAnimationFrame;
  else delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
}
console.log(`arc005-tab-reorder-smoke: ${passed}/${passed+failed}`);
if(failed) process.exitCode=1;
