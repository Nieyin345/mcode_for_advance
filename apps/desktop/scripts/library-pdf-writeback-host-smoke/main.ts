/**
 * True production IPC regression. All bytes live in a disposable sql.js
 * dataRoot and synthetic sample-paper.pdf; NEVER touch user library.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, linkSync, truncateSync, statSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { IpcMain } from "electron";
import { initDb, closeDb } from "@main/store/db.js";
import { LibraryRepo } from "@main/store/repositories.js";
import { IPC } from "@contracts/ipc";
import { registerLibraryHandlers } from "@main/ipc/library.js";
import { originalPathFor, highlightsPathFor } from "@main/library/pdfHighlightsStore.js";

let count=0,errors=0;
function check(name:string,yes:boolean,detail?:unknown){
 count++;if(yes)console.log("  ok   "+name);
 else {errors++;console.log("  FAIL "+name+" "+JSON.stringify(detail));}
}
const root=process.env.MCODE_SMOKE_DATA_ROOT;
if(!root)throw Error("NO ISOLATED DATA ROOT");
const pdf=join(root,"library","papers","smoke.pdf");
mkdirSync(dirname(pdf),{recursive:true});
const valid=readFileSync(join(process.cwd(),"scripts","fixtures","sample-paper.pdf"));
writeFileSync(pdf,valid);
const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
const revision=sha(valid);
const handlers=new Map<string,(evt:unknown,raw:unknown)=>unknown>();
const fake={handle:(channel:string,fn:(evt:unknown,raw:unknown)=>unknown)=>{handlers.set(channel,fn)}} as unknown as IpcMain;
registerLibraryHandlers(fake);
await initDb();
const send=async(bytes:Uint8Array,expectedRevision?:string,highlights?:unknown[])=>{
 const fn=handlers.get(IPC.LIBRARY_WRITE_HIGHLIGHTS);
 if(!fn)throw Error("real library.writeHighlights IPC handler missing");
 return await Promise.resolve(fn(null,{
  pdfPath:pdf,bytesBase64:Buffer.from(bytes).toString("base64"),
  ...(expectedRevision!==undefined?{expectedRevision}:{}),
  ...(highlights!==undefined?{highlights}:{}),
 })) as {ok:boolean,error?:string};
};
const bad=await send(Buffer.from("%PDF-"),revision);
check("★★ real IPC cannot replace user document with five-byte pseudo PDF",
 !bad.ok && readFileSync(pdf).equals(valid),{bad,bytes:readFileSync(pdf).length});
check("★★ invalid IPC output does not publish a clean-original backup",
 !existsSync(originalPathFor(pdf)));
const stale=await send(valid,sha(Buffer.from("older-view")));
check("★★ renderer stale expected revision is refused by Host",
 !stale.ok && readFileSync(pdf).equals(valid),stale);
const missing=await send(valid);
check("★★ missing expected revision cannot silently bypass concurrent-edit check",
 !missing.ok && readFileSync(pdf).equals(valid),missing);
const good=await send(valid,revision);
check("normal valid revision permits PDF export",good.ok && readFileSync(pdf).equals(valid),good);
check("first successful export preserved original bytes before replacing",
 existsSync(originalPathFor(pdf)) && readFileSync(originalPathFor(pdf)).equals(valid));

const sidecar=highlightsPathFor(pdf);
// In synthetic dataRoot only: emulate a sidecar that became a directory.
// PDF bytes may already be saved, but success must not claim both parts done.
mkdirSync(sidecar,{recursive:true});
const sideFail=await send(valid,sha(readFileSync(pdf)),[]);
check("★★ failed sidecar persistence cannot reply ok:true as if all saved",
 !sideFail.ok && /索引|部分/.test(sideFail.error??""),sideFail);
check("sidecar error retains existing PDF and unrelated directory",
 readFileSync(pdf).equals(valid) && existsSync(sidecar));

rmSync(sidecar,{recursive:true,force:true});
const sidecarOk=await send(valid,sha(readFileSync(pdf)),[]);
check("normal PDF + sidecar save reports complete success",sidecarOk.ok,sidecarOk);
const sidecarBody=JSON.parse(readFileSync(sidecar,"utf8")) as {version?:number;highlights?:unknown[]};
check("normal sidecar contains canonical versioned highlights",sidecarBody.version===1 && Array.isArray(sidecarBody.highlights) && sidecarBody.highlights.length===0,sidecarBody);
check("normal complete save releases Host file lease",!existsSync(pdf+".mcode-lock"));

// Real OS writer edits after this view loaded; the production IPC may not
// replace the newer on-disk revision even with a valid PDF save result.
const fromOtherWriter=Buffer.concat([valid,Buffer.from("\n% newer external writer bytes\n")]);
writeFileSync(pdf,fromOtherWriter);
const obsoleteWrite=await send(valid,revision,[]);
check("★★ real IPC refuses second editor's stale PDF snapshot after external update",
 !obsoleteWrite.ok && /冲突|版本/.test(obsoleteWrite.error??""),obsoleteWrite);
check("★★ real IPC keeps external writer's bytes and previously saved sidecar",
 readFileSync(pdf).equals(fromOtherWriter)
 && readFileSync(sidecar,"utf8").includes('"version": 1'));
check("★★ rejecting stale editor leaves immutable original snapshot unchanged",
 readFileSync(originalPathFor(pdf)).equals(valid));
check("stale editor refusal does not leak a Host OS file lease",
 !existsSync(pdf+".mcode-lock"));

// ARC-007: A PDF the user explicitly linked from outside their project/root
// must use the same DB-record-backed path permission for read-original as
// read/save highlights. An arbitrary unrelated outside path remains denied.
const readOrigHandler=handlers.get(IPC.LIBRARY_READ_ORIGINAL_PDF);
if (!readOrigHandler) throw Error("production library.readOriginalPdf handler missing");
const readOriginal=async (path:string):Promise<{bytes:Uint8Array|null}> =>
  (await Promise.resolve(readOrigHandler(null,{pdfPath:path}))) as {bytes:Uint8Array|null};
const linked=join(root,"linked-outside-library.pdf");
const unlinked=join(root,"unlinked-private.pdf");
writeFileSync(linked,valid);
writeFileSync(unlinked,Buffer.from("UNRELATED PRIVATE BYTES"));
const linkedItem=LibraryRepo.upsert({title:"Linked external PDF",entryMode:"linked",filePath:linked});
check("linked PDF fixture is an actual DB path reference",
 LibraryRepo.pathRefCounts().has(linked) && LibraryRepo.get(linkedItem.id)?.filePath===linked);
const originalLinked=await readOriginal(linked);
check("★★ legitimate linked external PDF can read its original through production IPC",
 originalLinked.bytes!==null && Buffer.from(originalLinked.bytes).equals(valid),
 {bytesLength:originalLinked.bytes?.byteLength??null,linkedItemId:linkedItem.id});
const deniedExternal=await readOriginal(unlinked);
check("★★ unreferenced external PDF remains unreadable",
 deniedExternal.bytes===null);
const readLibraryOriginal=await readOriginal(pdf);
check("ordinary library PDF original remains readable",
 readLibraryOriginal.bytes!==null && Buffer.from(readLibraryOriginal.bytes).equals(valid));

// The unbounded original-read IPC must not return a 65MiB payload to a renderer.
// Sparse file keeps this regression fast and never touches user documents.
const massive=join(root,"library","papers","65mb-original.pdf");
writeFileSync(massive,"%PDF-1.7\\n");
truncateSync(massive,64*1024*1024+1);
const oversizedRead=await readOriginal(massive);
check("★★ readOriginalPdf refuses a source PDF larger than the shared 64MiB IPC budget",
 oversizedRead.bytes===null,{read:oversizedRead.bytes?.byteLength,fileBytes:statSync(massive).size});

// The PDF is an allowed linked file, but its optional sibling backup can
// be a hardlink pointing to unrelated private bytes outside library roots.
// Permission on the PDF MUST NOT grant access to unrelated backup inodes.
const injectedBackup=originalPathFor(linked);
linkSync(unlinked,injectedBackup);
const backupRead=await readOriginal(linked);
check("★★ readOriginalPdf rejects a hardlinked foreign backup rather than leaking it",
 backupRead.bytes===null,{actual:backupRead.bytes?Buffer.from(backupRead.bytes).toString("utf8"):null});
check("rejected foreign backup preserves the foreign original bytes",
 readFileSync(unlinked).toString("utf8")==="UNRELATED PRIVATE BYTES");
rmSync(injectedBackup,{force:true});

// A user-visible "zero highlights" is not an acceptable interpretation of
// malformed/partially damaged sidecar JSON. The IPC can keep its legacy
// highlights array but MUST disclose the loss to UI/Agent callers.
const readHighlightsHandler=handlers.get(IPC.LIBRARY_READ_HIGHLIGHTS);
if(!readHighlightsHandler)throw Error("real readHighlights IPC handler missing");
const readIndex=async () => await Promise.resolve(readHighlightsHandler(null,{pdfPath:pdf})) as
 {highlights:unknown[];error?:string;omittedCount?:number;revision?:string|null};
writeFileSync(sidecar,JSON.stringify({version:1,highlights:[]}));
const healthyIndex=await readIndex();
check("normal empty versioned sidecar has no false corruption warning",
 healthyIndex.highlights.length===0 && !healthyIndex.error && !healthyIndex.omittedCount,healthyIndex);
const malformedBytes="{ unfinished user's original annotations";
writeFileSync(sidecar,malformedBytes);
const damagedIndex=await readIndex();
check("★★ corrupted JSON sidecar explicitly reports unreadable instead of silent []",
 !!damagedIndex.error && damagedIndex.highlights.length===0,damagedIndex);
check("★★ corrupt index raw bytes remain available for user recovery",
 readFileSync(sidecar,"utf8")===malformedBytes);
check("damaged JSON also returns its exact recoverable byte revision",
 damagedIndex.revision===sha(Buffer.from(malformedBytes)),damagedIndex);
writeFileSync(sidecar,JSON.stringify({version:1,highlights:"unexpected string"}));
const wrongShape=await readIndex();
check("★★ wrong highlights top-level shape is explicitly reported",
 !!wrongShape.error,wrongShape);
const goodRect={x1:0.1,y1:0.1,x2:0.5,y2:0.2,width:0.4,height:0.1,pageNumber:1};
const validRow={
 id:"retained-good",position:{boundingRect:goodRect,rects:[goodRect]},
 text:"readable",comment:"retained",color:"#ffee11",createdAt:1,
};
writeFileSync(sidecar,JSON.stringify({version:1,highlights:[validRow,{id:"damaged-entry"}]}));
const mixedIndex=await readIndex();
check("★★ invalid individual highlight omission is counted for UI/Agent",
 mixedIndex.omittedCount===1 && mixedIndex.highlights.length===1
 && (mixedIndex.highlights[0] as {id?:string}).id==="retained-good",mixedIndex);
rmSync(sidecar,{force:true});
linkSync(unlinked,sidecar);
const foreignIndex=await readIndex();
check("★★ hardlinked foreign annotation sidecar is rejected with diagnostic",
 !!foreignIndex.error && foreignIndex.highlights.length===0,foreignIndex);
check("foreign sidecar target remains untouched",
 readFileSync(unlinked).toString("utf8")==="UNRELATED PRIVATE BYTES");
rmSync(sidecar,{force:true});

// A bad renderer/Agent must never receive saveHighlights ok:true after it
// persists an invalid record that the very next read silently drops.
const saveHandler=handlers.get(IPC.LIBRARY_SAVE_HIGHLIGHTS);
if(!saveHandler)throw Error("real SAVE_HIGHLIGHTS IPC handler missing");
const saveIndex=async (rows:unknown[])=>await Promise.resolve(saveHandler(null,{
 pdfPath:pdf,highlights:rows,expectedRevision:existsSync(sidecar)?sha(readFileSync(sidecar)):null,
})) as {ok:boolean;error?:string;revision?:string};
writeFileSync(sidecar,JSON.stringify({version:1,highlights:[validRow]}));
const safeBefore=readFileSync(sidecar);
const malformedSave=await saveIndex([validRow,{id:"INVALID_ONLY"}]);
check("★★ invalid annotation cannot be persisted with ok:true",
 !malformedSave.ok && /批注|无效|第/.test(malformedSave.error??""),malformedSave);
check("★★ bad save input does not change last good versioned index",
 readFileSync(sidecar).equals(safeBefore));

// The existing sidecar path can itself be a hardlink to another file.
// Backing it up as .corrupt- would duplicate unrelated PRIVATE user bytes.
rmSync(sidecar,{force:true});
linkSync(unlinked,sidecar);
const existingBackups=()=>readdirSync(dirname(sidecar)).filter(name=>name.startsWith(basename(sidecar)+".corrupt-"));
const previousBackups=existingBackups();
const foreignWrite=await saveIndex([validRow]);
check("★★ existing hardlinked sidecar cannot be overwritten as if ours",
 !foreignWrite.ok && readFileSync(sidecar).toString("utf8")==="UNRELATED PRIVATE BYTES",foreignWrite);
check("★★ foreign sidecar bytes never copied into a .corrupt-backup by save",
 JSON.stringify(existingBackups())===JSON.stringify(previousBackups),existingBackups());
check("foreign file original survived attempted index save",
 readFileSync(unlinked).toString("utf8")==="UNRELATED PRIVATE BYTES");
rmSync(sidecar,{force:true});
const saveGood=await saveIndex([validRow]);
check("normal validated annotation index saves through production IPC",
 saveGood.ok && (await readIndex()).highlights.length===1,saveGood);

// Two windows loaded the identical index revision. A and B each change
// different annotations; without CAS the later B overwrites A without notice.
const versionA=await readIndex();
const diskSha=sha(readFileSync(sidecar));
check("★★ read IPC returns the exact loaded index SHA-256 for CAS",
 versionA.revision===diskSha,{revision:versionA.revision,diskSha});
const writer1={...validRow,id:"window-one",comment:"saved from first window"};
const writer2={...validRow,id:"window-two",comment:"stale second window"};
const sendVersioned=async(rows:unknown[],expectedRevision:string|null|undefined)=>await Promise.resolve(
 saveHandler(null,{
   pdfPath:pdf,highlights:rows,
   ...(expectedRevision===undefined?{}:{expectedRevision}),
 })
) as {ok:boolean;error?:string;revision?:string};
const firstCommitted=await sendVersioned([writer1],diskSha);
check("first window may save against the exact loaded index SHA",firstCommitted.ok,firstCommitted);
const firstBytes=readFileSync(sidecar);
const secondCommitted=await sendVersioned([writer2],diskSha);
check("★★ second window stale revision is rejected instead of overwriting first",
 !secondCommitted.ok && /冲突|版本|重新/.test(secondCommitted.error??""),secondCommitted);
check("★★ stale second window cannot lose first editor's annotation bytes",
 readFileSync(sidecar).equals(firstBytes));
const withoutVersion=await sendVersioned([writer2],undefined);
check("★★ legacy missing index revision fails closed rather than last-writer-wins",
 !withoutVersion.ok && readFileSync(sidecar).equals(firstBytes),withoutVersion);
const withCurrent=await sendVersioned([writer2],sha(firstBytes));
check("second window can save after explicitly re-reading new revision",withCurrent.ok,withCurrent);
const newRead=await readIndex();
check("★★ successful write returns the same new SHA seen by fresh readers",
 withCurrent.revision===sha(readFileSync(sidecar)) &&
 newRead.revision===withCurrent.revision,{save:withCurrent,read:newRead});

rmSync(sidecar,{force:true});
const absent=await readIndex();
check("★★ missing index explicitly returns revision:null (first-write identity)",
 absent.revision===null,absent);
const create=await sendVersioned([writer1],null);
check("first index creation succeeds only with explicit null revision",create.ok,create);
const nullStale=await sendVersioned([writer2],null);
check("★★ second index creation cannot overwrite after another writer won",
 !nullStale.ok && readFileSync(sidecar).includes(Buffer.from("window-one")),nullStale);

// Same revision, concurrently issued through the SAME production IPC:
 // OS lease must make precisely one successful winner, not both.
const concurrentRevision=(await readIndex()).revision;
if(typeof concurrentRevision!=="string")throw Error("index revision absent for race test");
const raceFirst={...validRow,id:"race-A",comment:"first race edit"};
const raceSecond={...validRow,id:"race-B",comment:"second race edit"};
const [racedA,racedB]=await Promise.all([
 sendVersioned([raceFirst],concurrentRevision),
 sendVersioned([raceSecond],concurrentRevision),
]);
check("★★ racing same-version writes accept exactly one committed editor",
 Number(racedA.ok)+Number(racedB.ok)===1,{racedA,racedB});
const finalData=readFileSync(sidecar,"utf8");
check("winner's index persists and rejected editor cannot overwrite",
 finalData.includes(racedA.ok?"race-A":"race-B"),
 {racedA,racedB,finalData});
check("racing writers always release the Host OS lease",
 !existsSync(pdf+".mcode-lock"));

closeDb();
console.log("library-pdf-writeback-host-smoke:"+(count-errors)+"/"+count+" PASS");
if(errors)process.exitCode=1;
