import {registerAgentSessionDisposer,registerAgentShutdownHook,disposeAgentSession,disposeAllAgentResources} from "../../src/main/mcp/agentSessionCleanup.js";
let ok=0,bad=0;const check=(name:string,pass:boolean,info="")=>{console.log((pass?"PASS ":"FAIL ")+name+" "+info);pass?ok++:bad++;};
const nasty=Object.create(null) as object;
let after=0;const warnings:unknown[]=[];const oldWarn=console.warn;console.warn=(...args:unknown[])=>warnings.push(args);
const a=registerAgentSessionDisposer(()=>{throw nasty;});
const b=registerAgentSessionDisposer(()=>{after++;});
try {
 let escaped=false;try{disposeAgentSession("fixture");}catch{escaped=true;}
 check("non-stringifiable sync throw never escapes",!escaped);
 check("following session disposer still executes",after===1, String(after));
}finally{a();b();}
let shutdownAfter=0;
const c=registerAgentShutdownHook(()=>{throw nasty;});const d=registerAgentShutdownHook(()=>shutdownAfter++);
try {
 let escaped=false;try{disposeAllAgentResources();}catch{escaped=true;}
 check("nasty shutdown error cannot escape cleanup",!escaped);
 check("following shutdown hook executes",shutdownAfter===1, String(shutdownAfter));
}finally{c();d();}
const unhandled:unknown[]=[];const onUnhandled=(x:unknown)=>unhandled.push(x);process.on("unhandledRejection",onUnhandled);
const e=registerAgentSessionDisposer(async()=>{throw nasty;});const f=registerAgentShutdownHook(async()=>{throw nasty;});
try {
 disposeAgentSession("async-fixture");disposeAllAgentResources();
 await new Promise(r=>setTimeout(r,70));
 check("malformed async disposer error observed, never rethrown as rejection",unhandled.length===0,String(unhandled.length));
}finally{e();f();process.off("unhandledRejection",onUnhandled);console.warn=oldWarn;}
check("all bad errors produced bounded diagnostics",warnings.some(x=>JSON.stringify(x).includes("未知错误")),String(warnings.length));
console.log(`agent-cleanup-hard-error-smoke: ${ok}/${ok+bad}`);if(bad)process.exitCode=1;
