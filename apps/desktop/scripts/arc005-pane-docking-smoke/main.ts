import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePaneDock, dockSideAtPoint, dockResizeDelta, dockFlexOrder, visibleRightPaneGeometry, PANE_DOCK_MIME, RIGHT_PANE_DRAG_ID } from "../../src/renderer/components/layout/paneDock.js";
import { dockSideAtRect } from "../../src/renderer/components/layout/paneLayout.js";
import { sourceHas } from "../lib/sourceText.js";
const src=(path:string)=>readFileSync(resolve("src/renderer",path),"utf8");
const store=src("stores/sessionStore.ts"),types=src("stores/sessionStoreTypes.ts");
const layout=src("components/layout/ThreePaneLayout.tsx"),rail=src("components/layout/RightPanel.tsx");
const shell=src("components/shell/ClassicShell.tsx"),app=src("App.tsx");
let ok=0,fail=0;
function check(name:string,passed:boolean) { if(passed)ok++;else fail++;console.log((passed?"PASS ":"FAIL ")+name); }
check("Empty legacy preference defaults to right dock",parsePaneDock(undefined)==="right" && parsePaneDock(null)==="right");
check("Both sides round trip through validated parser",parsePaneDock("left")==="left"&&parsePaneDock("right")==="right");
check("Invalid preference is never treated as left dock",parsePaneDock("LEFT")==="right"&&parsePaneDock({side:"left"})==="right");
check("Drop on left half selects left",dockSideAtPoint(100,20,400)==="left");
check("Drop on right half selects right",dockSideAtPoint(399,20,400)==="right");
check("Drop at exact midpoint selects right",dockSideAtPoint(220,20,400)==="right");
check("Invalid rectangle/NaN cannot corrupt dock",dockSideAtPoint(NaN,20,400)===null&&dockSideAtPoint(200,20,0)===null&&dockSideAtPoint(200,NaN,400)===null);
check("Right dock drag shrinks right pane when moving divider right",dockResizeDelta(20,"right")===20);
check("Left dock drag grows left pane when moving divider right",dockResizeDelta(20,"left")===-20);
check("Both splits obey inverted movement in both drag directions",dockResizeDelta(-40,"left")===40&&dockResizeDelta(-40,"right")===-40);
check("Stable flex order puts IDE aside before center in left dock",dockFlexOrder("left").aside<dockFlexOrder("left").divider&&dockFlexOrder("left").divider<dockFlexOrder("left").toolbar&&dockFlexOrder("left").toolbar<dockFlexOrder("left").center);
check("Stable flex order puts IDE aside after center in right dock",dockFlexOrder("right").center<dockFlexOrder("right").toolbar&&dockFlexOrder("right").toolbar<dockFlexOrder("right").divider&&dockFlexOrder("right").divider<dockFlexOrder("right").aside);
check("Private drag MIME cannot be confused with file or text drag",PANE_DOCK_MIME.includes("pane-dock")&&RIGHT_PANE_DRAG_ID==="mcode-right-panel");
check("Persisted layout includes dock beside existing width fields",sourceHas(store, "dock: s.rightDock"));
check("Hydration validates dock field strictly",sourceHas(store, "parseSavedPaneLayout(fp[UI_PANE_WIDTHS_SETTING_KEY])")&&sourceHas(store, "rightDock: firstPaintLayout.dock"));
check("Initial dock defaults right and setter persists",sourceHas(store, 'rightDock: "right"')&&sourceHas(store, "setRightDock: (dock)")&&sourceHas(store, 'schedulePaneWidthPersist(get, "rightDock")'));
check("Store type includes right dock and action",sourceHas(types, "rightDock: PaneDock")&&sourceHas(types, "setRightDock: (dock: PaneDock) => void"));
check("App subscribes and forwards dock store state",sourceHas(app, "const rightDock = useSessionStore")&&sourceHas(app, "rightDock={rightDock}"));
check("Shell forwards saved dock, layout uses the visible dock without remounting center",sourceHas(shell, "rightDock={rightDock}")&&sourceHas(layout, "dockFlexOrder(visibleDock)")&&sourceHas(layout, "visibleRightPaneGeometry(rightSurface, rightOpen, rightDock, rightPlacement?.side === \"bottom\")")&&visibleRightPaneGeometry("drawer",true,"left",false).visibleDock==="right");
check("DOM order only, not ternary swapping pane component identities",sourceHas(layout, "style={{ order: order.center }}")&&sourceHas(layout, "order: order.aside,")&&sourceHas(layout, "style={{ order: order.toolbar }}"));
check("Divider stays direct flex child so its ResizeObserver measures full row",
  !sourceHas(layout, '<div className="flex shrink-0" style={{ order: order.divider }}>') &&
  sourceHas(layout, 'className={rightDock === "left" ? "order-3" : "order-4"}'));
check("Left-docked right pane mirrors inner seam border",
  sourceHas(layout, 'rightDock === "left" ? "border-r" : "border-l"'));
check("Left dock mirrors center corner radius instead of leaving clipped notch",
  sourceHas(layout, 'rightDock === "left"') && sourceHas(layout, '"rounded-tr-[10px] rounded-br-[10px]"') &&
  sourceHas(layout, '"rounded-tr-3xl rounded-br-3xl"'));
check("Drag target preview is hidden from screen readers",
  sourceHas(layout, 'data-testid="pane-dock-preview"') && sourceHas(layout, 'aria-hidden="true"'));
check("Right pane drag is a private-only HTML5 operation",sourceHas(rail, "PANE_DOCK_MIME")&&sourceHas(rail, "RIGHT_PANE_DRAG_ID")&&sourceHas(rail, "onDragStart")&&sourceHas(layout, "e.dataTransfer.getData(PANE_DOCK_MIME)"));
check("Drag target honors workspace left/right/bottom geometry",
  sourceHas(layout, "dockSideAtRect(e.clientX, e.clientY, bounds.left, bounds.top, bounds.width, bounds.height)") &&
  sourceHas(layout, 'onMovePane?.("right", "bottom", 0)') && sourceHas(layout, "onDropCapture=") &&
  dockSideAtRect(100, 100, 0, 0, 800, 600) === "left" &&
  dockSideAtRect(700, 100, 0, 0, 800, 600) === "right" &&
  dockSideAtRect(400, 550, 0, 0, 800, 600) === "bottom");
check("Keyboard-accessible dock switch is available",sourceHas(rail, "onClick={() => setRightDock(rightDock === \"left\" ? \"right\" : \"left\")}")&&sourceHas(rail, "aria-label={dockTitle}"));
check("Right/left docking flips normal and wide split resize sign",sourceHas(shell, "dockResizeDelta(deltaPx, rightDock)")&&sourceHas(shell, "onResizeRight={handleDockedResize}"));
console.log("arc005-pane-docking "+ok+"/"+(ok+fail));if(fail)process.exitCode=1;
