import {SlidesBridge,type SlidesEditExecutor} from "../../src/main/document/slidesBridge.js";
let ok=0,bad=0;
function check(name:string,p:boolean,detail:unknown){console.log((p?"PASS ":"FAIL ")+name+" "+JSON.stringify(detail));p?ok++:bad++;}
const make=(part:Partial<SlidesEditExecutor>):SlidesEditExecutor=>({
addBlankSlide:part.addBlankSlide??(async()=>({slideCount:2,slides:[{id:1,nodes:[]},{id:2,nodes:[]}],index:1})),
editText:part.editText??(async()=>({text:"new",renderedSlide:{nodes:[]}})),
openDeck:part.openDeck??(async()=>({openResult:{path:"/a.pptx",slides:[],size:{cx:1,cy:1}}})),
saveDeck:part.saveDeck??(async()=>({bytes:123})),
});
for(const [label,provider] of [
["NaN save byte count",make({saveDeck:async()=>({bytes:NaN})})],
["negative save byte count",make({saveDeck:async()=>({bytes:-1})})],
["zero-byte successful pptx",make({saveDeck:async()=>({bytes:0})})],
] as const){
const r=await new SlidesBridge(provider).saveDeck(1,"doc","/a.pptx");
check(label+" is rejected rather than marked saved",r.ok===false,r);
}
const added=await new SlidesBridge(make({addBlankSlide:async()=>({slideCount:2,slides:[{id:1}],index:5})})).addSlide(1,"doc");
check("inconsistent vendor slideCount/index/slides list isn't reported successful",added.ok===false,added);
const open=await new SlidesBridge(make({openDeck:async()=>({openResult:null})})).openDeck(1,"doc","/a.pptx",1280);
check("vendor null openResult must not mark document opened",open.ok===false,open);
const edit=await new SlidesBridge(make({editText:async()=>({text:"fake",renderedSlide:{}})})).editText(1,"doc",0,"shape","fake");
check("vendor missing canvas nodes must not report edited",edit.ok===false,edit);
// L2 bridge must not forge native canvas success from an incomplete vendor
// render tree; RenderSlide.nodes is required by upstream pptx-render.
const brokenAdded=await new SlidesBridge(make({addBlankSlide:async()=>({
  slideCount:2,slides:[{nodes:[]},{widthPx:1}],index:1
})})).addSlide(1,"doc");
check("★ full slide count without native RenderSlide.nodes must not count as added",
  brokenAdded.ok===false,brokenAdded);
const brokenOpen=await new SlidesBridge(make({openDeck:async()=>({
  openResult:{path:"/a.pptx",slides:[{widthPx:1}],size:{cx:100,cy:100}}
})})).openDeck(1,"doc","/a.pptx",1280);
check("★ vendor open with corrupt slide render nodes must not count as opened",
  brokenOpen.ok===false,brokenOpen);
const wrongOpen=await new SlidesBridge(make({openDeck:async()=>({
  openResult:{path:"/someone-elses-file.pptx",slides:[],size:{cx:100,cy:100}}
})})).openDeck(1,"doc","/a.pptx",1280);
check("★ open result of another file must not be passed to native renderer",
  wrongOpen.ok===false,wrongOpen);
const badText=await new SlidesBridge(make({editText:async()=>({
  text:undefined as unknown as string,renderedSlide:{nodes:[]}
})})).editText(1,"doc",0,"shape","new");
check("★ text edit cannot acknowledge a missing vendor text value",
  badText.ok===false,badText);
const normal=new SlidesBridge(make({}));
const a=await normal.addSlide(1,"doc");
check("valid native add response unchanged",a.ok===true,a);
const b=await normal.openDeck(1,"doc","/a.pptx",1280);
check("valid native open response unchanged",b.ok===true,b);
const c=await normal.editText(1,"doc",0,"shape","new");
check("valid native edit response unchanged",c.ok===true,c);
const d=await normal.saveDeck(1,"doc","/a.pptx");
check("valid native save response unchanged",d.ok===true,d);
console.log(`slides-bridge-result-contract-smoke: ${ok}/${ok+bad}`);if(bad)process.exitCode=1;