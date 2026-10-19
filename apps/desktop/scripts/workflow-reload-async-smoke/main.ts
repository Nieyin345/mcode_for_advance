import { setWorkflowReloader, requestWorkflowReload } from "../../src/main/orchestration/reloadRequest.js";
let passed=0, failed=0;
const check=(name:string,ok:boolean)=>{console.log((ok?"PASS ":"FAIL ")+name);if(ok)passed++;else failed++;};
let uncaught:unknown[]=[];
const handler=(reason:unknown)=>uncaught.push(reason);
process.on("unhandledRejection",handler);
try {
 setWorkflowReloader(null);
 check("request without registered runner is harmless", (()=>{try{requestWorkflowReload("wf0");return true;}catch{return false;}})());
 const ids:string[]=[];
 setWorkflowReloader((id)=>{ids.push(id);});
 requestWorkflowReload("wf1");
 check("normal registration receives workflow ID", ids.join(",")==="wf1");
 setWorkflowReloader(()=>{throw new Error("fixture synchronous reload failed");});
 check("synchronous failure never turns saved workflow into save failure", (()=>{try{requestWorkflowReload("wf2");return true;}catch{return false;}})());
 setWorkflowReloader(async()=>{throw new Error("fixture asynchronous reload failed");});
 check("asynchronous callback returns immediately without throwing", (()=>{try{requestWorkflowReload("wf3");return true;}catch{return false;}})());
 await new Promise<void>(resolve=>setTimeout(resolve,30));
 check("asynchronous rejection is observed instead of leaking unhandledRejection",uncaught.length===0);
 setWorkflowReloader(async()=>{ids.push("async-ok");});
 requestWorkflowReload("wf4");
 await new Promise<void>(resolve=>setImmediate(resolve));
 check("healthy async reload still executes",ids.includes("async-ok"));
} finally {
 setWorkflowReloader(null);
 process.off("unhandledRejection",handler);
}
console.log(`workflow-reload-async-smoke: ${passed}/${passed+failed}`);
if(failed) process.exitCode=1;
