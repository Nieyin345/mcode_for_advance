import {ideDirtyTracker as tracker} from "../../src/renderer/lib/ideDirty.js";
let good=0,bad=0;
function eq(name:string,a:unknown,b:unknown){const yes=JSON.stringify(a)===JSON.stringify(b);console.log((yes?"PASS ":"FAIL ")+name+" got="+JSON.stringify(a));yes?good++:bad++;}
let log:string[]=[];let offB=()=>{};
const offA=tracker.subscribe(()=>{log.push("A");offB();});
offB=tracker.subscribe(()=>log.push("B"));
const offC=tracker.subscribe(()=>log.push("C"));
tracker.set("/fixture/uncommitted-a.ts",true);
eq("unsubscribe while notifying must not skip in-flight dirty indicator refresh",log,["A","B","C"]);
offA();offB();offC();
let heard:string[]=[];
const offThrow=tracker.subscribe(()=>{heard.push("throw");throw Error("fixture render listener failed");});
const offHealthy=tracker.subscribe(()=>heard.push("healthy"));
let escaped=false;
try{tracker.set("/fixture/uncommitted-b.ts",true);}catch{escaped=true;}
eq("failing listener must not interrupt other dirty indicators",heard,["throw","healthy"]);
eq("faulty renderer observer does not crash dirty tracking action",escaped,false);
eq("dirty state was still recorded for a failed observer",tracker.has("/fixture/uncommitted-b.ts"),true);
offThrow();offHealthy();
tracker.set("/fixture/uncommitted-a.ts",false);tracker.set("/fixture/uncommitted-b.ts",false);
eq("cleanup clears test file dirty state",tracker.snapshot().size,0);
console.log(`ide-dirty-listener-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
