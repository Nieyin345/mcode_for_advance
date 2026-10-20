import {slidesBridge,type SlidesEditExecutor} from "../../src/main/document/slidesBridge.js";
let yes=0,no=0;
function ok(s:string,p:boolean,x:unknown){console.log((p?"PASS ":"FAIL ")+s+" "+JSON.stringify(x));p?yes++:no++;}
const executor=(tag:number):SlidesEditExecutor=>({
async addBlankSlide(){return {slideCount:tag,slides:[{id:tag,nodes:[]}],index:tag-1};},
async editText(){return {text:"vendor",renderedSlide:{nodes:[]}};},
async openDeck(){return {openResult:{tag}};},
async saveDeck(){return {bytes:tag};}
});
const a=executor(1),b=executor(2);
slidesBridge.attach(a);
ok("first attach activates vendor",slidesBridge.available,slidesBridge.available);
const init=await slidesBridge.addSlide(1,"d");
ok("initial attachment owns vendor runtime",init.ok&&init.ok&&("slideCount" in init)?init.slideCount===1:false,init);
slidesBridge.attach(a);
ok("same executor repeat attach remains harmless",(await slidesBridge.saveDeck(1,"d","/f")).ok===true,await slidesBridge.saveDeck(1,"d","/f"));
let refused=false;try{slidesBridge.attach(b);}catch{refused=true;}
ok("different executor cannot hot-swap an active vendor session",refused,refused);
const result=await slidesBridge.addSlide(1,"d");
ok("original executor remains in effect after attempted replacement",result.ok&&"slideCount" in result&&result.slideCount===1,result);
console.log(`slides-bridge-attach-smoke: ${yes}/${yes+no}`);if(no)process.exitCode=1;