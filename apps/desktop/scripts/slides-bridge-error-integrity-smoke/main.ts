import {SlidesBridge,SLIDES_BRIDGE_UNAVAILABLE,type SlidesEditExecutor} from "../../src/main/document/slidesBridge.js";
let passes=0, failures=0;
function check(label:string,condition:boolean,detail:unknown){console.log((condition?"PASS ":"FAIL ")+label+" "+JSON.stringify(detail)); condition?passes++:failures++;}
const nasty=Object.create(null);
const bad={
async addBlankSlide(){throw nasty;},
async editText(){throw nasty;},
async openDeck(){throw nasty;},
async saveDeck(){throw nasty;},
} satisfies SlidesEditExecutor;
const bridge=new SlidesBridge(bad);
const cases=[
["slide creation error",()=>bridge.addSlide(42,"view")],
["text edit error",()=>bridge.editText(42,"view",0,"node","hey")],
["vendor PPTX opening error",()=>bridge.openDeck(42,"view","/fixture/a.pptx",1280)],
["vendor PPTX save error",()=>bridge.saveDeck(42,"view","/fixture/a.pptx")]
] as const;
for(const [label,invoke] of cases){
 let reply:unknown=null; let escaped=false;
 try{reply=await invoke();}catch{escaped=true;}
 check(label+" does not throw secondary TypeError",!escaped,{reply,escaped});
 const r=reply as {ok?:boolean;reason?:string}|null;
 check(label+" returns explicit bounded rejection",r?.ok===false&&typeof r?.reason==="string"&&r.reason.includes("未知错误"),reply);
}
const missing=new SlidesBridge(null);
check("no vendor integration fails closed",JSON.stringify(await missing.addSlide(42,"view"))===JSON.stringify({ok:false,reason:SLIDES_BRIDGE_UNAVAILABLE}),await missing.addSlide(42,"view"));
const normal=new SlidesBridge({
async addBlankSlide(){return {slideCount:1,slides:[{id:"one"}],index:0};},
async editText(){return {text:"new",renderedSlide:{nodes:[{id:"part"}]}};},
async openDeck(){return {openResult:{slides:[{id:"one"}]}};},
async saveDeck(){return {bytes:120};}
});
check("vendor healthy add keeps full slides",JSON.stringify(await normal.addSlide(1,"view"))===JSON.stringify({ok:true,slideCount:1,slides:[{id:"one"}],index:0}),await normal.addSlide(1,"view"));
check("vendor healthy save keeps byte count",(await normal.saveDeck(1,"view","/fixture/a.pptx")).ok===true,await normal.saveDeck(1,"view","/fixture/a.pptx"));
check("vendor healthy open keeps result",(await normal.openDeck(1,"view","/fixture/a.pptx",1200)).ok===true,await normal.openDeck(1,"view","/fixture/a.pptx",1200));
const raced=new SlidesBridge({
 async addBlankSlide(){return null;},async editText(){return null;},
 async openDeck(){return null;},
 async saveDeck(){return {reason:"SLIDES_FILE_VERSION_CONFLICT: another editor changed this file"};}
} as SlidesEditExecutor);
const racedResult=await raced.saveDeck(1,"view","/fixture/a.pptx");
check("★ native vendor revision conflicts are propagated as ok:false, not false saves",
  racedResult.ok===false&&racedResult.reason.includes("VERSION_CONFLICT"),racedResult);

console.log(`slides-bridge-error-integrity-smoke: ${passes}/${passes+failures}`);
if(failures)process.exitCode=1;
