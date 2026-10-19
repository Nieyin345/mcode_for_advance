import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCoalescedPaneWriter, mayApplyPaneHydration, withoutLocallyEditedPaneFields } from "../../src/renderer/stores/paneWidthWriteQueue.js";
const store=readFileSync(resolve("src/renderer/stores/sessionStore.ts"),"utf8");
let total=0,failed=0;function ck(s:string,b:boolean){total++;if(!b)failed++;console.log((b?"PASS ":"FAIL ")+s);}
type Gate={val:string;resolve:()=>void;reject:(error:Error)=>void};
let value="dock-right:360",maxParallel=0,inFlight=0;
const started:Gate[]=[];const errors:unknown[]=[];
const queue=createCoalescedPaneWriter(()=>value,(v:string)=>new Promise<void>((resolve,reject)=>{
 started.push({val:v,resolve,reject}); inFlight++; maxParallel=Math.max(maxParallel,inFlight);
}),err=>errors.push(err));
const flush=async()=>{for(let i=0;i<3;i++)await Promise.resolve();};
const finish=(idx:number,fail=false)=>{inFlight--;if(fail)started[idx].reject(new Error("simulated read-only setting"));else started[idx].resolve();};
const first=queue.request();
ck("First drag writes immediately at debounce boundary",started.length===1&&started[0].val==="dock-right:360");
value="dock-left:280";const second=queue.request();
value="dock-right:400";const third=queue.request();
ck("Two drags during slow IPC never start parallel writes",started.length===1&&inFlight===1);
finish(0);await flush();
ck("Pending updates coalesce to exactly the latest layout",started.length===2&&started[1].val==="dock-right:400");
ck("Only one async write active across all requests",maxParallel===1&&inFlight===1);
finish(1);await Promise.all([first,second,third]);
ck("Queue settles cleanly without extra obsolete writes",started.length===2&&inFlight===0);
value="dock-left:320";const failure=queue.request();
ck("After settling queue can accept next drag",started.length===3&&started[2].val==="dock-left:320");
value="dock-left:420";const recovery=queue.request();
finish(2,true);await flush();
ck("Failed DB write does not strand the latest pending layout",started.length===4&&started[3].val==="dock-left:420"&&errors.length===1);
finish(3);await Promise.all([failure,recovery]);
ck("Recovered queue has no residual async activity",inFlight===0&&started.length===4);
ck("Production pane persistence uses single-flight queue instead of overlapping await setting.set",
  store.includes("const paneWidthWriter = createCoalescedPaneWriter(")&&store.includes("void paneWidthWriter.request()"));
ck("Production still applies 400ms debounce before queueing",store.includes("}, 400);")&&store.includes("paneWidthPersistTimer"));
ck("Stale async hydrate must not overwrite a user dock action",!mayApplyPaneHydration(0,1));
ck("Hydration proceeds when no local layout action occurred",mayApplyPaneHydration(4,4));
ck("A second local resize invalidates the older delayed hydration",!mayApplyPaneHydration(4,6));
ck("Production snapshot guards deferred pane settings against local changes",
  store.includes("initialPaneLayoutRevision = paneLayoutRevision;") &&
  store.includes("if (mayApplyPaneHydration(initialPaneLayoutRevision, paneLayoutRevision))") &&
  store.includes("paneLayoutRevision++;"));
const persistedLayout={rightDock:"right",leftWidthPct:29,rightWidth:525,bottomTerminalHeight:310,editorWidthPct:62};
const userChangedDock=new Set<keyof typeof persistedLayout>(["rightDock"]);
const safeHydration=withoutLocallyEditedPaneFields(persistedLayout,userChangedDock);
ck("A live docking decision survives delayed restoration",!("rightDock" in safeHydration));
ck("Unchanged pane widths still hydrate during a concurrent docking action",
  safeHydration.rightWidth===525&&safeHydration.leftWidthPct===29&&safeHydration.editorWidthPct===62);
ck("A concurrent width change suppresses only that exact field",
  (()=>{
    const patch=withoutLocallyEditedPaneFields(persistedLayout,new Set<keyof typeof persistedLayout>(["rightWidth"]));
    return !("rightWidth" in patch)&&patch.rightDock==="right"&&patch.bottomTerminalHeight===310;
  })());
ck("No local change restores every known pane setting",
  Object.keys(withoutLocallyEditedPaneFields(persistedLayout,new Set())).length===5);
ck("Production marks local field per drag and merges untouched preferences during hydration",
  store.includes("withoutLocallyEditedPaneFields(patch, paneLayoutLocalEdits)")&&
  store.includes('schedulePaneWidthPersist(get, "rightDock")')&&
  store.includes('schedulePaneWidthPersist(get, "rightWidth")'));
ck("Right pane rehydration clamps against the latest sidebar share if it changed during init",
  store.includes('const leftPct = paneLayoutLocalEdits.has("leftWidthPct")'));
ck("Production snapshot serializes dock and all four existing dimensions",
  store.includes("dock: s.rightDock")&&store.includes("leftPct: s.leftWidthPct")&&store.includes("editor: s.editorWidthPct"));
console.log("arc005-pane-write-race "+(total-failed)+"/"+total);if(failed)process.exitCode=1;
