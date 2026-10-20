/** Real sql.js Settings compare-and-set safety test.
 * Only touches MCODE_SMOKE_DATA_ROOT (run.sh creates a fresh temp dir).
 * Never opens a production profile or user database. */
import { initDb, closeDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
let total=0,failed=0;
function check(name:string,condition:boolean,actual?:unknown){total++;if(condition) console.log("PASS "+name);else{failed++;console.log("FAIL "+name+" "+JSON.stringify(actual));}}
if(!process.env.MCODE_SMOKE_DATA_ROOT) throw Error("missing isolated data root");
await initDb();
const cas = (SettingRepo as typeof SettingRepo & {
  compareAndSet?: (key:string,expected:string|null,next:string)=>boolean;
}).compareAndSet;
check("real sql.js SettingRepo offers atomic compare-and-set",typeof cas==="function");
if(typeof cas==="function"){
  const key="workflow.review.v1.test.cas";
  if(process.argv[2]==="verify"){
    check("new process reads the previously persisted CAS revision",SettingRepo.get(key)==="repaired",SettingRepo.get(key));
    check("restart cannot use pre-CAS value to overwrite persisted revision",!cas(key,"pending","stale"));
    check("restart preserves last approved value after conflict",SettingRepo.get(key)==="repaired");
  } else {
    SettingRepo.delete(key);
  check("null expected inserts an absent key",cas(key,null,"pending"));
  check("another absent-key claim cannot replace the first",!cas(key,null,"stale"));
  check("failed absent-key CAS preserves first value",SettingRepo.get(key)==="pending");
  check("stale previous value is rejected",!cas(key,"old","approved"));
  check("stale CAS does not overwrite current pending state",SettingRepo.get(key)==="pending");
  check("correct original value updates once",cas(key,"pending","approved"));
  check("replayed old approval cannot replace newer state",!cas(key,"pending","replay"));
  check("replayed old approval preserves new state",SettingRepo.get(key)==="approved");
  check("same value conditional update is allowed",cas(key,"approved","approved"));
  check("null expectation never treats existing empty string as absent",!cas(key,null,"new"));
  check("empty value is an ordinary present key",cas(key,"approved",""));
  check("matching empty expectation changes present empty key",cas(key,"","repaired"));
    check("CAS changes persisted SQL view",SettingRepo.get(key)==="repaired");
  }
}
closeDb();
console.log(`setting-cas-smoke:${total-failed}/${total}`);
if(failed) process.exitCode=1;
