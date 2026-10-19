import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {VendorSlidesExecutor} from "../../src/main/document/slidesExecutor.js";
let passed=0,failed=0;
function check(name:string,ok:boolean,details:unknown){console.log((ok?"PASS ":"FAIL ")+name+" "+JSON.stringify(details)); ok?passed++:failed++;}
const root=mkdtempSync(join(tmpdir(),"mcode-slides-epoch-"));
function deferred<T>(){let resolve!:(arg:T)=>void; const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const waiting=new Map<string,ReturnType<typeof deferred<unknown>>>();
const makeDeck=(name:string)=>({deck:{slides:[{id:name}],size:{cx:1,cy:1}}});
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
}finally{rmSync(root,{recursive:true,force:true});}
console.log(`slides-executor-session-epoch-smoke: ${passed}/${passed+failed}`);
if(failed)process.exitCode=1;
