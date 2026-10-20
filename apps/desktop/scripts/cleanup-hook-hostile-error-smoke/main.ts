import {registerSessionCleanupHook,runSessionCleanupHooks,registerProjectCleanupHook,runProjectCleanupHooks,__sessionCleanupHookCount} from "../../src/main/lib/sessionCleanupHooks.js";
let pass=0,fail=0;const test=(s:string,x:boolean)=>{console.log((x?"PASS ":"FAIL ")+s);x?pass++:fail++;};
const evil=Object.create(null);
const previous=console.warn, warnings:string[]=[];
console.warn=(...args:unknown[])=>warnings.push(args.map(x=>typeof x==="string"?x:"nonstring").join(" "));
let sessionNext=0,projectNext=0;
const offA=registerSessionCleanupHook(()=>{throw evil;});
const offB=registerSessionCleanupHook(()=>{sessionNext++;});
const offC=registerProjectCleanupHook(()=>{throw evil;});
const offD=registerProjectCleanupHook(()=>{projectNext++;});
try {
let escaped=false;try{runSessionCleanupHooks("fixture-session");}catch{escaped=true;}
test("malformed thrown error does not escape session deletion hooks",!escaped);
test("session hook after a hostile throw still executes",sessionNext===1);
escaped=false;try{runProjectCleanupHooks("fixture-project","/fixture/root");}catch{escaped=true;}
test("malformed thrown error does not escape project deletion hooks",!escaped);
test("project hook after hostile throw still executes",projectNext===1);
test("host warnings explicitly show unknown error",warnings.filter(x=>x.includes("未知错误")).length>=2);
}finally{offA();offB();offC();offD();console.warn=previous;}
const unhandled:unknown[]=[];
const handleUnhandled=(reason:unknown)=>unhandled.push(reason);
process.on("unhandledRejection",handleUnhandled);
const oldWarn=console.warn;
const warningsAsync:string[]=[];
console.warn=(...args:unknown[])=>warningsAsync.push(args.filter(x=>typeof x==="string").join(" "));
const offAsyncSession=registerSessionCleanupHook(async()=>{throw evil;});
const offAsyncProject=registerProjectCleanupHook(async()=>{throw evil;});
try {
 runSessionCleanupHooks("async-session");
 runProjectCleanupHooks("async-project","/fixture");
 await new Promise(r=>setTimeout(r,40));
 test("async returning session hook rejection is observed, no unhandledRejection",unhandled.length===0);
 test("both asynchronous cleanup failures are diagnosed safely",warningsAsync.filter(x=>x.includes("未知错误")).length===2);
}finally {
 offAsyncSession();offAsyncProject();process.off("unhandledRejection",handleUnhandled);console.warn=oldWarn;
}
test("all session hooks removed",__sessionCleanupHookCount()===0);
console.log(`cleanup-hook-hostile-error-smoke: ${pass}/${pass+fail}`);if(fail)process.exitCode=1;