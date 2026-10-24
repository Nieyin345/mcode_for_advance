import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dockFlexOrder, dockSideAtPoint, parsePaneDock, visibleRightPaneGeometry } from "../../src/renderer/components/layout/paneDock.js";
import { sourceHas } from "../lib/sourceText.js";
const src=readFileSync(resolve("src/renderer/components/layout/ThreePaneLayout.tsx"),"utf8");
const rail=readFileSync(resolve("src/renderer/components/layout/RightPanel.tsx"),"utf8");
let pass=0, fail=0;
function ck(name:string,ok:boolean){if(ok)pass++;else fail++;console.log((ok?"PASS ":"FAIL ")+name);}
ck("Tiny/zero stage never changes layout", dockSideAtPoint(100,0,0)===null);
ck("Large window supports left and right dock",dockSideAtPoint(40,0,800)==="left"&&dockSideAtPoint(790,0,800)==="right");
ck("Invalid preference falls back to conventional right dock",parsePaneDock("center")==="right");
ck("Left docking changes visual order, not React component key",dockFlexOrder("left").aside!==dockFlexOrder("right").aside&&!sourceHas(src, "key={rightDock}"));
ck("IDE aside flex item allows shrinking on narrow windows",sourceHas(src, 'className="flex h-full min-w-0 shrink-0 flex-col overflow-hidden'));
ck("IDE aside cannot consume whole center row when window shrinks",sourceHas(src, 'maxWidth: "calc(80% - 48px)"'));
ck("Dock side/mode/closed state clears transient drag ghost",sourceHas(src, "setDockPreview(null);\n  }, [rightOpen, rightDock, rightSurface]);"));
ck("External drags cannot be interpreted as a native pane drag",sourceHas(src, "Array.from(e.dataTransfer.types).includes(PANE_DOCK_MIME)")&&sourceHas(src, "e.dataTransfer.getData(PANE_DOCK_MIME) !== RIGHT_PANE_DRAG_ID"));
ck("Dock preview explicitly ignores screen-reader tree",sourceHas(src, 'data-testid="pane-dock-preview"')&&sourceHas(src, 'aria-hidden="true"'));
ck("Pane drag uses capture phase so embedded editor/composer drop zones cannot steal it",sourceHas(src, "onDragOverCapture={handleDockDragOver}")&&sourceHas(src, "onDropCapture={handleDockDrop}"));
ck("Native pane drag consumes nested dragover while external file drop remains intact",sourceHas(src, "e.stopPropagation();\n    e.dataTransfer.dropEffect = \"move\""));
ck("Drag preview clears after valid drop",sourceHas(src, "setDockPreview(null);")&&sourceHas(src, "onDropCapture={handleDockDrop}"));
ck("Dock drag ghost has window dragend and drop cleanup",sourceHas(src, 'window.addEventListener("dragend", clearPreview)')&&sourceHas(src, 'window.addEventListener("drop", clearPreview)'));
ck("Dock handle is accessible by native keyboard, not drag-only",sourceHas(rail, 'type="button" draggable')&&sourceHas(rail, "aria-label={dockTitle}")&&sourceHas(rail, "onClick={() => setRightDock("));
ck("Aside remains a stable React element under visual reordering",sourceHas(src, "{rightEverMounted && (")&&sourceHas(src, "order: order.aside"));
/* ---- drawer mode (T119/T137) --------------------------------------------
 * The drawer branch is a separate style object. It used to omit `order`,
 * on the assumption that DOM order already put the center first. It does
 * not: center carries order 2 and the aside default is 0, so the drawer
 * rendered to the LEFT of the conversation. These two assertions exist so
 * that omission cannot come back silently -- no suite covered the drawer
 * branch at all, which is why the bug survived. */
const drawerBlock = src.slice(src.indexOf('isDrawer ? {'));
ck("Drawer branch sets an explicit flex order (omitting it puts the drawer left of the center)",
  drawerBlock.length > 0 && /order:\s*\d/.test(drawerBlock.slice(0, 2000)));
ck("Drawer order places it after the center pane, matching the docked-right pane",
  (() => {
    const m = drawerBlock.slice(0, 2000).match(/order:\s*(\d)/);
    return m !== null && Number(m[1]) > dockFlexOrder("right").center;
  })());
/* ARC-005: A saved left/bottom dock is a *preference*, not the geometry of
 * the right-only compact drawer or a panel that is currently closed.
 * Rendering should preserve the preference for restoring pane mode later. */
ck("Surface-aware geometry resolves saved dock before computing center/toolbar flex order",
  sourceHas(src, 'visibleRightPaneGeometry(rightSurface, rightOpen, rightDock, rightPlacement?.side === "bottom")') &&
  sourceHas(src, "dockFlexOrder(visibleDock)"));
ck("Center curvature follows visible dock instead of stale persisted left docking",
  sourceHas(src, 'visibleDock === "left" ? "rounded-tr-[10px]') &&
  sourceHas(src, 'visibleDock === "left" ? "rounded-tr-3xl'));
ck("Drawer never captures a pane divider double-click/pointer resize",
  sourceHas(src, 'if (isDrawer || !(e.target as HTMLElement).closest') &&
  sourceHas(src, 'if (isDrawer || !rightOpen || rightAtBottom'));
ck("Compact drawer cannot inherit bottom placement sizing from persisted panel",
  sourceHas(src, 'atBottom: rightAtBottom') &&
  sourceHas(src, 'rightAtBottom ? "h-[calc(100%-var(--pane-bottom-share))]" : "h-full"'));
// Runtime cases: the pure geometry resolver must never mutate stored
// placement; leaving the compact surface restores the original pane layout.
const savedLeft = visibleRightPaneGeometry("pane", true, "left", false);
const compactLeft = visibleRightPaneGeometry("drawer", true, "left", false);
const savedBottom = visibleRightPaneGeometry("pane", true, "right", true);
const compactBottom = visibleRightPaneGeometry("drawer", true, "right", true);
const closedBottom = visibleRightPaneGeometry("pane", false, "right", true);
const closedLeft = visibleRightPaneGeometry("pane", false, "left", false);
ck("Saved left dock is displayed on left only in open full-pane mode",
  savedLeft.visibleDock === "left" && !savedLeft.atBottom &&
  compactLeft.visibleDock === "right" && !compactLeft.atBottom &&
  closedLeft.visibleDock === "right" && !closedLeft.atBottom);
ck("Bottom pane stops shrinking the workspace in drawer or closed state",
  savedBottom.atBottom && !compactBottom.atBottom && !closedBottom.atBottom);
ck("Returning to pane mode restores saved left/bottom preference without writes",
  visibleRightPaneGeometry("pane", true, "left", false).visibleDock === "left" &&
  visibleRightPaneGeometry("pane", true, "right", true).atBottom);
ck("Negative control: ignoring the surface fails the drawer-left case",
  compactLeft.visibleDock !== savedLeft.visibleDock);
ck("Negative control: ignoring closed state fails bottom-height case",
  closedBottom.atBottom !== savedBottom.atBottom);
console.log("arc005-pane-layout-edges "+pass+"/"+(pass+fail));if(fail)process.exitCode=1;
