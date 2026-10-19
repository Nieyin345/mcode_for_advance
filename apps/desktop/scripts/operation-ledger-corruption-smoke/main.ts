/**
 * ARC-006 operation-ledger replay integrity:
 * An invalid persisted result must not be returned as a proven success nor
 * cause another run of the same non-idempotent operation. Synthetic SQL DB.
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { DurableOperationLedger as ledger } from "@main/store/operationLedger.js";
import type { OperationIntent, OperationResult } from "@contracts/appControl";

let n=0, fails=0;
function check(name:string,yes:boolean,details?:unknown):void {
 n++;if(yes)console.log("  ok   "+name);
 else {fails++;console.log("  FAIL "+name+" "+JSON.stringify(details));}
}
await initDb();
const intent:OperationIntent={
 operationId:"op_healthy",ownerId:"s_owner",sessionId:"s_owner",sceneId:"app_api_call",
 method:"setting.set",requestDigest:"hash_original",effectKind:"readonly",grantRevision:"test"
};
check("healthy op originally claimed",ledger.begin(intent).begin==="claimed");
const good:OperationResult={resultKind:"SUCCEEDED",operationId:intent.operationId,
 method:intent.method,retryable:false,warnings:[],resources:[]};
ledger.settle(intent.operationId,{status:"SUCCEEDED",result:good,body:"original-body"});
const db=getDb();
const stored=()=>{
 const row=db.exec("SELECT result_json FROM operations WHERE operation_id = 'op_healthy'")[0]?.values[0]?.[0];
 return row===null?null:String(row);
};
const rawHealthy=stored();
check("healthy replay retains valid result",ledger.begin(intent).begin==="replay" && ledger.get(intent.operationId)?.result?.operationId===intent.operationId);
for(const [label,bad] of [
 ["truncated JSON","{broken"],
 ["JSON null","null"],
 ["array instead of result","[]"],
 ["wrong result structure",'{"resultKind":"SUCCEEDED"}'],
 ["wrong operation id",JSON.stringify({...good,operationId:"another_operation"})],
 ["wrong method",JSON.stringify({...good,method:"secrets.delete"})],
 ["result status mismatches ledger",JSON.stringify({...good,resultKind:"FAILED"})],
] as const) {
 db.run("UPDATE operations SET result_json = ? WHERE operation_id = ?",[bad,intent.operationId]);
 const record=ledger.get(intent.operationId);
 check("★★ "+label+": get never reports proven SUCCEEDED",record?.status==="UNCERTAIN"&&record.result===undefined,record);
 check("★★ "+label+": user-visible recovery reason not raw data",!!record?.body?.includes("损坏")&&!record.body.includes(bad),record?.body);
 check("★★ "+label+": same intent must be uncertain, never replay/claimed",ledger.begin(intent).begin==="uncertain");
 check("★★ "+label+": corrupt original SQL payload remains byte-exact",stored()===bad,{actual:stored(),expected:bad});
}
db.run("UPDATE operations SET result_json = ? WHERE operation_id = ?",[rawHealthy,intent.operationId]);
check("healthy result replay resumes exactly same stored operation",ledger.begin(intent).begin==="replay");
check("healthy result projection still holds body",ledger.get(intent.operationId)?.body==="original-body");

// A successful row with intentionally *no* result is legal in the current
// ledger semantics; do not classify null payload as corruption.
const noResult:OperationIntent={...intent,operationId:"op_no_result",requestDigest:"hash_no_result"};
ledger.begin(noResult);
ledger.settle(noResult.operationId,{status:"SUCCEEDED"});
check("legitimate null-result legacy operation remains readable",ledger.get(noResult.operationId)?.status==="SUCCEEDED"&&ledger.get(noResult.operationId)?.result===undefined);

// For a poisoned SQL query, the original error must propagate while the
// native prepared statement is freed exactly once.
const spy=db as unknown as {prepare:(sql:string)=>unknown};
const originalPrepare=spy.prepare;
for(const stage of ["bind","step","row"] as const) {
 let freed=0,prepared=0;
 const fault=new Error("FAKE_OPERATION_"+stage);
 spy.prepare=()=>{
   prepared++;
   return {
     bind:()=>{if(stage==="bind")throw fault;},
     step:()=>{if(stage==="step")throw fault;return true;},
     getAsObject:()=>{if(stage==="row")throw fault;return {};},
     free:()=>{freed++;},
   };
 };
 let thrown:unknown=null;
 try{ledger.get(intent.operationId)}catch(e){thrown=e}finally{spy.prepare=originalPrepare}
 check("★★ "+stage+": original SQL fault propagates",thrown===fault,{thrown:String(thrown)});
 check("★★ "+stage+": statement freed once",prepared===1&&freed===1,{prepared,freed});
}
closeDb();
console.log("operation-ledger-corruption-smoke:"+(n-fails)+"/"+n+" PASS");
if(fails)process.exitCode=1;
