/**
 * ARC-006 Session Fork orphan registry: resource cleanup and resolution durability.
 * Isolation: dataRoot alias requires temp $MCODE_SMOKE_DATA_ROOT, real sql.js.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { initDb, getDb, commitNow, closeDb } from "@main/store/db.js";
import { ForkOrphanRepo, compensateProviderFork } from "@main/store/forkOrphans.js";

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
function diskHasUnresolvedProvider(providerSessionId:string):boolean{
 const file=join(root!,"mcode.db");
 const handle=new SQL.Database(new Uint8Array(readFileSync(file)));
 try{
  const stmt=handle.prepare("SELECT 1 FROM fork_orphans WHERE provider_session_id = ? AND status = 'ORPHANED'");
  try{
   stmt.bind([providerSessionId]);
   return stmt.step();
  }finally{stmt.free();}
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

// SDK/plugin failures can reject with ANY JS value, not just Error.
// The compensation path promises never to throw a secondary exception:
// otherwise the original failed fork is masked AND no orphan is recorded.
const unsafeGetter=Object.defineProperty({}, "message", {
 get(){throw new Error("synthetic hostile message getter");},
});
for(const [tag,thrown] of [["null",null],["getter",unsafeGetter]] as const){
 const providerSessionId="synthetic_bad_delete_"+tag;
 let secondary:unknown=undefined;
 try{
  await compensateProviderFork({
   sourceSessionId:"s_parent",
   providerSessionId,providerId:"claude-sdk",cwd:"/isolated/only",
   cause:"synthetic failed local transaction",
   deleteSession:async()=>{throw thrown;},
  });
 }catch(err){secondary=err;}
 check("★★ SDK rejection "+tag+" cannot rethrow during fork compensation",
  secondary===undefined,{secondary:String(secondary)});
 check("★★ SDK rejection "+tag+" still creates an orphan in memory",
  ForkOrphanRepo.list().some((o)=>o.providerSessionId===providerSessionId));
 check("★★ SDK rejection "+tag+" persists orphan in a second on-disk DB reader",
  diskHasUnresolvedProvider(providerSessionId));
}
// Failing the registry itself must not let a malicious thrown value break
// the "never throw from compensation" contract either.
const dbRunSpy=db as unknown as {run:(sql:string,params?:unknown)=>unknown};
const savedRun=dbRunSpy.run;
let registrySecondary:unknown=undefined;
try{
 dbRunSpy.run=()=>{throw null;};
 await compensateProviderFork({
  sourceSessionId:"s_parent",providerSessionId:"synthetic_registry_fail",
  providerId:"claude-sdk",cwd:"/isolated/only",cause:"synthetic failure",
 });
}catch(err){registrySecondary=err;}finally{dbRunSpy.run=savedRun;}
check("★★ orphan registry rejecting null never causes secondary compensation exception",
 registrySecondary===undefined,{secondary:String(registrySecondary)});
closeDb();
console.log("fork-orphan-lifetime-smoke:"+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
