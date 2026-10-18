import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sessionTabsToClose, sessionTabMenuPosition } from "../../src/renderer/components/layout/sessionTabContextActions.js";
let pass=0, fail=0;
const read=(p:string)=>readFileSync(resolve("src/renderer/components",p),"utf8");
function check(name:string, ok:boolean){console.log(`${ok?"PASS":"FAIL"} ${name}`);if(ok)pass++;else fail++;}
const sess=read("layout/SessionTabs.tsx");
const unified=read("layout/UnifiedTabsBar.tsx");
const files=read("ide/OpenTabsBar.tsx");
const menu=(()=>{try{return read("layout/SessionTabContextMenu.tsx");}catch{return "";}})();
check("regular session tab opens real context menu on right click",sess.includes("<SessionTabContextMenu") && sess.includes("onContextMenu={(e) =>"));
check("unified session tab opens same real context menu",unified.includes("<SessionTabContextMenu") && unified.includes("setSessionCtxMenu"));
check("menu uses cursor anchor and controlled Base UI menu portal",menu.includes("useCursorAnchor") && menu.includes("Menu.Root") && menu.includes("Menu.Portal"));
check("menu has close / close others / close all UI actions",menu.includes("closeOthers") && menu.includes("closeAll") && menu.includes("common.close"));
check("menu selection cannot activate a session or cancel active Agent",!menu.includes("selectSession(") && !menu.includes("kill") && !menu.includes("cancelTurn"));
check("overflow toggle available before multi-row overflow with 2 tabs",sess.includes("tabs.length >= 2") && files.includes("openFiles.length + (hasPlanTab ? 1 : 0) >= 2") && unified.includes("tabs.length + openFiles.length + (hasPlanTab ? 1 : 0) + (fileView ? 1 : 0) >= 2"));
const openTabs = ["session-1", "session-2", "session-3"];
check("Close one picks only the target tab",sessionTabsToClose(openTabs,"session-2","one").join() === "session-2");
check("Close others keeps the target tab open",sessionTabsToClose(openTabs,"session-2","others").join() === "session-1,session-3");
check("Close all only acts when the menu target is still open",sessionTabsToClose(openTabs,"session-2","all").join() === "session-1,session-2,session-3");
check("Stale or missing context target never mass-closes another user's tabs",
  sessionTabsToClose(openTabs,"no-longer-open","all").length === 0 &&
  sessionTabsToClose(openTabs,"","others").length === 0);
check("Single tab has no close-others targets",sessionTabsToClose(["solo"],"solo","others").length === 0);
check("Close planning never mutates the tab list or session data",openTabs.join() === "session-1,session-2,session-3");
const rect = { left: 90, bottom: 130 };
check("Mouse right-click uses cursor coords even when detail is zero", sessionTabMenuPosition(400, 250, rect).x === 400 && sessionTabMenuPosition(400, 250, rect).y === 250);
check("Shift+F10 zero coordinates anchor to the tab itself", sessionTabMenuPosition(0, 0, rect).x === 106 && sessionTabMenuPosition(0, 0, rect).y === 130);
check("Both tab strips share safe context menu placement", sess.includes("sessionTabMenuPosition(e.clientX, e.clientY") && unified.includes("sessionTabMenuPosition(e.clientX, e.clientY"));
console.log(`arc005-tab-context smoke ${pass}/${pass+fail}`);
if(fail) process.exitCode=1;
