import { registerAgentSessionDisposer, registerAgentShutdownHook, disposeAgentSession, disposeAllAgentResources } from "../../src/main/mcp/agentSessionCleanup.js";
let passed=0,failed=0;
const check=(n:string,c:boolean)=>{console.log((c?"PASS ":"FAIL ")+n);if(c)passed++;else failed++;};
const calls:string[]=[];
let offB:()=>void=()=>{};
const offA=registerAgentSessionDisposer(()=>{calls.push("A");offB();});
offB=registerAgentSessionDisposer(()=>calls.push("B"));
const offC=registerAgentSessionDisposer(()=>{calls.push("C");});
disposeAgentSession("fixture-session");
check("disposer unregistering a sibling must not skip its in-flight cleanup",calls.join(",")==="A,B,C");
offA();offB();offC();
const shutdown:string[]=[];
let offSecond:()=>void=()=>{};
const offFirst=registerAgentShutdownHook(()=>{shutdown.push("first");offSecond();});
offSecond=registerAgentShutdownHook(()=>shutdown.push("second"));
disposeAllAgentResources();
check("shutdown unregistering sibling must not skip required cleanup",shutdown.join(",")==="first,second");
offFirst();offSecond();
const thrown:string[]=[];
const oldWarn=console.warn;
console.warn=()=>{};
const offThrow=registerAgentSessionDisposer(()=>{thrown.push("throw");throw new Error("expected fixture");});
const offAfter=registerAgentSessionDisposer(()=>thrown.push("after"));
disposeAgentSession("fixture-session");
console.warn=oldWarn;
check("synchronous hook failure does not block later resources",thrown.join(",")==="throw,after");
offThrow();offAfter();
const rejected:unknown[]=[];
const onUnhandled=(reason:unknown)=>rejected.push(reason);
process.on("unhandledRejection",onUnhandled);
const offAsync=registerAgentSessionDisposer(async()=>{throw new Error("expected async fixture");});
try {disposeAgentSession("fixture-session");await new Promise(r=>setTimeout(r,30));}
finally {offAsync();process.off("unhandledRejection",onUnhandled);}
check("async disposer rejection is observed and not unhandled",rejected.length===0);
const asyncWarnings:unknown[]=[];
const onAsync=(reason:unknown)=>asyncWarnings.push(reason);
process.on('unhandledRejection',onAsync);
const offAsyncExit=registerAgentShutdownHook(async()=>{throw Error('shutdown fixture');});
try {disposeAllAgentResources();await new Promise(r=>setTimeout(r,25));}
finally {offAsyncExit();process.off('unhandledRejection',onAsync);}
check('shutdown async rejection must be consumed',asyncWarnings.length===0);
console.log(`agent-cleanup-mutation-smoke: ${passed}/${passed+failed}`);
if(failed)process.exitCode=1;
