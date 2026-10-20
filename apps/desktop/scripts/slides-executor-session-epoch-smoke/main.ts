import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {VendorSlidesExecutor} from "../../src/main/document/slidesExecutor.js";
let passed=0,failed=0;
function check(name:string,ok:boolean,details:unknown){console.log((ok?"PASS ":"FAIL ")+name+" "+JSON.stringify(details)); ok?passed++:failed++;}
const root=mkdtempSync(join(tmpdir(),"mcode-slides-epoch-"));
function requireNoStages(dir:string):boolean{return readdirSync(dir).every(name=>!name.startsWith(".mcode-slides-stage-"));}
function deferred<T>(){let resolve!:(arg:T)=>void; const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const waiting=new Map<string,ReturnType<typeof deferred<unknown>>>();
const makeDeck=(name:string)=>({deck:{slides:[{id:name,nodes:[]}],size:{cx:1,cy:1}}});
const vendor={
engine:{
 openPptx(bytes:Uint8Array){const name=new TextDecoder().decode(bytes);const d=deferred<unknown>();waiting.set(name,d);return d.promise;},
 async savePptxToFile(opened:unknown,path:string){writeFileSync(path,(opened as {deck:{slides:{id:string}[]}}).deck.slides[0]!.id);},
 async createBlankPptx(){return new Uint8Array([66]);},
 commitSaved(){},
},
render:{HeuristicMetrics:class{},buildRenderSlide(slide:unknown){return slide;}},
ops:{runTxn(){return {applied:false};}}
};
try{
const pathA=join(root,"A.pptx"),pathB=join(root,"B.pptx"),pathC=join(root,"C.pptx"),pathBroken=join(root,"BROKEN.pptx");
writeFileSync(pathA,"A");writeFileSync(pathB,"B");writeFileSync(pathC,"C");writeFileSync(pathBroken,"BROKEN");
const executor=new VendorSlidesExecutor(vendor as never);
const oldOpen=executor.openDeck(77,"doc-A",pathA,1200);
const newOpen=executor.openDeck(77,"doc-B",pathB,1200);
for(let i=0;i<50&&(!waiting.has("A")||!waiting.has("B"));i++)await new Promise(r=>setTimeout(r,2));
check("both independent vendor parsers entered",waiting.has("A")&&waiting.has("B"),[...waiting.keys()]);
waiting.get("B")!.resolve(makeDeck("B"));
const newer=await newOpen;
check("new selected deck opened",newer!==null,newer);
waiting.get("A")!.resolve(makeDeck("A"));
const older=await oldOpen;
check("stale slow A parse is refused",older===null,older);
const save=await executor.saveDeck(77,"doc-B",pathB);
check("later save still belongs to B not A",save!==null&&readFileSync(pathB,"utf8")==="B",save);
check("abandoned slow open did not change session count",executor.sessionCount===1,executor.sessionCount);
executor.release(77);
check("close releases deck session",executor.sessionCount===0,executor.sessionCount);
const reopened=executor.openDeck(77,"doc-C",pathC,1280);
for(let i=0;i<50&&!waiting.has("C");i++)await new Promise(r=>setTimeout(r,2));
check("in-flight C parse started",waiting.has("C"),[...waiting.keys()]);
executor.release(77);
waiting.get("C")!.resolve(makeDeck("C"));
const closedResult=await reopened;
check("view closed before parse completion must not resurrect a session",closedResult===null&&executor.sessionCount===0,{closedResult,count:executor.sessionCount});
check("closed view cannot save without session",(await executor.saveDeck(77,"doc-C",pathC))===null,null);
const broken=executor.openDeck(88,"doc-BROKEN",pathBroken,1200);
for(let i=0;i<50&&!waiting.has("BROKEN");i++)await new Promise(r=>setTimeout(r,2));
(vendor.render as {buildRenderSlide: (s:unknown)=>unknown}).buildRenderSlide=(slide)=>{
 if((slide as {id:string}).id==="BROKEN")throw Error("malformed vendor render tree");
 return slide;
};
waiting.get("BROKEN")!.resolve(makeDeck("BROKEN"));
let caught=false;
try{await broken;}catch{caught=true;}
check("malformed renderer error is visibly reported",caught,null);
check("failed render must not publish a saveable opened session",executor.sessionCount===0,executor.sessionCount);
check("failed render cannot save broken deck",(await executor.saveDeck(88,"doc-BROKEN",pathBroken))===null,null);
// The native vendor may return an object but no RenderSlide.nodes. The
// outer SlidesBridge already rejects the malformed OpenResult; the executor
// must not retain that failed open as a saveable session.
const badShape=join(root,"BAD-SHAPE.pptx");
writeFileSync(badShape,"BAD-SHAPE");
const shapeOpen=executor.openDeck(89,"bad-shape",badShape,1200);
for(let i=0;i<50&&!waiting.has("BAD-SHAPE");i++)await new Promise(r=>setTimeout(r,2));
(vendor.render as {buildRenderSlide:(s:unknown)=>unknown}).buildRenderSlide=()=>({widthPx:1280});
waiting.get("BAD-SHAPE")!.resolve(makeDeck("BAD-SHAPE"));
const badShapeResult=await shapeOpen;
check("★ native slides malformed renderer result is not published as successful open",
  badShapeResult===null,badShapeResult);
check("★ no saveable native session survives malformed renderer tree",
  executor.sessionCount===0,executor.sessionCount);
check("★ malformed-render deck cannot overwrite original file",
  (await executor.saveDeck(89,"bad-shape",badShape))===null,readFileSync(badShape,"utf8"));
/* FULL-1 Slides native vendor save, Host revision, no silent overwrite:
   real mkdtemp files + actual bundled VendorSlidesExecutor with fake native vendor ports. */
const base=join(root,"real-vendor.pptx"), failTarget=join(root,"bad-vendor.pptx");
writeFileSync(base,"ORIGINAL");
writeFileSync(failTarget,"ORIGINAL");
let savedPaths:string[]=[];
let commits=0;
let saveFault=false;
let enteredSave:()=>void=()=>{};
let unblockSave:()=>void=()=>{};
let saveBarrier=new Promise<void>(r=>{unblockSave=()=>r();});
let entering=new Promise<void>(r=>{enteredSave=()=>r();});
let blocked=false;
const safeVendor={
  engine:{
    async openPptx(bytes:Uint8Array){
      return makeDeck(new TextDecoder().decode(bytes));
    },
    async savePptxToFile(_opened:unknown,path:string){
      savedPaths.push(path);
      writeFileSync(path,"NEW-CONTENT");
      if(saveFault)throw new Error("SYNTHETIC_VENDER_MID_SAVE");
      if(blocked){enteredSave?.();await saveBarrier;}
    },
    async createBlankPptx(){return new Uint8Array([66]);},
    commitSaved(){commits++;}
  },
  render:{HeuristicMetrics:class{},buildRenderSlide(slide:unknown){return slide;}},
  ops:{runTxn(){return {applied:false};}}
};
const saver=new VendorSlidesExecutor(safeVendor as never);
check("★ vendor fake open original document",(await saver.openDeck(121,"owner",base,1200))!==null,null);
writeFileSync(base,"EXTERNAL_NEWER");
const conflict=await saver.saveDeck(121,"owner",base);
check("★ external edit after Slides open must reject stale vendor write",
  conflict!==null&&"reason" in conflict&&conflict.reason.includes("VERSION_CONFLICT")&&
    readFileSync(base,"utf8")==="EXTERNAL_NEWER",{conflict,actual:readFileSync(base,"utf8")});
check("★ stale save must not advance the vendor commitSaved state",commits===0,{commits});
check("★ old vendor must NOT have written directly to target without CAS",
  savedPaths.length===0,{savedPaths});
saver.release(121);

check("★ vendor fake opens second real file",(await saver.openDeck(122,"owner",failTarget,1200))!==null,null);
saveFault=true;
const failedVendor=await saver.saveDeck(122,"owner",failTarget);
check("★ vendor write fails after staging partial: original PPTX must survive",
  failedVendor===null&&readFileSync(failTarget,"utf8")==="ORIGINAL",
  {failedVendor,actual:readFileSync(failTarget,"utf8")});
check("★ failed write never calls commitSaved",commits===0,{commits});
saveFault=false;
savedPaths=[];
const success=await saver.saveDeck(122,"owner",failTarget);
check("★ valid native vendor save still commits and advances target revision",
  success!==null&&readFileSync(failTarget,"utf8")==="NEW-CONTENT"&&commits===1,
  {success,actual:readFileSync(failTarget,"utf8"),commits});
check("★ vendor writes only to a private staging pathname before atomic publish",
  savedPaths.length===1&&savedPaths[0]!==failTarget,{savedPaths});
saver.release(122);

const closed=join(root,"closed-during-vendor-save.pptx");
writeFileSync(closed,"STILL-ORIGINAL");
blocked=true;
check("★ native session opened for close during write",
  (await saver.openDeck(123,"owner",closed,1200))!==null,null);
const inFlight=saver.saveDeck(123,"owner",closed);
await entering;
saver.release(123);
unblockSave();
const dead=await inFlight;
check("★ vendor save finished after webContents close cannot republish orphan result",
  dead===null&&readFileSync(closed,"utf8")==="STILL-ORIGINAL",
  {dead,bytes:readFileSync(closed,"utf8")});
check("★ close race leaves no saveable vendor session",saver.sessionCount===0,saver.sessionCount);

const concurrent=join(root,"vendor-save-late-edit.pptx");
writeFileSync(concurrent,"EXTERNAL-BASE");
saveBarrier=new Promise<void>(r=>{unblockSave=()=>r();});
entering=new Promise<void>(r=>{enteredSave=()=>r();});
blocked=true;
check("★ vendor opens target for external modification during async serialization",
  (await saver.openDeck(124,"owner",concurrent,1200))!==null,null);
const externalSaving=saver.saveDeck(124,"owner",concurrent);
await entering;
writeFileSync(concurrent,"EXTERNAL-NEWER-VERSION");
unblockSave();
const externalRaced=await externalSaving;
check("★ late external bytes during native PPTX serialization reject stale save explicitly",
  externalRaced!==null&&"reason" in externalRaced&&
  externalRaced.reason.includes("VERSION_CONFLICT")&&
  readFileSync(concurrent,"utf8")==="EXTERNAL-NEWER-VERSION",
  {externalRaced,bytes:readFileSync(concurrent,"utf8")});
check("★ failed late save cleaned up private staging directories",
  requireNoStages(root),null);
saver.release(124);

const editedWhileSaving=join(root,"vendor-save-internal-edit.pptx");
writeFileSync(editedWhileSaving,"EDIT-SOURCE");
saveBarrier=new Promise<void>(r=>{unblockSave=()=>r();});
entering=new Promise<void>(r=>{enteredSave=()=>r();});
blocked=true;
check("★ vendor opens for model edit during in-flight serializer",
  (await saver.openDeck(125,"owner",editedWhileSaving,1200))!==null,null);
const modelSaving=saver.saveDeck(125,"owner",editedWhileSaving);
await entering;
(safeVendor.ops as {runTxn:(opened:unknown,request:unknown)=>unknown}).runTxn=(opened,request)=>{
  (opened as {deck:{slides:Array<{id:string}>}}).deck.slides[0]!.id="LATER-UI-EDIT";
  void request;
  return {applied:true};
};
const changed=await saver.editText(125,"owner",0,"fake-node","LATER-UI-EDIT");
check("★ second UI edit was actually accepted before old serializer completed",
  changed!==null,changed);
unblockSave();
const obsolete=await modelSaving;
check("★ older serializing deck cannot overwrite a newer UI model edit",
  obsolete===null&&readFileSync(editedWhileSaving,"utf8")==="EDIT-SOURCE",
  {obsolete,bytes:readFileSync(editedWhileSaving,"utf8")});
check("★ model edit race leaves no staged filesystem residue",requireNoStages(root),null);
saver.release(125);

const otherDoc=join(root,"different-doc-owner.pptx");
writeFileSync(otherDoc,"SAFE-OWNER");
blocked=false;
check("★ native vendor opens dedicated docId", (await saver.openDeck(126,"authorized",otherDoc,1200))!==null,null);
const wrongSave=await saver.saveDeck(126,"imposter",otherDoc);
check("★ same webContents stale/incorrect docId cannot save other document",
  wrongSave===null&&readFileSync(otherDoc,"utf8")==="SAFE-OWNER",wrongSave);
check("★ same webContents stale/incorrect docId cannot mutate other document",
  (await saver.addBlankSlide(126,"imposter"))===null&&
  (await saver.editText(126,"imposter",0,"x","BAD"))===null,null);
saver.release(126);

/* Native vendor may mutate its in-memory deck and THEN throw, or return a
   partial failure / an unrenderable updated slide. None of those is a
   safely committed UI edit. Do not later save a deck the user never saw. */
for(const kind of ["throw-add","throw-edit","render-add","render-edit","partial-add"] as const){
 const target=join(root,`unsafe-native-${kind}.pptx`);
 writeFileSync(target,"SAFE_ORIGINAL");
 let nativeSaves=0;
 let nativeCommits=0;
 const vendorMutation={
   engine:{
     async openPptx(){return {deck:{slides:[{id:"SAFE_ORIGINAL",nodes:[]}],size:{cx:10,cy:10}}};},
     async savePptxToFile(opened:unknown,dest:string){
       nativeSaves++;
       writeFileSync(dest,(opened as {deck:{slides:Array<{id:string}>}}).deck.slides.map(s=>s.id).join("|"));
     },
     async createBlankPptx(){return new Uint8Array([1]);},
     commitSaved(){nativeCommits++;}
   },
   render:{
     HeuristicMetrics:class{},
     buildRenderSlide(slide:unknown){
       if(kind.startsWith("render") && (slide as {id:string}).id==="CHANGED"){
         throw new Error("SYNTHETIC_VENDOR_RENDER_FAILURE");
       }
       return slide;
     }
   },
   ops:{
     runTxn(opened:unknown){
       const slides=(opened as {deck:{slides:Array<{id:string,nodes:unknown[]}>}}).deck.slides;
       if(kind.endsWith("add"))slides.push({id:"CHANGED",nodes:[]});
       else slides[0]!.id="CHANGED";
       if(kind.startsWith("throw"))throw new Error("SYNTHETIC_PARTIAL_VENDOR_MUTATION");
       if(kind==="partial-add")return {applied:true,failures:[{index:0,error:"partial failure"}]};
       return {applied:true};
     }
   }
 };
 const unsafe=new VendorSlidesExecutor(vendorMutation as never);
 const wc=300+["throw-add","throw-edit","render-add","render-edit","partial-add"].indexOf(kind);
 check(`★ ${kind}: fixture native PPTX opened`,(await unsafe.openDeck(wc,kind,target,1280))!==null,null);
 let result:unknown,threw=false;
 try{result=kind.endsWith("add")?await unsafe.addBlankSlide(wc,kind):await unsafe.editText(wc,kind,0,"element","CHANGED");}
 catch{threw=true;}
 check(`★ ${kind}: failed/partial native mutation must not be reported as successful`,
   threw||result===null,{result,threw});
 const uncertain=await unsafe.saveDeck(wc,kind,target);
 check(`★ ${kind}: poisoned native session may not save modified model after failed UI edit`,
   uncertain!==null && "reason" in uncertain && uncertain.reason.includes("SESSION_UNCERTAIN") &&
   readFileSync(target,"utf8")==="SAFE_ORIGINAL" && nativeSaves===0 && nativeCommits===0,
   {uncertain,bytes:readFileSync(target,"utf8"),nativeSaves,nativeCommits});
 unsafe.release(wc);
}

/* Native commitSaved runs AFTER atomic disk rename. If it throws, bytes
   are already visible; reporting plain null gives a false "not saved"
   message, and reusing the uncommitted vendor model can corrupt follow-ups. */
{
 const published=join(root,"post-commit-original.pptx");
 writeFileSync(published,"POST_COMMIT_OLD");
 let shouldThrow=true;
 let saveCount=0;
 const vendorCommit={
   engine:{
     async openPptx(){return {deck:{slides:[{id:"POST_COMMIT_MODEL",nodes:[]}],size:{cx:4,cy:4}}};},
     async savePptxToFile(_model:unknown,to:string){saveCount++;writeFileSync(to,"POST_COMMIT_NEW");},
     async createBlankPptx(){return new Uint8Array([1]);},
     commitSaved(){if(shouldThrow)throw Error("SYNTHETIC_COMMIT_FAILED");},
   },
   render:{HeuristicMetrics:class{},buildRenderSlide(slide:unknown){return slide;}},
   ops:{runTxn(){return {applied:false};}}
 };
 const host=new VendorSlidesExecutor(vendorCommit as never);
 check("★ post-commit probe opens existing native file",(await host.openDeck(390,"doc",published,1200))!==null,null);
 const first=await host.saveDeck(390,"doc",published);
 check("★ failed commitSaved reports uncertain disk commit, not plain unsaved",
   first!==null&&"reason" in first&&first.reason.includes("POST_COMMIT_UNCERTAIN"),
   {first,bytes:readFileSync(published,"utf8")});
 check("★ native serializer already published intact new bytes",
   readFileSync(published,"utf8")==="POST_COMMIT_NEW",readFileSync(published,"utf8"));
 shouldThrow=false;
 const retry=await host.saveDeck(390,"doc",published);
 check("★ uncertain vendor state cannot save again until reopen",
   retry!==null&&"reason" in retry&&retry.reason.includes("SESSION_UNCERTAIN")&&saveCount===1,
   {retry,saveCount});
 host.release(390);
 check("★ reopening authoritative disk file clears taint",
   (await host.openDeck(391,"new-doc",published,1200))!==null,null);
 const healthy=await host.saveDeck(391,"new-doc",published);
 check("★ reopened fresh vendor session can save again",
   healthy!==null&&"bytes" in healthy&&healthy.bytes===Buffer.byteLength("POST_COMMIT_NEW"),
   healthy);
 host.release(391);
}

}finally{rmSync(root,{recursive:true,force:true});}
console.log(`slides-executor-session-epoch-smoke: ${passed}/${passed+failed}`);
if(failed)process.exitCode=1;
