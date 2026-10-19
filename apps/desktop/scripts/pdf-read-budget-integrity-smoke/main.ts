/**
 * ARC-007 read contract: real temporary sql.js LibraryRepo + real filesystem.
 * Never reads the authenticated user's app data.
 */
import { mkdirSync, writeFileSync, truncateSync, statSync as realStat, readFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { initDb, closeDb } from "@main/store/db.js";
import { LibraryRepo } from "@main/store/repositories/library.js";
import { readPdfBytes } from "@main/library/pdfRead.js";

let checks=0,bad=0;
function check(label:string,good:boolean,extra?:unknown) {
 checks++;if(good)console.log("  ok   "+label);
 else {bad++;console.log("  FAIL "+label+" "+JSON.stringify(extra));}
}
const root=process.env.MCODE_SMOKE_DATA_ROOT;
if(!root)throw new Error("Must use temporary MCODE_SMOKE_DATA_ROOT");
const papers=join(root,"library","papers");
mkdirSync(papers,{recursive:true});
const file=join(papers,"ordinary.pdf");
writeFileSync(file,"%PDF-1.7 real bytes read");
const secret=join(root,"secret.pdf");
writeFileSync(secret,"SECRET_OUTSIDE_LIBRARY");
await initDb();
const id="read-contract";
LibraryRepo.upsert({id,title:"Synthetic PDF"});
const associate=(path:string)=>LibraryRepo.setPdf(id,path,"synthetic-hash");

check("unknown item gives a clean error",!readPdfBytes("nonexistent").ok);
associate("papers/ordinary.pdf");
const ok=readPdfBytes(id);
check("normal referenced PDF reads as exact Uint8Array",
 ok.ok && Buffer.from(ok.bytes??[]).equals(readFileSync(file)),ok.error);

associate("../secret.pdf");
const escaped=readPdfBytes(id);
check("★★ corrupt DB path outside library must not read or expose foreign bytes",
 !escaped.ok && escaped.bytes===null,{ok:escaped.ok,text:Buffer.from(escaped.bytes??[]).toString("utf8")});
check("★★ unsafe source path cannot leak filesystem absolute location",
 !String(escaped.error).includes(root),escaped.error);

associate("papers");
const dir=readPdfBytes(id);
check("★★ directory accidentally stored as PDF path is explicitly refused",
 !dir.ok && /目录|文件夹|不是.*文件/.test(dir.error??""),dir.error);
check("★★ directory read error does not disclose private absolute paths",
 !String(dir.error).includes(root),dir.error);

associate("papers/missing.pdf");
check("missing PDF returns an explicit error, not empty success",!readPdfBytes(id).ok);

const oversized=join(papers,"oversized.pdf");
writeFileSync(oversized,"%PDF-1.7\n");
truncateSync(oversized,64*1024*1024+1);
associate("papers/oversized.pdf");
const preflight=readPdfBytes(id);
check("oversized file is blocked by normal budget check",!preflight.ok && preflight.bytes===null,preflight.error);

// Simulate a write by another process between statSync and readFileSync:
// old code trusts the small pre-read stat and returns a 64MB+ IPC payload.
// New code checks the opened fd and never returns it, even if stat lies.
const fs=createRequire(import.meta.url)("node:fs") as {statSync:(p:unknown,...args:unknown[])=>unknown};
const prior=fs.statSync;
try {
 fs.statSync=(path:unknown,...args:unknown[])=>{
   const r=(prior as (...xs:unknown[])=>unknown)(path,...args);
   return String(path)===oversized ? Object.assign(Object.create(Object.getPrototypeOf(r)),r,{size:8}) : r;
 };
 syncBuiltinESMExports();
 const raced=readPdfBytes(id);
 check("★★ stale stat after concurrent PDF enlargement cannot bypass 64MB IPC bound",
   !raced.ok && raced.bytes===null,{ok:raced.ok,length:raced.bytes?.length,error:raced.error});
}finally {
 fs.statSync=prior;syncBuiltinESMExports();
}
check("oversized original file is still intact and has original byte size",
 realStat(oversized).size===64*1024*1024+1);
closeDb();
console.log("pdf-read-budget-integrity-smoke:"+(checks-bad)+"/"+checks+" PASS");
if(bad)process.exitCode=1;
