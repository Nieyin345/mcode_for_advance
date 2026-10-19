/** ARC-005: keyboard accessible recorder and same-pointer gesture lifecycle. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recorderKeyDecision } from "../../src/renderer/components/settings/recorderCaptureKeys.js";

let total = 0, failed = 0;
function check(name: string, good: boolean, details?: unknown): void {
  total++;
  console.log("  " + (good ? "PASS" : "FAIL") + " " + name +
    (good ? "" : " — " + JSON.stringify(details)));
  if (!good) failed++;
}
function key(k: string, mode: "recording" | "conflict", action: boolean, mods: Record<string, boolean> = {}) {
  return recorderKeyDecision(mode, {
    key: k, ctrlKey: !!mods.ctrlKey, metaKey: !!mods.metaKey, altKey: !!mods.altKey,
  }, action);
}
check("Shortcut recording preserves Tab navigation", key("Tab", "recording", false) === "pass");
check("Conflict prompt preserves Shift+Tab navigation", key("Tab", "conflict", false) === "pass");
check("Esc cancels recording before SettingsPage can close", key("Escape", "recording", false) === "cancel");
check("Esc also cancels the conflict prompt", key("Escape", "conflict", true) === "cancel");
check("Recorder Cancel button Enter uses native activation", key("Enter", "recording", true) === "pass");
check("Conflict Confirm button Space uses native activation", key(" ", "conflict", true) === "pass");
check("Recorder Ctrl+Enter is still captured as a chord", key("Enter", "recording", true, {ctrlKey: true}) === "capture");
check("Conflict prompt blocks unrelated shortcut Enter", key("Enter", "conflict", false) === "swallow");
check("Raw chord while recording does not leak to app", key("k", "recording", false, {metaKey: true}) === "capture");
check("Raw chord while confirming is swallowed", key("k", "conflict", false, {metaKey: true}) === "swallow");

const src = (name: string) => readFileSync(resolve(process.cwd(), "src/renderer/components/settings", name), "utf8");
const shortcut = src("ShortcutRecorder.tsx");
const gesture = src("GestureRecorder.tsx");

check("Shortcut recorder actually gates real event with shared policy", shortcut.includes('recorderKeyDecision(mode, e,') && shortcut.includes('decision === "pass"'));
check("Shortcut recorder focuses Cancel/Confirm", shortcut.includes("cancelButtonRef.current?.focus()") && shortcut.includes("confirmButtonRef.current?.focus()"));
check("Shortcut recorder restores Modify focus only after interaction", shortcut.includes("modifyButtonRef.current?.focus()") && shortcut.includes("wasActiveRef.current"));
check("Shortcut recorder distinguishes own button targets", shortcut.includes("e.target === cancelButtonRef.current") && shortcut.includes("e.target === confirmButtonRef.current"));

check("Gesture recorder applies identical keyboard gate", gesture.includes('recorderKeyDecision(mode, e,') && gesture.includes('decision === "pass"'));
check("Gesture recorder focuses Cancel/Confirm", gesture.includes("cancelButtonRef.current?.focus()") && gesture.includes("confirmButtonRef.current?.focus()"));
check("Gesture recorder restores Modify focus only after interaction", gesture.includes("modifyButtonRef.current?.focus()") && gesture.includes("wasActiveRef.current"));
check("Gesture recorder ties move/up to armed pointer", gesture.includes("e.pointerId !== activePointerId") && gesture.includes("activePointerId = e.pointerId"));
check("Gesture recorder cancels on pointercancel/blur", gesture.includes('"pointercancel", onCancel') && gesture.includes('"blur", onBlur') && gesture.includes("resetStroke()"));
check("Gesture recorder samples release position", gesture.includes("pts.push({ x: e.clientX, y: e.clientY });") && gesture.includes("const seq = recognizeGesture(pts);"));
check("Gesture recorder cannot start capture in conflict mode", gesture.includes('if (mode !== "recording" || !e.isPrimary') && gesture.includes("if (dragging) return;"));
check("Gesture recorder preserves context menu in conflict state", gesture.includes('if (mode !== "recording" || button !== 2) return;'));


// Runtime and recorder must both ignore events from a different pointer.
// Also test that a stroke whose only final sample is pointerup remains visible.
const runtime = readFileSync(resolve(process.cwd(), "src/renderer/hooks/useMouseGestures.ts"), "utf8");
check("Global gestures bind a pointerId at trigger press", runtime.includes("activePointerId = e.pointerId"));
check("Global gestures ignore foreign pointermove and pointerup", runtime.includes("e.pointerId !== activePointerId") && runtime.includes("if (armed) return;"));
check("Global gesture cancellation ignores another pointer", runtime.includes("if (armed && e.pointerId === activePointerId) endStroke()"));
check("Global gestures include final pointerup coordinate", runtime.includes("points.push({ x: e.clientX, y: e.clientY });") && runtime.includes("const seq = active ? recognizeGesture(points) : [];"));
check("Global gesture release clears pointer owner", runtime.includes("activePointerId = null;"));

const { recognizeGesture } = await import("../../src/renderer/lib/gestures.js");
check("Release-only fast horizontal stroke recognizes R", recognizeGesture([{ x: 0, y: 0 }, { x: 90, y: 0 }]).join(",") === "R");
check("Release-only fast vertical stroke recognizes D", recognizeGesture([{ x: 0, y: 0 }, { x: 0, y: 90 }]).join(",") === "D");

// The global keyboard listener must not steal IME composition or text
// selection by treating Shift-only chords as editor commands.
const shortcutsSource = readFileSync(resolve(process.cwd(), "src/renderer/lib/shortcuts.ts"), "utf8");
const globalKeys = readFileSync(resolve(process.cwd(), "src/renderer/hooks/useGlobalShortcuts.ts"), "utf8");
check("Global shortcuts skip IME composition", globalKeys.includes("e.isComposing") && globalKeys.includes('e.key === "Process"') && globalKeys.includes("e.keyCode === 229"));
check("Gesture capture suppresses global keyboard shortcuts before its own listener runs", globalKeys.includes("useSessionStore.getState().gestureRecording) return;"));
check("Editable target guard does not treat bare Shift as a command modifier", !shortcutsSource.includes("return a.cmd || a.shift || a.alt || isFunctionKey(a.key);"));

// Platform module needs a navigator stub in a headless Node renderer smoke.
if (!("navigator" in globalThis)) Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Win32", maxTouchPoints: 0 } });
const { shouldDispatchInEditable } = await import("../../src/renderer/lib/shortcuts.js");
const chord = (key: string, cmd: boolean, shift: boolean, alt: boolean) => ({ key, cmd, shift, alt });
check("Shift+ArrowLeft is left for the Monaco text selection", !shouldDispatchInEditable(chord("arrowleft", false, true, false)));
check("Shift+Letter is left for editing, not global commands", !shouldDispatchInEditable(chord("a", false, true, false)));
check("Alt+ArrowLeft still dispatches navigation", shouldDispatchInEditable(chord("arrowleft", false, false, true)));
check("Command+Shift+K remains a command chord", shouldDispatchInEditable(chord("k", true, true, false)));
check("Bare F1 remains dispatchable from an editor", shouldDispatchInEditable(chord("f1", false, false, false)));

console.log("arc005-recorder-input-smoke: " + (total-failed) + "/" + total + " PASS");
if (failed) process.exitCode = 1;
