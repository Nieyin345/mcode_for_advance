/** ARC-007 content-addressed PDF publish: actual temp filesystem + sql.js.
 * E1 race mutation uses fs.copyFileSync shim after source SHA was calculated.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { initDb, closeDb } from "@main/store/db.js";
import { LibraryRepo } from "@main/store/repositories/library.js";
import { hashFile } from "@main/library/pdfFile.js";
import { pdfPathForHash } from "@main/library/paths.js";
import { importPdfFiles, attachPdfToItem } from "@main/library/pdfImport.js";

let total=0,failed=0;
function check(label:string,pass:boolean,extra?:unknown):void {
 total++;if(pass)console.log("  ok   "+label);
 else {failed++;console.log("  FAIL "+label+" "+JSON.stringify(extra));}
}
const root=process.env.MCODE_SMOKE_DATA_ROOT;
if(!root)throw new Error("Must set temp MCODE_SMOKE_DATA_ROOT");
const srcDir=join(root,"uploads");
mkdirSync(srcDir,{recursive:true});
const fixture=readFileSync(join(process.cwd(),"scripts","fixtures","sample-paper.pdf"));
function source(name:string):string {
 const p=join(srcDir,name+".pdf");
 writeFileSync(p,Buffer.concat([fixture,Buffer.from("\n% "+name+"\n")]));
 return p;
}
const fs=createRequire(import.meta.url)("node:fs") as { copyFileSync:(a:string,b:string,flags?:number)=>void };
const realCopy=fs.copyFileSync;
async function onCopy(src:string,callback:()=>void,fn:()=>Promise<void>):Promise<void> {
 let applied=false;
 try {
   fs.copyFileSync=(from:string,to:string,flags?:number)=>{
     if(!applied && from===src) {applied=true;callback();}
     return realCopy(from,to,flags);
   };
   syncBuiltinESMExports();
   await fn();
 }finally{
   fs.copyFileSync=realCopy;syncBuiltinESMExports();
 }
 check("copy-race injection actually executed",applied);
}

await initDb();
const baseline=source("source-after-hash-mutation");
const firstSha=hashFile(baseline);
const firstDest=pdfPathForHash(firstSha);
await onCopy(baseline,()=>writeFileSync(baseline,Buffer.concat([fixture,Buffer.from("\n% CHANGED AFTER HASH\n")])),async()=>{
 const entries=await importPdfFiles({paths:[baseline]});
 check("★★ mutated source after hash is rejected, not registered under stale SHA",
   !entries[0]?.item && Boolean(entries[0]?.error),entries[0]);
 check("★★ wrong bytes were not published under original content-addressed name",
   !existsSync(firstDest),existsSync(firstDest) ? hashFile(firstDest) : null);
});
check("source file belongs to user and is never deleted",existsSync(baseline));

const corrupt=source("existing-destination-corrupt");
const corruptSha=hashFile(corrupt);
const corruptDest=pdfPathForHash(corruptSha);
mkdirSync(dirname(corruptDest),{recursive:true});
const originalCorrupt=Buffer.from("DO_NOT_OVERWRITE_CORRUPTED_EXISTING_BYTES");
writeFileSync(corruptDest,originalCorrupt);
const corruptResult=await importPdfFiles({paths:[corrupt]});
check("★★ already-existing wrong-hash object cannot be registered as matching PDF",
  !corruptResult[0]?.item && Boolean(corruptResult[0]?.error),corruptResult[0]);
check("★★ existing corrupt bytes preserved exactly",
  readFileSync(corruptDest).equals(originalCorrupt));
rmSync(corruptDest,{force:true});

const collision=source("concurrent-writer-destination");
const collisionSha=hashFile(collision),collisionDest=pdfPathForHash(collisionSha);
await onCopy(collision,()=>{
 mkdirSync(dirname(collisionDest),{recursive:true});
 writeFileSync(collisionDest,"OTHER_WRITER_CREATED_DEST_DURING_COPY");
},async()=>{
 const result=await importPdfFiles({paths:[collision]});
 check("★★ concurrent stranger destination cannot be overwritten",
   readFileSync(collisionDest,"utf8")==="OTHER_WRITER_CREATED_DEST_DURING_COPY");
 check("★★ collision with wrong content reports failure, no DB registration",
   !result[0]?.item && Boolean(result[0]?.error),result[0]);
});
rmSync(collisionDest,{force:true});

const healthy=source("healthy-import");
const healthyHash=hashFile(healthy);
const healthyResult=await importPdfFiles({paths:[healthy]});
const healthyItem=healthyResult[0]?.item;
check("normal import continues successfully",!!healthyItem && !healthyResult[0]?.error,healthyResult[0]);
check("normal published blob matches DB hash exactly",hashFile(pdfPathForHash(healthyHash))===healthyHash);
const duplicate=await importPdfFiles({paths:[healthy]});
check("normal duplicate stays idempotent",duplicate[0]?.alreadyPresent===true && duplicate[0]?.item?.id===healthyItem?.id);

const attached=source("attach-after-hash-mutation");
const attachedHash=hashFile(attached);
const attachedDest=pdfPathForHash(attachedHash);
LibraryRepo.upsert({id:"pdf-attach-target",title:"Attach target"});
await onCopy(attached,()=>writeFileSync(attached,Buffer.concat([fixture,Buffer.from("\n% ALTERED-ATTACH\n")])),async()=>{
 let result:ReturnType<typeof attachPdfToItem>|undefined;
 try{result=attachPdfToItem("pdf-attach-target",attached);}catch(e){result={ok:false,error:String(e)};}
 check("★★ attach also refuses source changed between hash and copy",result?.ok===false,result);
 check("★★ attach never records a mismatched PDF path",!LibraryRepo.get("pdf-attach-target")?.pdfPath,LibraryRepo.get("pdf-attach-target")?.pdfPath);
 check("★★ attach never publishes mismatched object",!existsSync(attachedDest));
});
writeFileSync(attached,Buffer.concat([fixture,Buffer.from("\n% attach-final-valid\n")]));
const attachedOk=attachPdfToItem("pdf-attach-target",attached);
check("normal attachment still works after a failed race",attachedOk.ok && !!LibraryRepo.get("pdf-attach-target")?.pdfPath,attachedOk);
const expectedAttachment=pdfPathForHash(hashFile(attached));
check("normal attach published content-addressed bytes",
  existsSync(expectedAttachment) && hashFile(expectedAttachment)===hashFile(attached));
const parents=readdirSync(join(root,"library","papers"),{recursive:true}) as string[];
check("no failed import left orphan .tmp in library papers",!parents.some(p=>p.endsWith(".tmp")),parents.filter(p=>p.endsWith(".tmp")));
closeDb();
console.log("pdf-import-atomic-smoke:"+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
