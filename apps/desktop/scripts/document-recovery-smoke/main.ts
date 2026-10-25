import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
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
 const { readdir } = await import("node:fs/promises");
 const dir=join(dataRoot,"docs","recovery");
 const f=(await readdir(dir)).find(n=>n.endsWith(".docx"));
 if (!f) throw Error("missing expected recovery file");
 await writeFile(join(dir,f),Buffer.from("corrupt"));
 check("tampered recovery data fails checksum/ZIP and is never restored",
   await inspectDocRecovery(original,dataRoot,changed)===null);
 await clearDocRecovery(original,dataRoot);
 check("clear leaves no original DOCX mutation",(await stat(original)).size===5);
} finally {await rm(root,{recursive:true,force:true});}
console.log("document-recovery-smoke: "+(total-fail)+"/"+total+" passed");
if(fail)process.exitCode=1;
