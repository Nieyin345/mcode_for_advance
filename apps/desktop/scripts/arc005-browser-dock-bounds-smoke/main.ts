import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dockFlexOrder } from "../../src/renderer/components/layout/paneDock.js";
let passed=0,failed=0;
function check(s:string,b:boolean){if(b)passed++;else failed++;console.log((b?"PASS ":"FAIL ")+s);}
const src=readFileSync(resolve("src/renderer/components/browser/BrowserPanel.tsx"),"utf8");
check("Side move changes only CSS flex order",dockFlexOrder("left").aside!==dockFlexOrder("right").aside);
check("Sidebar browser subscribes to dock state",src.includes("const rightDock = useSessionStore((s) => s.rightDock);"));
check("Side move schedules a stage geometry sync",src.includes("if (mode !== \"sidebar\" || !isActive) return;")&&src.includes("requestAnimationFrame(() => {")&&src.includes("syncBounds();"));
check("Dock geometry effect depends on dock side",src.includes("[rightDock, mode, isActive, syncBounds]"));
check("Panel remains mounted: do not destroy native tab on dock",!src.includes("key={rightDock}"));
check("Browser positioning is guarded while sidebar inactive",src.includes("const isActive = sidebarBrowserIsActive("));
console.log("arc005-browser-dock-bounds "+passed+"/"+(passed+failed));if(failed)process.exitCode=1;
