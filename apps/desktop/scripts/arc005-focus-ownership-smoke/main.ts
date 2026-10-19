/** ARC-005: top overlay owns Tab, including Base UI portals without aria-modal. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Focus from "../../src/renderer/hooks/useFocusTrap.js";

let total=0,failed=0;
function check(name:string, good:boolean, detail?:unknown) {
 total++;
 console.log("  "+(good?"PASS ":"FAIL ")+name+(good?"":": "+JSON.stringify(detail)));
 if (!good) failed++;
}
const src = readFileSync(resolve(process.cwd(), "src/renderer/hooks/useFocusTrap.ts"),"utf8");
check("Global Settings Tab listener yields to topmost external dialog",
 src.includes("hasTopmostForeignDialog(container)") && src.includes("if (hasTopmostForeignDialog(container)) return;"));
const owner = { contains: (v:unknown) => (v as {scope:string}).scope === "settings" };
const fakeDialog=(scope:string, aria:string|null=null, connected=true, inert=false)=>({
 scope,isConnected:connected,
 getAttribute:(name:string)=> name==="aria-modal"?aria:null,
 closest:(_sel:string)=>inert?{}:null,
 getClientRects:()=>inert?[]:[{}],
});
const dialog = fakeDialog("portal"); // actual Base UI Dialog.Popup has aria-modal=null.
const own = fakeDialog("settings");
const noModal = fakeDialog("portal","false");
const detached = fakeDialog("portal",null,false);
const hidden = fakeDialog("portal",null,true,true);
const asDocument=(rows:unknown[]) => ({ querySelectorAll: (_sel:string)=>rows });
const fn = (Focus as unknown as Record<string,unknown>).hasTopmostForeignDialog;
check("Shared real focus-trap code exposes foreign dialog detector",typeof fn==="function");
if(typeof fn==="function"){
 const test=(name:string,rows:unknown[],expected:boolean)=>{
  const actual=(fn as (x:unknown,y:unknown)=>boolean)(owner,asDocument(rows));
  check(name,actual===expected,{actual,expected});
 };
 test("Base UI portal lacks aria-modal but still owns input",[dialog],true);
 test("Standalone settings root owns Tab when there is no modal",[],false);
 test("Dialog in settings container does not steal from its owner",[own],false);
 test("Non-modal aria-modal=false editor does not steal owner",[noModal],false);
 test("Detached dialog does not capture Tab",[detached],false);
 test("Hidden/inert dialog does not capture Tab",[hidden],false);
 test("An active external modal wins even if another modal is hidden",[hidden,dialog],true);
 test("Mixed inactive dialogs cannot block settings focus",[noModal,detached],false);
}else{
 for(let i=0;i<8;i++)check("missing pure overlay ownership contract "+i,false);
}
console.log("arc005-focus-ownership-smoke: "+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
