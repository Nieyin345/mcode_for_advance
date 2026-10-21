/**
 * T18 E1 smoke. Bundles the REAL FileMentionPicker with a minimal React hooks
 * scheduler, not a source-string assertion. Pure physical rules are imported
 * from the same module that production components actually call.
 *
 * Run from apps/desktop:
 *   bash src/renderer/components/chat/tests/t18-run.sh
 */
import { __mount, __flush, __nodes } from "../../../../../scripts/ime-enter-smoke/fakeReact.js";
import { FileMentionPicker } from "../FileMentionPicker.js";
import { composerSendAction, composerEditorHeightCap, isPostCompositionEnter, placeComposerPicker } from "../composerPhysicalRules.js";

type Listener = (e: any) => void;
const listeners = new Map<string, Listener[]>();
const globalTarget = globalThis as unknown as Record<string, unknown>;
globalTarget.Element = class { closest() { return null; } };
globalTarget.ResizeObserver = undefined;
globalTarget.window = {
  innerWidth: 900,
  innerHeight: 700,
  setTimeout,
  clearTimeout,
  addEventListener: (name: string, fn: Listener) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
  removeEventListener: (name: string, fn: Listener) => listeners.set(name, (listeners.get(name) ?? []).filter((v) => v !== fn)),
};
globalTarget.document = {
  addEventListener() {},
  removeEventListener() {},
};
let total = 0;
let failed = 0;
function check(name: string, result: boolean, detail: unknown = "") {
  total++;
  if (!result) failed++;
  console.log(`  ${result ? "PASS" : "FAIL"} ${name}${result ? "" : " " + JSON.stringify(detail)}`);
}
const anchor = { top: 500, bottom: 548, left: 120, width: 340 };
const viewport = { width: 900, height: 700 };
const above = placeComposerPicker(anchor, 256, viewport, 480);
check("floating @ menu prefers above if it fits", above.side === "top" && above.top === 236, above);
const below = placeComposerPicker({ ...anchor, top: 40, bottom: 90 }, 256, viewport, 480);
check("floating @ menu flips below near top", below.side === "bottom" && below.top === 98, below);
const cramped = placeComposerPicker({ ...anchor, top: 90, bottom: 150, left: 890 }, 256, {width: 310,height: 300}, 480);
check("floating @ menu fits narrow viewport both directions", cramped.width === 294 && cramped.left === 8 &&
  cramped.maxHeight <= 142 && cramped.top >= 8, cramped);

const shortCap = composerEditorHeightCap(500, 16);
check("auto-grow cap scales with short viewport and enables scrolling", shortCap === 200, shortCap);
check("auto-grow stops at 24rem on tall viewport", composerEditorHeightCap(1800, 16) === 384);
check("auto-grow never goes below min-height", composerEditorHeightCap(80, 16) === 48);
check("IME post-composition false Enter is blocked", isPostCompositionEnter("Enter", 1250, 1000, "Apple Computer, Inc.", false));
check("IME later Enter / modified Enter still work", !isPostCompositionEnter("Enter", 1600, 1000, "Apple Computer, Inc.", false) &&
  !isPostCompositionEnter("Enter", 1100, 1000, "Apple Computer, Inc.", true));
check("IME guard is limited to WebKit", !isPostCompositionEnter("Enter", 1050, 1000, "Google Inc.", false));
check("send action transitions disabled -> send -> stop", composerSendAction(false,false) === "disabled" &&
  composerSendAction(false,true) === "send" && composerSendAction(true,false) === "stop");
check("busy typed-ahead action queues rather than losing the draft", composerSendAction(true,true) === "enqueue");

let picked: string[] = [];
let closed = 0;
__mount(() => FileMentionPicker({
  open: true,
  projectPath: "C:/project",
  query: "",
  anchorRect: anchor as DOMRect,
  mode: "mention",
  onPick: (entries) => picked.push(...entries.map((entry) => entry.name)),
  onClose: () => closed++,
}));
await new Promise((r) => setTimeout(r, 160));
await __flush();
const rows = () => __nodes().filter((node) => node.type === "button" && typeof node.props["data-idx"] === "number");
const active = () => rows().findIndex((node) => (node.props.className as string).includes("bg-accent/15"));
check("real picker loads 3 rows and selects first", rows().length === 3 && active() === 0, {count:rows().length,active:active()});
async function press(key: string, options: { composing?:boolean; keyCode?:number } = {}) {
  let prevented = 0;
  const event = {
    key,
    isComposing: options.composing ?? false,
    keyCode: options.keyCode ?? 0,
    repeat: false, altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,
    target: {},
    preventDefault: () => prevented++,
    stopPropagation: () => {},
  };
  for (const fn of [...(listeners.get("keydown") ?? [])]) fn(event);
  await __flush();
  return prevented;
}
const downConsumed = await press("ArrowDown");
check("real picker ArrowDown moves highlighted selection to second", downConsumed === 1 && active() === 1, active());
await press("ArrowUp");
check("real picker ArrowUp moves highlighted selection to first", active() === 0, active());
await press("ArrowDown");
await press("Enter", { composing: true });
check("IME Enter cannot pick selected file", picked.length === 0 && active() === 1, picked);
await press("Enter", { keyCode: 229 });
check("IME keyCode229 cannot pick selected file", picked.length === 0, picked);
await press("Tab");
check("real picker Tab confirms ACTIVE second file", picked.length === 1 && picked[0] === "beta.ts", picked);
await press("Escape");
check("real picker Escape closes without picking again", closed === 1 && picked.length === 1, { closed, picked });

// Mount the actual popup with an upper-edge anchor and inspect its rendered
// inline placement, not only the pure geometry function.
listeners.clear();
__mount(() => FileMentionPicker({
  open: true,
  projectPath: "C:/project",
  query: "",
  anchorRect: { ...anchor, top: 40, bottom: 90 } as DOMRect,
  mode: "mention",
  onPick: () => {},
  onClose: () => {},
}));
await __flush();
const popup = __nodes().find((node) => node.type === "div" &&
  typeof node.props.className === "string" &&
  (node.props.className as string).includes("fixed z-[70]"));
const popupStyle = popup?.props.style as { top?: number; maxHeight?: number } | undefined;
check("real mention popup renders BELOW near viewport top", popupStyle?.top === 98 &&
  (popupStyle?.maxHeight ?? 0) > 0, popupStyle);

console.log(`T18 composer behavior: ${total - failed}/${total} passed`);
if (failed) process.exitCode = 1;
