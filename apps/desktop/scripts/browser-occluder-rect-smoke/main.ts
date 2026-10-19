import { rectOf, setBrowserStageRect, registerOccluder, unregisterOccluder, shouldSuppressBrowserView, OCCLUDER_UNMEASURED } from "../../src/renderer/lib/browserOcclusion.js";
import { readFileSync } from "node:fs";
let pass=0,fail=0;
function eq(name:string,a:unknown,b:unknown){const ok=a===b;console.log((ok?"PASS ":"FAIL ")+name);if(ok)pass++;else fail++;}
function el(width:number,height:number){return {isConnected:true,getBoundingClientRect:()=>({left:10,top:10,right:10+width,bottom:10+height,width,height})} as unknown as HTMLElement;}
eq("zero-width popup is not measurable",rectOf(el(0,100)),null);
eq("zero-height popup is not measurable",rectOf(el(100,0)),null);
eq("zero-size popup is not measurable",rectOf(el(0,0)),null);
eq("disconnected popup cannot overlap browser",rectOf({isConnected:false} as HTMLElement),null);
eq("real popup yields rect dimensions",rectOf(el(5,6))?.right,15);
setBrowserStageRect({left:0,top:0,right:100,bottom:100});
const id=registerOccluder(OCCLUDER_UNMEASURED);
try {eq("unmeasured portal does not cover browser",shouldSuppressBrowserView(),false);}
finally {unregisterOccluder(id);setBrowserStageRect(null);}
const hook=readFileSync("src/renderer/hooks/useSuppressBrowserView.ts","utf8");
eq("ref-aware remeasure keeps a zero-sized popup non-occluding",hook.includes("list.length > 0 ? (measureUnion() ?? OCCLUDER_UNMEASURED) : null"),true);
console.log(`browser-occluder-rect-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
