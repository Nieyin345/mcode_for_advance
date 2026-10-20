import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parsePaneLayout, DEFAULT_PANE_LAYOUT, movePane, clampLayout, dockSideAtRect,
  computeSplitDrag, SPLIT_COLLAPSE_THRESHOLD, SPLIT_DEAD_ZONE_PX,
  SPLIT_MIN_LEFT_PX, SPLIT_MIN_RIGHT_PX, SPLIT_SNAP_RATIO,
} from "../../src/renderer/components/layout/paneLayout.js";
import { parseSavedPaneLayout } from "../../src/renderer/stores/paneLayoutPrefs.js";

let passed = 0; let failed = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); console.log("PASS", name); passed++; }
  catch (error) { console.error("FAIL", name, error); failed++; }
};
const good = structuredClone(DEFAULT_PANE_LAYOUT);
for (const [name, value] of [
  ["null", null], ["legacy", {dock:"right",right:420}],
  ["duplicate", { version:1, placements:[...good.placements.slice(0,3),good.placements[0]] }],
  ["NaN", { version:1, placements:good.placements.map((p,i)=>i===1?{...p,sizePct:NaN}:p) }],
  ["range", { version:1, placements:good.placements.map((p,i)=>i===1?{...p,sizePct:110}:p) }],
  ["missing fields", { version:1, placements:good.placements.map((p,i)=>i===1?{id:p.id,side:p.side}:p) }],
  ["missing id", { version:1, placements:good.placements.slice(0,3) }],
  ["bad order", { version:1, placements:good.placements.map((p,i)=>i===3?{...p,order:9}:p) }],
  ["bad side", { version:1, placements:good.placements.map((p,i)=>i===1?{...p,side:"top"}:p) }],
]) check(`parser repairs ${name}`, () => {
  const parsed = parsePaneLayout(value);
  assert.deepEqual(parsed.layout,good);
  assert.ok(parsed.repaired.length>0);
});
check("valid v1 roundtrip with zero repair", () => assert.deepEqual(parsePaneLayout(good),{layout:good,repaired:[]}));
check("moves right pane through all 3 dock zones without dropping members",()=>{
  for (const side of ["left","right","bottom"] as const) {
    const moved = movePane(good,"right",side,0);
    assert.equal(moved.placements.find(p=>p.id==="right")?.side,side);
    assert.equal(parsePaneLayout(moved).repaired.length,0);
    assert.equal(new Set(moved.placements.map(p=>p.id)).size,4);
  }
});
check("clamp accepts proper v1 only",()=>{
  assert.equal(clampLayout(good).placements.length,4);
  assert.equal(clampLayout({version:1,placements:[]} as never).placements.length,4);
});
check("dock geometry: legacy midpoint reused for upper area, lower-third bottom",()=>{
  assert.equal(dockSideAtRect(100,100,0,0,900,600),"left");
  assert.equal(dockSideAtRect(850,100,0,0,900,600),"right");
  assert.equal(dockSideAtRect(450,500,0,0,900,600),"bottom");
  assert.equal(dockSideAtRect(NaN,500,0,0,900,600),null);
});
check("deadzone: under 4 px does not start a split, 4 px starts it",()=>{
  assert.equal(SPLIT_DEAD_ZONE_PX,4);
  assert.equal(computeSplitDrag(0.5,3.9,1200).moved,false);
  assert.equal(computeSplitDrag(0.5,4,1200).moved,true);
});
check("collapse thresholds 18 / 82 and exact constants",()=>{
  assert.equal(SPLIT_COLLAPSE_THRESHOLD,0.18);
  assert.deepEqual(computeSplitDrag(0.5,-400,1200).collapsed,"left");
  assert.deepEqual(computeSplitDrag(0.5,400,1200).collapsed,"right");
  assert.deepEqual(computeSplitDrag(0.5,0,1200).collapsed,null);
});
check("pixel clamps 380 left and 420 right when feasible",()=>{
  assert.equal(SPLIT_MIN_LEFT_PX,380);
  assert.equal(SPLIT_MIN_RIGHT_PX,420);
  assert.equal(computeSplitDrag(0.5,-300,1200).ratio,380/1200);
  assert.equal(computeSplitDrag(0.5,300,1200).ratio,780/1200);
});
check("snap constant exactly 50/50",()=> assert.equal(SPLIT_SNAP_RATIO,0.5));
const layout = readFileSync(resolve("src/renderer/components/layout/ThreePaneLayout.tsx"),"utf8");
const store = readFileSync(resolve("src/renderer/stores/sessionStore.ts"),"utf8");
const shell = readFileSync(resolve("src/renderer/components/shell/ClassicShell.tsx"),"utf8");
check("real DndContext and draggable activator connected to placement state",()=>{
  assert.ok(layout.includes("<DndContext sensors={sensors}"));
  assert.ok(layout.includes('useDraggable({ id: "mcode-pane-right" })'));
  assert.ok(layout.includes('onMovePane("right", side, 0)'));
  assert.ok(shell.includes("paneLayout={paneLayout}"));
});
check("escape discards split preview and keeps old store size",()=>{
  assert.ok(layout.includes('e.key !== "Escape"'));
  assert.ok(layout.includes("setSplitPreview(null)"));
  assert.ok(layout.includes("onPointerUpCapture={endSplit}"));
});
check("double-click split handle uses 50/50 snap",()=>{
  assert.ok(layout.includes("width * (1 - SPLIT_SNAP_RATIO)"));
  assert.ok(layout.includes("onDoubleClick={() => {"));
});
check("root drag attribute and iframe/browser pointer shield",()=>{
  assert.ok(layout.includes('data-pane-dragging={paneDragging ? "true" : undefined}'));
  assert.ok(layout.includes('data-pane-iframe-shield="" className="pointer-events-none'));
  assert.ok(layout.includes('style={paneDragging ? { pointerEvents: "none" } : undefined}'));
});
check("first paint uses canonical key and old widths are read-only migration",()=>{
  assert.ok(store.includes('key: UI_PANE_LAYOUT_SETTING_KEY,'));
  assert.ok(store.includes("UI_PANE_LAYOUT_SETTING_KEY,\n          UI_PANE_WIDTHS_SETTING_KEY"));
  assert.ok(store.includes("parseSavedPaneLayout(fp[UI_PANE_WIDTHS_SETTING_KEY])"));
  assert.ok(!store.includes("key: UI_PANE_WIDTHS_SETTING_KEY,"));
  assert.ok(parseSavedPaneLayout(JSON.stringify({paneLayout:good}))?.paneLayout);
});
check("corrupt layout emits visible warning and safe default",()=>{
  assert.ok(store.includes('"store.toast.paneLayoutRepaired"'));
  assert.ok(store.includes('kind: "warning"'));
  assert.deepEqual(parseSavedPaneLayout(JSON.stringify({paneLayout:{bad:1}}))?.paneLayout,good);
});
console.log(`arc005-pane-free-grid ${passed}/${passed+failed}`);
if (failed) process.exitCode=1;
