/**
 * ARC-006 synthetic SQL-backed library suppression fail-closed contract.
 * Never reads or modifies the user's real data root.
 */
import { initDb, closeDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories/setting.js";
import { LIBRARY_SUPPRESS_SETTING_KEY } from "@contracts/libraryTypes";
import { loadSuppress, saveSuppress, isFileSuppressed, resetSuppressCacheForTest } from "@main/library/suppress.js";

let checks=0,failures=0;
function check(label:string,pass:boolean,details?:unknown):void {
 checks++;if(pass)console.log("  ok   "+label);
 else{failures++;console.log("  FAIL "+label+" "+JSON.stringify(details));}
}
await initDb();
const key=LIBRARY_SUPPRESS_SETTING_KEY;
SettingRepo.delete(key);
resetSuppressCacheForTest();
check("missing suppress setting defaults to no restrictions",loadSuppress().nodes.length===0 && loadSuppress().extensions.length===0);
check("valid suppress config saves successfully",saveSuppress({nodes:["collection:keep-private"],extensions:["PDF"]}).ok);
resetSuppressCacheForTest();
check("normal configured PDF is suppressed",isFileSuppressed("source.pdf")===true);
check("normal non-blocked .md allowed",isFileSuppressed("source.md")===false);

// A mutable cache snapshot is a privilege boundary. UI/add-on callers may
// mutate arrays returned by read, but must never change current authorization.
const returned=loadSuppress();
returned.nodes.pop();
returned.extensions.splice(0,returned.extensions.length);
check("★★ caller cannot mutate cached .pdf suppression without a save",
 isFileSuppressed("source.pdf")===true && loadSuppress().nodes.includes("collection:keep-private"),loadSuppress());

// A corrupt persisted restriction list is not an EMPTY allow list.
for(const [label,broken] of [
 ["truncated JSON","{truncated"],
 ["explicit JSON null","null"],
 ["array instead of object","[]"],
 ["invalid extensions shape",JSON.stringify({nodes:[],extensions:"pdf"})],
 ["invalid nodes shape",JSON.stringify({nodes:"bad",extensions:[".pdf"]})],
] as const){
 SettingRepo.set(key,broken);
 resetSuppressCacheForTest();
 let error="";
 try{loadSuppress();}catch(e){error=String(e);}
 check("★★ "+label+": read fails closed rather than granting access",error.includes("损坏")||error.includes("拒绝"),{error});
 error="";
 try{isFileSuppressed("/sensitive/path.pdf");}catch(e){error=String(e);}
 check("★★ "+label+": AI-facing file filter cannot treat bad list as allow",error.includes("损坏")||error.includes("拒绝"),{error});
 const saved=saveSuppress({nodes:[],extensions:[]});
 check("★★ "+label+": save cannot overwrite damaged user's original rules",!saved.ok,saved);
 check(label+": persisted corrupt bytes are unchanged",SettingRepo.get(key)===broken,SettingRepo.get(key));
}
// A previously cached valid rule must not give a stale writer permission to
// overwrite a concurrently corrupted persisted row.
SettingRepo.set(key,JSON.stringify({nodes:[],extensions:[".pdf"]}));
resetSuppressCacheForTest();
check("healthy config loaded before competing write",loadSuppress().extensions.includes(".pdf"));
const laterBroken="{concurrent-damage";
SettingRepo.set(key,laterBroken); // simulate external settings writer without module invalidate
const staleSave=saveSuppress({nodes:[],extensions:[]});
check("★★ save rechecks persisted bytes rather than trusting a stale valid cache",!staleSave.ok,staleSave);
check("★★ concurrent corrupted bytes remain unchanged",SettingRepo.get(key)===laterBroken);

// Recovery is an explicit setting repair (or a fresh legitimate install),
// not implicit clearing in the read or ordinary save route.
SettingRepo.delete(key);
resetSuppressCacheForTest();
check("explicit deletion allows fresh setup",saveSuppress({nodes:["type:obsolete","collection:still-valid"],extensions:["PDF"]}).ok);
resetSuppressCacheForTest();
check("legacy invalid node is skipped but valid restriction remains",loadSuppress().nodes.join(",")==="collection:still-valid"&&isFileSuppressed("valid.pdf"));
closeDb();
console.log("library-suppress-integrity-smoke:"+(checks-failures)+"/"+checks+" PASS");
if(failures)process.exitCode=1;
