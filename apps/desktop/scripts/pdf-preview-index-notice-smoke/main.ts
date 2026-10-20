/**
 * Render the actual PdfPreviewImpl React function with deterministic hook
 * state and fake vendor UI. E1 for user-visible annotation-index diagnostics;
 * this intentionally does not claim real Electron GUI U1.
 */
import { createHash } from "node:crypto";
import { PdfPreview } from "@renderer/components/library/PdfPreviewImpl.js";
import { __mount,__render,__flush,__text,__nodes } from "../preview-panel-smoke/fakeReact.js";
import { responses,calls,writes,getSaveHandler,setWriteResponse,PDFViewer,useFileViewStore } from "./deps.js";

type Reply={highlights:unknown[];error?:string;omittedCount?:number;revision?:string|null};
let assertions=0,failures=0;
function check(label:string,yes:boolean,detail?:unknown){
 assertions++;if(yes)console.log("  ok   "+label);
 else{failures++;console.log("  FAIL "+label+" "+JSON.stringify(detail));}
}
(globalThis as unknown as {window:{location:{href:string}}}).window={location:{href:"http://127.0.0.1/"}};
const bytes=new Uint8Array([37,80,68,70,45,49,46,55,10,37,37,69,79,70,10]);
let path="C:/fake-libraries/damaged.pdf";
const show=(p:string,respond:()=>Promise<Reply>)=>{
 path=p;responses.set(p,respond);
};
const render=()=>PdfPreview({item:{id:"paper-1"},filePath:path,bytes});
show(path,async()=>({highlights:[],error:"批注索引 JSON 损坏，已保留原文件"}));
__mount(render);
await __flush();
check("★★ production PDF preview warns about a damaged annotation index",
 __text().includes("批注索引 JSON 损坏"),__text());
check("corrupt index is presented as an accessible warning",
 __nodes().some(n=>n.props.role==="alert"),__nodes().filter(n=>n.props.role==="alert").length);

// Normal missing index is NOT an error and must not hide the viewer.
show("C:/fake-libraries/fresh.pdf",async()=>({highlights:[],revision:null}));
__render();
await __flush();
check("empty new PDF index does not create a false corruption banner",
 !__text().includes("损坏")&&!__nodes().some(n=>n.props.role==="alert"),__text());

// Existing sidecar with only a subset of valid records is visibly partial.
show("C:/fake-libraries/partly-corrupt.pdf",async()=>({highlights:[],omittedCount:2,revision:"f".repeat(64)}));
__render();
await __flush();
check("★★ partial invalid annotations show exact omitted count to user",
 __text().includes("2")&&__text().includes("跳过"),__text());

// Real IPC rejection must not be swallowed as a blank annotation list.
show("C:/fake-libraries/denied.pdf",async()=>{throw new Error("这个位置不允许读取高亮")});
__render();
await __flush();
check("★★ index IPC read failure is visibly explained",
 __text().includes("这个位置不允许读取高亮"),__text());

// Retry should query ONLY the index, without resetting the PDF or losing
// unsaved PDFium in-memory changes via the document load nonce.
show("C:/fake-libraries/retry.pdf",async()=>({highlights:[],error:"批注索引损坏"}));
__render();
await __flush();
responses.set(path,async()=>({highlights:[],revision:"a".repeat(64)}));
const refresh=__nodes().find(n=>n.type==="button" && n.props["data-index-retry"]===true);
check("damaged index provides a separate retry control",typeof refresh?.props.onClick==="function");
const beforeCalls=calls.filter(x=>x===path).length;
if(typeof refresh?.props.onClick==="function"){
 (refresh.props.onClick as ()=>void)();
 await __flush();
}
check("refresh rereads the sidecar and clears the warning without PDF reload",
 calls.filter(x=>x===path).length===beforeCalls+1 && !__text().includes("批注索引损坏"),__text());

// A stale slow response for A may not overwrite B's clean UI after switch.
let resolveOld!:(r:Reply)=>void;
show("C:/fake-libraries/slow-old.pdf",()=>new Promise(resolve=>{resolveOld=resolve}));
__render();
await __flush();
show("C:/fake-libraries/current.pdf",async()=>({highlights:[],revision:null}));
__render();
await __flush();
if(resolveOld)resolveOld({highlights:[],error:"OUTDATED_DOCUMENT_WARNING"});
await __flush();
check("★★ late warning from previous file cannot paint current document",
 !__text().includes("OUTDATED_DOCUMENT_WARNING"),__text());
check("UI never tried to read the real user's PDF file",calls.length>=6,calls);

// UI-012: An outstanding export/save promise for file A is still alive when
// the same preview component is reused for B. The late A promise must never
// write an old snapshot after switch, or mark B clean/saved.
function attachExport(
 saveResult:()=>Promise<ArrayBuffer>,
 onAnnotationListener?:(cb:(evt:{type:string})=>void)=>void,
 onUnsubscribe?:()=>void,
):void {
 const el=__nodes().find(n=>n.type===PDFViewer);
 if(!el)throw Error("EmbedPDF viewer node missing: no save test");
 const ref=el.props.ref as {current:unknown};
 const registry={
   getPlugin:(name:string)=>name==="export"
     ? {provides:()=>({saveAsCopy:()=>({toPromise:saveResult})})}
     : name==="annotation"
       ? {provides:()=>({onAnnotationEvent:(cb:(evt:{type:string})=>void)=>{
           onAnnotationListener?.(cb);return ()=>{onUnsubscribe?.()};
         }})}
       : undefined,
 };
 ref.current={registry:Promise.resolve(registry)};
 const ready=el.props.onReady as ((arg:unknown)=>void)|undefined;
 ready?.(registry);
}
show("C:/fake-libraries/export-pending-A.pdf",async()=>({highlights:[],revision:null}));
__mount(render);
await __flush();
let finishExport!:(buffer:ArrayBuffer)=>void;
attachExport(()=>new Promise(resolve=>{finishExport=resolve}));
const exportSave=getSaveHandler();
if(!exportSave)throw Error("production save handler was not registered");
const exportPending=exportSave();
await Promise.resolve();
await Promise.resolve();
show("C:/fake-libraries/export-pending-B.pdf",async()=>({highlights:[],revision:null}));
__render();
await __flush();
const beforeExportWrites=writes.length;
useFileViewStore.getState().setDirty(true);
if(finishExport)finishExport(new Uint8Array([37,80,68,70,45,49,10]).buffer);
const oldExportOk=await exportPending;
await __flush();
check("★★ late export from previous PDF cannot start a Host IPC write",
 writes.length===beforeExportWrites && oldExportOk===false,{beforeExportWrites,writes,oldExportOk});
check("★★ late export from previous PDF cannot clear new PDF dirty state",
 useFileViewStore.getState().dirty===true,useFileViewStore.getState().dirty);

// Even when file A's IPC was already sent, A's late success must never stamp
// file B as saved, update B's CAS revision, or clear B's dirty indication.
show("C:/fake-libraries/ipc-pending-A.pdf",async()=>({highlights:[],revision:null}));
__mount(render);
await __flush();
attachExport(async()=>new Uint8Array([37,80,68,70,45,49,10]).buffer);
let finishIpc!:(result:{ok:boolean})=>void;
setWriteResponse(()=>new Promise(resolve=>{finishIpc=resolve}));
const ipcSave=getSaveHandler();
if(!ipcSave)throw Error("second save handler missing");
const ipcPending=ipcSave();
for(let n=0;n<12 && !finishIpc;n++)await new Promise(r=>setTimeout(r,0));
check("old PDF had actually dispatched the pending IPC before navigation",
 !!finishIpc && writes.at(-1)?.pdfPath==="C:/fake-libraries/ipc-pending-A.pdf",writes.at(-1));
show("C:/fake-libraries/ipc-pending-B.pdf",async()=>({highlights:[],revision:null}));
__render();
await __flush();
useFileViewStore.getState().setDirty(true);
if(finishIpc)finishIpc({ok:true});
await ipcPending;
await __flush();
check("★★ stale Host success must not mark the new document saved",
 !__text().includes("library.pdfViewer.savedToast"),__text());
check("★★ stale Host success must not clear the new document dirty status",
 useFileViewStore.getState().dirty===true,useFileViewStore.getState().dirty);
setWriteResponse(async()=>({ok:true}));

// Normal user action must still save and advance exactly the revision the
// vendor exported, otherwise the next manual save would fail the Host CAS.
show("C:/fake-libraries/normal-save.pdf",async()=>({highlights:[],revision:null}));
__mount(render);
await __flush();
const exported=new Uint8Array([37,80,68,70,45,49,46,55,10,37,37,69,79,70,10,37]);
attachExport(async()=>exported.buffer.slice(0));
const normalSave=getSaveHandler();
if(!normalSave)throw Error("normal save handler missing");
const beforeNormal=writes.length;
const normalOk=await normalSave();
await __flush();
check("normal EmbedPDF export invokes Host once and reports saved",
 normalOk===true && writes.length===beforeNormal+1 &&
 __text().includes("library.pdfViewer.savedToast"),{normalOk,text:__text(),writes});
const exportedHash=createHash("sha256").update(exported).digest("hex");
const savedHandler=getSaveHandler();
if(!savedHandler)throw Error("post-save handler missing");
const secondOk=await savedHandler();
await __flush();
check("success advances the saved PDF CAS revision for the next edit",
 secondOk && writes.at(-1)?.expectedRevision===exportedHash,
 {secondOk,last:writes.at(-1),exportedHash});

// User modifies PDFium annotations while an older snapshot is still being
// exported. Host may commit that snapshot, but new edits remain unsaved and
// any navigation guard must receive false instead of a misleading success.
show("C:/fake-libraries/edits-during-save.pdf",async()=>({highlights:[],revision:null}));
__mount(render);
await __flush();
let annotationEvent!:(event:{type:string})=>void;
let finishEditedExport!:(data:ArrayBuffer)=>void;
attachExport(
 ()=>new Promise(resolve=>{finishEditedExport=resolve}),
 cb=>{annotationEvent=cb},
);
const saveWithEdit=getSaveHandler();
if(!saveWithEdit)throw Error("mid-save edit handler missing");
const pendingEdited=saveWithEdit();
await Promise.resolve();
await Promise.resolve();
if(annotationEvent)annotationEvent({type:"create"});
check("a new annotation event makes the live viewer dirty",useFileViewStore.getState().dirty===true);
if(finishEditedExport)finishEditedExport(exported.buffer.slice(0));
const midSaveResult=await pendingEdited;
await __flush();
check("★★ saving an older snapshot cannot clear edits added during the save",
 useFileViewStore.getState().dirty===true,useFileViewStore.getState().dirty);
check("★★ a partial snapshot save must not report success to navigation guard",
 midSaveResult===false&&!__text().includes("library.pdfViewer.savedToast"),
 {midSaveResult,text:__text()});
check("UI explicitly asks user to save newer annotation edits again",
 __text().includes("新批注")||__text().includes("再次保存"),__text());
attachExport(async()=>exported.buffer.slice(0));
const resave=getSaveHandler();
if(!resave)throw Error("retry save handler missing");
const retryOK=await resave();
await __flush();
check("retry without newer changes finally marks annotation state clean",
 retryOK===true && useFileViewStore.getState().dirty===false
 && __text().includes("library.pdfViewer.savedToast"),
 {retryOK,dirty:useFileViewStore.getState().dirty,text:__text()});

// Save can be entered from the PDF button AND the file-view navigation guard,
// so disabling one button does not prevent concurrent exports. Both callers
// must join ONE active snapshot/Host write rather than race the same CAS.
show("C:/fake-libraries/two-save-callers.pdf",async()=>({highlights:[],revision:null}));
__mount(render);
await __flush();
const pendingExports:Array<(data:ArrayBuffer)=>void>=[];
let exportCount=0;
attachExport(()=>{exportCount++;return new Promise(resolve=>pendingExports.push(resolve));});
const sharedSave=getSaveHandler();
if(!sharedSave)throw Error("two-caller save handler missing");
const beforeCoalescedWrites=writes.length;
const firstRequest=sharedSave();
const secondRequest=sharedSave();
await Promise.resolve();
await Promise.resolve();
check("★★ two save callers use just one live PDFium export",
 exportCount===1,{exportCount});
for(const finish of pendingExports)finish(exported.buffer.slice(0));
const [firstResult,secondResult]=await Promise.all([firstRequest,secondRequest]);
await __flush();
check("★★ two save callers issue exactly one Host CAS write",
 writes.length===beforeCoalescedWrites+1,
 {writesAfter:writes.length,writesBefore:beforeCoalescedWrites,exportCount});
check("both callers receive the same committed save result",
 firstResult===true && secondResult===true,{firstResult,secondResult});

// A's save is pending and B is selected. B must have a new single-flight
// slot; completion of A cannot release or cancel B's in-flight slot.
show("C:/fake-libraries/epoch-A.pdf",async()=>({highlights:[],revision:null}));
__mount(render);
await __flush();
let finishSaveA!:(data:ArrayBuffer)=>void;
attachExport(()=>new Promise(resolve=>{finishSaveA=resolve}));
const saveOld=getSaveHandler();
if(!saveOld)throw Error("old epoch save missing");
const waitingA=saveOld();
await Promise.resolve();await Promise.resolve();
show("C:/fake-libraries/epoch-B.pdf",async()=>({highlights:[],revision:null}));
__render();await __flush();
let finishSaveB!:(data:ArrayBuffer)=>void;
attachExport(()=>new Promise(resolve=>{finishSaveB=resolve}));
const saveNew=getSaveHandler();
if(!saveNew)throw Error("new epoch save missing");
const waitingB=saveNew();
await Promise.resolve();await Promise.resolve();
check("★★ new document can start its own export while A is pending",
 typeof finishSaveB==="function", {a:!!finishSaveA,b:!!finishSaveB});
if(finishSaveA)finishSaveA(exported.buffer.slice(0));
const oldResult=await waitingA;
if(finishSaveB)finishSaveB(exported.buffer.slice(0));
const newResult=await waitingB;
await __flush();
check("stale A returns false while B's independent save commits",
 oldResult===false && newResult===true,
 {oldResult,newResult,final:writes.at(-1)});
check("only the B document is submitted to Host after the switch",
 writes.at(-1)?.pdfPath==="C:/fake-libraries/epoch-B.pdf",writes.at(-1));

// The same PDF preview component is reused across directory children. Vendor
// onReady for A may fire late, and A's old subscription must not leave an
// active callback that falsely marks the new B dirty or steals its listener.
show("C:/fake-libraries/listener-A.pdf",async()=>({highlights:[],revision:null}));
__mount(render);await __flush();
let oldAnnotation!:(evt:{type:string})=>void;
let closedA=0;
const originalReady=__nodes().find(n=>n.type===PDFViewer)?.props.onReady as
 ((registry:unknown)=>void)|undefined;
attachExport(async()=>exported.buffer.slice(0),cb=>{oldAnnotation=cb},()=>{closedA++});
show("C:/fake-libraries/listener-B.pdf",async()=>({highlights:[],revision:null}));
__render();await __flush();
let newAnnotation!:(evt:{type:string})=>void;
let closedB=0;
attachExport(async()=>exported.buffer.slice(0),cb=>{newAnnotation=cb},()=>{closedB++});
check("★★ switching file releases old vendor annotation subscription",
 closedA===1,{closedA,closedB});
useFileViewStore.getState().setDirty(false);
if(oldAnnotation)oldAnnotation({type:"create"});
check("★★ stale vendor annotation event cannot mark new PDF as dirty",
 useFileViewStore.getState().dirty===false,useFileViewStore.getState().dirty);
if(newAnnotation)newAnnotation({type:"create"});
check("current vendor annotation events still mark the right PDF dirty",
 useFileViewStore.getState().dirty===true);
useFileViewStore.getState().setDirty(false);
if(originalReady)originalReady({
 getPlugin:(name:string)=>name==="annotation"
   ? {provides:()=>({onAnnotationEvent:()=>()=>{closedA++}})}
   : undefined,
});
check("★★ late onReady from removed PDF cannot replace current subscription",
 closedB===0,{closedA,closedB});
if(newAnnotation)newAnnotation({type:"update"});
check("late onReady cannot disable newer PDF annotation events",
 useFileViewStore.getState().dirty===true);

// Same ready generation can be delivered twice after vendor internal reset.
// Only the newest listener may remain active, with the old one unsubscribed.
show("C:/fake-libraries/listener-reconnect.pdf",async()=>({highlights:[],revision:null}));
__mount(render);await __flush();
let reconnectClosed=0;
attachExport(async()=>exported.buffer.slice(0),()=>{},()=>{reconnectClosed++});
attachExport(async()=>exported.buffer.slice(0),()=>{},()=>{reconnectClosed++});
check("★★ repeated vendor onReady cleans up the previous subscription",
 reconnectClosed===1,{reconnectClosed});

console.log("pdf-preview-index-notice-smoke:"+(assertions-failures)+"/"+assertions+" PASS");
if(failures)process.exitCode=1;
