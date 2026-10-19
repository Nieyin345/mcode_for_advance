import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePaneDock, dockSideAtPoint, dockResizeDelta, dockFlexOrder, PANE_DOCK_MIME, RIGHT_PANE_DRAG_ID } from "../../src/renderer/components/layout/paneDock.js";
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
check("Persisted layout includes dock beside existing width fields",store.includes("dock: s.rightDock"));
check("Hydration validates dock field strictly",store.includes("parseSavedPaneLayout(fp[UI_PANE_WIDTHS_SETTING_KEY])")&&store.includes("rightDock: firstPaintLayout.dock"));
check("Initial dock defaults right and setter persists",store.includes('rightDock: "right"')&&store.includes("setRightDock: (dock)")&&store.includes('schedulePaneWidthPersist(get, "rightDock")'));
check("Store type includes right dock and action",types.includes("rightDock: PaneDock")&&types.includes("setRightDock: (dock: PaneDock) => void"));
check("App subscribes and forwards dock store state",app.includes("const rightDock = useSessionStore")&&app.includes("rightDock={rightDock}"));
check("Shell and layout forward dock while preserving center tree",shell.includes("rightDock={rightDock}")&&layout.includes("dockFlexOrder(rightDock)"));
check("DOM order only, not ternary swapping pane component identities",layout.includes("style={{ order: order.center }}")&&layout.includes("order: order.aside,")&&layout.includes("style={{ order: order.toolbar }}"));
check("Divider stays direct flex child so its ResizeObserver measures full row",
  !layout.includes('<div className="flex shrink-0" style={{ order: order.divider }}>') &&
  layout.includes('className={rightDock === "left" ? "order-3" : "order-4"}'));
check("Left-docked right pane mirrors inner seam border",
  layout.includes('rightDock === "left" ? "border-r" : "border-l"'));
check("Left dock mirrors center corner radius instead of leaving clipped notch",
  layout.includes('rightDock === "left"') && layout.includes('"rounded-tr-[10px] rounded-br-[10px]"') &&
  layout.includes('"rounded-tr-3xl rounded-br-3xl"'));
check("Drag target preview is hidden from screen readers",
  layout.includes('data-testid="pane-dock-preview"') && layout.includes('aria-hidden="true"'));
check("Right pane drag is a private-only HTML5 operation",rail.includes("PANE_DOCK_MIME")&&rail.includes("RIGHT_PANE_DRAG_ID")&&rail.includes("onDragStart")&&layout.includes("e.dataTransfer.getData(PANE_DOCK_MIME)"));
check("Drag target honors workspace left/right geometry",layout.includes("dockSideAtPoint(e.clientX")&&layout.includes("onDropCapture="));
check("Keyboard-accessible dock switch is available",rail.includes("onClick={() => setRightDock(rightDock === \"left\" ? \"right\" : \"left\")}")&&rail.includes("aria-label={dockTitle}"));
check("Right/left docking flips normal and wide split resize sign",shell.includes("dockResizeDelta(deltaPx, rightDock)")&&shell.includes("onResizeRight={handleDockedResize}"));
console.log("arc005-pane-docking "+ok+"/"+(ok+fail));if(fail)process.exitCode=1;
