/**
 * ARC-006 isolated LibraryRepo prepared-statement lifetime and atomic delete.
 * Faults injected ONLY into a synthetic sql.js DB at prepare() boundary.
 */
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { LibraryRepo } from "@main/store/repositories/library.js";

let checks=0,failures=0;
function check(name:string,pass:boolean,detail?:unknown):void{
 checks++;if(pass)console.log("  ok   "+name);
 else {failures++;console.log("  FAIL "+name+" "+JSON.stringify(detail));}
}
function same(name:string,a:unknown,b:unknown):void{check(name,JSON.stringify(a)===JSON.stringify(b),{actual:a,expected:b});}
await initDb();
const one=LibraryRepo.upsert({title:"One"});
const two=LibraryRepo.upsert({title:"Two"});
LibraryRepo.setPdf(one.id,"files/shared.pdf","sha_same");
LibraryRepo.setPdf(two.id,"files/shared.pdf","sha_same");
const db=getDb();
const raw=db as unknown as {prepare:(sql:string)=>unknown;run:(sql:string,params?:unknown)=>unknown};
const actualPrepare=raw.prepare;
const actualRun=raw.run;
const cases: Array<{
 name:string;
 match:string;
 invoke:()=>unknown;
 stages:readonly ("bind"|"step"|"row"|"reset")[];
}>=[
 {name:"list count",match:"SELECT COUNT(*) AS n FROM library_items i",invoke:()=>LibraryRepo.list(),stages:["bind","step","row"]},
 {name:"list page",match:"SELECT i.* FROM library_items i",invoke:()=>LibraryRepo.list(),stages:["bind","step","row"]},
 {name:"listAllItems",match:"SELECT * FROM library_items ORDER BY",invoke:()=>LibraryRepo.listAllItems(),stages:["bind","step","row"]},
 {name:"pathRefCounts",match:"SELECT pdf_path, md_path, file_path",invoke:()=>LibraryRepo.pathRefCounts(),stages:["step","row"]},
 {name:"get",match:"SELECT * FROM library_items WHERE id = ?",invoke:()=>LibraryRepo.get(one.id),stages:["bind","step","row"]},
 {name:"findByPdfSha",match:"SELECT * FROM library_items WHERE pdf_sha256",invoke:()=>LibraryRepo.findByPdfSha("sha_same"),stages:["bind","step","row"]},
 {name:"findLinkedByPath",match:"WHERE entry_mode = 'linked' AND file_path",invoke:()=>LibraryRepo.findLinkedByPath("/tmp/path"),stages:["bind","step","row"]},
 {name:"conversionStats",match:"SELECT COUNT(*) AS n FROM library_items",invoke:()=>LibraryRepo.conversionStats(),stages:["step","row"]},
 {name:"getMany",match:"SELECT * FROM library_items WHERE id = ?",invoke:()=>LibraryRepo.getMany([one.id,two.id]),stages:["bind","step","row","reset"]},
 {name:"listByCollection",match:"JOIN library_collection_items ci ON ci.item_id = i.id",invoke:()=>LibraryRepo.listByCollection("lc_synthetic"),stages:["bind","step","row"]},
 {name:"listByCollectionTree",match:"WITH RECURSIVE subtree(id)",invoke:()=>LibraryRepo.listByCollectionTree("lc_synthetic"),stages:["bind","step","row"]},
 {name:"count",match:"SELECT COUNT(*) AS n FROM library_items",invoke:()=>LibraryRepo.count(),stages:["step","row"]},
];
for(const {name,match,invoke,stages} of cases){
  for(const stage of stages){
    let freed=0,prepared=0;
    const thrown=new Error("INJECT_LIBRARY_"+name+"_"+stage);
    raw.prepare=(sql:string)=>{
      if(!sql.includes(match)) return actualPrepare.call(db,sql);
      prepared++;
      return {
        bind:()=>{if(stage==="bind")throw thrown;},
        step:()=>{if(stage==="step")throw thrown;return true;},
        getAsObject:()=>{if(stage==="row")throw thrown;return {
          n:2,id:one.id,title:"One",abstract:null,language:null,url:null,
          pdf_path:"files/shared.pdf",pdf_sha256:"sha_same",md_path:null,
          entry_mode:"attached",file_path:null,added_at:1,updated_at:1,
        };},
        reset:()=>{if(stage==="reset")throw thrown;},
        free:()=>{freed++;},
      };
    };
    let error:unknown=null;
    try{invoke()}catch(err){error=err}
    finally{raw.prepare=actualPrepare}
    check(name+"/"+stage+": original SQL error propagates",error===thrown,{got:String(error)});
    check(name+"/"+stage+": statement free exactly once",prepared===1&&freed===1,{prepared,freed});
  }
}
// If BEGIN fails, the delete stmt must not have been prepared first (old code
// allocated it before BEGIN, then BEGIN error leaked a statement).
{
  let prepared=0;
  const error=new Error("FAKE_BEGIN_REJECT");
  raw.prepare=(sql:string)=>{
    if(sql.includes("DELETE FROM library_items WHERE id = ?"))prepared++;
    return actualPrepare.call(db,sql);
  };
  raw.run=(sql:string,params?:unknown)=>{
    if(sql==="BEGIN")throw error;
    return actualRun.call(db,sql,params);
  };
  let caught:unknown=null;
  try{LibraryRepo.delete([one.id])}catch(e){caught=e}
  finally{raw.prepare=actualPrepare;raw.run=actualRun}
  check("delete propagates original BEGIN failure",caught===error,{error:String(caught)});
  check("★★ no statement prepared before failing BEGIN",prepared===0,{prepared});
  check("failed BEGIN leaves library item intact",LibraryRepo.get(one.id)?.id===one.id);
}

// SQL write failure during second delete must preserve BOTH rows.
{
  let calls=0;
  const fault=new Error("FAKE_SECOND_DELETE_FAILED");
  raw.prepare=(sql:string)=>{
    const q=actualPrepare.call(db,sql) as {run:(args:unknown[])=>unknown;free:()=>void};
    if(!sql.includes("DELETE FROM library_items WHERE id = ?"))return q;
    return {
      run:(args:unknown[])=>{
        calls++;
        if(calls===2)throw fault;
        return q.run(args);
      },
      free:()=>q.free(),
    };
  };
  let caught:unknown=null;
  try{LibraryRepo.delete([one.id,two.id])}catch(e){caught=e}finally{raw.prepare=actualPrepare}
  check("second delete actual statement failed",caught===fault,{error:String(caught)});
  check("failed multi-delete rolls back FIRST deleted item",LibraryRepo.get(one.id)?.id===one.id);
  check("failed multi-delete preserves SECOND item",LibraryRepo.get(two.id)?.id===two.id);
}
// Positive controls for the unmodified observable results.
same("normal list returns both",LibraryRepo.list({limit:10}).items.map(x=>x.title).sort(),["One","Two"]);
same("normal getMany returns requested order",LibraryRepo.getMany([two.id,one.id]).map(x=>x.id),[two.id,one.id]);
same("shared attachment ref count still tracks two rows",LibraryRepo.pathRefCounts().get("files/shared.pdf"),2);
LibraryRepo.delete([one.id,two.id]);
same("normal batch delete still works",LibraryRepo.list().total,0);
closeDb();
console.log("library-repo-lifetime-smoke: "+(checks-failures)+"/"+checks+" PASS");
if(failures)process.exitCode=1;
