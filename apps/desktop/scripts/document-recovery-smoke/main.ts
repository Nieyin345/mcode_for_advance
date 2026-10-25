import { mkdtemp, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";
import { writeDocRecovery, inspectDocRecovery, clearDocRecovery } from "@main/document/documentRecovery.js";

let total=0,fail=0;
function check(name:string,condition:boolean,observed?:unknown):void {
 total++;
 if (condition) console.log("ok   "+name);
 else {fail++;console.log("FAIL "+name+" "+JSON.stringify(observed));}
}
const root=await mkdtemp(join(tmpdir(),"mcode-docs-recovery-"));
const original=join(root,"document.docx");
const dataRoot=join(root,"mcode-data");
const initial=Buffer.from([0x50,0x4b,0x03,0x04,0x10,0x11]);
const modified=Buffer.from([0x50,0x4b,0x03,0x04,0x20,0x22]);
try {
 await writeFile(original,initial);
 const base=(await fileContentVersion(original))!;
 check("normal docx hash initialized",typeof base==="string" && base.length===64);
 check("denies non-ZIP encrypted/invalid recovery bytes",
    !(await writeDocRecovery({filePath:original,bytes:Buffer.from("opaque"),baseRevision:base,dataRoot})).ok);
 check("denies unknown file-version",
    !(await writeDocRecovery({filePath:original,bytes:modified,baseRevision:null,dataRoot})).ok);
 check("denies forged version",
    !(await writeDocRecovery({filePath:original,bytes:modified,baseRevision:"0".repeat(64),dataRoot})).ok);
 check("invalid writes create no cache",await inspectDocRecovery(original,dataRoot,base)===null);
 const stored=await writeDocRecovery({filePath:original,bytes:modified,baseRevision:base,dataRoot});
 check("writes valid bounded DOCX to Mcode recovery cache",stored.ok,stored);
 const candidate=await inspectDocRecovery(original,dataRoot,base);
 check("returns original-version-backed candidate without overwriting DOCX",
    candidate?.bytes.equals(modified)===true && candidate.basedOnCurrent &&
    (await readFile(original)).equals(initial));
 // mutate original without touching the recovery cache: candidate remains
 // available but MUST be identified as based on a different disk version.
 await writeFile(original,Buffer.from([0x50,0x4b,0x03,0x04,0x33]));
 const changed=(await fileContentVersion(original))!;
 const newer=await inspectDocRecovery(original,dataRoot,changed);
 check("externally updated DOCX produces explicit newer-disk warning",
   newer?.basedOnCurrent===false && newer.baseRevision===base && newer.bytes.equals(modified));
 const rejected=await writeDocRecovery({filePath:original,bytes:modified,baseRevision:base,dataRoot});
 check("stale session cannot overwrite recovery cache",rejected.ok===false);
 const after=await inspectDocRecovery(original,dataRoot,changed);
 check("stale recovery write preserved previous uncommitted copy",after?.bytes.equals(modified)===true);
 await clearDocRecovery(original,dataRoot);
 check("successful save/discard clears recovery copy",await inspectDocRecovery(original,dataRoot,changed)===null);
 const good=await writeDocRecovery({filePath:original,bytes:modified,baseRevision:changed,dataRoot});
 check("new disk version can establish own recovery baseline",good.ok,good);
 await clearDocRecovery(original,dataRoot,changed);
 check("cleanup after an older save cannot erase recovery for freshly saved revision",
   (await inspectDocRecovery(original,dataRoot,changed))?.bytes.equals(modified) === true);
 await clearDocRecovery(original,dataRoot,changed);
 check("repeated post-save cleanup must preserve current draft",
   (await inspectDocRecovery(original,dataRoot,changed))?.baseRevision === changed);

 // A confirmation made for the OLD disk revision cannot erase a recovery
 // copy once another writer has published a newer revision.
 let rejectedDiscard = false;
 try { await clearDocRecovery(original,dataRoot,undefined,base); }
 catch { rejectedDiscard = true; }
 check("stale discard confirmation fails closed after external disk edit",rejectedDiscard);
 check("stale discard leaves the candidate recoverable",
   (await inspectDocRecovery(original,dataRoot,changed))?.bytes.equals(modified) === true);

 // Manufacture the exact writer/read race under the ONE existing OS lease.
 // Recovery inspection must wait for the writer, not observe a torn pair of
 // manifest/bytes in the middle of a new snapshot publication.
 let releaseWriter: (() => void) | undefined;
 let writerEntered: (() => void) | undefined;
 const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
 const ready = new Promise<void>(resolve => { writerEntered = resolve; });
 const holdingWriter = withOsFileLease(original, async () => {
   writerEntered?.();
   await writerGate;
 });
 await ready;
 let readerSettled = false;
 const reader = inspectDocRecovery(original,dataRoot,changed)
   .then(value => { readerSettled = true; return value; });
 await new Promise(resolve => setTimeout(resolve,90));
 check("recovery manifest and bytes inspection waits for active writer's OS lease",!readerSettled);
 releaseWriter?.();
 await holdingWriter;
 const inspected = await reader;
 check("read after lease release sees intact recovery contents and revision",
   inspected?.bytes.equals(modified) === true && inspected.baseRevision === changed);
 // Find the name of exactly this test's cache and corrupt its contents;
 // parsing must NEVER treat a broken snapshot as genuine recovery material.
 const dir=join(dataRoot,"docs","recovery");
 const names=await readdir(dir);
 const f=names.find(n=>n.endsWith(".docx"));
 if (!f) throw Error("missing expected recovery file");
 await writeFile(join(dir,f),Buffer.from("corrupt"));
 let corruptRejected=false;
 try { await inspectDocRecovery(original,dataRoot,changed); }
 catch(e){corruptRejected=String(e).includes("校验失败");}
 check("tampered recovery data fails CLOSED rather than opening old DOCX",corruptRejected);
 await clearDocRecovery(original,dataRoot);

 // Crash consistency: a newly fsynced payload MUST NOT corrupt an older
 // committed snapshot when the process dies before manifest publication.
 const oldCopy=Buffer.from([0x50,0x4b,0x03,0x04,0x41,0x42]);
 const newCopy=Buffer.from([0x50,0x4b,0x03,0x04,0x61,0x62]);
 check("v2 first committed snapshot succeeds",
   (await writeDocRecovery({filePath:original,baseRevision:changed,dataRoot,bytes:oldCopy})).ok);
 const crashed=await writeDocRecovery({
   filePath:original,baseRevision:changed,dataRoot,bytes:newCopy,
   beforeManifestCommit:async()=>{throw Error("simulated process death after payload fsync");},
 });
 check("injected crash between payload and manifest is reported",!crashed.ok);
 const survived=await inspectDocRecovery(original,dataRoot,changed);
 check("crash BEFORE manifest rename preserves previous committed DOCX",
   survived?.bytes.equals(oldCopy)===true && survived.baseRevision===changed);
 check("new committed snapshot survives without modifying original",
   (await writeDocRecovery({filePath:original,baseRevision:changed,dataRoot,bytes:newCopy})).ok);
 const newSnapshot=await inspectDocRecovery(original,dataRoot,changed);
 check("manifest switches atomically to validated newer payload",
   newSnapshot?.bytes.equals(newCopy)===true && (await readFile(original)).length===5);
 const entries=await readdir(dir);
 check("old/orphan DOCX snapshots collected after commit",
   entries.filter(n=>n.endsWith(".docx")).length===1,entries);

 // REAL PROCESS KILL (not an orderly teardown): another Node OS process
 // obtains the cross-process file lease, fsyncs a replacement snapshot,
 // pauses immediately BEFORE its commit point, and gets forcibly killed.
 // Old recovery bytes and the original file must survive and the deceased
 // process's .mcode-lock must be safely reclaimed.
 const workerPath=process.env.MCODE_DOC_RECOVERY_CRASH_WORKER;
 if(!workerPath)throw Error("missing isolated crash worker: run through run.sh");
 const child=spawn(process.execPath,[workerPath,original,dataRoot,changed],{
   windowsHide:true,stdio:["ignore","pipe","pipe"],
 });
 let childOutput="";
 let childError="";
 child.stderr?.on("data",(b:Buffer)=>{childError+=String(b);});
 try {
   await new Promise<void>((resolve,reject)=>{
     let settled=false;
     const timeout=setTimeout(()=>{if(!settled){settled=true;reject(Error("child didn't reach crash point "+childOutput+" "+childError));}},15000);
     child.stdout?.on("data",(buf:Buffer)=>{
       childOutput+=String(buf);
       if(!settled && childOutput.includes("READY_TO_KILL")){
         settled=true;clearTimeout(timeout);resolve();
       }
     });
     child.once("error",err=>{if(!settled){settled=true;clearTimeout(timeout);reject(err);}});
     child.once("exit",()=>{if(!settled){settled=true;clearTimeout(timeout);reject(Error("child exited before crash point "+childError));}});
   });
   const killed=child.kill("SIGKILL");
   check("only isolated recovery writer child is forcibly terminated",killed,{pid:child.pid});
   await new Promise<void>((resolve,reject)=>{
     if(child.exitCode!==null || child.signalCode!==null){resolve();return;}
     const timeout=setTimeout(()=>reject(Error("kill did not exit child "+child.pid)),10000);
     child.once("exit",()=>{clearTimeout(timeout);resolve();});
   });
   const postKill=await inspectDocRecovery(original,dataRoot,changed);
   check("real OS crash after new fsync still exposes previous committed draft",
     postKill?.bytes.equals(newCopy)===true && postKill.baseRevision===changed);
   check("real process kill never rewrites original disk document",
     (await readFile(original)).length===5);
 }finally{ if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL"); }

 // Legacy on-disk v1 format remains compatible after upgrade to v2.
 await clearDocRecovery(original,dataRoot);
 const real=await (await import("node:fs/promises")).realpath(original);
 const key=createHash("sha256").update(real).digest("hex");
 await writeFile(join(dir,key+".docx"),oldCopy);
 await writeFile(join(dir,key+".json"),JSON.stringify({
   version:1,baseRevision:changed,snapshotSha256:createHash("sha256").update(oldCopy).digest("hex"),savedAt:123,
 }));
 const oldVersion=await inspectDocRecovery(original,dataRoot,changed);
 check("previous-release v1 recovery manifest is still readable",
   oldVersion?.bytes.equals(oldCopy)===true && oldVersion.savedAt===123);
 await clearDocRecovery(original,dataRoot);
 check("legacy v1 cleanup removes old payload",
   (await readdir(dir)).filter(n=>n.endsWith(".docx")).length===0);

 await writeFile(join(dir,key+".json"),"{not-json");
 let badManifestRejected=false;
 try {await inspectDocRecovery(original,dataRoot,changed);}
 catch(e){badManifestRejected=String(e).includes("恢复清单损坏");}
 check("malformed committed manifest fails CLOSED",badManifestRejected);
 await clearDocRecovery(original,dataRoot);
 check("clear leaves no original DOCX mutation",(await stat(original)).size===5);
} finally {await rm(root,{recursive:true,force:true});}
console.log("document-recovery-smoke: "+(total-fail)+"/"+total+" passed");
if(fail)process.exitCode=1;
