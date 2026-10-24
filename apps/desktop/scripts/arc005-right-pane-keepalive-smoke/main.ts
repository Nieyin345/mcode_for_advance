import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shouldMountRightPane } from "../../src/renderer/components/layout/rightPaneKeepAlive.js";
import { sidebarBrowserIsActive } from "../../src/renderer/components/browser/sidebarBrowserVisibility.js";
import { sourceHas } from "../lib/sourceText.js";
let pass=0, fail=0;
const read=(p:string)=>readFileSync(resolve("src/renderer/components",p),"utf8");
const check=(name:string,ok:boolean)=>{console.log(`${ok?"PASS":"FAIL"} ${name}`);if(ok)pass++;else fail++;};
const layout=read("layout/ThreePaneLayout.tsx");
const browser=read("browser/BrowserPanel.tsx");
check("RightPane keeps React child after first open instead of conditional unmount",sourceHas(layout, "shouldMountRightPane(rightOpen, hasOpenedRight)") && sourceHas(layout, "setHasOpenedRight(true)"));
check("Right pane is display-hidden without unmounting after collapse",sourceHas(layout, 'display: rightOpen ? "flex" : "none"') && sourceHas(layout, "rightEverMounted"));
check("Divider remains truly absent while right pane is folded",sourceHas(layout, "rightOpen && onResizeRight"));
check("Browser sidebar respects rightOpen even while kept mounted",sourceHas(browser, "sidebarBrowserIsActive(") && sourceHas(browser, "const rightOpen = useSessionStore"));
check("Browser overlay ignores sidebar visibility but respects overlay and settings",sourceHas(browser, "sidebarBrowserIsActive(mode, open, rightOpen, settingsOpen, selected)"));
check("Fresh hidden right panel does not mount before first use",!shouldMountRightPane(false,false));
check("First opening mounts pane immediately",shouldMountRightPane(true,false));
check("Collapse retains the originally mounted right pane",shouldMountRightPane(false,true));
check("Repeated reopening reuses the mounted subtree",shouldMountRightPane(true,true));
check("Native sidebar browser hides while parent pane is collapsed",
  !sidebarBrowserIsActive("sidebar",false,false,false));
check("Native sidebar browser resumes only after right pane reopens",
  sidebarBrowserIsActive("sidebar",false,true,false));
check("Native overlay browser is independent of right pane visibility",
  sidebarBrowserIsActive("overlay",true,false,false));
check("Overlay has precedence over sidebar",!sidebarBrowserIsActive("sidebar",true,true,false));
check("Settings disables native browser surfaces in BOTH modes",
  !sidebarBrowserIsActive("sidebar",false,true,true) &&
  !sidebarBrowserIsActive("overlay",true,true,true));
check("Background browser must be inactive behind Files/Git/custom panes",
  !sidebarBrowserIsActive("sidebar",false,true,false,false));
check("Selecting browser tab reactivates its native view",
  sidebarBrowserIsActive("sidebar",false,true,false,true));
check("Browser overlay independent of selected sidebar tab",
  sidebarBrowserIsActive("overlay",true,false,false,false));
console.log(`arc005-right-pane-keepalive ${pass}/${pass+fail}`);
if(fail) process.exitCode=1;
