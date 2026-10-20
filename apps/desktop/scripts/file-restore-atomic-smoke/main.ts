/** FULL-1 / ARC-007: real restoreFiles, isolated physical file, injected
 * failure ONLY at already-existing atomicReplaceFile leaf. No user data. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { restoreFiles } from "../../src/main/lib/fileSnapshot.js";
import type { TurnFileEntry } from "@contracts/runtime";

let passes=0,failures=0;
function check(label:string, ok:boolean, data?:unknown){
 if(ok)passes++; else failures++;
 console.log((ok?"  ok  ":"  FAIL ")+label+(ok?"":" "+JSON.stringify(data)));
}
const root=mkdtempSync(join(tmpdir(),"mcode-atomic-rewind-"));
try{
 const file=join(root,"original.md");
 writeFileSync(file,"USER_LATEST","utf8");
 const entry:TurnFileEntry={
  filePath:file,kind:"modified",before:"PREVIOUS_STATE",
  adds:1,dels:1,afterHash:createHash("sha256").update("USER_LATEST").digest("hex"),
 };
 process.env.MCODE_TEST_ATOMIC_FAIL="1";
 let threw=false;
 let result:Awaited<ReturnType<typeof restoreFiles>>|null=null;
 try{result=await restoreFiles(root,[entry]);}
 catch{threw=true;}
 finally{delete process.env.MCODE_TEST_ATOMIC_FAIL;}
 check("★ atomic rename/fsync failure must report failed rather than successful rewind",
   !threw && result?.failed.includes(file)===true && result.restored.length===0,{threw,result});
 check("★ failed atomic replacement must preserve the original latest user's bytes",
   readFileSync(file,"utf8")==="USER_LATEST");
 check("★ no failed-save temporary file should remain in project directory",
   readdirSync(root).join(",")==="original.md",readdirSync(root));
 const retried=await restoreFiles(root,[entry]);
 check("successful retry through the same existing atomic writer reports restored",
   retried.restored.includes(file) && retried.failed.length===0,retried);
 check("successful retry restores original pre-turn bytes",
   readFileSync(file,"utf8")==="PREVIOUS_STATE");
 check("no temporary files after successful retry",readdirSync(root).join(",")==="original.md");
 const repeated=await restoreFiles(root,[entry]);
 check("idempotent repeat does not rewrite or reject an already restored file",
  repeated.restored.includes(file)&&readFileSync(file,"utf8")==="PREVIOUS_STATE",repeated);
} finally{
 delete process.env.MCODE_TEST_ATOMIC_FAIL;
 rmSync(root,{recursive:true,force:true});
}
console.log(`file-restore-atomic-smoke: ${passes}/${passes+failures}`);
if(failures)process.exitCode=1;
