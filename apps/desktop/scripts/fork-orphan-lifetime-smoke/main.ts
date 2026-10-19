/**
 * ARC-006 Session Fork orphan registry: resource cleanup and resolution durability.
 * Isolation: dataRoot alias requires temp $MCODE_SMOKE_DATA_ROOT, real sql.js.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { initDb, getDb, commitNow, closeDb } from "@main/store/db.js";
import { ForkOrphanRepo } from "@main/store/forkOrphans.js";

let total=0,failed=0;
function check(name:string,ok:boolean,data?:unknown):void{
 total++;
 if(ok) console.log("  ok   "+name);
 else {failed++;console.log("  FAIL "+name+" "+JSON.stringify(data));}
}
function equal(name:string,a:unknown,b:unknown):void{
 check(name,JSON.stringify(a)===JSON.stringify(b),{a,b});
}
const root=process.env.MCODE_SMOKE_DATA_ROOT;
if(!root)throw new Error("missing isolated MCODE_SMOKE_DATA_ROOT");
await initDb();
const SQL=await initSqlJs();
function diskStatus():string|undefined{
 const file=join(root!,"mcode.db");
 if(!existsSync(file))return undefined;
 const handle=new SQL.Database(new Uint8Array(readFileSync(file)));
 try{
  const rows=handle.exec("SELECT status FROM fork_orphans WHERE id = 'orphan_source_a'");
  return rows[0]?.values[0]?.[0] as string|undefined;
 }finally{handle.close();}
}
const id=ForkOrphanRepo.add({
 id:"orphan_source_a",sourceSessionId:"s_parent",providerSessionId:"sdk_fork_test",
 providerId:"claude-sdk",cwd:"/isolated/only",reason:"synthetic failed fork",
});
const db=getDb();
check("normal add returns declared synthetic id",id==="orphan_source_a");
check("★★ unresolved external fork is recorded on disk before add() returns",
 diskStatus()==="ORPHANED",{status:diskStatus()});
check("normal get returns ORPHANED",ForkOrphanRepo.get(id)?.status==="ORPHANED");
equal("normal countForSource initial",ForkOrphanRepo.countForSource("s_parent"),1);
equal("normal list shows one orphan",ForkOrphanRepo.list().map(x=>x.id),[id]);

const dbSpy=db as unknown as {prepare:(sql:string)=>unknown};
const rawPrepare=dbSpy.prepare;
const cases:Array<[string,()=>unknown]>=[
 ["get",()=>ForkOrphanRepo.get(id)],
 ["list",()=>ForkOrphanRepo.list()],
 ["countForSource",()=>ForkOrphanRepo.countForSource("s_parent")],
];
for(const [name,action] of cases){
 for(const stage of ["bind","step","row"] as const){
  let prepared=0,frees=0;
  const fault=new Error("ORPHAN_INJECT_"+name+"_"+stage);
  dbSpy.prepare=()=>{
   prepared++;
   return {
    bind:()=>{if(stage==="bind")throw fault;},
    step:()=>{if(stage==="step")throw fault;return true;},
    getAsObject:()=>{if(stage==="row")throw fault;return {};},
    free:()=>{frees++;},
   };
  };
  let caught:unknown=null;
  try{action()}catch(e){caught=e}finally{dbSpy.prepare=rawPrepare}
  check("SQL "+name+"/"+stage+" preserves original exception",caught===fault,{caught:String(caught)});
  check("★★ SQL "+name+"/"+stage+" frees statement exactly once",prepared===1&&frees===1,{prepared,frees});
 }
}
// Snapshot the ORPHANED row to the temp disk, then resolve it. If resolve()
// forgets persist(), the in-memory status is RESOLVED but disk still says
// ORPHANED, and another process would resurrect this already-cleared task.
check("synthetic ORPHANED row was durably written",commitNow().outcome==="DURABLE");
check("pre-resolution disk status is ORPHANED",diskStatus()==="ORPHANED",diskStatus());
ForkOrphanRepo.resolve(id);
check("normal resolve updates in-memory record",ForkOrphanRepo.get(id)?.status==="RESOLVED");
equal("normal countForSource excludes resolved rows",ForkOrphanRepo.countForSource("s_parent"),0);
// The cleanup confirmation must be durable before it is reported complete:
// a crash in the next tick must not resurrect a resolved SDK-side orphan.
check("★★ resolving an orphan commits status before resolve() returns",diskStatus()==="RESOLVED",diskStatus());
check("normal ORPHANED list excludes resolved",ForkOrphanRepo.list().length===0);
equal("normal RESOLVED list includes record",ForkOrphanRepo.list("RESOLVED").map(x=>x.id),[id]);

closeDb();
console.log("fork-orphan-lifetime-smoke:"+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
