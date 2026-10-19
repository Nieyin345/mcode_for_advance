/**
 * ARC-006 isolated SQL/repository ownership and project path cache guards.
 * Data root points only to a temporary smoke directory.
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { ProjectRepo } from "@main/store/repositories/project.js";
import { HookRunRepo, type HookRunRow } from "@main/store/repositories/hookRun.js";
import type { Project } from "@contracts/session";

let n=0,fails=0;
function assert(name:string,yes:boolean,details?:unknown):void{
  n++; if(yes)console.log("  ok   "+name);else {fails++;console.log("  FAIL "+name+" "+JSON.stringify(details));}
}
function eq(name:string,a:unknown,b:unknown):void{
  assert(name,JSON.stringify(a)===JSON.stringify(b),{actual:a,expected:b});
}
function rejected(name:string,invoke:()=>unknown):void{
  let err="";try{invoke()}catch(e){err=String(e)}
  assert(name,err.length>0,{error:err});
}
await initDb();
const db=getDb();
const time=Date.now();
const mk=(id:string,path:string):Project=>({id,name:id,path,archived:false,group:null,
  sortOrder:0,pinnedAt:null,createdAt:time,updatedAt:time});
ProjectRepo.create(mk("p_test_A","/isolated/workspace-A"));
ProjectRepo.create(mk("p_test_B","/isolated/workspace-B"));
eq("normal projects initially list A/B",
  ProjectRepo.list().map(x=>x.id).filter(x=>x.startsWith("p_test_")),["p_test_A","p_test_B"]);

// pathGuard receives ProjectRepo.listPaths on every security-sensitive call.
// Mutating one return value must not change the trusted list for later calls.
const paths=ProjectRepo.listPaths();
paths.push("/outside/trusted-root-injection");
paths.splice(paths.indexOf("/isolated/workspace-A"),1);
const rootsAfter=ProjectRepo.listPaths();
assert("★★ path caller cannot insert a fake root into shared trusted roots",!rootsAfter.includes("/outside/trusted-root-injection"),rootsAfter);
assert("★★ path caller cannot drop a real root from shared cache",rootsAfter.includes("/isolated/workspace-A"),rootsAfter);
eq("ProjectRepo.list() remains unchanged",ProjectRepo.get("p_test_A")?.path,"/isolated/workspace-A");

const orderBefore=ProjectRepo.list().map(x=>({id:x.id,sort:x.sortOrder})).filter(x=>x.id.startsWith("p_test_"));
rejected("★★ duplicate reorder id must reject before any UPDATE",()=>ProjectRepo.reorder(["p_test_A","p_test_A"]));
eq("★★ rejected duplicate reorder keeps both original positions",
  ProjectRepo.list().map(x=>({id:x.id,sort:x.sortOrder})).filter(x=>x.id.startsWith("p_test_")),orderBefore);
ProjectRepo.reorder(["p_test_B","p_test_A"]);
eq("normal distinct reorder still works",ProjectRepo.list().filter(x=>x.id.startsWith("p_test_")).map(x=>x.id),["p_test_B","p_test_A"]);

// Failure injection at real repository prepare boundary. The existing
// withStatement must free after every SQL error and ROLLBACK reorder.
const sql=db as unknown as {prepare:(text:string)=>unknown};
const actualPrepare=sql.prepare;
const tests=[
  ["project.create(max)","SELECT COALESCE(MAX(sort_order)",()=>ProjectRepo.create(mk("p_never_created","/isolated/ghost"))],
  ["project.list","SELECT * FROM projects ORDER BY",()=>ProjectRepo.list()],
  ["project.get","SELECT * FROM projects WHERE id",()=>ProjectRepo.get("p_test_A")],
  ["project.reorder","UPDATE projects SET sort_order",()=>ProjectRepo.reorder(["p_test_A","p_test_B"])],
] as const;
for(const [name,queryMatch,invoke] of tests){
  for(const stage of ["step","row"] as const){
    if(name==="project.reorder"&&stage==="row")continue;
    let frees=0,hits=0;
    const err=new Error("FAULT_PROJECT_"+name+"_"+stage);
    sql.prepare=(query:string)=>{
      if(!query.includes(queryMatch))return actualPrepare.call(db,query);
      hits++;
      return {
        bind:()=>{},
        step:()=>{if(stage==="step")throw err;return true;},
        getAsObject:()=>{if(stage==="row")throw err;return {next:7,id:"p_test_A",name:"A",path:"/isolated/workspace-A",archived:0,group:null,sort_order:0,pinned_at:null,created_at:time,updated_at:time};},
        run:()=>{throw err;},
        free:()=>{frees++;},
      };
    };
    let caught:unknown=null;
    try{invoke()}catch(e){caught=e}finally{sql.prepare=actualPrepare}
    assert(name+"/"+stage+": original SQL fault propagates",caught===err,{caught:String(caught)});
    assert(name+"/"+stage+": prepared Statement freed exactly once",frees===1&&hits===1,{frees,hits});
  }
}
eq("failed project create did not insert ghost",ProjectRepo.get("p_never_created"),undefined);

// Hook-run ID is global. A collision must not change the attribution of an
// existing source event nor falsely turn a running event into "ok".
const hook:HookRunRow={
 runId:"hrun_collision",hookId:"hk_original",source:"plugin",pluginId:"plugin_a",
 pluginVersion:"1",nativeEvent:"PreToolUse",commandDigest:"digest_1",
 matcherDigest:null,event:"tool.use",sessionId:"s_original",sessionKind:"chat",
 status:"running",exitCode:null,durationMs:null,error:null,startedAt:time
};
HookRunRepo.record(hook);
const beforeHook=HookRunRepo.get(hook.runId);
for(const [label,mutation] of [
  ["foreign session",{sessionId:"s_other",status:"ok"}],
  ["foreign hook",{hookId:"hk_new",status:"ok"}],
  ["foreign plugin",{pluginId:"plugin_other",status:"ok"}],
  ["changed command",{commandDigest:"digest_other",status:"ok"}],
] as const){
  rejected("★★ hook-run same ID from "+label+" must not rewrite original audit",
    ()=>HookRunRepo.record({...hook,...mutation}));
  eq("★★ "+label+": original hook audit fact remains unchanged",HookRunRepo.get(hook.runId),beforeHook);
}
HookRunRepo.record({...hook,status:"ok",exitCode:0,durationMs:12});
eq("legitimate hook terminal update works",HookRunRepo.get(hook.runId)?.status,"ok");
eq("legitimate hook terminal duration persisted",HookRunRepo.get(hook.runId)?.durationMs,12);

closeDb();
console.log("project-hook-repo-guard-smoke: "+(n-fails)+"/"+n+" PASS");
if(fails)process.exitCode=1;
