import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parsePaneLayout, DEFAULT_PANE_LAYOUT, movePane, clampLayout, dockSideAtRect,
  computeSplitDrag, SPLIT_COLLAPSE_THRESHOLD, SPLIT_DEAD_ZONE_PX,
  SPLIT_MIN_LEFT_PX, SPLIT_MIN_RIGHT_PX, SPLIT_SNAP_RATIO,
  LAYOUT_PRESETS, setPaneSizePct, copyPaneLayout, withHostedPaneContent, moveHostedPane, hostedPaneContent,
} from "../../src/renderer/components/layout/paneLayout.js";
import { parseSavedPaneLayout } from "../../src/renderer/stores/paneLayoutPrefs.js";
import { createCoalescedPaneWriter } from "../../src/renderer/stores/paneWidthWriteQueue.js";
import { sourceHas } from "../lib/sourceText.js";

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
check("T07 document and flow placements survive serialization, restart and 3-way docking", () => {
  for (const content of [
    { kind: "document", documentId: "C:\\\\workspace\\\\draft.docx" },
    { kind: "flow", flowId: "node-red" },
  ] as const) {
    const pinned = withHostedPaneContent(good, content);
    for (const side of ["left", "right", "bottom"] as const) {
      const moved = moveHostedPane(pinned, side, 0);
      const restarted = parseSavedPaneLayout(JSON.stringify({ paneLayout: moved }));
      assert.deepEqual(restarted?.paneLayout?.placements.find(p => p.id === side)?.content, content);
      assert.deepEqual(restarted?.paneLayout && hostedPaneContent(restarted.paneLayout), content);
      assert.equal(restarted?.paneLayout?.placements.find(p => p.id === "right")?.side, side);
      assert.equal(restarted?.repaired?.length, 0);
    }
  }
});
check("T07 old layouts remain valid and malformed content fails closed", () => {
  assert.equal(parsePaneLayout(good).repaired.length, 0);
  const base = withHostedPaneContent(good, {kind:"flow", flowId:"node-red"});
  for (const content of [{kind:"flow",flowId:"../bad"}, {kind:"document",documentId:""},
    {kind:"builtin",id:"unknown"}, {kind:"builtin",id:{toString:8}}, {kind:"flow",flowId:8}]) {
    const invalid = structuredClone(base);
    invalid.placements.find(p => p.id === "right")!.content = content as never;
    assert.ok(parsePaneLayout(invalid).repaired.length > 0);
    assert.deepEqual(parsePaneLayout(invalid).layout, good);
  }
});
check("moves right pane through all 3 dock zones without dropping members",()=>{
  for (const side of ["left","right","bottom"] as const) {
    const moved = movePane(good,"right",side,0);
    assert.equal(moved.placements.find(p=>p.id==="right")?.side,side);
    assert.equal(parsePaneLayout(moved).repaired.length,0);
    assert.equal(new Set(moved.placements.map(p=>p.id)).size,4);
  }
});
check("★ 同侧多 pane 尺寸之和 ≤ 100（按比例缩，不放大任何一方）",()=>{
  // 缺这条时两条分割线会互相推挤、右栏被挤出容器。判据是「和」不是「单值」——
  // 每个都 ≤100 仍然可能加起来 180。
  const crowded = { version: 1, placements: [
    { id: "left", side: "left", order: 0, sizePct: 20 },
    { id: "right", side: "right", order: 0, sizePct: 60 },
    { id: "editor", side: "right", order: 1, sizePct: 60 },
    { id: "bottom", side: "bottom", order: 0, sizePct: 30 },
  ] } as never;
  const out = clampLayout(crowded);
  const rightSum = out.placements.filter(p => p.side === "right")
    .reduce((n, p) => n + p.sizePct, 0);
  assert.ok(rightSum <= 100 + 1e-9, "right side sum " + rightSum);
  // 原比例应保留：60:60 → 50:50
  const r = out.placements.filter(p => p.side === "right").sort((a, b) => a.order - b.order);
  assert.ok(Math.abs(r[0].sizePct - r[1].sizePct) < 1e-9, "ratio not preserved");
  // 单侧不拥挤时不得被改
  const roomy = { version: 1, placements: [
    { id: "left", side: "left", order: 0, sizePct: 20 },
    { id: "right", side: "right", order: 0, sizePct: 30 },
    { id: "editor", side: "right", order: 1, sizePct: 25 },
    { id: "bottom", side: "bottom", order: 0, sizePct: 30 },
  ] } as never;
  const kept = clampLayout(roomy);
  assert.equal(kept.placements.find(p => p.id === "right")!.sizePct, 30);
  assert.equal(kept.placements.find(p => p.id === "editor")!.sizePct, 25);
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
check("T23 pointer movement continuously updates right placement with same-side clamp", () => {
  const start = 0.5;
  const sizes: number[] = [];
  let current = copyPaneLayout(good);
  for (const delta of [-60, -120, -180]) {
    const result = computeSplitDrag(start, delta, 1200);
    assert.equal(result.moved, true);
    current = setPaneSizePct(current, "right", (1 - result.ratio) * 100);
    sizes.push(current.placements.find(p => p.id === "right")!.sizePct);
    for (const side of ["left", "right", "bottom"]) {
      assert.ok(current.placements.filter(p => p.side === side)
        .reduce((n, p) => n + p.sizePct, 0) <= 100);
    }
    assert.equal(parsePaneLayout(current).repaired.length, 0);
  }
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2]);
  sizes.forEach((value, i) => assert.ok(Math.abs(value - [55, 60, 65][i]) < 1e-8));
});
check("T23 fold thresholds at 18/82, on both dock sides and recover", () => {
  for (const side of ["left", "right"] as const) {
    const percent = (ratio: number) => 100 * (side === "left" ? ratio : 1 - ratio);
    const low = computeSplitDrag(0.5, -385, 1200);
    const high = computeSplitDrag(0.5, 385, 1200);
    assert.equal(low.collapsed, "left");
    assert.equal(high.collapsed, "right");
    assert.equal(percent(side === "left" ? low.ratio : high.ratio), 0, "right pane collapses");
    assert.equal(percent(side === "left" ? high.ratio : low.ratio), 100, "center pane collapses");
    const folded = setPaneSizePct(good, "right", 0);
    assert.equal(folded.placements.find(p => p.id === "right")!.sizePct, 0);
    const restored = setPaneSizePct(folded, "right", 30);
    assert.equal(restored.placements.find(p => p.id === "right")!.sizePct, 30);
  }
});
check("T23 pixel min 380/420 with actual updated placements", () => {
  const width = 1200;
  const toLeft = computeSplitDrag(0.5, -300, width);
  const toRight = computeSplitDrag(0.5, 300, width);
  assert.equal(toLeft.ratio * width, 380);
  assert.equal((1 - toRight.ratio) * width, 420);
  assert.equal(setPaneSizePct(good, "right", (1 - toLeft.ratio) * 100)
    .placements.find(p => p.id === "right")!.sizePct, 100 * (1 - 380 / width));
  assert.equal(setPaneSizePct(good, "right", (1 - toRight.ratio) * 100)
    .placements.find(p => p.id === "right")!.sizePct, 35);
});
check("T23 three presets preserve exactly requested percentages and clamp invariants", () => {
  for (const [key, left, right] of [
    ["chat", 18, 22], ["editor", 0, 60], ["balanced", 22, 50],
  ] as const) {
    const preset = clampLayout(copyPaneLayout(LAYOUT_PRESETS[key]));
    assert.equal(parsePaneLayout(preset).repaired.length, 0);
    assert.equal(preset.placements.find(p => p.id === "left")?.sizePct, left);
    assert.equal(preset.placements.find(p => p.id === "right")?.sizePct, right);
    assert.ok(preset.placements.filter(p => p.side === "right").reduce((n,p) => n+p.sizePct,0) <= 100);
  }
});
check("T23 one-step reset returns full default without aliasing the preset", () => {
  const damaged = setPaneSizePct(LAYOUT_PRESETS.editor, "right", 83);
  assert.notDeepEqual(damaged, DEFAULT_PANE_LAYOUT);
  const reset = clampLayout(copyPaneLayout(DEFAULT_PANE_LAYOUT));
  assert.deepEqual(reset, good);
  reset.placements[0].sizePct = 77;
  assert.equal(DEFAULT_PANE_LAYOUT.placements[0].sizePct, 24);
});
const persisted: string[] = [];
let latestLayout = good;
const writer = createCoalescedPaneWriter(
  () => latestLayout, async value => { persisted.push(JSON.stringify(value)); },
  error => { throw error; },
);
for (const delta of [-60, -120, -180]) {
  const drag = computeSplitDrag(0.5, delta, 1200);
  latestLayout = setPaneSizePct(latestLayout, "right", (1 - drag.ratio) * 100);
}
// Same snapshot coalescing queue as sessionStore; the drag commits once.
await writer.request();
check("T23 drag release persists the final clamped placement", () => {
  assert.equal(persisted.length, 1);
  assert.deepEqual(JSON.parse(persisted[0]), latestLayout);
  assert.equal(latestLayout.placements.find(p => p.id === "right")?.sizePct, 65);
});
const layout = readFileSync(resolve("src/renderer/components/layout/ThreePaneLayout.tsx"),"utf8");
const store = readFileSync(resolve("src/renderer/stores/sessionStore.ts"),"utf8");
const shell = readFileSync(resolve("src/renderer/components/shell/ClassicShell.tsx"),"utf8");
check("real DndContext and draggable activator connected to placement state",()=>{
  assert.ok(sourceHas(layout, "<DndContext sensors={sensors}"));
  assert.ok(sourceHas(layout, 'useDraggable({ id: "mcode-pane-right" })'));
  assert.ok(sourceHas(layout, 'onMovePane("right", side, 0)'));
  assert.ok(sourceHas(shell, "paneLayout={paneLayout}"));
});
check("escape discards split preview and keeps old store size",()=>{
  assert.ok(sourceHas(layout, 'e.key !== "Escape"'));
  assert.ok(sourceHas(layout, "setSplitPreview(null)"));
  assert.ok(sourceHas(layout, "onPointerUpCapture={endSplit}"));
});
check("double-click split handle uses 50/50 snap",()=>{
  assert.ok(sourceHas(layout, "width * (1 - SPLIT_SNAP_RATIO)"));
  assert.ok(sourceHas(layout, "onDoubleClick={() => {"));
});
check("★ 50/50 吸附走直接设定，不走 delta 双重取反",()=>{
  // 行为判据：单靠源码里有 `width * (1 - SPLIT_SNAP_RATIO)` 证明不了落点是 50%。
  // delta 链路会经 dockResizeDelta 与 adjustRightWidth 内部各取反一次，
  // rightDock === "left" 时符号抵消错位。必须存在直接设定路径并被使用。
  assert.ok(sourceHas(layout, "onSetRightWidth(target)"),
    "双击必须优先走 onSetRightWidth(直接设宽)");
  assert.ok(sourceHas(layout, "if (onSetRightWidth) { onSetRightWidth(target); onSetPaneRightSizePct?.(50, width, true); return; }"),
    "直接设定必须在 delta 兜底之前 return");
  assert.ok(!/onDoubleClick[\s\S]{0,600}?onResizeRight\(rightDock === "left" \(target - current\) : current - target\)\s*;\s*\}\}/.test(layout)
    || layout.indexOf("onSetRightWidth(target)") < layout.indexOf('onResizeRight(rightDock === "left" ? target - current'),
    "delta 兜底只能排在直接设定之后");
});
check("★ setRightWidthPx 直接落值并用同一套夹取",()=>{
  assert.ok(sourceHas(store, "setRightWidthPx: (px) =>"),
    "store 必须有直接设定 action");
  const body = store.slice(store.indexOf("setRightWidthPx: (px) =>"));
  assert.ok(body.slice(0, 400).includes("clampRightWidth(px,"),
    "直接设定仍须经过 clampRightWidth（min 240 / 80% 分享）");
  assert.ok(body.slice(0, 400).includes("schedulePaneWidthPersist(get, \"rightWidth\")"),
    "直接设定必须走同一持久化队列");
});
check("root drag attribute and iframe/browser pointer shield",()=>{
  assert.ok(sourceHas(layout, 'data-pane-dragging={paneDragging ? "true" : undefined}'));
  assert.ok(sourceHas(layout, 'data-pane-iframe-shield="" className="pointer-events-none'));
  assert.ok(sourceHas(layout, 'style={paneDragging ? { pointerEvents: "none" } : undefined}'));
});
check("first paint uses canonical key and old widths are read-only migration",()=>{
  assert.ok(sourceHas(store, 'key: UI_PANE_LAYOUT_SETTING_KEY,'));
  assert.ok(sourceHas(store, "UI_PANE_LAYOUT_SETTING_KEY,\n          UI_PANE_WIDTHS_SETTING_KEY"));
  assert.ok(sourceHas(store, "parseSavedPaneLayout(fp[UI_PANE_WIDTHS_SETTING_KEY])"));
  assert.ok(!sourceHas(store, "key: UI_PANE_WIDTHS_SETTING_KEY,"));
  assert.ok(parseSavedPaneLayout(JSON.stringify({paneLayout:good}))?.paneLayout);
});
check("corrupt layout emits visible warning and safe default",()=>{
  assert.ok(sourceHas(store, '"store.toast.paneLayoutRepaired"'));
  assert.ok(sourceHas(store, 'kind: "warning"'));
  assert.deepEqual(parseSavedPaneLayout(JSON.stringify({paneLayout:{bad:1}}))?.paneLayout,good);
});
console.log(`arc005-pane-free-grid ${passed}/${passed+failed}`);
if (failed) process.exitCode=1;
