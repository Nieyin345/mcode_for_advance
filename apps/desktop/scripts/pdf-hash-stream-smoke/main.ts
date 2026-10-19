/** Synthetic PDF streaming SHA regression; temp directory only. */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { hashFile, verifyPdf } from "@main/library/pdfFile.js";

let count=0,failed=0;
function check(name:string,ok:boolean,details?:unknown):void {
 count++;if(ok)console.log("  ok   "+name);
 else{failed++;console.log("  FAIL "+name+" "+JSON.stringify(details));}
}
const root=mkdtempSync(join(tmpdir(),"mcode-pdf-stream-"));
const file=join(root,"synthetic.pdf");
const fs=createRequire(import.meta.url)("node:fs") as {
 readFileSync:(file:unknown,...args:unknown[])=>unknown;
 readSync:(fd:number,b:Buffer,offset:number,length:number,pos:number|null)=>number;
 closeSync:(fd:number)=>void;
};
const orig={readFileSync:fs.readFileSync,readSync:fs.readSync,closeSync:fs.closeSync};
try{
 const bytes=Buffer.concat([Buffer.from("%PDF-1.7\n"),randomBytes(3*1024*1024),Buffer.from("\n%%EOF\n")]);
 writeFileSync(file,bytes);
 const digest=createHash("sha256").update(bytes).digest("hex");
 check("normal SHA is unchanged",hashFile(file)===digest);
 check("normal verifyPdf still passes",verifyPdf(file)===null);
 let whole=0;
 try{
   fs.readFileSync=(p,...args)=>{
     if(p===file){whole++;throw new Error("full file read");}
     return orig.readFileSync(p,...args);
   };
   syncBuiltinESMExports();
   let actual="",error="";
   try{actual=hashFile(file)}catch(e){error=String(e)}
   check("★★ hash does not allocate an entire PDF in readFileSync",error===""&&actual===digest,{error});
   check("★★ no whole-file read attempt",whole===0,whole);
 }finally{fs.readFileSync=orig.readFileSync;syncBuiltinESMExports();}
 let reads=0,max=0;
 try{
   fs.readSync=(fd,buf,offset,length,pos)=>{
     reads++;max=Math.max(max,length);
     return orig.readSync(fd,buf,offset,Math.min(length,123),pos);
   };
   syncBuiltinESMExports();
   check("★★ short reads produce correct SHA",hashFile(file)===digest);
   check("★★ 1MB maximum request",reads>1&&max<=1048576,{reads,max});
 }finally{fs.readSync=orig.readSync;syncBuiltinESMExports();}
 let closed=0,got=false;
 try{
   fs.readSync=()=>{throw new Error("controlled read fault")};
   fs.closeSync=fd=>{closed++;orig.closeSync(fd)};
   syncBuiltinESMExports();
   try{hashFile(file)}catch(e){got=String(e).includes("controlled read fault")}
   check("★★ file read errors propagate",got);
   check("★★ opened fd closed on failure",closed===1,closed);
 }finally{fs.readSync=orig.readSync;fs.closeSync=orig.closeSync;syncBuiltinESMExports();}
 check("source original bytes unchanged",readFileSync(file).equals(bytes));
}finally{rmSync(root,{recursive:true,force:true})}
console.log("pdf-hash-stream-smoke:"+(count-failed)+"/"+count+" PASS");
if(failed)process.exitCode=1;
