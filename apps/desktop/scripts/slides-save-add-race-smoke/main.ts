import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {VendorSlidesExecutor} from "../../src/main/document/slidesExecutor.js";
let good=0,bad=0;
function ok(s:string,p:boolean,details?:unknown){console.log((p?"PASS ":"FAIL ")+s+" "+JSON.stringify(details));p?good++:bad++;}
function gate(){let unlock!:()=>void;const promise=new Promise<void>(r=>unlock=r);return {promise,unlock};}
const dir=mkdtempSync(join(tmpdir(),"mcode-native-slides-add-save-"));
const file=join(dir,"source.pptx");writeFileSync(file,"original");
const entered=gate(), proceed=gate();
let serializations=0;
let latestTxn: {ops:Array<{op:string;target:{slide:number};to?:number}>}|null=null;
const readNativeTxn=():typeof latestTxn=>latestTxn;
const engine={
async openPptx(){return {deck:{slides:[{id:"original",nodes:[]}],size:{cx:10,cy:10}}};},
async savePptxToFile(opened:unknown,p:string){
 const d=opened as {deck:{slides:{id:string}[]}};
 const captured=d.deck.slides.map(x=>x.id).join(",");
 serializations++;
 if(serializations===1){entered.unlock();await proceed.promise;}
 writeFileSync(p,captured);
},
async createBlankPptx(){return new Uint8Array([1]);},
commitSaved(){}
};
const executor=new VendorSlidesExecutor({
 engine,
 render:{HeuristicMetrics:class{},buildRenderSlide:(slide:unknown)=>slide},
 ops:{runTxn(opened:unknown,req:unknown){
  latestTxn=req as typeof latestTxn;
  (opened as {deck:{slides:{id:string;nodes:unknown[]}[]}}).deck.slides.push({id:"added",nodes:[]});
  return {applied:true};
 }}
} as never);
try{
const opened=await executor.openDeck(101,"actual-doc",file,1200);
ok("vendor original file opens",opened!==null);
const firstSave=executor.saveDeck(101,"actual-doc",file);
await entered.promise;
const appended=await executor.addBlankSlide(101,"actual-doc");
ok("native slide added while vendor serializer awaits",appended!==null,appended);
proceed.unlock();
const oldResult=await firstSave;
ok("in-flight save must not report success after native addSlide",oldResult===null,oldResult);
ok("in-flight stale save must not replace on-disk document",readFileSync(file,"utf8")==="original",readFileSync(file,"utf8"));
const secondSave=await executor.saveDeck(101,"actual-doc",file);
ok("subsequent fresh save succeeds",secondSave!==null,secondSave);
ok("subsequent save contains newly added slide",readFileSync(file,"utf8")==="original,added",readFileSync(file,"utf8"));
ok("wrong document identity cannot insert slide",(await executor.addBlankSlide(101,"another-doc"))===null);
// This L2 adapter has no undo()/redo() API. Its additional shallow
// snapshots are *not* the vendor's undo system and accumulate forever across
// a long editing session. Preserve native operations without fake history.
for(let n=0;n<20;n++)await executor.addBlankSlide(101,"actual-doc");
const live=(executor as unknown as {sessions:Map<number,{undo?:unknown[];redo?:unknown[]}>}).sessions.get(101);
ok("★ native edits do not build unbounded unusable second undo history",
  !live?.undo?.length && !live?.redo?.length,
  {undo:live?.undo?.length,redo:live?.redo?.length});
const originalSelected=await executor.addBlankSlide(101,"actual-doc",0,false);
ok("★ original selected slide 0 inserts AFTER its position, not always append",
  originalSelected?.index===1 && readNativeTxn()?.ops?.[0]?.target.slide===0,
  {originalSelected,latestTxn});
const insertedBefore=await executor.addBlankSlide(101,"actual-doc",0,true);
ok("★ native vendor before=true keeps its original two-operation atomic insert",
  insertedBefore?.index===0 && readNativeTxn()?.ops?.length===2 &&
    readNativeTxn()?.ops[0]?.op==="addBlankSlide" &&
    readNativeTxn()?.ops[1]?.op==="moveSlide" && readNativeTxn()?.ops[1]?.to===1,
  {insertedBefore,latestTxn});
const priorCount=insertedBefore?.slideCount;
const getNativeEpoch=()=>(executor as unknown as {sessions:Map<number,{editEpoch:number}>})
  .sessions.get(101)?.editEpoch;
const epochBeforeInvalid=getNativeEpoch();
const rejected=await executor.addBlankSlide(101,"actual-doc",Number.MAX_SAFE_INTEGER,true);
ok("★ an invalid slide selection does not cancel a valid in-flight save epoch",
  epochBeforeInvalid===getNativeEpoch(),
  {epochBeforeInvalid,epochAfterInvalid:getNativeEpoch()});
ok("★ invalid sourceIndex rejected before mutating the original deck",
  rejected===null && (executor as unknown as {sessions:Map<number,{opened:{deck:{slides:unknown[]}}}>})
    .sessions.get(101)?.opened.deck.slides.length===priorCount,
  {rejected,priorCount});
}finally{executor.release(101);rmSync(dir,{recursive:true,force:true});}
console.log(`slides-save-add-race-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;