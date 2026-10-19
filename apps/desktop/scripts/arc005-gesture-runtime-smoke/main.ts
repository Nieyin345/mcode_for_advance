/** ARC-005: run the actual React gesture hook with isolated EventTarget-like buses. */
import { unmount } from "./stubs/react.js";
import { performed } from "./stubs/commands.js";

type Handler = (e: any) => void;
class Bus {
  private readonly h = new Map<string, Set<Handler>>();
  addEventListener(type: string, fn: Handler): void {
    if (!this.h.has(type)) this.h.set(type, new Set());
    this.h.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void { this.h.get(type)?.delete(fn); }
  emit(type: string, e: any): void { for (const fn of [...(this.h.get(type) ?? [])]) fn(e); }
}
class FakeElement {
  closest(): null { return null; }
}
Object.assign(globalThis, {
  Element: FakeElement,
  window: new Bus(),
  document: Object.assign(new Bus(), { body: { style: { cursor: "" } } }),
});
const win = globalThis.window as unknown as Bus;
const doc = globalThis.document as unknown as Bus & { body: { style: { cursor: string } } };
const { useMouseGestures } = await import("../../src/renderer/hooks/useMouseGestures.js");

let total = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  console.log("  " + (ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : " — " + JSON.stringify(detail)));
  if (!ok) failed++;
}
function ptr(id: number, x: number, y: number, button = 2) {
  return {
    pointerId: id, isPrimary: true, button, clientX: x, clientY: y,
    target: new FakeElement(),
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
  };
}
function down(id: number, x = 0, y = 0) { win.emit("pointerdown", ptr(id, x, y)); }
function move(id: number, x: number, y: number) { win.emit("pointermove", ptr(id, x, y)); }
function up(id: number, x: number, y: number) { win.emit("pointerup", ptr(id, x, y)); }
function cancel(id: number) { win.emit("pointercancel", ptr(id, 0, 0)); }

useMouseGestures();

down(7);
move(8, 0, 100);
up(8, 0, 100);
cancel(8);
check("Secondary pointer cannot terminate primary armed gesture", performed.length === 0, performed);
up(7, 90, 0);
check("Primary release after secondary interference dispatches only R", performed.join(",") === "layout.toggle-right", performed);

down(3);
up(3, 0, 90);
check("Down/up only: release coordinate activates intended D", performed.at(-1) === "layout.toggle-bottom-terminal" && performed.length === 2, performed);

down(4);
move(4, 0, 80);
cancel(5);
up(4, 0, 110);
check("Foreign cancel cannot end primary active stroke", performed.length === 3 && performed.at(-1) === "layout.toggle-bottom-terminal", performed);

down(6);
move(6, 0, 80);
cancel(6);
up(6, 0, 100);
check("Primary pointercancel prevents unintended command execution", performed.length === 3, performed);
check("Primary pointercancel restores cursor", doc.body.style.cursor === "", doc.body.style.cursor);

down(9);
up(9, 0, 0);
check("Plain right-click never dispatches an app command", performed.length === 3, performed);

down(10);
move(10, 0, 90);
win.emit("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
up(10, 0, 100);
check("Esc cancels an active gesture without executing it", performed.length === 3, performed);

unmount();
down(11);
up(11, 100, 0);
check("Unmount unregisters pointer handlers", performed.length === 3, performed);

console.log("arc005-gesture-runtime-smoke: " + (total-failed) + "/" + total + " PASS");
if (failed) process.exitCode = 1;
