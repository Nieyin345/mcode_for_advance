import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { liveSessionTabMenu, sessionTabsToClose } from "../../src/renderer/components/layout/sessionTabContextActions.js";
const src=(p:string)=>readFileSync(resolve("src/renderer/components/layout",p),"utf8");
const normal=src("SessionTabs.tsx"), unified=src("UnifiedTabsBar.tsx");
let pass=0,fail=0;
function check(name:string,ok:boolean){console.log((ok?"PASS":"FAIL")+" "+name);if(ok)pass++;else fail++;}
const open=["session-A","session-B","session-C"];
const menu={id:"session-A",x:43,y:79,projectId:"project-A"};
check("Valid menu remains actionable in original project",liveSessionTabMenu(menu,"project-A",open)===menu);
check("Cross-project menu denied even if session is still globally open",liveSessionTabMenu(menu,"project-B",open)===null);
check("Closed target is denied instead of closeOthers on wrong tab",liveSessionTabMenu(menu,"project-A",["session-B","session-C"])===null);
check("Empty origin/active project denied",liveSessionTabMenu({...menu,projectId:null},"project-A",open)===null&&liveSessionTabMenu(menu,null,open)===null);
check("Valid other-close set retains existing behavior",sessionTabsToClose(open,"session-A","others").join(",")==="session-B,session-C");
check("Invalid target never executes bulk close",sessionTabsToClose(open,"gone","all").length===0);
for (const [name,source] of [["SessionTabs",normal],["UnifiedTabsBar",unified]] as const) {
 check(name+" records origin project in right-click menu",source.includes("setSessionCtxMenu({ id, projectId: pid, ...anchor })"));
 check(name+" displays only validated session menu",source.includes("ctxMenu={liveSessionTabMenu(sessionCtxMenu, pid, tabs)}"));
 check(name+" clears stale menu state when project/tabs change",source.includes("setSessionCtxMenu((prev) => prev && !liveSessionTabMenu(prev, pid, tabs) ? null : prev)"));
 check(name+" checks LIVE store state before bulk close",source.includes("const current = useSessionStore.getState();")&&source.includes("liveSessionTabMenu(sessionCtxMenu, current.activeProjectId, current.openTabs)"));
}
console.log("arc005-session-menu-identity "+pass+"/"+(pass+fail));if(fail)process.exitCode=1;
